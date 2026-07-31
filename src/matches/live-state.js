// matches/live-state.js — modelo de LEITURA da partida: junta os STATE_SYNC
// dos clients num placar só. Não decide nada nem escreve no banco.
import { db } from '../db.js';
import { HttpError } from '../auth.js';
import { isConnected } from '../ws/registry.js';

const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

// Os 10 jogadores do lobby ficam consultando o placar ao mesmo tempo; sem
// cache seriam ~200 queries/min no Turso pra dados que mudam a cada 10s
// (intervalo do STATE_SYNC). 2s de cache derruba isso pra ~30/min.
const CACHE_MS = 2000;
const cache = new Map(); // matchId -> { at, promise }

/** Estado ao vivo com cache curto — é o que as rotas HTTP usam. */
export function liveState(matchId) {
  const hit = cache.get(matchId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;

  const promise = buildLiveState(matchId).catch((e) => {
    cache.delete(matchId); // erro não fica cacheado
    throw e;
  });
  cache.set(matchId, { at: Date.now(), promise });
  if (cache.size > 200) {
    for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
  }
  return promise;
}

/**
 * Monta o estado do zero (sem cache). O registro automático do placar usa
 * esta versão: ele precisa enxergar o GAME_OVER que acabou de ser gravado.
 *
 * Traduz o placar CT/T do CS2 pros times da plataforma. A tradução é
 * necessária porque os lados trocam no halftime: descobrimos de que lado
 * cada time está pelo `player.team` que os próprios clients reportam.
 */
export async function buildLiveState(matchId) {
  const match = await db.prepare('SELECT * FROM live_matches WHERE id = ?').get(matchId);
  if (!match) throw new HttpError(404, 'Partida não encontrada.');

  const [syncs, ownSyncs, roster, over] = await Promise.all([
    db.prepare(`
      SELECT steamid, data, MAX(ts) AS ts FROM match_events
      WHERE match_id = ? AND type = 'STATE_SYNC' GROUP BY steamid`).all(matchId),
    // Quando a pessoa morre e passa a assistir um colega, o GSI troca o bloco
    // "player" pelo jogador OBSERVADO — e o client manda player:null, porque
    // aquelas stats não são dela (events.rs). Esses syncs são ~20% do total.
    // Se o K/D/A saísse do sync mais recente, ele sumiria da tela a cada morte
    // ("fora do jogo") e só voltaria no respawn. Por isso as stats de cada um
    // vêm do último sync em que o bloco "player" era dele mesmo.
    db.prepare(`
      SELECT steamid, data, MAX(ts) AS ts FROM match_events
      WHERE match_id = ? AND type = 'STATE_SYNC'
        AND json_extract(data, '$.player') IS NOT NULL
      GROUP BY steamid`).all(matchId),
    db.prepare(`
      SELECT lp.steamid, lp.team, p.name, p.avatar
      FROM lobby_players lp LEFT JOIN players p ON p.steamid = lp.steamid
      WHERE lp.code = ?`).all(match.code),
    db.prepare(`
      SELECT data, ts FROM match_events
      WHERE match_id = ? AND type = 'GAME_OVER' ORDER BY ts DESC LIMIT 1`).get(matchId),
  ]);

  const syncByPlayer = new Map(syncs.map((r) => [r.steamid, { ts: r.ts, state: parse(r.data) }]));
  const ownByPlayer = new Map(ownSyncs.map((r) => [r.steamid, { ts: r.ts, state: parse(r.data) }]));

  // Contexto global: o STATE_SYNC mais recente (todos veem o mesmo placar).
  let latest = null;
  for (const { ts, state } of syncByPlayer.values()) {
    if (state && (!latest || ts > latest.ts)) latest = { ts, state };
  }
  const g = latest?.state ?? {};

  const players = roster.map((p) => montaJogador(p, syncByPlayer.get(p.steamid), ownByPlayer.get(p.steamid)));

  // O placar do STATE_SYNC pode estar até 10s atrasado (intervalo do sync).
  // No fim de jogo o GAME_OVER traz o placar capturado na hora exata — é ele
  // que vale, senão o último round podia ficar de fora do resultado.
  const overData = over ? parse(over.data) : null;
  const scoreCt = overData?.score_ct ?? g.score_ct ?? null;
  const scoreT = overData?.score_t ?? g.score_t ?? null;

  const ladoA = ladoDoTimeA(players);
  const temPlacar = ladoA !== null && scoreCt !== null && scoreT !== null;

  return {
    match,
    finished: Boolean(over) || g.map_phase === 'gameover',
    map: g.map ?? null,
    round: g.round ?? null,
    round_phase: g.round_phase ?? null,
    map_phase: g.map_phase ?? null,
    score_ct: scoreCt,
    score_t: scoreT,
    lado_a: ladoA,
    score_a: temPlacar ? (ladoA === 'CT' ? scoreCt : scoreT) : null,
    score_b: temPlacar ? (ladoA === 'CT' ? scoreT : scoreCt) : null,
    updated: latest?.ts ?? null,
    players,
  };
}

/** Um jogador do roster + o que o client dele reportou. */
function montaJogador(p, sync, own) {
  const ps = own?.state?.player ?? null;
  // O sync mais recente veio sem bloco próprio, mas já houve um antes: a
  // pessoa está assistindo um colega, ou seja, morta neste round. O health
  // do sync antigo é de quando ela ainda estava viva — não vale mais.
  const espectando = Boolean(ps) && Boolean(sync?.state) && !sync.state.player;
  return {
    steamid: p.steamid,
    name: p.name,
    avatar: p.avatar,
    team: p.team,                          // A / B (plataforma)
    side: ps?.team ?? null,                // CT / T (CS2)
    // Dois estados diferentes e igualmente úteis: se o app desktop está
    // conectado (senão a pessoa esqueceu de abrir) e se o CS2 já mandou
    // dados (senão ela ainda não entrou na partida).
    client_online: isConnected(p.steamid),
    no_jogo: Boolean(ps),
    health: espectando ? 0 : (ps?.health ?? null),
    kills: ps?.kills ?? null,
    deaths: ps?.deaths ?? null,
    assists: ps?.assists ?? null,
    mvps: ps?.mvps ?? null,
    updated: sync?.ts ?? null,
  };
}

/**
 * De que lado (CT/T) está o time A? Voto da maioria dos jogadores que
 * reportaram — empate ou ninguém reportando significa que não dá pra
 * traduzir o placar do CS2 pros times da plataforma.
 */
function ladoDoTimeA(players) {
  const votos = { CT: 0, T: 0 };
  for (const p of players) {
    if (!p.side || !p.team) continue;
    // Time B no lado X significa time A no lado oposto.
    const lado = p.team === 'A' ? p.side : (p.side === 'CT' ? 'T' : 'CT');
    if (lado === 'CT' || lado === 'T') votos[lado]++;
  }
  if (votos.CT === votos.T) return null;
  return votos.CT > votos.T ? 'CT' : 'T';
}

/** Estado ao vivo pelo código do lobby (o site só conhece o code). */
export async function liveStateByCode(code) {
  const match = await db.prepare(
    'SELECT id FROM live_matches WHERE code = ? ORDER BY id DESC LIMIT 1'
  ).get(String(code).toUpperCase());
  if (!match) throw new HttpError(404, 'Nenhuma partida para esse lobby.');
  return liveState(match.id);
}
