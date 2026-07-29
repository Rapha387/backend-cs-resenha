// matches.js — Match Management: liga/desliga a coleta nos clients e guarda
// os eventos. O site avisa aqui (rotas /internal) quando o lobby fica pronto
// (veto encerrado) e quando o placar é registrado.
import { db } from './db.js';
import { HttpError } from './auth.js';
import { sendTo, isConnected } from './ws.js';
import { log } from './log.js';

// Cache steamid -> matchId ativo (null = sabidamente sem partida).
// Reconstruído do banco sob demanda, então sobrevive a restart do servidor.
const activeBySteamid = new Map();

// Uma partida de CS2 não passa de ~1h30. Depois disso a partida é considerada
// abandonada: se o END_MATCH se perdeu (site sem internet na hora de registrar
// o placar, por exemplo), o client não pode ficar coletando pra sempre — ele
// acabaria mandando eventos de Premier/Casual, que é justamente o que a
// plataforma promete não monitorar.
const MAX_DURACAO_MS = 4 * 60 * 60 * 1000;

async function lobbyPlayers(code) {
  return db.prepare('SELECT steamid FROM lobby_players WHERE code = ?').all(code);
}

/** POST /internal/match/start { code } — site avisa que o veto terminou. */
export async function startMatch(body) {
  const code = String(body?.code ?? '').trim().toUpperCase();
  if (!code) throw new HttpError(400, 'Informe o code do lobby.');

  const lobby = await db.prepare('SELECT * FROM lobbies WHERE code = ?').get(code);
  if (!lobby) throw new HttpError(404, 'Lobby não encontrado.');

  // Idempotente: reaproveita a partida ativa se o site avisar duas vezes.
  let match = await db.prepare("SELECT id FROM live_matches WHERE code = ? AND status = 'ativa'").get(code);
  if (!match) {
    const rs = await db.prepare('INSERT INTO live_matches (code, status, started) VALUES (?, ?, ?)')
      .run(code, 'ativa', Date.now());
    match = { id: Number(rs.lastInsertRowid) };
  }

  const players = await lobbyPlayers(code);
  let notified = 0;
  for (const p of players) {
    activeBySteamid.set(p.steamid, match.id);
    notified += sendTo(p.steamid, { type: 'START_MATCH', matchId: match.id }) > 0 ? 1 : 0;
  }
  log(`START_MATCH #${match.id} (lobby ${code}): ${notified}/${players.length} clients online`);
  return { matchId: match.id, players: players.length, notified };
}

/** POST /internal/match/end { code } — site avisa que o placar foi registrado. */
export async function endMatch(body) {
  const code = String(body?.code ?? '').trim().toUpperCase();
  if (!code) throw new HttpError(400, 'Informe o code do lobby.');

  const match = await db.prepare("SELECT id FROM live_matches WHERE code = ? AND status = 'ativa'").get(code);
  if (!match) return { ok: true, matchId: null }; // nada ativo: idempotente

  await db.prepare("UPDATE live_matches SET status = 'encerrada', ended = ? WHERE id = ?")
    .run(Date.now(), match.id);

  const players = await lobbyPlayers(code);
  let notified = 0;
  for (const p of players) {
    activeBySteamid.set(p.steamid, null);
    notified += sendTo(p.steamid, { type: 'END_MATCH' }) > 0 ? 1 : 0;
  }
  log(`END_MATCH #${match.id} (lobby ${code}): ${notified}/${players.length} clients online`);
  return { ok: true, matchId: match.id, notified };
}

/** matchId ativo de um jogador (cache → banco), ignorando partidas velhas. */
async function activeMatchFor(steamid) {
  if (activeBySteamid.has(steamid)) return activeBySteamid.get(steamid);
  const row = await db.prepare(`
    SELECT lm.id FROM live_matches lm
    JOIN lobby_players lp ON lp.code = lm.code
    WHERE lm.status = 'ativa' AND lp.steamid = ? AND lm.started > ?
    ORDER BY lm.id DESC LIMIT 1`
  ).get(steamid, Date.now() - MAX_DURACAO_MS);
  const matchId = row ? Number(row.id) : null;
  activeBySteamid.set(steamid, matchId);
  return matchId;
}

/**
 * Encerra partidas esquecidas (END_MATCH perdido) e manda os clients pararem
 * a coleta. Roda no boot e de hora em hora.
 */
