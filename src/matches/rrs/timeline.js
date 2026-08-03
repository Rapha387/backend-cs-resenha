// matches/rrs/timeline.js — transforma os eventos crus de match_events numa
// linha do tempo por jogador e por round. Não calcula métrica nenhuma: só
// organiza o que aconteceu, para metricas.js perguntar depois.
//
// O ponto delicado é o TEMPO. As até 10 máquinas têm relógios diferentes (o
// desvio chega a segundos), então comparar `ts` absoluto entre clients daria
// entry kill aleatório. Por isso todo evento de jogador vira o tempo relativo
// ao ROUND_START que o PRÓPRIO client daquele jogador reportou.

const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

/**
 * Monta a linha do tempo da partida.
 *
 * @param eventos linhas de match_events (steamid, type, ts, data), em qualquer ordem
 * @returns {{ roundsJogados: number, jogadores: Map, rounds: Map }}
 */
export function montarTimeline(eventos) {
  // Ordem total e determinística: mesmos eventos ⇒ mesma linha do tempo,
  // independente da ordem em que o banco devolveu (invariante I8).
  const ordenados = [...eventos].sort(
    (a, b) => a.ts - b.ts || String(a.steamid).localeCompare(String(b.steamid))
  );

  const jogadores = new Map();
  const rounds = new Map();
  let placarFinal = null;

  for (const ev of ordenados) {
    const data = parse(ev.data) ?? {};
    const j = jogador(jogadores, ev.steamid);

    switch (ev.type) {
      // Só o ROUND_START ancora o tempo. O FREEZETIME abre o round (marca
      // como observado e passa a numerar os eventos seguintes), mas acontece
      // ~15s antes do jogo liberar: se um client ancorasse nele e outro no
      // ROUND_START, os dois relógios ficariam defasados por esses 15s — e é
      // a comparação entre máquinas que decide entry e trade.
      case 'FREEZETIME':
        abrirRound(j, numeroDoRound(data.round), null);
        break;

      case 'ROUND_START':
        abrirRound(j, numeroDoRound(data.round), ev.ts);
        break;

      case 'ROUND_END': {
        // O ROUND_END do CS2 traz o round 0-indexado; o ROUND_START soma 1.
        // Aqui interessa quem venceu, que é informação global do round.
        // Sem número de round não dá pra saber de qual round é o vencedor —
        // somar 1 em null daria round 1 e sobrescreveria o vencedor dele.
        const r = numeroDoRound(data.round);
        if (r !== null) registrarVencedor(rounds, r + 1, data.winner);
        fecharRound(j);
        break;
      }

      case 'PLAYER_KILL':
        marcar(j, 'kills', ev.ts, Number(data.delta) || 1);
        j.killsTotal = Math.max(j.killsTotal, Number(data.total) || 0);
        break;

      case 'PLAYER_ASSIST':
        marcar(j, 'assists', ev.ts, Number(data.delta) || 1);
        j.assistsTotal = Math.max(j.assistsTotal, Number(data.total) || 0);
        break;

      case 'PLAYER_DEAD':
        marcar(j, 'deaths', ev.ts, 1);
        j.deathsTotal = Math.max(j.deathsTotal, Number(data.deaths) || 0);
        break;

      case 'PLAYER_MVP':
        j.mvpsTotal = Math.max(j.mvpsTotal, Number(data.total) || 0);
        break;

      case 'WEAPON_CHANGE':
        // Guardado só para atribuir o plant: só quem carrega a C4 a deixa
        // ativa, e num round quem faz isso é uma pessoa só.
        if (j.roundAtual !== null && String(data.weapon ?? '') === 'weapon_c4') {
          j.roundsComC4.add(j.roundAtual);
        }
        break;

      case 'BOMB_PLANTED':
        marcarBomba(rounds, j, 'plant', ev.ts);
        break;

      case 'BOMB_DEFUSED':
        marcarBomba(rounds, j, 'defuse', ev.ts);
        break;

      case 'STATE_SYNC': {
        const r = numeroDoRound(data.round);
        // O sync é 0-indexado como o map.round; +1 alinha com o ROUND_START.
        if (r !== null) abrirRoundSeNovo(j, r + 1);
        // Bloco player nulo = a pessoa morreu e está assistindo um colega:
        // aquelas stats não são dela (events.rs). Não dá para ler lado aqui.
        if (data.player?.team && j.roundAtual !== null) {
          j.ladoPorRound.set(j.roundAtual, data.player.team);
        }
        if (data.player) {
          j.killsTotal = Math.max(j.killsTotal, Number(data.player.kills) || 0);
          j.deathsTotal = Math.max(j.deathsTotal, Number(data.player.deaths) || 0);
          j.assistsTotal = Math.max(j.assistsTotal, Number(data.player.assists) || 0);
          j.mvpsTotal = Math.max(j.mvpsTotal, Number(data.player.mvps) || 0);
          // Score do placar do CS2: sobe com kill, assistência, plant e
          // defuse. É o que separa "jogou mal" de "não jogou" (ver ehAFK).
          j.scoreTotal = Math.max(j.scoreTotal, Number(data.player.score) || 0);
        }
        break;
      }

      case 'GAME_OVER':
        placarFinal = somaPlacar(data);
        break;

      default:
        break; // MAP_CHANGE, MAP_PHASE, SCORE_UPDATE, PLAYER_ALIVE, PLAYER_TEAM
    }
  }

  return { roundsJogados: roundsJogados(placarFinal, jogadores), jogadores, rounds };
}

