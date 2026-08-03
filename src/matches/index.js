// matches/ — tudo sobre a partida ao vivo, separado por responsabilidade:
//
//   lifecycle.js   liga/desliga a coleta nos clients (START_MATCH/END_MATCH)
//   events.js      recebe e valida os eventos que os clients mandam
//   live-state.js  monta o placar ao vivo a partir dos STATE_SYNC (leitura)
//   scoring.js     registra o resultado: elo, histórico, lobby finalizado
//   sweep.js       rede de segurança (registro pendente, coleta órfã, 4h)
//   rrs/           quanto de elo a partida vale (métricas, PIS, Δelo)
//
// Este arquivo é só a fachada: quem usa importa daqui e não precisa saber
// em qual módulo cada coisa mora.
export { startMatch, endMatch, resync } from './lifecycle.js';
export { handleClientEvent } from './events.js';
export { liveState, liveStateByCode } from './live-state.js';
export { registrarPlacar } from './scoring.js';
export { encerrarPartidasAbandonadas } from './sweep.js';
