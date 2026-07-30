// version.js — controle de versão do Resenha Client.
//
// O backend é a fonte de verdade: o site serve o instalador como arquivo
// estático, mas é AQUI que se decide qual versão é a atual e se um client
// antigo pode operar. Client desatualizado recebe UPDATE_REQUIRED no HELLO
// e não coleta nada até atualizar.
//
// Pra lançar uma versão nova:
//   1. bump em resenha-client (Cargo.toml + tauri.conf.json) e `tauri build`;
//   2. copia o instalador pro site (public/client/ResenhaClient-setup.exe);
//   3. sobe CLIENT_LATEST aqui (ou via env CLIENT_LATEST_VERSION no Render);
//   4. deploy do site e do backend.

export const CLIENT_LATEST = process.env.CLIENT_LATEST_VERSION || '0.2.0';

// URL absoluta do instalador (o app desktop não sabe o endereço do site).
// Ex.: https://resenha.vercel.app/client/ResenhaClient-setup.exe
export const CLIENT_DOWNLOAD_URL = process.env.CLIENT_DOWNLOAD_URL || '';

/** a < b em semver simples (x.y.z numérico; partes ausentes valem 0). */
export function versaoMenor(a, b) {
  const pa = String(a ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}
