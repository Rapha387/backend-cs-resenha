// test-rrs.mjs — testa o Resenha Rating System de ponta a ponta: eventos crus
// em match_events viram métricas, PIS e variação de elo.
//   node --env-file=.env test-rrs.mjs
//
// Dois cenários, porque o comportamento com e sem cobertura é diferente:
//   1. cobertura total  — todas as métricas ligadas (entry, trade, KAST…)
//   2. cobertura 75%    — só as métricas da própria máquina; quem está sem
//                         client leva apenas o componente de resultado
import { createClient } from '@libsql/client';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000';
const KEY = process.env.INTERNAL_API_KEY;

const LOBBY_CHEIO = 'ZZRR1';
const LOBBY_PARCIAL = 'ZZRR2';
const A1 = '76561198000000091';
const A2 = '76561198000000092';
const B1 = '76561198000000093';
const B2 = '76561198000000094';
const TODOS = [A1, A2, B1, B2];
const TIME = { [A1]: 'A', [A2]: 'A', [B1]: 'B', [B2]: 'B' };

const ROUNDS = 16; // MR12 não chega aqui, mas passa do mínimo de 13
const K_2X2 = 15;  // amplitude do formato de 4 jogadores

// Rounds em que a bomba é desarmada. Todos são rounds vencidos pelo lado CT
// (1 a 8 o time A é CT; de 9 em diante é o B), senão o dado ficaria
// contraditório: defuse é vitória de CT.
const DEFUSES = [1, 3, 5, 7, 9, 11, 13];

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let falhas = 0;
const check = (nome, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!cond) falhas++;
};

async function cleanup() {
  const lobbies = [LOBBY_CHEIO, LOBBY_PARCIAL];
  const marcadores = TODOS.map(() => '?').join(', ');
  await db.batch([
    ...lobbies.flatMap((code) => [
      { sql: 'DELETE FROM match_events WHERE match_id IN (SELECT id FROM live_matches WHERE code = ?)', args: [code] },
      { sql: 'DELETE FROM match_player_stats WHERE code = ?', args: [code] },
      { sql: 'DELETE FROM lobby_players WHERE code = ?', args: [code] },
      { sql: 'DELETE FROM lobbies WHERE code = ?', args: [code] },
      { sql: 'DELETE FROM live_matches WHERE code = ?', args: [code] },
      { sql: 'DELETE FROM matches WHERE code = ?', args: [code] },
    ]),
    { sql: `DELETE FROM players WHERE steamid IN (${marcadores})`, args: TODOS },
  ], 'write');
}

const evento = (matchId, steamid, type, ts, data) => ({
  sql: 'INSERT INTO match_events (match_id, steamid, type, ts, data) VALUES (?, ?, ?, ?, ?)',
  args: [matchId, steamid, type, ts, JSON.stringify(data)],
});

/**
 * Gera uma partida sintética de 16 rounds.
 *
 * `semClient` não emite evento nenhum — é o jogador que esqueceu de abrir o
 * app. `roteiro(round)` devolve os lances daquele round, em tempo relativo ao
 * início do round, que é como o backend compara máquinas diferentes.
 */
