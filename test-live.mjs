// test-live.mjs — testa a agregação do placar ao vivo (tradução CT/T → A/B).
//   node --env-file=.env test-live.mjs
import { createClient } from '@libsql/client';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000';
const KEY = process.env.INTERNAL_API_KEY;
const LOBBY = 'ZZLIV';
const A1 = '76561198000000081'; // time A
const A2 = '76561198000000082'; // time A
const B1 = '76561198000000083'; // time B

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let falhas = 0;
const check = (nome, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!cond) falhas++;
};

// O backend cacheia o estado por 2s (10 jogadores fazem polling ao mesmo
// tempo). Como o teste escreve e lê no mesmo instante, espera o cache virar.
const CACHE_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = async (path, { fresco = true } = {}) => {
  if (fresco) await sleep(CACHE_MS + 150);
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Internal-Key': KEY } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

async function cleanup(matchId) {
  const stmts = [
    { sql: 'DELETE FROM lobby_players WHERE code = ?', args: [LOBBY] },
    { sql: 'DELETE FROM lobbies WHERE code = ?', args: [LOBBY] },
    { sql: 'DELETE FROM live_matches WHERE code = ?', args: [LOBBY] },
    { sql: 'DELETE FROM players WHERE steamid IN (?, ?, ?)', args: [A1, A2, B1] },
  ];
  if (matchId) stmts.push({ sql: 'DELETE FROM match_events WHERE match_id = ?', args: [matchId] });
  await db.batch(stmts, 'write');
}

// grava um STATE_SYNC como se viesse do client daquele jogador
const sync = (matchId, steamid, state) => ({
  sql: 'INSERT INTO match_events (match_id, steamid, type, ts, data) VALUES (?, ?, ?, ?, ?)',
  args: [matchId, steamid, 'STATE_SYNC', Date.now(), JSON.stringify(state)],
});

let matchId = null;
try {
  await cleanup();
  const agora = Date.now();
  await db.batch([
    { sql: "INSERT INTO lobbies (code, owner, status, decider_map, created) VALUES (?, ?, 'pronto', 'de_mirage', ?)", args: [LOBBY, A1, agora] },
    { sql: 'INSERT INTO players (steamid, name, elo, created) VALUES (?, ?, 1000, ?)', args: [A1, 'Jogador A1', agora] },
    { sql: 'INSERT INTO players (steamid, name, elo, created) VALUES (?, ?, 1000, ?)', args: [A2, 'Jogador A2', agora] },
    { sql: 'INSERT INTO players (steamid, name, elo, created) VALUES (?, ?, 1000, ?)', args: [B1, 'Jogador B1', agora] },
    { sql: "INSERT INTO lobby_players (code, steamid, team, joined) VALUES (?, ?, 'A', ?)", args: [LOBBY, A1, agora] },
    { sql: "INSERT INTO lobby_players (code, steamid, team, joined) VALUES (?, ?, 'A', ?)", args: [LOBBY, A2, agora] },
    { sql: "INSERT INTO lobby_players (code, steamid, team, joined) VALUES (?, ?, 'B', ?)", args: [LOBBY, B1, agora] },
  ], 'write');

  const start = await fetch(`${BASE}/internal/match/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': KEY },
    body: JSON.stringify({ code: LOBBY }),
  }).then((r) => r.json());
  matchId = start.matchId;
  check('partida criada', Number.isInteger(matchId), `matchId=${matchId}`);

  // Sem nenhum STATE_SYNC ainda: não dá pra traduzir o placar
  const vazio = await get(`/internal/lobby/${LOBBY}/state`);
  check('sem dados → score_a nulo', vazio.status === 200 && vazio.data.score_a === null);
  check('sem dados → roster completo', vazio.data.players?.length === 3);
  check('sem dados → ninguém no jogo', vazio.data.players.every((p) => p.no_jogo === false));
  check('sem dados → nenhum client conectado', vazio.data.players.every((p) => p.client_online === false));

  // Primeiro tempo: time A de CT. Placar CS2 = 9 CT × 3 T → A 9 × 3 B
  await db.batch([
    sync(matchId, A1, { map: 'de_mirage', round: 11, round_phase: 'live', map_phase: 'live', score_ct: 9, score_t: 3,
      player: { steamid: A1, name: 'Jogador A1', team: 'CT', health: 100, kills: 14, deaths: 8, assists: 3, mvps: 2 } }),
    sync(matchId, A2, { map: 'de_mirage', round: 11, round_phase: 'live', map_phase: 'live', score_ct: 9, score_t: 3,
      player: { steamid: A2, name: 'Jogador A2', team: 'CT', health: 0, kills: 7, deaths: 11, assists: 5, mvps: 0 } }),
    sync(matchId, B1, { map: 'de_mirage', round: 11, round_phase: 'live', map_phase: 'live', score_ct: 9, score_t: 3,
      player: { steamid: B1, name: 'Jogador B1', team: 'T', health: 45, kills: 10, deaths: 9, assists: 1, mvps: 1 } }),
  ], 'write');

  const t1 = await get(`/internal/lobby/${LOBBY}/state`);
  check('1º tempo: lado do time A = CT', t1.data.lado_a === 'CT');
  check('1º tempo: placar traduzido A=9 B=3', t1.data.score_a === 9 && t1.data.score_b === 3,
    `A=${t1.data.score_a} B=${t1.data.score_b}`);
  check('mapa e round', t1.data.map === 'de_mirage' && t1.data.round === 11);
  const a1 = t1.data.players.find((p) => p.steamid === A1);
  check('stats do jogador', a1.kills === 14 && a1.deaths === 8 && a1.assists === 3 && a1.side === 'CT');
  const a2 = t1.data.players.find((p) => p.steamid === A2);
  check('jogador morto (health 0)', a2.health === 0);
  check('todos no jogo', t1.data.players.every((p) => p.no_jogo));
  check('ainda não terminou', t1.data.finished === false);

  // Segundo tempo: lados trocados. CS2 diz 11 CT × 13 T, mas agora o time A é T
  // → o placar do time A tem que ser 13, não 11.
  await db.batch([
    sync(matchId, A1, { map: 'de_mirage', round: 23, round_phase: 'live', map_phase: 'live', score_ct: 11, score_t: 13,
      player: { steamid: A1, name: 'Jogador A1', team: 'T', health: 100, kills: 25, deaths: 18, assists: 6, mvps: 4 } }),
    sync(matchId, A2, { map: 'de_mirage', round: 23, round_phase: 'live', map_phase: 'live', score_ct: 11, score_t: 13,
      player: { steamid: A2, name: 'Jogador A2', team: 'T', health: 88, kills: 16, deaths: 20, assists: 8, mvps: 1 } }),
    sync(matchId, B1, { map: 'de_mirage', round: 23, round_phase: 'live', map_phase: 'live', score_ct: 11, score_t: 13,
      player: { steamid: B1, name: 'Jogador B1', team: 'CT', health: 12, kills: 19, deaths: 22, assists: 4, mvps: 2 } }),
  ], 'write');

  const t2 = await get(`/internal/lobby/${LOBBY}/state`);
  check('2º tempo: lado do time A virou T', t2.data.lado_a === 'T');
  check('2º tempo: placar traduzido A=13 B=11', t2.data.score_a === 13 && t2.data.score_b === 11,
    `A=${t2.data.score_a} B=${t2.data.score_b}`);

  // Fim de jogo
  await db.batch([
    { sql: 'INSERT INTO match_events (match_id, steamid, type, ts, data) VALUES (?, ?, ?, ?, ?)',
      args: [matchId, A1, 'GAME_OVER', Date.now(), JSON.stringify({ score_ct: 11, score_t: 13 })] },
  ], 'write');
  const fim = await get(`/internal/lobby/${LOBBY}/state`);
  check('GAME_OVER → finished', fim.data.finished === true);
  check('placar final continua A=13 B=11', fim.data.score_a === 13 && fim.data.score_b === 11);

  // Lobby sem partida → 404 (o site trata como "sem placar ao vivo")
  const semPartida = await get('/internal/lobby/NAOEX/state', { fresco: false });
  check('lobby inexistente → 404', semPartida.status === 404);
} finally {
  await cleanup(matchId);
  console.log(falhas === 0 ? '\n🎉 tudo passou' : `\n💥 ${falhas} falha(s)`);
  process.exit(falhas === 0 ? 0 : 1);
}
