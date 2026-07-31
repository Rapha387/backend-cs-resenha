// matches/scoring.js — registro automático do placar: a única parte do
// sistema que mexe em elo, vitórias/derrotas e no histórico de partidas.
import { db } from '../db.js';
import { buildLiveState } from './live-state.js';
import { endMatch } from './lifecycle.js';
import { log } from '../log.js';

// Quanto de elo troca de mãos por partida (mesmo K do registro manual antigo).
const K_ELO = 25;

// Só um lobby 'pronto' pode virar 'finalizado'. A condição vai DENTRO de cada
// statement do batch (transação), o que resolve a corrida dos até 10 clients
// mandando GAME_OVER quase juntos: o primeiro registra, os outros viram no-op.
const GUARDA = "(SELECT status FROM lobbies WHERE code = ?) = 'pronto'";

/**
 * Registra o placar de uma partida encerrada. Chamado no GAME_OVER e como
 * retry pela varredura. Sai sem fazer nada (retornando false) se a partida
 * ainda não acabou, se já foi registrada ou se o placar não é conclusivo.
 *
 * Retorna true só pra quem efetivamente registrou.
 */
export async function registrarPlacar(matchId) {
  // Sem o cache do liveState: precisa enxergar o GAME_OVER recém-gravado.
  const live = await buildLiveState(matchId);
  if (!live.finished) return false;

  const code = live.match.code;
  const lobby = await db.prepare('SELECT * FROM lobbies WHERE code = ?').get(code);
  if (!lobby || lobby.status !== 'pronto') return false; // já registrado

  const motivo = motivoParaNaoRegistrar(live);
  if (motivo) {
    log(`partida #${matchId} (${code}) não registrada: ${motivo}`);
    return false;
  }

  const winner = live.score_a > live.score_b ? 'A' : 'B';
  const teams = await db.prepare('SELECT steamid, team FROM lobby_players WHERE code = ?').all(code);
  const resultados = await db.batch(
    montaBatch({ code, live, lobby, teams, winner })
  );

  // rowsAffected do UPDATE final diz se ESTE chamador ganhou a corrida.
  const registrou = Number(resultados[resultados.length - 1]?.rowsAffected ?? 0) > 0;
  if (registrou) {
    log(`placar registrado automaticamente: ${code} ${live.score_a}x${live.score_b} (vencedor: time ${winner})`);
    await endMatch({ code }); // encerra a coleta e manda END_MATCH pros clients
  }
  return registrou;
}

/** Por que este placar não pode virar resultado? null = pode. */
function motivoParaNaoRegistrar(live) {
  if (live.score_a === null || live.score_b === null) {
    // Sem voto de lado (ninguém com client reportando team) não dá pra saber
    // qual placar é de quem. A varredura tenta de novo; se nunca resolver,
    // a partida cai na rede de segurança de 4h.
    return 'placar do CS2 não pôde ser traduzido pros times A/B';
  }
  if (live.score_a === live.score_b) {
    return `terminou empatada (${live.score_a}x${live.score_b}) — empate não vale`;
  }
  return null;
}

/** Elo de cada jogador + histórico + fechamento do lobby, tudo condicionado. */
function montaBatch({ code, live, lobby, teams, winner }) {
  const statements = teams
    .filter((t) => t.team)
    .map((t) => ({
      sql: `UPDATE players SET elo = MAX(0, elo + ?), wins = wins + ?, losses = losses + ?
        WHERE steamid = ? AND ${GUARDA}`,
      // MAX(0, ...): elo nunca fica negativo.
      args: t.team === winner ? [K_ELO, 1, 0, t.steamid, code] : [-K_ELO, 0, 1, t.steamid, code],
    }));

  statements.push({
    sql: `INSERT INTO matches (code, map, score_a, score_b, winner, teams_json, played_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${GUARDA}`,
    args: [code, live.map ?? lobby.decider_map, live.score_a, live.score_b, winner,
      JSON.stringify(teams), Date.now(), code],
  });

  // Por último: virar o status é o que desarma a guarda dos concorrentes.
  statements.push({
    sql: "UPDATE lobbies SET status = 'finalizado' WHERE code = ? AND status = 'pronto'",
    args: [code],
  });

  return statements;
}