export async function encerrarPartidasAbandonadas() {
  // Caso 1 — END_MATCH perdido na hibernação: o placar já foi registrado no
  // site (lobby 'finalizado'), mas o /internal/match/end não chegou porque o
  // backend estava dormindo (plano free do Render) e o cold start estourou o
  // timeout do site. Como o banco é compartilhado, dá pra detectar por aqui.
  // A varredura roda no boot — ou seja, TODA acordada do backend recupera
  // esses casos sem esperar a rede de segurança de 4h.
  const perdidas = await db.prepare(`
    SELECT lm.id, lm.code FROM live_matches lm
    JOIN lobbies l ON l.code = lm.code
    WHERE lm.status = 'ativa' AND l.status = 'finalizado'`).all();
  if (perdidas.length > 0) {
    await db.batch(perdidas.map((m) => ({
      sql: "UPDATE live_matches SET status = 'encerrada', ended = ? WHERE id = ?",
      args: [Date.now(), m.id],
    })));
    for (const m of perdidas) {
      for (const p of await lobbyPlayers(m.code)) {
        activeBySteamid.set(p.steamid, null);
        sendTo(p.steamid, { type: 'END_MATCH' });
      }
    }
    log(`${perdidas.length} partida(s) com END_MATCH perdido encerrada(s): ${perdidas.map((m) => m.code).join(', ')}`);
  }

  // Caso 2 — partida sem placar registrado que passou do tempo máximo.
  const limite = Date.now() - MAX_DURACAO_MS;
  const velhas = await db.prepare(
    "SELECT id, code FROM live_matches WHERE status = 'ativa' AND started <= ?"
  ).all(limite);
  if (velhas.length === 0) return perdidas.length;

  await db.batch(velhas.map((m) => ({
    sql: "UPDATE live_matches SET status = 'abandonada', ended = ? WHERE id = ?",
    args: [Date.now(), m.id],
  })));

  for (const m of velhas) {
    for (const p of await lobbyPlayers(m.code)) {
      activeBySteamid.set(p.steamid, null);
      sendTo(p.steamid, { type: 'END_MATCH' });
    }
  }
  log(`${velhas.length} partida(s) abandonada(s) encerrada(s): ${velhas.map((m) => m.code).join(', ')}`);
  return perdidas.length + velhas.length;
}

/** Contrato do client: após o HELLO, reenviamos o estado atual. */
export async function resync(steamid) {
  const matchId = await activeMatchFor(steamid);
  if (matchId) {
    sendTo(steamid, { type: 'START_MATCH', matchId });
    log(`resync ${steamid}: partida #${matchId} ativa`);
  } else {
    sendTo(steamid, { type: 'END_MATCH' });
  }
}

// Tipos que o Resenha Client emite (events.rs) — qualquer outro é descartado.
const EVENT_TYPES = new Set([
  'MAP_CHANGE', 'MAP_PHASE', 'FREEZETIME', 'ROUND_START', 'ROUND_END',
  'SCORE_UPDATE', 'BOMB_PLANTED', 'BOMB_DEFUSED', 'BOMB_EXPLODED',
  'PLAYER_KILL', 'PLAYER_ASSIST', 'PLAYER_MVP', 'PLAYER_DEAD', 'PLAYER_ALIVE',
  'WEAPON_CHANGE', 'PLAYER_TEAM', 'GAME_OVER', 'STATE_SYNC',
]);
const MAX_DATA_LEN = 32_000;

/** Evento de partida vindo de um client (ROUND_END, PLAYER_KILL, STATE_SYNC…). */
export async function handleClientEvent(steamid, msg) {
  if (!EVENT_TYPES.has(msg.type)) {
    log(`evento de tipo desconhecido de ${steamid}: ${String(msg.type).slice(0, 40)} — descartado`);
    return;
  }
  const expected = await activeMatchFor(steamid);
  if (!expected || Number(msg.matchId) !== expected) {
    // Client dessincronizado (perdeu o END_MATCH?) — corrige na hora.
    log(`evento ${msg.type} de ${steamid} com matchId ${msg.matchId}, esperado ${expected} — resync`);
    await resync(steamid);
    return;
  }
  const data = JSON.stringify(msg.data ?? null);
  if (data.length > MAX_DATA_LEN) {
    log(`evento ${msg.type} de ${steamid} grande demais (${data.length} bytes) — descartado`);
    return;
  }
  await db.prepare('INSERT INTO match_events (match_id, steamid, type, ts, data) VALUES (?, ?, ?, ?, ?)')
    .run(expected, steamid, msg.type, Number(msg.timestamp) || Date.now(), data);
}

const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

// Os 10 jogadores do lobby ficam consultando o placar ao mesmo tempo; sem
// cache seriam ~200 queries/min no Turso pra dados que mudam a cada 10s
// (intervalo do STATE_SYNC). 2s de cache derruba isso pra ~30/min.
const CACHE_MS = 2000;
const cache = new Map(); // matchId -> { at, promise }

/**
 * GET /internal/match/:id/state e /internal/lobby/:code/state
 *
 * Junta o último STATE_SYNC de cada jogador com os times do lobby (A/B) e
 * traduz o placar CT/T do CS2 pros times da plataforma. A tradução é
 * necessária porque os lados trocam no halftime: descobrimos de que lado
 * cada time está pelo `player.team` que os próprios clients reportam.
 */
