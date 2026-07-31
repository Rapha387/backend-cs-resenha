// http/helpers.js — encanamento HTTP puro: ler corpo, responder JSON,
// descobrir o IP, exigir a chave interna. Nada de regra de negócio aqui.
import { HttpError } from '../auth.js';

export function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Corpo grande demais.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(new HttpError(400, 'JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

export function clientIp(req) {
  // X-Forwarded-For é forjável por qualquer cliente — só pode ser levado a
  // sério quando um proxy reverso confiável (nginx/Caddy/Railway) o preenche.
  // Sem TRUST_PROXY=1, usar o header deixaria o rate limit contornável.
  if (process.env.TRUST_PROXY === '1') {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'desconhecido';
}

export function requireInternalKey(req) {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) throw new HttpError(503, 'INTERNAL_API_KEY não configurada no backend.');
  if (req.headers['x-internal-key'] !== expected) throw new HttpError(401, 'Chave interna inválida.');
}
