// auth.js — pareamento do Resenha Client e sessões (tokens opacos no banco).
//
// Fluxo: o usuário loga no SITE com a Steam e gera um código de 6 caracteres
// (tabela client_pair_codes, escrita pelo site). Aqui trocamos esse código
// por um par access/refresh. O access expira rápido; o refresh rotaciona.
import crypto from 'crypto';
import { db } from './db.js';

const ACCESS_TTL = 60 * 60 * 1000; // 1 hora
const REFRESH_TTL = 90 * 24 * 60 * 60 * 1000; // 90 dias

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const newToken = () => crypto.randomBytes(32).toString('hex');

async function createSession(steamid) {
  const now = Date.now();
  const access_token = newToken();
  const refresh_token = newToken();
  await db.prepare(`
    INSERT INTO client_sessions (steamid, access_token, access_expires, refresh_token, refresh_expires, created)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(steamid, access_token, now + ACCESS_TTL, refresh_token, now + REFRESH_TTL, now);
  return { access_token, refresh_token };
}

/** POST /api/client/auth/pair { code } → { access_token, refresh_token } */
export async function pair(body) {
  const code = String(body?.code ?? '').trim().toUpperCase();
  if (!code) throw new HttpError(400, 'Informe o código de conexão.');

  const now = Date.now();
  const row = await db.prepare('SELECT * FROM client_pair_codes WHERE code = ?').get(code);
  if (!row || row.used || row.expires < now) {
    throw new HttpError(401, 'Código inválido ou expirado. Gere outro no site.');
  }

  // "used = 0" no WHERE fecha a corrida: se dois pedidos chegarem juntos,
  // só um consegue marcar o código como usado.
  const upd = await db.prepare('UPDATE client_pair_codes SET used = 1 WHERE code = ? AND used = 0').run(code);
  if (Number(upd.rowsAffected) === 0) {
    throw new HttpError(401, 'Código inválido ou expirado. Gere outro no site.');
  }

  // Faxina barata: sessões com refresh vencido nunca mais autenticam nada.
  await db.prepare('DELETE FROM client_sessions WHERE refresh_expires < ?').run(now);

  // Sessões antigas do mesmo jogador continuam válidas de propósito: permite
  // reparear (PC novo, reinstalação) sem derrubar nada — e dá pra revogar
  // apagando da tabela client_sessions.
  return createSession(row.steamid);
}

/** POST /api/client/auth/refresh { refresh_token } → novo par (rotaciona os dois) */
export async function refresh(body) {
  const token = String(body?.refresh_token ?? '').trim();
  if (!token) throw new HttpError(400, 'Informe o refresh_token.');

  const now = Date.now();
  const session = await db.prepare('SELECT * FROM client_sessions WHERE refresh_token = ?').get(token);
  if (!session) throw new HttpError(401, 'Sessão não encontrada.');
  if (session.refresh_expires < now) {
    await db.prepare('DELETE FROM client_sessions WHERE id = ?').run(session.id);
    throw new HttpError(401, 'Sessão expirada. Pareie o client novamente.');
  }

  const access_token = newToken();
  const refresh_token = newToken();
  await db.prepare(`
    UPDATE client_sessions
    SET access_token = ?, access_expires = ?, refresh_token = ?, refresh_expires = ?
    WHERE id = ?`
  ).run(access_token, now + ACCESS_TTL, refresh_token, now + REFRESH_TTL, session.id);
  return { access_token, refresh_token };
}

/** Valida o "Authorization: Bearer x" do handshake WebSocket. */
export async function sessionFromAuthHeader(header) {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) return null;
  const session = await db.prepare('SELECT * FROM client_sessions WHERE access_token = ?').get(match[1].trim());
  if (!session || session.access_expires < Date.now()) return null;
  return { steamid: session.steamid, sessionId: session.id };
}
