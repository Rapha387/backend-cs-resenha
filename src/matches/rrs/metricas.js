// matches/rrs/metricas.js — da linha do tempo para os valores brutos de cada
// métrica. Nenhuma normalização acontece aqui, e nada é escrito no banco.
//
// Invariante que vale para TODAS as métricas daqui: maior é melhor. Deaths e
// entry deaths entram invertidas dentro de IMP e ENT, o que evita ter que
// carregar um sinal por métrica no normalizador.

// Trade é o mesmo evento visto dos dois lados: eu vingo o companheiro (TK) ou
// sou vingado (o T do KAST). 5s é a janela clássica de troca no CS.
const JANELA_TRADE = 5000;

// Duas marcas mais próximas que isso, vindas de máquinas diferentes, não são
// distinguíveis com relógios distintos — o round não credita entry a ninguém.
const JANELA_EMPATE = 300;

// Amostra menor que isso não sustenta média por round.
const MIN_ROUNDS_JOGADOR = 8;
const FRACAO_ROUNDS_JOGADOR = 0.6;

// Cobertura da partida: acima do total, tudo liga; abaixo do mínimo, ninguém
// tem desempenho e a partida vale só o resultado.
const COBERTURA_TOTAL = 0.8;
const COBERTURA_MINIMA = 0.6;

const METRICAS_PROPRIAS = ['imp', 'mvp'];
const METRICAS_CRUZADAS = ['kast', 'ent', 'trade', 'clutch', 'obj'];

const PONTOS_CLUTCH = { 1: 1.0, 2: 2.0, 3: 3.5, 4: 5.0, 5: 7.0 };

// Quanto o desempenho pode mexer no elo, conforme o que deu para medir.
//
// Sem as métricas que cruzam máquinas sobram IMP e MVP, e as duas saem de
// abate: o PIS viraria 100% ranking de fragger, com o IMP — limitado a 15%
// justamente por ser o mais inflável — valendo 75% da nota. Isso contraria o
// objetivo de recompensar jogo de time, então a faixa parcial vale metade:
// mexe no máximo ±0,2·K em vez de ±0,4·K.
const CONFIANCA_PARCIAL = 0.5;

const confiancaDoConjunto = (habilitadas) =>
  (METRICAS_CRUZADAS.some((m) => habilitadas.has(m)) ? 1 : CONFIANCA_PARCIAL);

// Lance cujo ROUND_START não chegou fica sem tempo relativo (timeline.js).
// Ele ainda conta onde só o round importa — matou, morreu, assistiu — mas
// some de tudo que compara instantes entre máquinas.
const comTempo = (m) => m.t !== null;

/**
 * Calcula os valores brutos de cada jogador e decide quais métricas a partida
 * tem condição de usar.
 *
 * @param timeline saída de montarTimeline
 * @param roster   [{ steamid, team }] — o roster do lobby (fonte do time)
 * @returns {{ brutos: Map, avaliados: string[], habilitadas: Set, cobertura: number, roundsPorJogador: Map }}
 */
