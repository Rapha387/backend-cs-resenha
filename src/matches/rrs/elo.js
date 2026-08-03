// matches/rrs/elo.js — do Player Impact Score para a variação de elo.
//
// Δelo = s · 0,60·K + 0,40·K · q
//
// O componente de resultado (0,60·K) é maior que o de desempenho (0,40·K), e
// é isso que garante — por aritmética, não por checagem — que derrota nunca
// vira ganho: o termo de desempenho não tem amplitude para cruzar o zero.

const PESO_RESULTADO = 0.60;
const PESO_DESEMPENHO = 0.40;

// Amplitude máxima por formato. Cresce com o tamanho da partida: num 2x2 o
// resultado depende de duas pessoas e diz menos sobre quem é melhor, então o
// elo se move menos. O 5x5 mantém os ±25 do sistema antigo — a escala do
// ranking não infla nem encolhe com a adoção do RRS.
const K_POR_JOGADORES = [
  { minimo: 10, k: 25 },
  { minimo: 8, k: 22 },
  { minimo: 6, k: 20 },
  { minimo: 0, k: 15 },
];

// Uma partida de CS2 no MR12 termina com pelo menos 13 rounds. Menos que isso
// é partida criada e encerrada em dois rounds — não vale elo.
const MIN_ROUNDS_PARTIDA = 13;

// Ganho líquido máximo por jogador por dia. Seis vitórias com desempenho
// máximo já encostam no limite, bem acima de uma resenha típica: o teto é
// invisível no uso normal e barra maratona combinada.
const TETO_DIARIO = 150;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** K do formato. Vale para qualquer número de jogadores, inclusive ímpar. */
export function kDoFormato(n) {
  return K_POR_JOGADORES.find((f) => n >= f.minimo).k;
}

/** PIS (0–100) para o fator de desempenho (−1 a +1). PIS 50 = neutro. */
export const fatorDeDesempenho = (pis) =>
  (pis === null || pis === undefined ? 0 : clamp((pis - 50) / 50, -1, 1));

/**
 * Variação de elo de um jogador.
 * @param venceu  true se o time dele ganhou
 * @param k       amplitude do formato
 * @param q       fator de desempenho; 0 para quem não tem dados
 */
export function calcularDelta({ venceu, k, q }) {
  const sinal = venceu ? 1 : -1;
  return Math.round(sinal * PESO_RESULTADO * k + PESO_DESEMPENHO * k * q);
}

/**
 * Corta o ganho que ultrapassaria o teto do dia. Derrota nunca é cortada:
 * o teto existe para limitar farm, não para proteger de perda.
 */
export function aplicarTetoDiario(delta, ganhoLiquidoHoje) {
  if (delta <= 0) return delta;
  const disponivel = TETO_DIARIO - Math.max(0, ganhoLiquidoHoje);
  return Math.max(0, Math.min(delta, disponivel));
}

export const CONSTANTES = {
  PESO_RESULTADO, PESO_DESEMPENHO, MIN_ROUNDS_PARTIDA, TETO_DIARIO,
};
