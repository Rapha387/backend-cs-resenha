// ws.js — WebSocket server: registro de clients conectados por steamid,
// heartbeat e roteamento das mensagens do Resenha Client.
import { WebSocketServer } from 'ws';
import { sessionFromAuthHeader } from './auth.js';
import { resync, handleClientEvent } from './matches.js';
import { log } from './log.js';

// steamid -> Set<ws> (o mesmo jogador pode ter mais de uma conexão durante
// uma reconexão; todas recebem os comandos)
const clients = new Map();

/** Envia um objeto pra todas as conexões de um jogador. Retorna quantas. */
export function sendTo(steamid, obj) {
  const sockets = clients.get(steamid);
  if (!sockets || sockets.size === 0) return 0;
  const payload = JSON.stringify(obj);
  let sent = 0;
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
      sent++;
    }
  }
  return sent;
}

export function connectedCount() {
  let n = 0;
  for (const set of clients.values()) n += set.size;
  return n;
}

export function attachWebSocket(server) {
  // Um STATE_SYNC tem ~1 KB; 64 KB é folga generosa. Sem esse teto o default
  // do ws é 100 MiB por mensagem — um client malicioso incharia o banco.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws/client') {
      socket.destroy();
      return;
    }
    let session = null;
    try {
      session = await sessionFromAuthHeader(req.headers.authorization);
    } catch (e) {
      log('erro ao validar sessão no upgrade:', e.message);
    }
    if (!session) {
      // 401 explícito: o client entende e renova o access token
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, session);
    });
  });

  wss.on('connection', (ws, _req, session) => {
    const { steamid } = session;
    if (!clients.has(steamid)) clients.set(steamid, new Set());
    clients.get(steamid).add(ws);
    log(`client conectado: ${steamid} (${connectedCount()} conexões no total)`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // não é JSON: ignora
      }
      try {
        await handleMessage(steamid, msg, ws);
      } catch (e) {
        log(`erro tratando ${msg?.type} de ${steamid}:`, e.message);
      }
    });

    ws.on('close', () => {
      const set = clients.get(steamid);
      set?.delete(ws);
      if (set?.size === 0) clients.delete(steamid);
      log(`client desconectado: ${steamid}`);
    });

    ws.on('error', (e) => log(`erro WS de ${steamid}:`, e.message));
  });

  // Heartbeat: derruba conexões mortas (cabo puxado, PC hibernado…)
  const interval = setInterval(() => {
    for (const set of clients.values()) {
      for (const ws of set) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));

  return wss;
}

async function handleMessage(steamid, msg, ws) {
  switch (msg.type) {
    case 'HELLO':
      log(`HELLO de ${steamid} (client v${msg.version ?? '?'})`);
      // Ressincronização obrigatória do contrato: reenvia o estado atual
      // (START_MATCH se tem partida ativa, END_MATCH se não tem).
      await resync(steamid);
      break;
    case 'MATCH_ACK':
      log(`${steamid} confirmou START_MATCH da partida #${msg.matchId}`);
      break;
    case 'MATCH_ENDED_ACK':
      log(`${steamid} confirmou END_MATCH`);
      break;
    case 'PONG':
      break;
    default:
      // Eventos de partida (ROUND_START, PLAYER_KILL, STATE_SYNC…)
      if (typeof msg.type === 'string' && msg.matchId !== undefined) {
        await handleClientEvent(steamid, msg);
      }
  }
}
