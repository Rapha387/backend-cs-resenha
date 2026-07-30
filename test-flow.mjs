// test-flow.mjs — teste de ponta a ponta do backend (rode com o servidor no ar):
//   node --env-file=.env test-flow.mjs
//
// Usa steamid falso (prefixo 7656119800000000, mesmo padrão dos testes do
// site) e limpa tudo que criou no final.
import { createClient } from '@libsql/client';
import WebSocket from 'ws';
import { CLIENT_LATEST } from './src/version.js';

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
    { sql: 'DELETE FROM matches WHERE code = ?', args: [LOBBY] },
    { sql: 'DELETE FROM players WHERE steamid = ?', args: [STEAMID] },
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
  conn.ws.send(JSON.stringify({ type: 'HELLO', client: 'test', version: CLIENT_LATEST }));
  await sleep(700);
  check('resync sem partida → END_MATCH', conn.messages.some((m) => m.type === 'END_MATCH'));

  // ---- Portão de versão: client velho não opera ----
  const versao = await req('/api/client/version', { method: 'GET' });
  check('GET /api/client/version', versao.status === 200 && versao.data.version === CLIENT_LATEST,
    `version=${versao.data.version}`);

  // Cada refresh rotaciona os dois tokens: `tokens` guarda o par vivo pro
  // resto do teste (a conexão `conn` original segue válida — o backend não
  // derruba sessão já autenticada quando o token é rotacionado).
  const tokens = (await req('/api/client/auth/refresh', { body: { refresh_token: ref.data.refresh_token } })).data;

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

  // ---- Cenário real do portão: partida rolando e alguém abre o client velho ----
  // Fecha a conexão boa antes: o teste é sobre um jogador cujo ÚNICO client
  // é o desatualizado (com as duas abertas, o site veria o bom e diria online).
  conn.ws.close();
  await sleep(300);
  const connVelho = await wsConnect(tokens.access_token);
  connVelho.ws.send(JSON.stringify({ type: 'HELLO', client: 'test', version: '0.0.1' }));
  await sleep(800);
  check('client desatualizado → UPDATE_REQUIRED',
    connVelho.messages.some((m) => m.type === 'UPDATE_REQUIRED' && m.latest === CLIENT_LATEST));
  check('client desatualizado NÃO recebe START_MATCH (partida ativa)',
    !connVelho.messages.some((m) => m.type === 'START_MATCH'));
  // Aberta de propósito: fechar faria o client 0.1.0 (que não conhece
  // UPDATE_REQUIRED) reconectar em loop de 1s. Ver handleMessage em ws.js.
  check('conexão do client velho fica aberta (sem loop de reconexão)',
    connVelho.ws.readyState === WebSocket.OPEN);

  // Inerte mesmo sabendo o matchId certo (ele podia ter guardado de antes).
  const antesDoVelho = await db.execute({
    sql: 'SELECT COUNT(*) c FROM match_events WHERE match_id = ?', args: [start.data.matchId],
  });
  connVelho.ws.send(JSON.stringify({
    type: 'STATE_SYNC', matchId: start.data.matchId, timestamp: Date.now(),
    data: { map: 'de_dust2', score_ct: 5, score_t: 5 },
  }));
  await sleep(700);
  const depoisDoVelho = await db.execute({
    sql: 'SELECT COUNT(*) c FROM match_events WHERE match_id = ?', args: [start.data.matchId],
  });
  check('evento de client bloqueado não é gravado (nem com matchId válido)',
    Number(depoisDoVelho.rows[0][0]) === Number(antesDoVelho.rows[0][0]));

  const stateVelho = await req(`/internal/match/${start.data.matchId}/state`, { method: 'GET', headers: { 'X-Internal-Key': KEY } });
  check('client bloqueado aparece como offline pro site',
    stateVelho.data.players[0].client_online === false);

  // Volta ao normal: fecha o velho e reconecta atualizado pro resto do teste.
  connVelho.ws.close();
  await sleep(300);
  const connOk = await wsConnect(tokens.access_token);
  connOk.ws.send(JSON.stringify({ type: 'HELLO', client: 'test', version: CLIENT_LATEST }));
  await sleep(700);
  check('client atualizado reconecta e recebe START_MATCH da partida ativa',
    connOk.messages.some((m) => m.type === 'START_MATCH' && m.matchId === start.data.matchId));
  conn.ws = connOk.ws;
  conn.messages = connOk.messages;

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
  check('client conectado → client_online', state.data.players[0].client_online === true);

  // end + notificação
  const end = await req('/internal/match/end', { body: { code: LOBBY }, headers: { 'X-Internal-Key': KEY } });
  check('match/end', end.status === 200 && end.data.matchId === start.data.matchId);
  await sleep(700);
  // Esta conexão pegou START_MATCH no resync (a partida estava ativa), então
  // qualquer END_MATCH aqui veio do /internal/match/end.
  const endMsgs = conn.messages.filter((m) => m.type === 'END_MATCH');
  check('client recebeu END_MATCH', endMsgs.length >= 1);

  // Queda curta do WS (backend reiniciando, wi-fi oscilando) não pode acender
  // o aviso "Resenha Client fechado" pra sala inteira — ver TOLERANCIA_MS.
  conn.ws.close();
  await sleep(2300); // > CACHE_MS do liveState, senão a resposta vem do cache
  const caiu = await req(`/internal/match/${start.data.matchId}/state`, { method: 'GET', headers: { 'X-Internal-Key': KEY } });
  check('queda curta não vira "client fechado"', caiu.data.players[0].client_online === true);

  // ---- Registro automático do placar via GAME_OVER (fluxo real do client) ----
  // O lobby continua 'pronto' (endMatch não mexe no lobby); cria o jogador na
  // tabela players (elo/W-L são atualizados no registro) e uma partida nova.
  await db.execute({
    sql: 'INSERT INTO players (steamid, name, elo, wins, losses, created) VALUES (?, ?, 1000, 0, 0, ?)',
    args: [STEAMID, 'Testador', Date.now()],
  });
  const conn2 = await wsConnect(tokens.access_token);
  check('WS reconecta pro teste de registro', conn2.status === 101);

  const start3 = await req('/internal/match/start', { body: { code: LOBBY }, headers: { 'X-Internal-Key': KEY } });
  const mid3 = start3.data.matchId;
  check('nova partida criada', Number.isInteger(mid3) && mid3 !== start.data.matchId, `matchId=${mid3}`);

  // STATE_SYNC dá o voto de lado (jogador do time A jogando de CT)…
  conn2.ws.send(JSON.stringify({
    type: 'STATE_SYNC', matchId: mid3, timestamp: Date.now(),
    data: { map: 'de_mirage', round: 21, round_phase: 'over', map_phase: 'live', score_ct: 12, score_t: 9,
      player: { steamid: STEAMID, name: 'Testador', team: 'CT', health: 100, kills: 20, deaths: 5, assists: 3, mvps: 2 } },
  }));
  await sleep(600);
  // …e o GAME_OVER traz o placar final da hora exata (13x9, um round além do
  // último sync — é ele que tem que valer no registro).
  conn2.ws.send(JSON.stringify({
    type: 'GAME_OVER', matchId: mid3, timestamp: Date.now(),
    data: { score_ct: 13, score_t: 9 },
  }));
  await sleep(1200);

  const lobFinal = await db.execute({ sql: 'SELECT status FROM lobbies WHERE code = ?', args: [LOBBY] });
  check("GAME_OVER → lobby 'finalizado' sozinho", lobFinal.rows[0][0] === 'finalizado', `status=${lobFinal.rows[0][0]}`);

  const jog = await db.execute({ sql: 'SELECT elo, wins, losses FROM players WHERE steamid = ?', args: [STEAMID] });
  check('elo aplicado automaticamente (+25)', Number(jog.rows[0][0]) === 1025 && Number(jog.rows[0][1]) === 1,
    `elo=${jog.rows[0][0]} wins=${jog.rows[0][1]}`);

  const reg = await db.execute({ sql: 'SELECT score_a, score_b, winner, map FROM matches WHERE code = ?', args: [LOBBY] });
  check('histórico gravado com o placar do GAME_OVER (13x9, não 12x9)',
    reg.rows.length === 1 && Number(reg.rows[0][0]) === 13 && Number(reg.rows[0][1]) === 9 && reg.rows[0][2] === 'A',
    `${reg.rows[0]?.[0]}x${reg.rows[0]?.[1]} winner=${reg.rows[0]?.[2]}`);

  const lm3 = await db.execute({ sql: 'SELECT status FROM live_matches WHERE id = ?', args: [mid3] });
  check("coleta encerrada (live_match 'encerrada')", lm3.rows[0][0] === 'encerrada', `status=${lm3.rows[0][0]}`);
  check('client recebeu END_MATCH do registro', conn2.messages.some((m) => m.type === 'END_MATCH'));

  conn2.ws.close();
} finally {
  await cleanup();
  console.log(falhas === 0 ? '\n🎉 tudo passou' : `\n💥 ${falhas} falha(s)`);
  process.exit(falhas === 0 ? 0 : 1);
}
