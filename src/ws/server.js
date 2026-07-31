// ws/server.js — o servidor WebSocket em si: autentica o upgrade, registra a
// conexão e mantém o heartbeat. A lógica de cada mensagem fica em messages.js
// e o "quem está online" em registry.js.
import { WebSocketServer } from 'ws';
import { sessionFromAuthHeader } from '../auth.js';
import { handleMessage } from './messages.js';
import { registrar, remover, marcarAtividade, conexoes, connectedCount, limparLastSeen } from './registry.js';
import { log } from '../log.js';

// Um STATE_SYNC tem ~1 KB; 64 KB é folga generosa. Sem esse teto o default
// do ws é 100 MiB por mensagem — um client malicioso incharia o banco.
const MAX_PAYLOAD = 64 * 1024;
const HEARTBEAT_MS = 30_000;

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => autenticarUpgrade(wss, req, socket, head));
  wss.on('connection', (ws, _req, session) => aoConectar(ws, session));

  const interval = setInterval(() => baterHeartbeat(), HEARTBEAT_MS);
  wss.on('close', () => clearInterval(interval));

  return wss;
}

async function autenticarUpgrade(wss, req, socket, head) {
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

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, session));
}

function aoConectar(ws, { steamid }) {
  registrar(steamid, ws);
  log(`client conectado: ${steamid} (${connectedCount()} conexões no total)`);

  ws.isAlive = true;
  // Vira true no HELLO se a versão for antiga: a conexão continua aberta
  // (ver messages.js) mas não recebe comandos nem grava evento nenhum.
  ws.bloqueado = false;

  ws.on('pong', () => {
    ws.isAlive = true;
    marcarAtividade(steamid, ws);
  });

  ws.on('message', async (raw) => {
    marcarAtividade(steamid, ws);
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
    remover(steamid, ws);
    log(`client desconectado: ${steamid}`);
  });

  ws.on('error', (e) => log(`erro WS de ${steamid}:`, e.message));
}

/** Derruba conexões mortas (cabo puxado, PC hibernado…) e faz faxina. */
function baterHeartbeat() {
  for (const ws of conexoes()) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  limparLastSeen();
}
