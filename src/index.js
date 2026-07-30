// index.js — servidor HTTP (REST) + WebSocket do backend dedicado.
//
//   POST /api/client/auth/pair      troca código de pareamento por tokens
//   POST /api/client/auth/refresh   rotaciona os tokens
//   POST /internal/match/start      site avisa: veto terminou → START_MATCH
//   POST /internal/match/end        site avisa: placar registrado → END_MATCH
//   GET  /internal/match/:id/state  placar/stats ao vivo (STATE_SYNC agregado)
//   GET  /health                    liveness
//   WS   /ws/client                 conexão persistente do Resenha Client
import http from 'http';
import { pair, refresh, HttpError } from './auth.js';
import { startMatch, endMatch, liveState, liveStateByCode, encerrarPartidasAbandonadas } from './matches.js';
import { attachWebSocket, connectedCount } from './ws.js';
import { rateLimit } from './ratelimit.js';
import { CLIENT_LATEST, CLIENT_DOWNLOAD_URL } from './version.js';
import { log } from './log.js';

const PORT = Number(process.env.PORT) || 4000;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Corpo grande demais.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(new HttpError(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  // X-Forwarded-For é forjável por qualquer cliente — só pode ser levado a
  // sério quando um proxy reverso confiável (nginx/Caddy/Railway) o preenche.
  // Sem TRUST_PROXY=1, usar o header deixaria o rate limit contornável.
  if (process.env.TRUST_PROXY === '1') {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'desconhecido';
}

function requireInternalKey(req) {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) throw new HttpError(503, 'INTERNAL_API_KEY não configurada no backend.');
  if (req.headers['x-internal-key'] !== expected) throw new HttpError(401, 'Chave interna inválida.');
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && pathname === '/api/client/auth/pair') {
      if (!rateLimit(clientIp(req), { max: 10, windowMs: 5 * 60 * 1000 })) {
        throw new HttpError(429, 'Muitas tentativas. Espere alguns minutos.');
      }
      return json(res, 200, await pair(await readBody(req)));
    }
    if (req.method === 'POST' && pathname === '/api/client/auth/refresh') {
      if (!rateLimit(clientIp(req), { max: 60, windowMs: 5 * 60 * 1000 })) {
        throw new HttpError(429, 'Muitas tentativas. Espere alguns minutos.');
      }
      return json(res, 200, await refresh(await readBody(req)));
    }
    if (req.method === 'POST' && pathname === '/internal/match/start') {
      requireInternalKey(req);
      return json(res, 200, await startMatch(await readBody(req)));
    }
    if (req.method === 'POST' && pathname === '/internal/match/end') {
      requireInternalKey(req);
      return json(res, 200, await endMatch(await readBody(req)));
    }
    const stateMatch = /^\/internal\/match\/(\d+)\/state$/.exec(pathname);
    if (req.method === 'GET' && stateMatch) {
      requireInternalKey(req);
      return json(res, 200, await liveState(Number(stateMatch[1])));
    }
    const stateLobby = /^\/internal\/lobby\/([A-Za-z0-9]{1,10})\/state$/.exec(pathname);
    if (req.method === 'GET' && stateLobby) {
      requireInternalKey(req);
      return json(res, 200, await liveStateByCode(stateLobby[1]));
    }
    if (req.method === 'POST' && pathname === '/internal/sweep') {
      requireInternalKey(req);
      return json(res, 200, { encerradas: await encerrarPartidasAbandonadas() });
    }
    if (req.method === 'GET' && pathname === '/api/client/version') {
      // Público e barato: o client consulta no boot pra saber se está atual.
      return json(res, 200, { version: CLIENT_LATEST, url: CLIENT_DOWNLOAD_URL });
    }
    if (req.method === 'GET' && pathname === '/health') {
      return json(res, 200, { ok: true, clients: connectedCount() });
    }
    json(res, 404, { erro: 'Rota não encontrada.' });
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { erro: e.message });
    log(`erro em ${req.method} ${pathname}:`, e.message);
    json(res, 500, { erro: 'Erro interno.' });
  }
});

attachWebSocket(server);

server.listen(PORT, () => {
  log(`resenha-backend ouvindo em :${PORT} (REST + WS /ws/client)`);
});

// Rede de segurança: se um END_MATCH se perdeu, a partida não pode ficar
// "ativa" pra sempre — o client continuaria coletando fora da plataforma.
const varrer = () => encerrarPartidasAbandonadas().catch((e) => log('varredura falhou:', e.message));
varrer();
setInterval(varrer, 60 * 60 * 1000).unref();