function gerarPartida({ matchId, semClient = [], roteiro, vencedoresA }) {
  const stmts = [];
  const acumulado = Object.fromEntries(TODOS.map((s) => [s, { kills: 0, deaths: 0, assists: 0, mvps: 0 }]));
  const ativos = TODOS.filter((s) => !semClient.includes(s));
  let base = Date.now() - ROUNDS * 30_000;
  // O placar do GSI é por LADO, não por time: no intervalo os times trocam de
  // lado e os números vão junto. Por isso o teste guarda o placar por time e
  // traduz na hora de emitir o evento — é exatamente o que o CS2 faz.
  let scoreA = 0;
  let scoreB = 0;

  for (let round = 1; round <= ROUNDS; round++) {
    // Primeiro tempo: time A de CT. Trocam no intervalo (round 9).
    const aEhCT = round <= 8;
    const ladoDe = (steamid) => ((TIME[steamid] === 'A') === aEhCT ? 'CT' : 'T');
    const placarCt = () => (aEhCT ? scoreA : scoreB);
    const placarT = () => (aEhCT ? scoreB : scoreA);

    for (const steamid of ativos) {
      stmts.push(evento(matchId, steamid, 'ROUND_START', base, { round }));
    }

    const lances = roteiro(round);
    for (const lance of lances) {
      if (semClient.includes(lance.steamid)) continue;
      const acc = acumulado[lance.steamid];
      if (lance.tipo === 'kill') {
        acc.kills++;
        stmts.push(evento(matchId, lance.steamid, 'PLAYER_KILL', base + lance.t, { total: acc.kills, delta: 1 }));
      } else if (lance.tipo === 'morte') {
        acc.deaths++;
        stmts.push(evento(matchId, lance.steamid, 'PLAYER_DEAD', base + lance.t, { deaths: acc.deaths }));
      } else if (lance.tipo === 'assist') {
        acc.assists++;
        stmts.push(evento(matchId, lance.steamid, 'PLAYER_ASSIST', base + lance.t, { total: acc.assists, delta: 1 }));
      }
    }

    // STATE_SYNC com o lado — é ele que traduz CT/T pros times da plataforma.
    for (const steamid of ativos) {
      const acc = acumulado[steamid];
      stmts.push(evento(matchId, steamid, 'STATE_SYNC', base + 9200, {
        map: 'de_mirage', map_phase: 'live', round_phase: 'live',
        round: round - 1, score_ct: placarCt(), score_t: placarT(),
        player: {
          steamid, name: `Teste ${steamid.slice(-2)}`, team: ladoDe(steamid),
          health: 100, kills: acc.kills, deaths: acc.deaths, assists: acc.assists,
          mvps: acc.mvps,
          // Score do placar do CS2 (o client já manda): 2 por kill, 1 por
          // assistência, mais um ponto por round sobrevivido/objetivo.
          score: acc.kills * 2 + acc.assists + round,
        },
      }));
    }

    // Bomba: quem está de T carrega a C4 e planta. O carregador é escolhido
    // entre quem continua vivo na hora do plant. O defuse só acontece em
    // round que o lado CT venceu, e sempre com um único CT vivo — que é a
    // única situação em que o RRS credita o defuse a alguém.
    const carregadorC4 = aEhCT ? B2 : A1;
    if (ativos.includes(carregadorC4)) {
      stmts.push(evento(matchId, carregadorC4, 'WEAPON_CHANGE', base + 5500, { weapon: 'weapon_c4' }));
      for (const s of ativos) stmts.push(evento(matchId, s, 'BOMB_PLANTED', base + 6000, {}));
    }
    const desarmou = DEFUSES.includes(round);
    if (desarmou) {
      for (const s of ativos) stmts.push(evento(matchId, s, 'BOMB_DEFUSED', base + 7000, {}));
    }

    const aVenceu = vencedoresA.includes(round);
    if (aVenceu) scoreA++; else scoreB++;
    const vencedorCT = aVenceu === aEhCT;

    // O MVP vai pra alguém do lado que venceu o round (um por round, como no CS2).
    const mvp = ativos.find((s) => ladoDe(s) === (vencedorCT ? 'CT' : 'T'));
    if (mvp) {
      acumulado[mvp].mvps++;
      stmts.push(evento(matchId, mvp, 'PLAYER_MVP', base + 9400, { total: acumulado[mvp].mvps, delta: 1 }));
    }

    for (const steamid of ativos) {
      stmts.push(evento(matchId, steamid, 'ROUND_END', base + 9500, {
        round: round - 1, winner: vencedorCT ? 'CT' : 'T', score_ct: placarCt(), score_t: placarT(),
      }));
    }
    base += 20_000;
  }

  // No último round o time A está de T (2º tempo), então o placar do CS2 sai
  // invertido em relação aos times — é o backend que traduz de volta.
  const scoreCt = scoreB;
  const scoreT = scoreA;
  stmts.push(evento(matchId, ativos[0], 'GAME_OVER', base, { score_ct: scoreCt, score_t: scoreT }));
  return { stmts, scoreA, scoreB, scoreCt, scoreT };
}

/** Roteiro com abertura e troca claras, para exercitar entry e trade. */
const roteiroPadrao = (round) => {
  const lances = [
    // A1 abre o round: primeira kill; B1 é a primeira morte (mesmo duelo).
    { steamid: A1, tipo: 'kill', t: 3000 },
    { steamid: B1, tipo: 'morte', t: 3000 },
    // B2 vinga o companheiro 2s depois: trade kill dele, e o B1 foi "trocado".
    { steamid: B2, tipo: 'kill', t: 5000 },
    { steamid: A2, tipo: 'morte', t: 5000 },
    { steamid: A1, tipo: 'assist', t: 6000 },
  ];
  // Em alguns rounds o A1 também morre, para não ficar com KAST/entry perfeitos.
  if (round % 4 === 0) lances.push({ steamid: A1, tipo: 'morte', t: 8000 });
  return lances;
};

