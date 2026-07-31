// http/routes.js — a tabela de rotas. Cada entrada declara método, caminho
// (string ou regex) e o handler; o encanamento fica em helpers.js e o
// despacho em router.js. Pra adicionar uma rota, some uma linha aqui.
import { pair, refresh, HttpError } from '../auth.js';
import { startMatch, endMatch, liveState, liveStateByCode, encerrarPartidasAbandonadas } from '../matches/index.js';
import { connectedCount } from '../ws/registry.js';
import { rateLimit } from '../ratelimit.js';
import { CLIENT_LATEST, CLIENT_DOWNLOAD_URL } from '../version.js';
import { readBody, clientIp } from './helpers.js';

const JANELA_MS = 5 * 60 * 1000;
// Pareamento é o alvo de brute force (código de 6 chars): 10 por janela torna
// o ataque impraticável. Refresh é chamado pelo próprio client em reconexão,
// então precisa de folga.
const LIMITE_PAREAMENTO = { max: 10, windowMs: JANELA_MS };
const LIMITE_REFRESH = { max: 60, windowMs: JANELA_MS };

/** Handlers recebem { req, params } e devolvem o corpo da resposta. */
export const rotas = [
  {
    method: 'POST',
    path: '/api/client/auth/pair',
    handler: async ({ req }) => {
      limitar(req, LIMITE_PAREAMENTO);
      return pair(await readBody(req));
    },
  },
  {
    method: 'POST',
    path: '/api/client/auth/refresh',
    handler: async ({ req }) => {
      limitar(req, LIMITE_REFRESH);
      return refresh(await readBody(req));
    },
  },

  // --- rotas internas (site → backend), protegidas pela chave compartilhada ---
  {
    method: 'POST',
    path: '/internal/match/start',
    interna: true,
    handler: async ({ req }) => startMatch(await readBody(req)),
  },
  {
    method: 'POST',
    path: '/internal/match/end',
    interna: true,
    handler: async ({ req }) => endMatch(await readBody(req)),
  },
  {
    method: 'GET',
    path: /^\/internal\/match\/(\d+)\/state$/,
    interna: true,
    handler: ({ params }) => liveState(Number(params[0])),
  },
  {
    method: 'GET',
    path: /^\/internal\/lobby\/([A-Za-z0-9]{1,10})\/state$/,
    interna: true,
    handler: ({ params }) => liveStateByCode(params[0]),
  },
  {
    method: 'POST',
    path: '/internal/sweep',
    interna: true,
    handler: async () => ({ encerradas: await encerrarPartidasAbandonadas() }),
  },

  // --- públicas ---
  {
    method: 'GET',
    path: '/api/client/version',
    // O client consulta no boot pra saber se está atualizado.
    handler: () => ({ version: CLIENT_LATEST, url: CLIENT_DOWNLOAD_URL }),
  },
  {
    method: 'GET',
    path: '/health',
    handler: () => ({ ok: true, clients: connectedCount() }),
  },
];

function limitar(req, opcoes) {
  if (!rateLimit(clientIp(req), opcoes)) {
    throw new HttpError(429, 'Muitas tentativas. Espere alguns minutos.');
  }
}
