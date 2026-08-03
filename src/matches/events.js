// matches/events.js — porta de entrada dos eventos que os clients mandam.
// Valida, grava e dispara o registro automático no fim do jogo.
import { db } from '../db.js';
import { activeMatchFor, resync } from './lifecycle.js';
import { registrarPlacar } from './scoring.js';
import { log } from '../log.js';

// Tipos que alguém realmente lê: o placar ao vivo (live-state.js) e o cálculo
// do elo (rrs/timeline.js). Só estes viram linha em match_events.
const EVENT_TYPES = new Set([
  'FREEZETIME', 'ROUND_START', 'ROUND_END',
  'BOMB_PLANTED', 'BOMB_DEFUSED',
  'PLAYER_KILL', 'PLAYER_ASSIST', 'PLAYER_MVP', 'PLAYER_DEAD',
  'WEAPON_CHANGE', 'GAME_OVER', 'STATE_SYNC',
]);

// O client emite estes, e ninguém consome. Ficam aceitos e descartados em
// silêncio: não são erro (o client manda mais do que a gente usa hoje), então
// não podem virar log por evento. Se algum dia alguém precisar, é só sair
// desta lista — a informação toda já existe no STATE_SYNC.
const IGNORADOS = new Set([
  'MAP_CHANGE', 'MAP_PHASE', 'SCORE_UPDATE', 'PLAYER_ALIVE', 'PLAYER_TEAM',
  'BOMB_EXPLODED',
]);

// A única troca de arma que interessa é a C4 na mão, que é como o plant é
// atribuído. Em 7 partidas reais, WEAPON_CHANGE foi 62% das linhas da tabela
// e só 3,9% delas eram a C4 — o resto era faca, rifle e pistola.
const armaDescartavel = (msg) =>
  msg.type === 'WEAPON_CHANGE' && msg.data?.weapon !== 'weapon_c4';

// Um STATE_SYNC tem ~1 KB; o teto evita que um client incharia o banco.
const MAX_DATA_LEN = 32_000;

/** Evento de partida vindo de um client (ROUND_END, PLAYER_KILL, STATE_SYNC…). */
export async function handleClientEvent(steamid, msg) {
  // O descarte vem ANTES da checagem de matchId de propósito. Um client
  // dessincronizado que mandasse mil trocas de arma geraria mil linhas de log
  // e mil resyncs. O preço é o resync desses eventos não sair na hora — mas
  // ele sai no STATE_SYNC seguinte (10s) e em todo HELLO, então o desvio dura
  // segundos, não a partida.
  if (IGNORADOS.has(msg.type) || armaDescartavel(msg)) return;

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