export async function liveState(matchId) {
  const hit = cache.get(matchId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;

  const promise = buildLiveState(matchId).catch((e) => {
    cache.delete(matchId); // erro não fica cacheado
    throw e;
  });
  cache.set(matchId, { at: Date.now(), promise });
  if (cache.size > 200) {
    for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  }
  return promise;
}

async function buildLiveState(matchId) {
  const match = await db.prepare('SELECT * FROM live_matches WHERE id = ?').get(matchId);
  if (!match) throw new HttpError(404, 'Partida não encontrada.');

  const [syncs, ownSyncs, roster, over] = await Promise.all([
    db.prepare(`
      SELECT steamid, data, MAX(ts) AS ts FROM match_events
      WHERE match_id = ? AND type = 'STATE_SYNC' GROUP BY steamid`).all(matchId),
    // Quando a pessoa morre e passa a assistir um colega, o GSI troca o bloco
    // "player" pelo jogador OBSERVADO — e o client manda player:null, porque
    // aquelas stats não são dela (events.rs). Esses syncs são ~20% do total.
    // Se o K/D/A saísse do sync mais recente, ele sumiria da tela a cada morte
    // ("fora do jogo") e só voltaria no respawn. Por isso as stats de cada um
    // vêm do último sync em que o bloco "player" era dele mesmo.
    db.prepare(`
      SELECT steamid, data, MAX(ts) AS ts FROM match_events
      WHERE match_id = ? AND type = 'STATE_SYNC'
        AND json_extract(data, '$.player') IS NOT NULL
      GROUP BY steamid`).all(matchId),
    db.prepare(`
      SELECT lp.steamid, lp.team, p.name, p.avatar
      FROM lobby_players lp LEFT JOIN players p ON p.steamid = lp.steamid
      WHERE lp.code = ?`).all(match.code),
    db.prepare(`
      SELECT data, ts FROM match_events
      WHERE match_id = ? AND type = 'GAME_OVER' ORDER BY ts DESC LIMIT 1`).get(matchId),
  ]);

  const syncByPlayer = new Map(syncs.map((r) => [r.steamid, { ts: r.ts, state: parse(r.data) }]));
  const ownByPlayer = new Map(ownSyncs.map((r) => [r.steamid, { ts: r.ts, state: parse(r.data) }]));

  // Contexto global: o STATE_SYNC mais recente (todos veem o mesmo placar).
  let latest = null;
  for (const { ts, state } of syncByPlayer.values()) {
    if (state && (!latest || ts > latest.ts)) latest = { ts, state };
  }
  const g = latest?.state ?? {};

  const players = roster.map((p) => {
    const sync = syncByPlayer.get(p.steamid);
    const own = ownByPlayer.get(p.steamid);
    const ps = own?.state?.player ?? null;
    // O sync mais recente veio sem bloco próprio, mas já houve um antes: a
    // pessoa está assistindo um colega, ou seja, morta neste round. O health
    // do sync antigo é de quando ela ainda estava viva — não vale mais.
    const espectando = Boolean(ps) && Boolean(sync?.state) && !sync.state.player;
    return {
      steamid: p.steamid,
      name: p.name,
      avatar: p.avatar,
      team: p.team,                          // A / B (plataforma)
      side: ps?.team ?? null,                // CT / T (CS2)
      // Dois estados diferentes e igualmente úteis: se o app desktop está
      // conectado (senão a pessoa esqueceu de abrir) e se o CS2 já mandou
      // dados (senão ela ainda não entrou na partida).
      client_online: isConnected(p.steamid),
      no_jogo: Boolean(ps),
      health: espectando ? 0 : (ps?.health ?? null),
      kills: ps?.kills ?? null,
      deaths: ps?.deaths ?? null,
      assists: ps?.assists ?? null,
      mvps: ps?.mvps ?? null,
      updated: sync?.ts ?? null,
    };
  });

  // De que lado está o time A? Voto da maioria dos jogadores que reportaram
  // (empate ou ninguém reportando → não dá pra traduzir o placar).
  const votos = { CT: 0, T: 0 };
  for (const p of players) {
    if (!p.side || !p.team) continue;
    // Time B no lado X significa time A no lado oposto.
    const ladoDoA = p.team === 'A' ? p.side : (p.side === 'CT' ? 'T' : 'CT');
    if (ladoDoA === 'CT' || ladoDoA === 'T') votos[ladoDoA]++;
  }
  const ladoA = votos.CT === votos.T ? null : (votos.CT > votos.T ? 'CT' : 'T');

  const scoreCt = g.score_ct ?? null;
  const scoreT = g.score_t ?? null;
  const temPlacar = ladoA !== null && scoreCt !== null && scoreT !== null;

  return {
    match,
    finished: Boolean(over) || g.map_phase === 'gameover',
    map: g.map ?? null,
    round: g.round ?? null,
    round_phase: g.round_phase ?? null,
    map_phase: g.map_phase ?? null,
    score_ct: scoreCt,
    score_t: scoreT,
    lado_a: ladoA,
    score_a: temPlacar ? (ladoA === 'CT' ? scoreCt : scoreT) : null,
    score_b: temPlacar ? (ladoA === 'CT' ? scoreT : scoreCt) : null,
    updated: latest?.ts ?? null,
    players,
  };
}

/** Estado ao vivo pelo código do lobby (o site só conhece o code). */
export async function liveStateByCode(code) {
  const match = await db.prepare(
    'SELECT id FROM live_matches WHERE code = ? ORDER BY id DESC LIMIT 1'
  ).get(String(code).toUpperCase());
  if (!match) throw new HttpError(404, 'Nenhuma partida para esse lobby.');
  return liveState(match.id);
}
