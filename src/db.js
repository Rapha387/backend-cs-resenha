// db.js — mesmo banco Turso (libSQL) do site, mesma superfície de API do
// lib/db.js do site (prepare().get/.all/.run + batch). As tabelas do site
// (players, lobbies, lobby_players, client_pair_codes…) já existem lá; aqui
// só criamos as tabelas exclusivas do backend.
import { createClient } from '@libsql/client';

let _client = null;

function client() {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TURSO_DATABASE_URL não configurada. Use o MESMO banco do site — é nele ' +
      'que estão os lobbies e os códigos de pareamento.'
    );
  }
  _client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  return _client;
}

const SCHEMA = [
  // Também declarada no site (DDL idêntica): quem subir primeiro cria — o
  // pareamento não pode depender da ordem de deploy.
  `CREATE TABLE IF NOT EXISTS client_pair_codes (
    code TEXT PRIMARY KEY,
    steamid TEXT NOT NULL,
    expires INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    created INTEGER
  )`,
  // Sessões do Resenha Client (tokens opacos; rotacionados a cada refresh)
  `CREATE TABLE IF NOT EXISTS client_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    steamid TEXT NOT NULL,
    access_token TEXT UNIQUE NOT NULL,
    access_expires INTEGER NOT NULL,
    refresh_token TEXT UNIQUE NOT NULL,
    refresh_expires INTEGER NOT NULL,
    created INTEGER
  )`,
  // Partidas ao vivo (o matchId que o client recebe no START_MATCH)
  `CREATE TABLE IF NOT EXISTS live_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    status TEXT DEFAULT 'ativa',
    started INTEGER,
    ended INTEGER
  )`,
  // Eventos crus enviados pelos clients durante a partida
  `CREATE TABLE IF NOT EXISTS match_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL,
    steamid TEXT NOT NULL,
    type TEXT NOT NULL,
    ts INTEGER,
    data TEXT
  )`,

  // ---- Índices ----
  // As consultas quentes do liveState filtram (match_id, type) e agregam
  // MAX(ts) por steamid — (match_id, type, steamid, ts) atende as três:
  // STATE_SYNC por jogador, STATE_SYNC próprio e GAME_OVER ORDER BY ts.
  // O índice antigo (match_id, steamid, type) tinha o type no fim, então
  // toda leitura varria os eventos de TODOS os tipos da partida.
  `DROP INDEX IF EXISTS idx_match_events_match`,
  `CREATE INDEX IF NOT EXISTS idx_match_events_lookup ON match_events (match_id, type, steamid, ts)`,
  // startMatch/endMatch/liveStateByCode buscam por code (a tabela guarda o
  // histórico inteiro); a varredura busca por status + started.
  `CREATE INDEX IF NOT EXISTS idx_live_matches_code ON live_matches (code, status)`,
  `CREATE INDEX IF NOT EXISTS idx_live_matches_status ON live_matches (status, started)`,
  // Faxina de sessões vencidas a cada pareamento.
  `CREATE INDEX IF NOT EXISTS idx_client_sessions_refresh_expires ON client_sessions (refresh_expires)`,
];

let _schema = null;
function ensureSchema() {
  _schema ??= client().batch(SCHEMA, 'write');
  return _schema;
}

function toObject(row, columns) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

const bind = (args) => args.map((a) => (a === undefined ? null : a));

async function execute(sql, args) {
  await ensureSchema();
  return client().execute({ sql, args: bind(args) });
}

export const db = {
  prepare(sql) {
    return {
      async get(...args) {
        const rs = await execute(sql, args);
        return rs.rows[0] ? toObject(rs.rows[0], rs.columns) : undefined;
      },
      async all(...args) {
        const rs = await execute(sql, args);
        return rs.rows.map((r) => toObject(r, rs.columns));
      },
      async run(...args) {
        return execute(sql, args);
      },
    };
  },
  async batch(statements) {
    await ensureSchema();
    return client().batch(
      statements.map((s) => ({ sql: s.sql, args: bind(s.args ?? []) })),
      'write'
    );
  },
};
