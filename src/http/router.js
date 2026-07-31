// http/router.js — casa a requisição com a tabela de rotas e cuida do que é
// igual pra todas: chave interna, serialização e tratamento de erro.
import { HttpError } from '../auth.js';
import { rotas } from './routes.js';
import { json, requireInternalKey } from './helpers.js';
import { log } from '../log.js';

/** Devolve { rota, params } ou null. params = grupos capturados da regex. */
function casar(method, pathname) {
  for (const rota of rotas) {
    if (rota.method !== method) continue;
    if (typeof rota.path === 'string') {
      if (rota.path === pathname) return { rota, params: [] };
      continue;
    }
    const m = rota.path.exec(pathname);
    if (m) return { rota, params: m.slice(1) };
  }
  return null;
}

export async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    const achou = casar(req.method, pathname);
    if (!achou) return json(res, 404, { erro: 'Rota não encontrada.' });

    if (achou.rota.interna) requireInternalKey(req);
    const corpo = await achou.rota.handler({ req, params: achou.params });
    return json(res, 200, corpo);
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { erro: e.message });
    log(`erro em ${req.method} ${pathname}:`, e.message);
    json(res, 500, { erro: 'Erro interno.' });
  }
}
