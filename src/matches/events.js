// matches/events.js — porta de entrada dos eventos que os clients mandam.
// Valida, grava e dispara o registro automático no fim do jogo.
import { db } from '../db.js';
import { activeMatchFor, resync } from './lifecycle.js';
import { registrarPlacar } from './scoring.js';
import { log } from '../log.js';

// Tipos que o Resenha Client emite (events.rs) — qualquer outro é descartado.
const EVENT_TYPES = new Set([
  'MAP_CHANGE', 'MAP_PHASE', 'FREEZETIME', 'ROUND_START', 'ROUND_END',
  'SCORE_UPDATE', 'BOMB_PLANTED', 'BOMB_DEFUSED', 'BOMB_EXPLODED',
  'PLAYER_KILL', 'PLAYER_ASSIST', 'PLAYER_MVP', 'PLAYER_DEAD', 'PLAYER_ALIVE',
  'WEAPON_CHANGE', 'PLAYER_TEAM', 'GAME_OVER', 'STATE_SYNC',
]);

// Um STATE_SYNC tem ~1 KB; o teto evita que um client incharia o banco.
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

  // Fim de jogo detectado no CS2 → registra o placar sozinho. Se falhar aqui
  // (erro transitório), a varredura tenta de novo — nada de perder o registro.
  if (msg.type === 'GAME_OVER') {
    try {
      await registrarPlacar(expected);
    } catch (e) {
      log(`registro automático da partida #${expected} falhou (varredura vai tentar de novo):`, e.message);
    }
  }
}