export function calcularBrutos(timeline, roster) {
  const { roundsJogados, jogadores, rounds } = timeline;

  const roundsPorJogador = new Map();
  for (const p of roster) {
    roundsPorJogador.set(p.steamid, jogadores.get(p.steamid)?.observados.size ?? 0);
  }

  const minimo = Math.max(MIN_ROUNDS_JOGADOR, Math.ceil(roundsJogados * FRACAO_ROUNDS_JOGADOR));
  const avaliados = roster
    .filter((p) => roundsPorJogador.get(p.steamid) >= minimo)
    .map((p) => p.steamid);

  const cobertura = roster.length > 0 ? avaliados.length / roster.length : 0;
  const timePorJogador = new Map(roster.map((p) => [p.steamid, p.team]));

  const habilitadas = metricasHabilitadas({ cobertura, avaliados, jogadores, roundsJogados });

  const brutos = new Map();
  const detalhes = new Map();
  const duelos = duelosDeAbertura(avaliados, jogadores);
  const trocas = tradeKills(avaliados, jogadores, timePorJogador);
  const clutches = pontosDeClutch(avaliados, jogadores, timePorJogador, rounds, habilitadas.has('clutch'));
  const objetivos = objetivoPorJogador(avaliados, jogadores, timePorJogador, rounds);

  for (const steamid of avaliados) {
    const j = jogadores.get(steamid);
    const r = roundsPorJogador.get(steamid);
    const duelo = duelos.get(steamid) ?? { ek: 0, ed: 0 };
    const obj = objetivos.get(steamid) ?? { plants: 0, defuses: 0 };
    const kastRounds = roundsComKAST(j, jogadores, timePorJogador, steamid).size;
    const tk = trocas.get(steamid) ?? 0;
    const clutchPts = clutches.get(steamid) ?? 0;

    brutos.set(steamid, {
      kast: (100 * kastRounds) / r,
      imp: (j.killsTotal + 0.5 * j.assistsTotal) / Math.max(1, j.deathsTotal),
      // Suavização de Laplace: sem nenhum duelo o jogador fica exatamente em
      // 0,50 (neutro), e um único duelo ganho não vira nota máxima.
      ent: (duelo.ek + 1) / (duelo.ek + duelo.ed + 2),
      trade: tk / r,
      clutch: clutchPts / r,
      mvp: j.mvpsTotal / r,
      obj: (obj.plants + 1.5 * obj.defuses) / r,
    });

    // Os contadores crus vão para match_player_stats: é o que permite auditar
    // uma nota depois e recalibrar as referências com dados reais.
    detalhes.set(steamid, {
      rounds: r,
      kills: j.killsTotal, deaths: j.deathsTotal, assists: j.assistsTotal,
      kastRounds, ek: duelo.ek, ed: duelo.ed, tk, clutchPts,
      mvps: j.mvpsTotal, plants: obj.plants, defuses: obj.defuses,
    });
  }

  return {
    brutos, detalhes, avaliados, habilitadas, cobertura, roundsPorJogador, roundsJogados,
    confianca: confiancaDoConjunto(habilitadas),
  };
}

// ---------------------------------------------------------------- internos

/**
 * Cobertura manda: abaixo do mínimo nada é calculado; entre o mínimo e o
 * total só valem as métricas que saem da própria máquina; acima, tudo.
 */
function metricasHabilitadas({ cobertura, avaliados, jogadores, roundsJogados }) {
  if (cobertura < COBERTURA_MINIMA || avaliados.length === 0) return new Set();

  const habilitadas = new Set(METRICAS_PROPRIAS);
  if (cobertura >= COBERTURA_TOTAL) for (const m of METRICAS_CRUZADAS) habilitadas.add(m);

  // Clutch depende de saber quem estava vivo dos DOIS lados; sem a partida
  // inteira reportando, "último vivo" vira palpite.
  if (cobertura < 1) habilitadas.delete('clutch');

  // Sem nenhum round com vencedor conhecido não há como creditar clutch.
  if (roundsJogados <= 0) return new Set();

  return habilitadas;
}

/** Rounds em que o jogador matou, assistiu, sobreviveu ou foi trocado. */
function roundsComKAST(j, jogadores, timePorJogador, steamid) {
  const comKAST = new Set();
  const meuTime = timePorJogador.get(steamid);

  for (const round of j.observados) {
    const matou = j.kills.some((k) => k.round === round);
    const assistiu = j.assists.some((a) => a.round === round);
    const minhasMortes = j.deaths.filter((d) => d.round === round);
    if (matou || assistiu || minhasMortes.length === 0) {
      comKAST.add(round);
      continue;
    }
    // Morreu: só conta se um companheiro matou logo depois (foi trocado).
    const trocado = minhasMortes.filter(comTempo).some((morte) =>
      [...jogadores.entries()].some(([outro, o]) =>
        outro !== steamid
        && timePorJogador.get(outro) === meuTime
        && o.kills.some((k) => k.round === round && comTempo(k)
          && k.t > morte.t && k.t - morte.t <= JANELA_TRADE)
      )
    );
    if (trocado) comKAST.add(round);
  }
  return comKAST;
}

