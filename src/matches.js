// matches.js — Match Management: liga/desliga a coleta nos clients e guarda
// os eventos. O site avisa aqui (rotas /internal) quando o lobby fica pronto
// (veto encerrado) e quando o placar é registrado.
import { db } from './db.js';
import { HttpError } from './auth.js';
import { sendTo } from './ws.js';
import { log } from './log.js';

// Cache steamid -> matchId ativo (null = sabidamente sem partida).
// Reconstruído do banco sob demanda, então sobrevive a restart do servidor.
const activeBySteamid = new Map();

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

/** matchId ativo de um jogador (cache → banco). */
async function activeMatchFor(steamid) {
  if (activeBySteamid.has(steamid)) return activeBySteamid.get(steamid);
  const row = await db.prepare(`
    SELECT lm.id FROM live_matches lm
    JOIN lobby_players lp ON lp.code = lm.code
    WHERE lm.status = 'ativa' AND lp.steamid = ?
    ORDER BY lm.id DESC LIMIT 1`
  ).get(steamid);
  const matchId = row ? Number(row.id) : null;
  activeBySteamid.set(steamid, matchId);
  return matchId;
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

/** GET /internal/match/:id/state — placar/stats ao vivo (último STATE_SYNC de cada jogador). */
export async function liveState(matchId) {
  const match = await db.prepare('SELECT * FROM live_matches WHERE id = ?').get(matchId);
  if (!match) throw new HttpError(404, 'Partida não encontrada.');
  const rows = await db.prepare(`
    SELECT steamid, data, MAX(ts) AS ts FROM match_events
    WHERE match_id = ? AND type = 'STATE_SYNC'
    GROUP BY steamid`
  ).all(matchId);
  return {
    match,
    players: rows.map((r) => ({ steamid: r.steamid, ts: r.ts, state: JSON.parse(r.data) })),
  };
}