// ---------------------------------------------------------------- internos

function jogador(jogadores, steamid) {
  let j = jogadores.get(steamid);
  if (!j) {
    j = {
      steamid,
      roundAtual: null,
      inicioDoRound: null,
      observados: new Set(),
      kills: [],   // { round, t } — t relativo ao início do round do próprio client
      deaths: [],
      assists: [],
      ladoPorRound: new Map(),  // round -> 'CT' | 'T'
      roundsComC4: new Set(),   // rounds em que teve a C4 na mão (para o plant)
      killsTotal: 0, deathsTotal: 0, assistsTotal: 0, mvpsTotal: 0, scoreTotal: 0,
    };
    jogadores.set(steamid, j);
  }
  return j;
}

/**
 * Número de round vindo do evento, ou null se não veio.
 *
 * Cuidado com o atalho `Number.isFinite(Number(v))`: `Number(null)` é 0 e
 * `Number('')` também. Um evento sem round viraria round 0 — que depois vira
 * round 1 no `+1` do ROUND_END e sobrescreve o vencedor do primeiro round.
 */
const numeroDoRound = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `inicio` null = round aberto sem âncora de tempo (ver FREEZETIME). */
function abrirRound(j, round, inicio) {
  if (round === null) return;
  j.roundAtual = round;
  j.inicioDoRound = inicio;
  j.observados.add(round);
}

/**
 * O STATE_SYNC só abre round pra frente, e nunca ancora: ele chega no meio do
 * round, não no começo. Um sync atrasado (round menor que o atual) também
 * jogaria as kills seguintes pro round errado. Quem manda no t=0 é sempre o
 * ROUND_START do próprio client.
 */
function abrirRoundSeNovo(j, round) {
  if (round === null) return;
  if (j.roundAtual === null || round > j.roundAtual) abrirRound(j, round, null);
  else j.observados.add(round);
}

function fecharRound(j) {
  if (j.roundAtual !== null) j.observados.add(j.roundAtual);
}

/** Registra um evento de jogador no round corrente, com tempo relativo. */
function marcar(j, lista, ts, quantidade) {
  if (j.roundAtual === null) return; // evento antes de qualquer round: descarta
  // Sem ROUND_START daquele round, o tempo relativo é DESCONHECIDO — nunca
  // zero. Zero faria o lance parecer o primeiro do round e ganharia todo
  // duelo de abertura. Quem lê decide se pode usar (ver metricas.js).
  const t = j.inicioDoRound === null ? null : ts - j.inicioDoRound;
  j.observados.add(j.roundAtual);
  for (let i = 0; i < Math.max(1, quantidade); i++) {
    j[lista].push({ round: j.roundAtual, t });
  }
}

function infoDoRound(rounds, round) {
  let r = rounds.get(round);
  if (!r) {
    r = { winner: null, plant: null, defuse: null };
    rounds.set(round, r);
  }
  return r;
}

function registrarVencedor(rounds, round, winner) {
  if (round === null || !winner) return;
  infoDoRound(rounds, round).winner = winner === 'ct' ? 'CT' : winner === 't' ? 'T' : String(winner).toUpperCase();
}

/**
 * Bomba plantada/desarmada é evento GLOBAL: todo client reporta o mesmo. Fica
 * a primeira marca vista, com o tempo relativo de quem reportou — é o que
 * permite comparar com as mortes daquele round.
 */
function marcarBomba(rounds, j, tipo, ts) {
  if (j.roundAtual === null) return;
  const info = infoDoRound(rounds, j.roundAtual);
  const t = j.inicioDoRound === null ? null : ts - j.inicioDoRound;
  // Fica a primeira marca COM tempo utilizável. Sem nenhuma, guarda a marca
  // sem tempo: o plant não precisa de tempo (é atribuído por quem tinha a
  // C4), só o defuse precisa.
  if (info[tipo] === null || (info[tipo].t === null && t !== null)) {
    info[tipo] = { t, reportadoPor: j.steamid };
  }
}

const somaPlacar = (data) => {
  const ct = Number(data?.score_ct);
  const t = Number(data?.score_t);
  return Number.isFinite(ct) && Number.isFinite(t) ? ct + t : null;
};

/**
 * Quantos rounds a partida teve. O placar do GAME_OVER é a fonte de verdade
 * (vale mesmo sem ninguém com client aberto); o maior round observado é o
 * fallback para partida que terminou sem GAME_OVER legível.
 */
function roundsJogados(placarFinal, jogadores) {
  if (placarFinal !== null) return placarFinal;
  let maior = 0;
  for (const j of jogadores.values()) {
    for (const r of j.observados) if (r > maior) maior = r;
  }
  return maior;
}
