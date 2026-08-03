// matches/scoring.js — registro automático do placar: a única parte do
// sistema que mexe em elo, vitórias/derrotas e no histórico de partidas.
//
// Quanto cada jogador ganha ou perde é decidido pelo RRS (matches/rrs/):
// 60% resultado da partida, 40% desempenho individual. Aqui só se decide SE
// registra, e se escreve o resultado.
import { db } from '../db.js';
import { buildLiveState } from './live-state.js';
import { endMatch } from './lifecycle.js';
import { calcularRRS } from './rrs/index.js';
import { log } from '../log.js';

// Só um lobby 'pronto' pode virar 'finalizado'. A condição vai DENTRO de cada
// statement do batch (transação), o que resolve a corrida dos até 10 clients
// mandando GAME_OVER quase juntos: o primeiro registra, os outros viram no-op.
const GUARDA = "(SELECT status FROM lobbies WHERE code = ?) = 'pronto'";

// Registro em andamento por partida. Os até 10 clients mandam GAME_OVER
// quase juntos, e cada um dispararia o cálculo inteiro — ler todos os eventos
// da partida (milhares) e montar as métricas, dez vezes, para nove resultados
// jogados fora. Aqui o primeiro faz o trabalho e os outros esperam o mesmo
// resultado. Mesma ideia do cache de promessa do liveState.
//
// A entrada sai do mapa quando a promessa termina, então a varredura continua
// podendo tentar de novo mais tarde — isso é deduplicação do que está em voo,
// não cache de resultado.
const emAndamento = new Map();

/**
 * Registra o placar de uma partida encerrada. Chamado no GAME_OVER e como
 * retry pela varredura. Sai sem fazer nada (retornando false) se a partida
 * ainda não acabou, se já foi registrada ou se o placar não é conclusivo.
 *
 * Retorna true se ESTA chamada registrou — ou se ela pegou carona no registro
 * que já estava em voo para a mesma partida.
 */
export function registrarPlacar(matchId) {
  const emVoo = emAndamento.get(matchId);
  if (emVoo) return emVoo;

  const promessa = registrarAgora(matchId).finally(() => emAndamento.delete(matchId));
  emAndamento.set(matchId, promessa);
  return promessa;
}

async function registrarAgora(matchId) {
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
  const roster = teams.filter((t) => t.team);

  const rrs = await calcularRRS(matchId, { roster, vencedor: winner });
  const resultados = await db.batch(
    montaBatch({ matchId, code, live, lobby, teams, winner, rrs })
  );

  // rowsAffected do UPDATE final diz se ESTE chamador ganhou a corrida.
  const registrou = Number(resultados[resultados.length - 1]?.rowsAffected ?? 0) > 0;
  if (registrou) {
    log(`placar registrado automaticamente: ${code} ${live.score_a}x${live.score_b} (vencedor: time ${winner})`);
    log(`RRS #${matchId}: K=${rrs.k}, ${rrs.roundsJogados} rounds, cobertura ${Math.round(rrs.cobertura * 100)}%`
      + `, métricas [${rrs.habilitadas.join(' ')}]`
      + `${rrs.confianca < 1 ? ` (desempenho a ${rrs.confianca * 100}%)` : ''}`
      + `${rrs.contaDesempenho ? '' : ' — partida curta, só resultado'}`);
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
function montaBatch({ matchId, code, live, lobby, teams, winner, rrs }) {
  const agora = Date.now();

  const statements = rrs.jogadores.map((j) => ({
    sql: `UPDATE players SET elo = MAX(0, elo + ?), wins = wins + ?, losses = losses + ?
      WHERE steamid = ? AND ${GUARDA}`,
    // MAX(0, ...): elo nunca fica negativo.
    args: [j.delta, j.team === winner ? 1 : 0, j.team === winner ? 0 : 1, j.steamid, code],
  }));

  // A abertura do cálculo fica gravada: sem ela, ninguém consegue explicar
  // depois por que um jogador levou +19 e o companheiro +13.
  // OR IGNORE + índice único: um retry da varredura não duplica a linha.
  for (const j of rrs.jogadores) {
    statements.push({
      sql: `INSERT OR IGNORE INTO match_player_stats
        (match_id, code, steamid, rounds, kills, assists, deaths, kast_rounds,
         ek, ed, tk, clutch_pts, mvps, plants, defuses, pis, q, delta_elo, metricas, created)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${GUARDA}`,
      args: [
        matchId, code, j.steamid, j.rounds,
        j.stats?.kills ?? 0, j.stats?.assists ?? 0, j.stats?.deaths ?? 0,
        j.stats?.kastRounds ?? 0,
        j.stats?.ek ?? 0, j.stats?.ed ?? 0, j.stats?.tk ?? 0, j.stats?.clutchPts ?? 0,
        j.stats?.mvps ?? 0, j.stats?.plants ?? 0, j.stats?.defuses ?? 0,
        j.pis, j.q, j.delta, j.notas ? JSON.stringify(j.notas) : null, agora, code,
      ],
    });
  }

  statements.push({
    sql: `INSERT INTO matches (code, map, score_a, score_b, winner, teams_json, played_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${GUARDA}`,
    args: [code, live.map ?? lobby.decider_map, live.score_a, live.score_b, winner,
      JSON.stringify(teams), agora, code],
  });

  // Por último: virar o status é o que desarma a guarda dos concorrentes.
  statements.push({
    sql: "UPDATE lobbies SET status = 'finalizado' WHERE code = ? AND status = 'pronto'",
    args: [code],
  });

  return statements;
}