/**
 * Primeira kill e primeira morte de cada round — o mesmo duelo visto dos dois
 * lados. Empate técnico ou lado faltando: o round não credita ninguém.
 */
function duelosDeAbertura(avaliados, jogadores) {
  const porJogador = new Map(avaliados.map((s) => [s, { ek: 0, ed: 0 }]));

  for (const [lista, campo] of [['kills', 'ek'], ['deaths', 'ed']]) {
    const porRound = new Map();
    const duvidosos = new Set();

    for (const steamid of avaliados) {
      for (const m of jogadores.get(steamid)[lista]) {
        // Basta um lance sem tempo para o round inteiro virar dúvida: o
        // primeiro pode ser justamente ele. Ignorar só o lance e premiar o
        // segundo colocado seria transferir o entry para quem não abriu.
        if (!comTempo(m)) { duvidosos.add(m.round); continue; }
        if (!porRound.has(m.round)) porRound.set(m.round, []);
        porRound.get(m.round).push({ steamid, ...m });
      }
    }

    for (const [round, marcas] of porRound) {
      if (duvidosos.has(round)) continue;
      const primeiro = primeiroSemEmpate(marcas);
      if (primeiro) porJogador.get(primeiro.steamid)[campo]++;
    }
  }
  return porJogador;
}

/** Kills que vingam a morte recente de um companheiro. */
function tradeKills(avaliados, jogadores, timePorJogador) {
  const total = new Map(avaliados.map((s) => [s, 0]));

  for (const steamid of avaliados) {
    const j = jogadores.get(steamid);
    const meuTime = timePorJogador.get(steamid);
    for (const kill of j.kills.filter(comTempo)) {
      const vingou = avaliados.some((outro) => {
        if (outro === steamid || timePorJogador.get(outro) !== meuTime) return false;
        return jogadores.get(outro).deaths.some(
          (d) => d.round === kill.round && comTempo(d)
            && kill.t > d.t && kill.t - d.t <= JANELA_TRADE
        );
      });
      if (vingou) total.set(steamid, total.get(steamid) + 1);
    }
  }
  return total;
}

/**
 * Clutch: o jogador ficou por último do seu time, contra N inimigos vivos, e
 * o time venceu o round. Clutch perdido não pontua nem penaliza — ficar em
 * 1v3 e perder é o resultado esperado.
 */
function pontosDeClutch(avaliados, jogadores, timePorJogador, rounds, habilitado) {
  const total = new Map(avaliados.map((s) => [s, 0]));
  if (!habilitado) return total;

  const rodadas = new Set();
  for (const s of avaliados) for (const r of jogadores.get(s).observados) rodadas.add(r);

  for (const round of rodadas) {
    const info = rounds.get(round);
    if (!info?.winner) continue;

    // "Último vivo" se apoia em AUSÊNCIA de morte. Num round que alguém não
    // reportou, não ter morte registrada não quer dizer que estava vivo — e o
    // ausente viraria o último vivo, ou esconderia quem foi. Sem o round
    // inteiro observado por todos, nenhum clutch é creditado.
    if (!avaliados.every((s) => jogadores.get(s).observados.has(round))) continue;
    if (!temposConfiaveis(avaliados, jogadores, round)) continue;

    const times = new Map();
    for (const steamid of avaliados) {
      const time = timePorJogador.get(steamid);
      if (!times.has(time)) times.set(time, []);
      times.get(time).push({ steamid, morte: primeiraMorte(jogadores.get(steamid), round) });
    }

    for (const [time, membros] of times) {
      if (membros.length < 2) continue; // sem "último vivo" num time de um
      const ordenados = [...membros].sort((a, b) => a.morte - b.morte);
      const ultimo = ordenados[ordenados.length - 1];
      const virouUltimo = ordenados[ordenados.length - 2].morte;
      if (!Number.isFinite(virouUltimo)) continue; // o time não perdeu ninguém

      const lado = jogadores.get(ultimo.steamid).ladoPorRound.get(round);
      if (!lado || lado !== info.winner) continue; // não venceu (ou lado desconhecido)

      const inimigosVivos = [...times.entries()]
        .filter(([outro]) => outro !== time)
        .flatMap(([, m]) => m)
        .filter((m) => m.morte > virouUltimo).length;

      const pontos = PONTOS_CLUTCH[Math.min(inimigosVivos, 5)];
      if (pontos) total.set(ultimo.steamid, total.get(ultimo.steamid) + pontos);
    }
  }
  return total;
}

