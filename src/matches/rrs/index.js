// matches/rrs/ — Resenha Rating System: quanto de elo cada jogador ganha ou
// perde numa partida.
//
//   timeline.js  eventos crus -> linha do tempo por jogador e por round
//   metricas.js  linha do tempo -> valores brutos (KAST, impacto, entry, trade…)
//   pis.js       brutos -> notas 0–100 -> Player Impact Score
//   elo.js       PIS + resultado -> Δelo
//
// Este arquivo é a fachada e o único que lê o banco. As quatro peças acima
// são puras: recebem dados e devolvem números, o que permite testar o cálculo
// com partidas sintéticas sem escrever nada em produção.
//
// A regra que sustenta o resto: 60% do elo vem do resultado da partida e 40%
// do desempenho individual. Vitória sempre soma, derrota sempre subtrai;
// desempenho excepcional numa derrota reduz a perda, nunca a inverte.
import { db } from '../../db.js';
import { montarTimeline } from './timeline.js';
import { calcularBrutos } from './metricas.js';
import { calcularPIS, ehAFK } from './pis.js';
import { calcularDelta, fatorDeDesempenho, kDoFormato, aplicarTetoDiario, CONSTANTES } from './elo.js';

/**
 * Calcula a variação de elo de todos os jogadores de uma partida encerrada.
 *
 * Não escreve nada: quem grava é o scoring.js, numa transação só.
 *
 * @param matchId  id da live_match
 * @param roster   [{ steamid, team }] do lobby (só quem tem time definido)
 * @param vencedor 'A' ou 'B'
 * @returns {{ jogadores: Array, roundsJogados: number, cobertura: number, habilitadas: string[] }}
 */
export async function calcularRRS(matchId, { roster, vencedor }) {
  const eventos = await db.prepare(
    'SELECT steamid, type, ts, data FROM match_events WHERE match_id = ?'
  ).all(matchId);

  const timeline = montarTimeline(eventos);
  const { brutos, detalhes, avaliados, habilitadas, cobertura, roundsPorJogador, roundsJogados, confianca } =
    calcularBrutos(timeline, roster);

  // Partida curta demais não vale desempenho: a média por round de 3 rounds
  // não diz nada. O resultado continua valendo (quem chamou já checou que a
  // partida tem vencedor).
  const contaDesempenho = roundsJogados >= CONSTANTES.MIN_ROUNDS_PARTIDA;

  const afks = new Set(avaliados.filter((s) => ehAFK(timeline.jogadores.get(s))));
  const comparaveis = avaliados.filter((s) => !afks.has(s));

  const pontuacoes = contaDesempenho
    ? calcularPIS({ brutos, avaliados: comparaveis, habilitadas, n: roster.length })
    : new Map();

  const k = kDoFormato(roster.length);
  const ganhosHoje = await ganhoLiquidoDeHoje(roster.map((p) => p.steamid));

  const jogadores = roster.map((p) => {
    const pontuacao = pontuacoes.get(p.steamid);
    const pis = afks.has(p.steamid) && contaDesempenho && habilitadas.size > 0
      ? 0
      : (pontuacao?.pis ?? null);
    // A confiança encolhe o desempenho quando só deu para medir métrica de
    // abate (ver metricas.js). O q gravado é o que foi de fato aplicado.
    const q = fatorDeDesempenho(pis) * confianca;
    const venceu = p.team === vencedor;
    const bruto = calcularDelta({ venceu, k, q });

    return {
      steamid: p.steamid,
      team: p.team,
      pis,
      q,
      delta: aplicarTetoDiario(bruto, ganhosHoje.get(p.steamid) ?? 0),
      deltaSemTeto: bruto,
      rounds: roundsPorJogador.get(p.steamid) ?? 0,
      stats: detalhes.get(p.steamid) ?? null,
      notas: pontuacao?.notas ?? null,
    };
  });

  return {
    jogadores,
    k,
    roundsJogados,
    cobertura,
    confianca,
    contaDesempenho,
    habilitadas: [...habilitadas],
  };
}

/**
 * Quanto cada jogador já ganhou de elo hoje, para o teto diário. Só o saldo
 * positivo importa — derrota nunca é limitada.
 */
async function ganhoLiquidoDeHoje(steamids) {
  const total = new Map();
  if (steamids.length === 0) return total;

  const inicioDoDia = new Date();
  inicioDoDia.setHours(0, 0, 0, 0);

  const marcadores = steamids.map(() => '?').join(', ');
  const linhas = await db.prepare(
    `SELECT steamid, SUM(delta_elo) AS ganho FROM match_player_stats
     WHERE created >= ? AND steamid IN (${marcadores}) GROUP BY steamid`
  ).all(inicioDoDia.getTime(), ...steamids);

  for (const l of linhas) total.set(l.steamid, Number(l.ganho) || 0);
  return total;
}
