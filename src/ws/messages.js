// ws/messages.js — o que fazer com cada mensagem que o client manda.
import { resync } from '../matches/lifecycle.js';
import { handleClientEvent } from '../matches/events.js';
import { CLIENT_LATEST, CLIENT_DOWNLOAD_URL, versaoMenor } from '../version.js';
import { esquecer } from './registry.js';
import { log } from '../log.js';

export async function handleMessage(steamid, msg, ws) {
  // Conexão bloqueada por versão: inerte. Só o HELLO é processado (pra
  // reavisar), todo o resto é descartado antes de tocar no banco.
  if (ws.bloqueado && msg.type !== 'HELLO') return;

  switch (msg.type) {
    case 'HELLO':
      return hello(steamid, msg, ws);
    case 'MATCH_ACK':
      return log(`${steamid} confirmou START_MATCH da partida #${msg.matchId}`);
    case 'MATCH_ENDED_ACK':
      return log(`${steamid} confirmou END_MATCH`);
    case 'PONG':
      return;
    default:
      // Eventos de partida (ROUND_START, PLAYER_KILL, STATE_SYNC…)
      if (typeof msg.type === 'string' && msg.matchId !== undefined) {
        await handleClientEvent(steamid, msg);
      }
  }
}

async function hello(steamid, msg, ws) {
  log(`HELLO de ${steamid} (client v${msg.version ?? '?'})`);

  if (versaoMenor(msg.version, CLIENT_LATEST)) {
    bloquearPorVersao(steamid, msg, ws);
    return;
  }

  // Reconectou já atualizado numa conexão antes marcada? Libera.
  ws.bloqueado = false;
  // Ressincronização obrigatória do contrato: reenvia o estado atual
  // (START_MATCH se tem partida ativa, END_MATCH se não tem).
  await resync(steamid);
}

/**
 * Client desatualizado não opera — sem resync, sem receber START_MATCH e sem
 * gravar evento nenhum.
 *
 * A conexão NÃO é fechada de propósito: o client 0.1.0 (que já está instalado
 * nas máquinas e não conhece UPDATE_REQUIRED) trata o close como queda e
 * reconecta com backoff de 1s, o que viraria um martelo de uma conexão por
 * segundo por pessoa — cada uma consultando a sessão no Turso e segurando o
 * Render free acordado. Deixando aberta, ele fica parado. O client novo fecha
 * sozinho ao receber o aviso.
 */
function bloquearPorVersao(steamid, msg, ws) {
  ws.bloqueado = true;
  esquecer(steamid);
  log(`client de ${steamid} desatualizado (v${msg.version ?? '?'} < v${CLIENT_LATEST}) — bloqueado`);
  ws.send(JSON.stringify({
    type: 'UPDATE_REQUIRED',
    latest: CLIENT_LATEST,
    url: CLIENT_DOWNLOAD_URL,
  }));
}