/**
 * Plant e defuse são eventos globais no GSI: ninguém reporta o autor.
 * Plant  — quem teve a C4 ativa naquele round (só uma pessoa carrega).
 * Defuse — só credita quando havia exatamente um jogador vivo do lado que
 *          desarmou. Com dois ou mais, ninguém recebe: descartar é melhor do
 *          que inventar um autor.
 */
function objetivoPorJogador(avaliados, jogadores, timePorJogador, rounds) {
  const total = new Map(avaliados.map((s) => [s, { plants: 0, defuses: 0 }]));

  for (const [round, info] of rounds) {
    if (info.plant) {
      const comC4 = avaliados.filter((s) => jogadores.get(s).roundsComC4.has(round));
      if (comC4.length === 1) total.get(comC4[0]).plants++;
    }
    // Quem desarmou precisa de três certezas: a hora do defuse, o lado de
    // todo mundo naquele round e quem já estava morto. Faltando qualquer
    // uma, "um único CT vivo" vira ilusão e o crédito vai pro jogador errado.
    if (info.defuse?.t !== null && info.defuse !== null
        && avaliados.every((s) => jogadores.get(s).ladoPorRound.has(round))
        && temposConfiaveis(avaliados, jogadores, round)) {
      const vivos = avaliados.filter((s) => {
        const j = jogadores.get(s);
        return j.ladoPorRound.get(round) === 'CT' && primeiraMorte(j, round) > info.defuse.t;
      });
      if (vivos.length === 1) total.get(vivos[0]).defuses++;
    }
  }
  return total;
}

const primeiraMorte = (j, round) => {
  let menor = Infinity;
  // Só mortes com tempo: `null < Infinity` é verdadeiro em JS (null vira 0) e
  // uma morte sem tempo passaria a valer como a primeira do round.
  for (const d of j.deaths) if (d.round === round && comTempo(d) && d.t < menor) menor = d.t;
  return menor;
};

/**
 * Dá para raciocinar sobre "quem estava vivo quando" neste round? Não dá se
 * alguma morte dele chegou sem tempo: o jogador pareceria vivo o round todo.
 */
const temposConfiaveis = (avaliados, jogadores, round) =>
  avaliados.every((s) =>
    jogadores.get(s).deaths.every((d) => d.round !== round || comTempo(d)));

/**
 * A marca mais cedo do round, ou null se a de OUTRO jogador estiver colada
 * nela. Duas marcas do mesmo jogador (kill dupla entre dois frames do GSI)
 * não criam ambiguidade — a comparação tem que pular até achar outra pessoa,
 * senão um duplo abate esconderia o empate real com o adversário.
 */
function primeiroSemEmpate(marcas) {
  const ordenadas = [...marcas].sort((a, b) => a.t - b.t);
  const primeira = ordenadas[0];
  const deOutro = ordenadas.find((m) => m.steamid !== primeira.steamid);
  if (deOutro && deOutro.t - primeira.t < JANELA_EMPATE) return null;
  return primeira;
}
