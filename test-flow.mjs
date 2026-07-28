// test-flow.mjs — teste de ponta a ponta do backend (rode com o servidor no ar):
//   node --env-file=.env test-flow.mjs
//
// Usa steamid falso (prefixo 7656119800000000, mesmo padrão dos testes do
// site) e limpa tudo que criou no final.
import { createClient } from '@libsql/client';
import WebSocket from 'ws';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws/client';
const KEY = process.env.INTERNAL_API_KEY;
const STEAMID = '76561198000000091';
const LOBBY = 'ZZTST';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let falhas = 0;
function check(nome, cond, extra = '') {
  console.log(`${cond ? '✅' : '❌'} ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!cond) falhas++;
}

async function req(path, { method = 'POST', body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function wsConnect(token) {
  return new Promise((resolve) => {
    const messages = [];
    const ws = new WebSocket(WS_URL, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    ws.on('open', () => resolve({ ws, messages, status: 101 }));
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('unexpected-response', (_r, res) => resolve({ ws: null, messages, status: res.statusCode }));
    ws.on('error', () => {});
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await db.batch([
    { sql: 'DELETE FROM client_pair_codes WHERE steamid = ?', args: [STEAMID] },
    { sql: 'DELETE FROM client_sessions WHERE steamid = ?', args: [STEAMID] },
    { sql: 'DELETE FROM match_events WHERE steamid = ?', args: [STEAMID] },
    { sql: 'DELETE FROM live_matches WHERE code = ?', args: [LOBBY] },
    { sql: 'DELETE FROM lobby_players WHERE code = ?', args: [LOBBY] },
    { sql: 'DELETE FROM lobbies WHERE code = ?', args: [LOBBY] },
  ], 'write');
}

try {
  // saúde
  const health = await req('/health', { method: 'GET' });
  check('health', health.status === 200 && health.data.ok === true);

  // pareamento: código inválido
  const bad = await req('/api/client/auth/pair', { body: { code: 'NOPE99' } });
  check('pair com código inválido → 401', bad.status === 401);

  // pareamento: código válido (inserido direto, como o site faria)
  await cleanup();
  await db.execute({
    sql: 'INSERT INTO client_pair_codes (code, steamid, expires, used, created) VALUES (?, ?, ?, 0, ?)',
    args: ['TESTOK', STEAMID, Date.now() + 300000, Date.now()],
  });
  const ok = await req('/api/client/auth/pair', { body: { code: 'TESTOK' } });
  check('pair com código válido → tokens', ok.status === 200 && !!ok.data.access_token && !!ok.data.refresh_token);

  // código é de uso único
  const reuse = await req('/api/client/auth/pair', { body: { code: 'TESTOK' } });
  check('reuso do código → 401', reuse.status === 401);

  // refresh rotaciona
  const ref = await req('/api/client/auth/refresh', { body: { refresh_token: ok.data.refresh_token } });
  check('refresh → novos tokens', ref.status === 200 && ref.data.access_token !== ok.data.access_token);

  // refresh antigo morreu (foi rotacionado)
  const refOld = await req('/api/client/auth/refresh', { body: { refresh_token: ok.data.refresh_token } });
  check('refresh_token antigo → 401', refOld.status === 401);

  // WS sem token → 401
  const wsNoAuth = await wsConnect(null);
  check('WS sem Authorization → 401', wsNoAuth.status === 401);

  // WS com access antigo (rotacionado) → 401
  const wsOld = await wsConnect(ok.data.access_token);
  check('WS com access rotacionado → 401', wsOld.status === 401);

  // WS autenticado + HELLO → resync END_MATCH (sem partida ativa)
  const conn = await wsConnect(ref.data.access_token);
  check('WS autenticado conecta', conn.status === 101);
  conn.ws.send(JSON.stringify({ type: 'HELLO', client: 'test', version: '0' }));
  await sleep(700);
  check('resync sem partida → END_MATCH', conn.messages.some((m) => m.type === 'END_MATCH'));

  // partida: cria lobby falso e dispara start
  await db.batch([
    { sql: "INSERT INTO lobbies (code, owner, status, created) VALUES (?, ?, 'pronto', ?)", args: [LOBBY, STEAMID, Date.now()] },
    { sql: 'INSERT INTO lobby_players (code, steamid, team, joined) VALUES (?, ?, ?, ?)', args: [LOBBY, STEAMID, 'A', Date.now()] },
  ], 'write');
  const start = await req('/internal/match/start', { body: { code: LOBBY }, headers: { 'X-Internal-Key': KEY } });
  check('match/start → matchId', start.status === 200 && Number.isInteger(start.data.matchId), `matchId=${start.data.matchId}`);
  await sleep(700);
  check('client recebeu START_MATCH', conn.messages.some((m) => m.type === 'START_MATCH' && m.matchId === start.data.matchId));

  // idempotência do start
  const start2 = await req('/internal/match/start', { body: { code: LOBBY }, headers: { 'X-Internal-Key': KEY } });
  check('match/start repetido → mesmo matchId', start2.data.matchId === start.data.matchId);

  // evento do client é gravado
  conn.ws.send(JSON.stringify({
    type: 'ROUND_END', matchId: start.data.matchId, timestamp: Date.now(),
    data: { round: 1, winner: 'CT', score_ct: 1, score_t: 0 },
  }));
  await sleep(700);
  const saved = await db.execute({
    sql: "SELECT COUNT(*) c FROM match_events WHERE match_id = ? AND type = 'ROUND_END'",
    args: [start.data.matchId],
  });
  check('evento gravado em match_events', Number(saved.rows[0][0]) === 1);

  // evento com matchId errado não grava e recebe resync
  conn.ws.send(JSON.stringify({ type: 'ROUND_END', matchId: 999999, data: {} }));
  await sleep(700);
  const wrong = await db.execute({ sql: 'SELECT COUNT(*) c FROM match_events WHERE match_id = 999999', args: [] });
  check('matchId errado não grava', Number(wrong.rows[0][0]) === 0);

  // state ao vivo
  conn.ws.send(JSON.stringify({
    type: 'STATE_SYNC', matchId: start.data.matchId, timestamp: Date.now(),
    data: { map: 'de_mirage', score_ct: 1, score_t: 0 },
  }));
  await sleep(700);
  const state = await req(`/internal/match/${start.data.matchId}/state`, { method: 'GET', headers: { 'X-Internal-Key': KEY } });
  check('match/:id/state agrega STATE_SYNC', state.status === 200 && state.data.players?.length === 1);

  // end + notificação
  const end = await req('/internal/match/end', { body: { code: LOBBY }, headers: { 'X-Internal-Key': KEY } });
  check('match/end', end.status === 200 && end.data.matchId === start.data.matchId);
  await sleep(700);
  const endMsgs = conn.messages.filter((m) => m.type === 'END_MATCH');
  check('client recebeu END_MATCH', endMsgs.length >= 2); // 1 do resync inicial + 1 do end

  conn.ws.close();
} finally {
  await cleanup();
  console.log(falhas === 0 ? '\n🎉 tudo passou' : `\n💥 ${falhas} falha(s)`);
  process.exit(falhas === 0 ? 0 : 1);
}
