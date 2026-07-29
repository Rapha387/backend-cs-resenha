// test-abandonada.mjs — a rede de segurança contra partida que nunca recebeu
// END_MATCH (site sem internet na hora de registrar o placar, por exemplo).
// Sem isso o Resenha Client continuaria coletando pra sempre — inclusive em
// Premier/Casual, que é exatamente o que a plataforma promete não monitorar.
//   node --env-file=.env test-abandonada.mjs
import { createClient } from '@libsql/client';
import WebSocket from 'ws';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000';
const KEY = process.env.INTERNAL_API_KEY;
const LOBBY = 'ZZABD';
const STEAMID = '76561198000000071';
const CINCO_HORAS = 5 * 60 * 60 * 1000;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let falhas = 0;
const check = (nome, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!cond) falhas++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cleanup() {
  await db.batch([
    { sql: 'DELETE FROM lobby_players WHERE code = ?', args: [LOBBY] },
    { sql: 'DELETE FROM lobbies WHERE code = ?', args: [LOBBY] },
    { sql: 'DELETE FROM live_matches WHERE code = ?', args: [LOBBY] },
    { sql: 'DELETE FROM client_sessions WHERE steamid = ?', args: [STEAMID] },
    { sql: 'DELETE FROM client_pair_codes WHERE steamid = ?', args: [STEAMID] },
    { sql: 'DELETE FROM players WHERE steamid = ?', args: [STEAMID] },
  ], 'write');
}

try {
  await cleanup();
  const agora = Date.now();

  // Sessão pro client de teste
  await db.batch([
    { sql: 'INSERT INTO players (steamid, name, elo, created) VALUES (?, ?, 1000, ?)', args: [STEAMID, 'Abandonado', agora] },
    { sql: "INSERT INTO lobbies (code, owner, status, created) VALUES (?, ?, 'pronto', ?)", args: [LOBBY, STEAMID, agora] },
    { sql: "INSERT INTO lobby_players (code, steamid, team, joined) VALUES (?, ?, 'A', ?)", args: [LOBBY, STEAMID, agora] },
    { sql: 'INSERT INTO client_pair_codes (code, steamid, expires, used, created) VALUES (?, ?, ?, 0, ?)', args: ['ABDTST', STEAMID, agora + 300000, agora] },
    // Partida "esquecida": começou 5h atrás e nunca recebeu END_MATCH
    { sql: "INSERT INTO live_matches (code, status, started) VALUES (?, 'ativa', ?)", args: [LOBBY, agora - CINCO_HORAS] },
  ], 'write');

  const { access_token } = await fetch(`${BASE}/api/client/auth/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'ABDTST' }),
  }).then((r) => r.json());
  check('client pareado', Boolean(access_token));

  // Conecta e manda HELLO: o resync NÃO pode mandar START_MATCH de uma
  // partida de 5 horas atrás.
  const recebidas = [];
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/client`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  await new Promise((resolve) => ws.on('open', resolve));
  ws.on('message', (raw) => recebidas.push(JSON.parse(raw.toString())));

  ws.send(JSON.stringify({ type: 'HELLO', client: 'test', version: '0' }));
  await sleep(1000);
  check('resync ignora partida velha → END_MATCH', recebidas.some((m) => m.type === 'END_MATCH'));
  check('resync não reativa a coleta', !recebidas.some((m) => m.type === 'START_MATCH'));

  // Evento de uma partida velha também não pode ser gravado
  const velha = await db.execute({
    sql: "SELECT id FROM live_matches WHERE code = ? ORDER BY id DESC LIMIT 1", args: [LOBBY],
  });
  const matchIdVelho = Number(velha.rows[0][0]);
  ws.send(JSON.stringify({ type: 'PLAYER_KILL', matchId: matchIdVelho, data: { total: 1, delta: 1 } }));
  await sleep(1000);
  const gravados = await db.execute({
    sql: 'SELECT COUNT(*) c FROM match_events WHERE match_id = ?', args: [matchIdVelho],
  });
  check('evento de partida velha não é gravado', Number(gravados.rows[0][0]) === 0);

  // A varredura marca a partida como abandonada
  await db.execute({
    sql: "UPDATE live_matches SET status = 'ativa' WHERE id = ?", args: [matchIdVelho],
  });
  const { encerradas } = await fetch(`${BASE}/internal/sweep`, {
    method: 'POST', headers: { 'X-Internal-Key': KEY },
  }).then((r) => r.json());
  check('varredura encerrou a partida', encerradas >= 1, `encerradas=${encerradas}`);

  const status = await db.execute({
    sql: 'SELECT status FROM live_matches WHERE id = ?', args: [matchIdVelho],
  });
  check("status virou 'abandonada'", status.rows[0][0] === 'abandonada', `status=${status.rows[0][0]}`);

  // Sem o registro manual, um lobby 'pronto' de partida abandonada não teria
  // mais NENHUM caminho pra sair desse estado — a varredura fecha ele junto.
  const lobAbd = await db.execute({ sql: 'SELECT status FROM lobbies WHERE code = ?', args: [LOBBY] });
  check("lobby fechado junto (status 'abandonado')", lobAbd.rows[0][0] === 'abandonado',
    `status=${lobAbd.rows[0][0]}`);

  // END_MATCH perdido na hibernação: partida recente ainda 'ativa', mas o
  // lobby já está 'finalizado' no site (o /internal/match/end não chegou
  // porque o backend dormia). A varredura do boot precisa encerrar.
  await db.batch([
    { sql: "UPDATE lobbies SET status = 'finalizado' WHERE code = ?", args: [LOBBY] },
    { sql: "INSERT INTO live_matches (code, status, started) VALUES (?, 'ativa', ?)", args: [LOBBY, Date.now()] },
  ], 'write');
  const endsAntes = recebidas.filter((m) => m.type === 'END_MATCH').length;

  const varrida2 = await fetch(`${BASE}/internal/sweep`, {
    method: 'POST', headers: { 'X-Internal-Key': KEY },
  }).then((r) => r.json());
  check('varredura encerrou a partida com END_MATCH perdido', varrida2.encerradas >= 1,
    `encerradas=${varrida2.encerradas}`);

  const perdida = await db.execute({
    sql: 'SELECT status FROM live_matches WHERE code = ? ORDER BY id DESC LIMIT 1', args: [LOBBY],
  });
  check("lobby finalizado → partida vira 'encerrada' (não 'abandonada')",
    perdida.rows[0][0] === 'encerrada', `status=${perdida.rows[0][0]}`);

  await sleep(700);
  check('client conectado recebeu o END_MATCH atrasado',
    recebidas.filter((m) => m.type === 'END_MATCH').length > endsAntes);

  ws.close();
} finally {
  await cleanup();
  console.log(falhas === 0 ? '\n🎉 tudo passou' : `\n💥 ${falhas} falha(s)`);
  process.exit(falhas === 0 ? 0 : 1);
}
