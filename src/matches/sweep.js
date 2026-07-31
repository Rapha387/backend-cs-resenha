// matches/sweep.js — rede de segurança. Roda no boot (toda acordada do plano
// free) e de hora em hora. Garante que nenhuma partida fica coletando pra
// sempre e que nenhum lobby fica preso num estado sem saída.
import { db } from '../db.js';
import { registrarPlacar } from './scoring.js';
import { pararColeta, MAX_DURACAO_MS } from './lifecycle.js';
import { log } from '../log.js';

/**
 * Três passos, nesta ordem — cada um remove casos do seguinte:
 *   1. registro pendente  → partida terminou mas não foi registrada;
 *   2. END_MATCH perdido  → placar já registrado, coleta não parou;
 *   3. abandono após 4h   → fim nunca detectado, fecha sem elo.
 * Retorna quantas partidas foram tratadas no total.
 */
export async function encerrarPartidasAbandonadas() {
  const registradas = await registrarPendentes();
  const perdidas = await pararColetaOrfa();
  const abandonadas = await abandonarVelhas();
  return registradas + perdidas + abandonadas;
}

/**
 * Passo 1 — o GAME_OVER chegou mas o registro não completou (erro transitório,
 * placar sem tradução no momento, ou o fim só apareceu num STATE_SYNC com
 * map_phase 'gameover'). Tenta em toda partida ativa de lobby 'pronto': o
 * registrarPlacar sai de graça quando a partida ainda não terminou.
 */
async function registrarPendentes() {
  const pendentes = await db.prepare(`
    SELECT lm.id FROM live_matches lm
    JOIN lobbies l ON l.code = lm.code
    WHERE lm.status = 'ativa' AND l.status = 'pronto'`).all();

  let registradas = 0;
  for (const m of pendentes) {
    try {
      if (await registrarPlacar(Number(m.id))) registradas++;
    } catch (e) {
      log(`retry do registro automático da partida #${m.id} falhou:`, e.message);
    }
  }
  return registradas;
}

/**
 * Passo 2 — o placar já foi registrado (lobby 'finalizado') mas o END_MATCH
 * não chegou: o backend estava dormindo e o cold start estourou o timeout do
 * site. Como o banco é compartilhado, dá pra detectar por aqui.
 */
async function pararColetaOrfa() {
  const perdidas = await db.prepare(`
    SELECT lm.id, lm.code FROM live_matches lm
    JOIN lobbies l ON l.code = lm.code
    WHERE lm.status = 'ativa' AND l.status = 'finalizado'`).all();
  if (perdidas.length === 0) return 0;

  // "AND status = 'ativa'": um GAME_OVER pode chegar via WS entre o SELECT
  // acima e este UPDATE — quem já foi encerrado não é tocado de novo.
  await db.batch(perdidas.map((m) => ({
    sql: "UPDATE live_matches SET status = 'encerrada', ended = ? WHERE id = ? AND status = 'ativa'",
    args: [Date.now(), m.id],
  })));
  for (const m of perdidas) await pararColeta(m.code);

  log(`${perdidas.length} partida(s) com END_MATCH perdido encerrada(s): ${perdidas.map((m) => m.code).join(', ')}`);
  return perdidas.length;
}

/**
 * Passo 3 — passou do tempo máximo sem fim detectável: ninguém jogou com o
 * client aberto, ou deu empate sem replay. Sem o registro manual não existe
 * mais nenhum caminho de 'pronto' pra 'finalizado', então o lobby é fechado
 * junto (status 'abandonado', sem elo) — senão ficaria preso pra sempre.
 */
async function abandonarVelhas() {
  const limite = Date.now() - MAX_DURACAO_MS;
  const velhas = await db.prepare(
    "SELECT id, code FROM live_matches WHERE status = 'ativa' AND started <= ?"
  ).all(limite);
  if (velhas.length === 0) return 0;

  await db.batch([
    ...velhas.map((m) => ({
      // Mesma guarda do passo 2: não sobrescreve partida que acabou de ser
      // encerrada por um registro que chegou no meio da varredura.
      sql: "UPDATE live_matches SET status = 'abandonada', ended = ? WHERE id = ? AND status = 'ativa'",
      args: [Date.now(), m.id],
    })),
    ...velhas.map((m) => ({
      sql: "UPDATE lobbies SET status = 'abandonado' WHERE code = ? AND status = 'pronto'",
      args: [m.code],
    })),
  ]);
  for (const m of velhas) await pararColeta(m.code);

  log(`${velhas.length} partida(s) abandonada(s) encerrada(s): ${velhas.map((m) => m.code).join(', ')}`);
  return velhas.length;
}
