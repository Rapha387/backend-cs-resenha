// matches/lifecycle.js — ciclo de vida da partida: liga e desliga a coleta
// nos clients. É a única parte que decide se um jogador está coletando agora.
import { db } from '../db.js';
import { HttpError } from '../auth.js';
import { sendTo } from '../ws/registry.js';
import { log } from '../log.js';

// Cache steamid -> matchId ativo (null = sabidamente sem partida).
// Reconstruído do banco sob demanda, então sobrevive a restart do servidor.
const activeBySteamid = new Map();

// Uma partida de CS2 não passa de ~1h30. Depois disso a partida é considerada
// abandonada: se o END_MATCH se perdeu (site sem internet na hora de registrar
// o placar, por exemplo), o client não pode ficar coletando pra sempre — ele
// acabaria mandando eventos de Premier/Casual, que é justamente o que a
// plataforma promete não monitorar.
export const MAX_DURACAO_MS = 4 * 60 * 60 * 1000;

async function lobbyPlayers(code) {
  return db.prepare('SELECT steamid FROM lobby_players WHERE code = ?').all(code);
}

/**
 * Esquece o matchId ativo de todos os jogadores do lobby e manda parar.
 * Devolve { avisados, total } — quantos clients estavam de pé pra receber.
 */
export async function pararColeta(code) {
  const players = await lobbyPlayers(code);
  let avisados = 0;
  for (const p of players) {
    activeBySteamid.set(p.steamid, null);
    if (sendTo(p.steamid, { type: 'END_MATCH' }) > 0) avisados++;
  }
  return { avisados, total: players.length };
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

/** POST /internal/match/end { code } — encerra a coleta da partida do lobby. */
export async function endMatch(body) {
  const code = String(body?.code ?? '').trim().toUpperCase();
  if (!code) throw new HttpError(400, 'Informe o code do lobby.');

  const match = await db.prepare("SELECT id FROM live_matches WHERE code = ? AND status = 'ativa'").get(code);
  if (!match) return { ok: true, matchId: null }; // nada ativo: idempotente

  await db.prepare("UPDATE live_matches SET status = 'encerrada', ended = ? WHERE id = ?")
    .run(Date.now(), match.id);

  const { avisados, total } = await pararColeta(code);
  log(`END_MATCH #${match.id} (lobby ${code}): ${avisados}/${total} clients online`);
  return { ok: true, matchId: match.id, notified: avisados };
}

/** matchId ativo de um jogador (cache → banco), ignorando partidas velhas. */
export async function activeMatchFor(steamid) {
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
