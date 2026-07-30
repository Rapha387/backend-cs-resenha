// ws.js — WebSocket server: registro de clients conectados por steamid,
// heartbeat e roteamento das mensagens do Resenha Client.
import { WebSocketServer } from 'ws';
import { sessionFromAuthHeader } from './auth.js';
import { resync, handleClientEvent } from './matches.js';
import { CLIENT_LATEST, CLIENT_DOWNLOAD_URL, versaoMenor } from './version.js';
import { log } from './log.js';

// steamid -> Set<ws> (o mesmo jogador pode ter mais de uma conexão durante
// uma reconexão; todas recebem os comandos)
const clients = new Map();

// steamid -> última vez que vimos o client desse jogador (ms).
const lastSeen = new Map();

// Uma reconexão (backend reiniciando, wi-fi oscilando, PC saindo do sono) leva
// alguns segundos — o client refaz o handshake com backoff a partir de 1s.
// Sem tolerância, cada soluço desses anunciava "Resenha Client fechado" pra
// sala inteira de uma vez, mesmo com todo mundo jogando: o aviso existe pra
// quem esqueceu de abrir o app, não pra piscar a cada reconexão.
const TOLERANCIA_MS = 45_000;

/** Envia um objeto pra todas as conexões ATIVAS de um jogador. Retorna quantas. */
export function sendTo(steamid, obj) {
  const sockets = clients.get(steamid);
  if (!sockets || sockets.size === 0) return 0;
  const payload = JSON.stringify(obj);
  let sent = 0;
  for (const ws of sockets) {
    // Conexão bloqueada por versão nunca recebe comando (START_MATCH etc.).
    if (ws.readyState === ws.OPEN && !ws.bloqueado) {
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

/**
 * O Resenha Client desse jogador está de pé? Conta como sim durante uma
 * reconexão curta (ver TOLERANCIA_MS) — a coleta não se perde nesse intervalo,
 * o client reenvia o estado assim que volta.
 */
export function isConnected(steamid) {
  // Client bloqueado por versão não conta como conectado: ele realmente não
  // vai registrar nada, e o site precisa avisar isso na tela do lobby.
  const set = clients.get(steamid);
  if (set) for (const ws of set) if (ws.readyState === ws.OPEN && !ws.bloqueado) return true;
  const visto = lastSeen.get(steamid);
  return visto !== undefined && Date.now() - visto < TOLERANCIA_MS;
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
    lastSeen.set(steamid, Date.now());
    log(`client conectado: ${steamid} (${connectedCount()} conexões no total)`);

    ws.isAlive = true;
    // Vira true no HELLO se a versão for antiga: a conexão continua aberta
    // (ver handleMessage) mas não recebe comandos nem grava evento nenhum.
    ws.bloqueado = false;

    ws.on('pong', () => {
      ws.isAlive = true;
      if (!ws.bloqueado) lastSeen.set(steamid, Date.now());
    });

    ws.on('message', async (raw) => {
      if (!ws.bloqueado) lastSeen.set(steamid, Date.now());
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
      lastSeen.set(steamid, Date.now()); // começa a contar a tolerância
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
    // Faxina do lastSeen: passada a tolerância de quem já desconectou, a
    // entrada não muda mais nenhuma resposta.
    const limite = Date.now() - TOLERANCIA_MS;
    for (const [steamid, visto] of lastSeen) {
      if (visto < limite && !clients.has(steamid)) lastSeen.delete(steamid);
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));

  return wss;
}

async function handleMessage(steamid, msg, ws) {
  // Conexão bloqueada por versão: inerte. Só o HELLO é processado (pra
  // reavisar), todo o resto é descartado antes de tocar no banco.
  if (ws.bloqueado && msg.type !== 'HELLO') return;

  switch (msg.type) {
    case 'HELLO':
      log(`HELLO de ${steamid} (client v${msg.version ?? '?'})`);
      // Portão de versão: client desatualizado não opera — sem resync, sem
      // receber START_MATCH e sem gravar evento nenhum.
      //
      // A conexão NÃO é fechada de propósito: o client 0.1.0 (que já está
      // instalado nas máquinas e não conhece UPDATE_REQUIRED) trata o close
      // como queda e reconecta com backoff 1s, o que viraria um martelo de
      // uma conexão por segundo por pessoa — cada uma consultando a sessão
      // no Turso e segurando o Render free acordado. Deixando aberta, ele
      // fica parado. O client novo fecha sozinho ao receber o aviso.
      if (versaoMenor(msg.version, CLIENT_LATEST)) {
        ws.bloqueado = true;
        lastSeen.delete(steamid);
        log(`client de ${steamid} desatualizado (v${msg.version ?? '?'} < v${CLIENT_LATEST}) — bloqueado`);
        ws.send(JSON.stringify({ type: 'UPDATE_REQUIRED', latest: CLIENT_LATEST, url: CLIENT_DOWNLOAD_URL }));
        return;
      }
      // Reconectou já atualizado numa conexão antes marcada? Libera.
      ws.bloqueado = false;
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