async function prepararLobby(code) {
  const agora = Date.now();
  await db.batch([
    { sql: "INSERT INTO lobbies (code, owner, status, decider_map, created) VALUES (?, ?, 'pronto', 'de_mirage', ?)", args: [code, A1, agora] },
    ...TODOS.map((s) => ({
      sql: 'INSERT OR IGNORE INTO players (steamid, name, elo, wins, losses, created) VALUES (?, ?, 1000, 0, 0, ?)',
      args: [s, `Teste ${s.slice(-2)}`, agora],
    })),
    ...TODOS.map((s) => ({
      sql: 'INSERT INTO lobby_players (code, steamid, team, joined) VALUES (?, ?, ?, ?)',
      args: [code, s, TIME[s], agora],
    })),
  ], 'write');

  const start = await fetch(`${BASE}/internal/match/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': KEY },
    body: JSON.stringify({ code }),
  }).then((r) => r.json());
  return start.matchId;
}

const sweep = () =>
  fetch(`${BASE}/internal/sweep`, { method: 'POST', headers: { 'X-Internal-Key': KEY } }).then((r) => r.json());

/**
 * Espera o backend estar de pé. Dormir um tempo fixo antes de rodar a suíte
 * já produziu falha fantasma: a primeira chamada saía antes do servidor
 * atender e derrubava as asserções seguintes em cascata.
 */
async function esperarBackend(tentativas = 30) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(`${BASE}/api/client/version`);
      if (r.ok) return true;
    } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`backend não respondeu em ${BASE} — suba com "npm run dev" antes da suíte`);
}

async function statsDo(code) {
  const rs = await db.execute({
    sql: `SELECT steamid, rounds, kills, deaths, assists, kast_rounds, ek, ed, tk,
                 clutch_pts, mvps, plants, defuses, pis, q, delta_elo, metricas
          FROM match_player_stats WHERE code = ?`,
    args: [code],
  });
  return new Map(rs.rows.map((r) => [r[0], {
    rounds: Number(r[1]), kills: Number(r[2]), deaths: Number(r[3]), assists: Number(r[4]),
    kastRounds: Number(r[5]), ek: Number(r[6]), ed: Number(r[7]), tk: Number(r[8]),
    clutchPts: Number(r[9]), mvps: Number(r[10]), plants: Number(r[11]), defuses: Number(r[12]),
    pis: r[13] === null ? null : Number(r[13]), q: Number(r[14]), delta: Number(r[15]),
    metricas: r[16] ? JSON.parse(r[16]) : null,
  }]));
}

const eloDe = async () => {
  const marcadores = TODOS.map(() => '?').join(', ');
  const rs = await db.execute({
    sql: `SELECT steamid, elo, wins, losses FROM players WHERE steamid IN (${marcadores})`,
    args: TODOS,
  });
  return new Map(rs.rows.map((r) => [r[0], { elo: Number(r[1]), wins: Number(r[2]), losses: Number(r[3]) }]));
};

try {
  await esperarBackend();
  await cleanup();

  // ---------------------------------------------------------------------
  // Cenário 1 — cobertura total: as quatro máquinas reportando
  // ---------------------------------------------------------------------
  console.log('\n--- cenário 1: cobertura total (4/4 clients) ---');
  const matchCheio = await prepararLobby(LOBBY_CHEIO);
  check('partida criada', Number.isInteger(matchCheio), `matchId=${matchCheio}`);

  // Time A vence 9x7 (8 rounds do 1º tempo + o round 15).
  const vencedoresA = [1, 2, 3, 4, 5, 6, 7, 8, 15];

  const cheio = gerarPartida({ matchId: matchCheio, roteiro: roteiroPadrao, vencedoresA });
  for (let i = 0; i < cheio.stmts.length; i += 200) {
    await db.batch(cheio.stmts.slice(i, i + 200), 'write');
  }
  check('placar do CS2 soma 16 rounds e o time A fez 9',
    cheio.scoreCt + cheio.scoreT === ROUNDS && cheio.scoreA === 9,
    `${cheio.scoreCt}CT x ${cheio.scoreT}T (A=${cheio.scoreA} B=${cheio.scoreB})`);

  const s1 = await sweep();
  check('varredura registrou a partida', s1.encerradas >= 1, `encerradas=${s1.encerradas}`);

  const reg = await db.execute({ sql: 'SELECT score_a, score_b, winner FROM matches WHERE code = ?', args: [LOBBY_CHEIO] });
  check('placar traduzido: time A venceu 9x7',
    reg.rows.length === 1 && Number(reg.rows[0][0]) === 9 && Number(reg.rows[0][1]) === 7 && reg.rows[0][2] === 'A',
    reg.rows.length ? `${reg.rows[0][0]}x${reg.rows[0][1]} vencedor ${reg.rows[0][2]}` : 'sem registro');

  const st = await statsDo(LOBBY_CHEIO);
  check('match_player_stats tem os 4 jogadores', st.size === 4, `linhas=${st.size}`);

  const metricasUsadas = Object.keys(st.get(A1)?.metricas ?? {});
  check('cobertura total liga as métricas cruzadas',
    ['kast', 'imp', 'ent', 'trade', 'clutch', 'mvp', 'obj'].every((m) => metricasUsadas.includes(m)),
    metricasUsadas.join(' '));
  // O CS2 não expõe dano: ADR não existe no cálculo e não pode reaparecer.
  check('nenhuma métrica de dano no cálculo', !metricasUsadas.includes('adr'),
    metricasUsadas.join(' '));

  check('entry kill atribuído a quem abriu o round', st.get(A1).ek === ROUNDS,
    `ek do A1=${st.get(A1).ek}`);
  check('entry death atribuída a quem morreu primeiro', st.get(B1).ed === ROUNDS,
    `ed do B1=${st.get(B1).ed}`);
  check('trade kill atribuído a quem vingou o companheiro', st.get(B2).tk === ROUNDS,
    `tk do B2=${st.get(B2).tk}`);
  check('KAST conta o companheiro trocado', st.get(B1).kastRounds === ROUNDS,
    `kast_rounds do B1=${st.get(B1).kastRounds} (morreu todo round, mas foi vingado)`);

  // Objetivo: o GSI não diz quem plantou nem quem desarmou. O plant vai para
  // quem tinha a C4 na mão; o defuse, só quando havia um único CT vivo.
  check('plant atribuído a quem estava com a C4',
    st.get(B2).plants === 8 && st.get(A1).plants === 8,
    `B2=${st.get(B2).plants} (1º tempo de T) A1=${st.get(A1).plants} (2º tempo de T)`);
  check('defuse atribuído ao único CT vivo',
    st.get(A1).defuses === 4 && st.get(B2).defuses === 3,
    `A1=${st.get(A1).defuses} B2=${st.get(B2).defuses}`);
  check('quem não plantou nem desarmou fica zerado',
    st.get(A2).plants === 0 && st.get(A2).defuses === 0
    && st.get(B1).plants === 0 && st.get(B1).defuses === 0,
    `A2=${st.get(A2).plants}/${st.get(A2).defuses} B1=${st.get(B1).plants}/${st.get(B1).defuses}`);

  const elos1 = await eloDe();
  const vencedores = [A1, A2];
  const perdedores = [B1, B2];
  check('I1 — todo vencedor ganhou elo',
    vencedores.every((s) => st.get(s).delta > 0),
    vencedores.map((s) => `${s.slice(-2)}:${st.get(s).delta}`).join(' '));
  check('I2 — todo perdedor perdeu elo',
    perdedores.every((s) => st.get(s).delta < 0),
    perdedores.map((s) => `${s.slice(-2)}:${st.get(s).delta}`).join(' '));
  check('I3 — nenhuma variação passa do K do formato',
    TODOS.every((s) => Math.abs(st.get(s).delta) <= K_2X2),
    `K=${K_2X2}`);
  check('elo aplicado bate com o delta calculado',
    TODOS.every((s) => elos1.get(s).elo === 1000 + st.get(s).delta),
    TODOS.map((s) => `${s.slice(-2)}:${elos1.get(s).elo}`).join(' '));
  check('vitórias e derrotas contabilizadas',
    vencedores.every((s) => elos1.get(s).wins === 1) && perdedores.every((s) => elos1.get(s).losses === 1));
  // O A1 domina o A2 em tudo (mais dano, mais kills, menos mortes, entry e
  // assistências), então tem que levar mais elo pela mesma vitória.
  check('quem jogou melhor ganhou mais que o companheiro',
    st.get(A1).delta > st.get(A2).delta,
    `A1=${st.get(A1).delta} A2=${st.get(A2).delta}`);
  // Propriedade da fórmula, não dos dados: dentro do mesmo time, maior PIS
  // nunca pode levar menos elo.
  const monotonico = ['A', 'B'].every((time) => {
    const doTime = TODOS.filter((s) => TIME[s] === time).sort((x, y) => st.get(y).pis - st.get(x).pis);
    return doTime.every((s, i) => i === 0 || st.get(doTime[i - 1]).delta >= st.get(s).delta);
  });
  check('elo é monotônico no PIS dentro do time', monotonico,
    TODOS.map((s) => `${s.slice(-2)}:pis=${st.get(s).pis?.toFixed(1)}/Δ=${st.get(s).delta}`).join(' '));

  // Idempotência: a varredura roda de hora em hora e no boot.
  await sweep();
  const st2 = await statsDo(LOBBY_CHEIO);
  const elos2 = await eloDe();
  const regCount = await db.execute({ sql: 'SELECT COUNT(*) FROM matches WHERE code = ?', args: [LOBBY_CHEIO] });
  check('I5 — varredura repetida não duplica nada',
    st2.size === 4 && Number(regCount.rows[0][0]) === 1
    && TODOS.every((s) => elos2.get(s).elo === elos1.get(s).elo),
    `linhas=${st2.size} matches=${regCount.rows[0][0]}`);

  // ---------------------------------------------------------------------
  // Cenário 2 — um jogador sem o client (cobertura 3/4 = 75%)
  // ---------------------------------------------------------------------
  console.log('\n--- cenário 2: cobertura parcial (3/4 clients) ---');
  const matchParcial = await prepararLobby(LOBBY_PARCIAL);
  const parcial = gerarPartida({
    matchId: matchParcial, semClient: [A2], roteiro: roteiroPadrao, vencedoresA,
  });
  for (let i = 0; i < parcial.stmts.length; i += 200) {
    await db.batch(parcial.stmts.slice(i, i + 200), 'write');
  }
  await sweep();

  const stp = await statsDo(LOBBY_PARCIAL);
  check('partida parcial registrada', stp.size === 4, `linhas=${stp.size}`);

  const semDados = stp.get(A2);
  check('I7 — jogador sem client fica neutro (q=0, sem PIS)',
    semDados.pis === null && semDados.q === 0,
    `pis=${semDados.pis} q=${semDados.q}`);
  check('jogador sem client leva só o componente de resultado (+0,6·K)',
    semDados.delta === Math.round(0.6 * K_2X2),
    `delta=${semDados.delta} esperado=${Math.round(0.6 * K_2X2)}`);

  const metricasParciais = Object.keys(stp.get(A1)?.metricas ?? {});
  check('cobertura de 75% desliga as métricas cruzadas',
    ['imp', 'mvp'].every((m) => metricasParciais.includes(m))
    && !['kast', 'ent', 'trade', 'clutch', 'obj'].some((m) => metricasParciais.includes(m)),
    metricasParciais.join(' '));

  check('mesmo sem desempenho, o resultado da partida continua valendo',
    stp.get(A1).delta > 0 && stp.get(B1).delta < 0,
    `A1=${stp.get(A1).delta} B1=${stp.get(B1).delta}`);

  // Sem as métricas de time sobram IMP e MVP, as duas derivadas de abate. Se
  // valessem cheio, a faixa parcial seria um ranking de fragger — o oposto do
  // objetivo do sistema. Por isso o desempenho vale metade aqui: no máximo
  // 0,2·K, contra 0,6·K do resultado.
  const tetoParcial = Math.round(0.2 * K_2X2);
  const resultado = Math.round(0.6 * K_2X2);
  const dentroDoTeto = TODOS.every((s) => {
    const esperado = stp.get(s).delta > 0 ? resultado : -resultado;
    return Math.abs(stp.get(s).delta - esperado) <= tetoParcial;
  });
  check('cobertura parcial limita o desempenho a metade', dentroDoTeto,
    TODOS.map((s) => `${s.slice(-2)}:${stp.get(s).delta}`).join(' ') + ` (resultado ±${resultado}, desempenho ±${tetoParcial})`);
} catch (e) {
  falhas++;
  console.error('💥 erro inesperado:', e);
} finally {
  await cleanup();
  console.log(falhas === 0 ? '\n🎉 tudo passou' : `\n💥 ${falhas} falha(s)`);
  process.exitCode = falhas === 0 ? 0 : 1;
}
