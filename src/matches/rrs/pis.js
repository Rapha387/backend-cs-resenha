// matches/rrs/pis.js — Player Impact Score: transforma os valores brutos em
// notas de 0 a 100 e junta tudo numa nota só. Função pura, sem banco.
//
// Cada métrica vira duas notas: uma ABSOLUTA (contra uma referência fixa) e
// uma RELATIVA (percentil dentro da partida). A mistura das duas é o que faz
// o sistema funcionar tanto num 5x5 quanto num 2x2: percentil puro com quatro
// jogadores só produz 0, 33, 67 e 100, e trataria 95 e 90 de KAST como a mesma
// distância que 95 e 20.

// Não há ADR aqui, e a ausência é medida, não esquecimento: o GSI do CS2
// (provider 14173) não expõe dano. O `player.state` real traz health, armor,
// helmet, flashed, smoked, burning, money, round_kills, round_killhs e
// equip_value — o `round_totaldmg` é do CS:GO e não sobreviveu ao CS2.
// Sem fonte de dano, KAST vira a métrica âncora.
const PESOS = {
  kast: 0.282,   // presença útil: protege quem joga de apoio
  imp: 0.211,    // ganhar duelo é o jogo, mas é o mais inflável
  ent: 0.141,    // abrir round decide round
  trade: 0.113,  // peso contido: é heurística, não fato (o GSI não diz quem matou quem)
  clutch: 0.113,
  mvp: 0.070,    // resumo grosseiro do próprio CS2; entra como desempate
  obj: 0.070,
};

// Valor que vale nota 50. São estimativas de nível amador — a seção de
// balanceamento do RRS pede recalibrar pela mediana observada depois de ~20
// partidas registradas.
const REFERENCIAS = (n) => ({
  kast: 70,
  imp: 1.10,
  ent: 0.50,
  trade: 0.10,
  clutch: 0.06,
  // Só existe um MVP por round: a fatia média é 1/n, seja num 5x5 ou num 2x2.
  mvp: 1 / n,
  obj: 1.2 / n,
});

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * Peso do percentil na nota final. Cresce com o tamanho da partida porque é
 * uma medida de confiança na amostra: 0,40 no 2x2 e 0,80 no 5x5.
 */
const alfa = (n) => clamp((n + 2) / 15, 0.40, 0.80);

/**
 * Com menos de três avaliados o percentil só sabe dizer "melhor" e "pior" —
 * não há mediana. Nesse caso a nota vem só da referência fixa.
 */
const MIN_PARA_PERCENTIL = 3;

/**
 * @param brutos      Map steamid -> { kast, imp, ent, ... }
 * @param avaliados   steamids que entram na comparação
 * @param habilitadas Set das métricas que a partida tem condição de usar
 * @param n           jogadores do lobby (define alfa e as referências de MVP/OBJ)
 * @returns Map steamid -> { pis, notas }
 */
export function calcularPIS({ brutos, avaliados, habilitadas, n }) {
  const saida = new Map();
  if (habilitadas.size === 0 || avaliados.length === 0) return saida;

  const refs = REFERENCIAS(n);
  const metricas = [...habilitadas];
  const somaPesos = metricas.reduce((s, m) => s + PESOS[m], 0);
  const peso = avaliados.length >= MIN_PARA_PERCENTIL ? alfa(n) : 0;

  // Uma coluna por métrica com os valores de todo mundo: é contra ela que o
  // percentil de cada jogador é medido.
  const colunas = new Map(
    metricas.map((m) => [m, avaliados.map((s) => brutos.get(s)[m])])
  );

  for (const steamid of avaliados) {
    const notas = {};
    let pis = 0;
    for (const m of metricas) {
      const bruto = brutos.get(steamid)[m];
      const abs = clamp(50 * (bruto / refs[m]), 0, 100);
      const rel = percentil(bruto, colunas.get(m));
      const nota = peso * rel + (1 - peso) * abs;
      const pesoFinal = PESOS[m] / somaPesos;
      pis += pesoFinal * nota;
      notas[m] = { bruto, abs, rel, nota, peso: pesoFinal };
    }
    saida.set(steamid, { pis, notas });
  }
  return saida;
}

/** Percentil clássico, com meio-crédito para empate. Melhor = 100, pior = 0. */
function percentil(valor, todos) {
  if (todos.length < 2) return 50;
  const piores = todos.filter((v) => v < valor).length;
  const empatados = todos.filter((v) => v === valor).length - 1;
  return (100 * (piores + 0.5 * empatados)) / (todos.length - 1);
}

/**
 * Quem deixou o jogo rodando sozinho. A penalidade é o mínimo da faixa, então
 * o custo de um falso positivo é alto: exige os TRÊS sinais zerados na
 * partida inteira — nenhuma kill, nenhuma assistência e score zero no placar
 * do próprio CS2, que também sobe com plant e defuse.
 *
 * Sem o score, "0 kill e 0 assist" bastaria, e um jogador novo que jogou mal
 * a partida toda levaria a mesma punição de quem não jogou. Não é a mesma
 * coisa, e a diferença aparece no score.
 */
export function ehAFK(jogador) {
  if (!jogador) return false;
  return jogador.killsTotal === 0
    && jogador.assistsTotal === 0
    && jogador.scoreTotal === 0;
}
