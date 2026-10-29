// Pre-voo: tudo que, se estiver errado, so apareceria no minuto 40 de um build —
// ou pior, depois que o dono da maquina ja estiver longe.
//
// Este modulo so LE. Nao conserta nada, nao pede senha, nao guarda segredo. Cada
// item diz o que esta errado e qual e o comando ou a tela que resolve, porque o
// conserto e sempre uma decisao de quem e dono do Mac.
import fs from 'node:fs';
import path from 'node:path';
import { capture } from './exec.js';
import { credentialStorePath } from './git.js';
import * as git from './git.js';

const ok = (label, detail) => ({ label, state: 'ok', detail, fix: null });
const warn = (label, detail, fix) => ({ label, state: 'warn', detail, fix });
const fail = (label, detail, fix) => ({ label, state: 'fail', detail, fix });

async function checkRepo(cfg) {
  if (!fs.existsSync(credentialStorePath(cfg))) {
    return fail('Acesso ao repositorio', 'Nenhum token gravado para o agent.',
      'Cole um PAT no cartao "Acesso ao repositorio", escopo Code (Read).');
  }
  try {
    await git.fetchMirror(cfg);
    return ok('Acesso ao repositorio', 'O agent autentica e atualiza o mirror.');
  } catch {
    return fail('Acesso ao repositorio', 'O token nao esta sendo aceito pelo servidor.',
      'Gere outro PAT e grave no cartao "Acesso ao repositorio".');
  }
}

async function checkCertificate() {
  const res = await capture('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const linhas = res.stdout.split('\n').filter((l) => /^\s*\d+\)/.test(l));
  const distribution = linhas.filter((l) => /Apple Distribution|iPhone Distribution/.test(l));
  if (distribution.length) {
    return ok('Certificado de distribuicao', `${distribution.length} encontrado(s) no keychain.`);
  }
  return fail('Certificado de distribuicao',
    `Nenhum. Ha ${linhas.length} identidade(s), todas de desenvolvimento — nao servem para TestFlight.`,
    'Aceite o contrato pendente em developer.apple.com (Account > Agreements) e gere um Apple Distribution.');
}

function checkProfiles() {
  const dir = path.join(process.env.HOME, 'Library/MobileDevice/Provisioning Profiles');
  let arquivos = [];
  try {
    arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.mobileprovision'));
  } catch {
    /* diretorio nem existe */
  }
  if (arquivos.length) return ok('Perfis de provisionamento', `${arquivos.length} instalado(s).`);
  return warn('Perfis de provisionamento', 'Nenhum instalado nesta conta.',
    'Com signing automatico o Xcode cria na hora, mas precisa do certificado antes.');
}

function lerChaves(secretsFile) {
  // Devolve os NOMES das chaves que tem valor. O valor em si nao sai desta funcao,
  // nao e devolvido e nao vai para log — so a resposta "tem algo ali ou nao".
  //
  // Contar nome vazio como preenchido seria pior que nao checar: o pre-voo ficaria
  // verde num arquivo de placeholders, que e exatamente o arquivo que acabamos de
  // criar para ser preenchido depois.
  try {
    const nomes = new Set();
    for (const linha of fs.readFileSync(secretsFile, 'utf8').split('\n')) {
      const limpa = linha.trim();
      if (!limpa || limpa.startsWith('#')) continue;
      const eq = limpa.indexOf('=');
      if (eq < 1) continue;
      const valor = limpa.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (valor) nomes.add(limpa.slice(0, eq).trim());
    }
    return nomes;
  } catch {
    return null;
  }
}

function checkAppStoreKey(cfg) {
  const esperadas = ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEYS_DIR'];
  const conserto = 'Crie a chave em App Store Connect > Users and Access > Integrations, salve o .p8 e aponte o secretsFile para ele.';
  if (!cfg.secretsFile || !fs.existsSync(cfg.secretsFile)) {
    return fail('Chave da App Store Connect', `O secretsFile nao existe (${cfg.secretsFile ?? 'nao configurado'}).`, conserto);
  }
  const chaves = lerChaves(cfg.secretsFile);
  const faltando = esperadas.filter((k) => !chaves?.has(k));
  if (faltando.length) {
    return fail('Chave da App Store Connect', `Sem valor no secretsFile: ${faltando.join(', ')}.`, conserto);
  }
  const dir = path.join(process.env.HOME, '.appstoreconnect/private_keys');
  const p8 = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.p8')) : [];
  if (!p8.length) return fail('Chave da App Store Connect', `Nenhum .p8 em ${dir}.`, conserto);
  return ok('Chave da App Store Connect', `${p8.length} chave(s) .p8 instalada(s), com as tres variaveis definidas.`);
}

async function checkKeychain() {
  const res = await capture('/usr/bin/security', ['show-keychain-info', path.join(process.env.HOME, 'Library/Keychains/login.keychain-db')]);
  if (/no-timeout/.test(res.stdout)) {
    return ok('Keychain de login', 'Destravado e sem timeout — codesign nao vai pedir senha.');
  }
  if (res.code !== 0) {
    return fail('Keychain de login', 'Trancado. codesign falharia sem conseguir perguntar nada.',
      'Abra o Acesso as Chaves e desmarque o bloqueio automatico do keychain de login.');
  }
  return warn('Keychain de login', `Tem timeout de bloqueio: ${res.stdout.trim()}`,
    'Desmarque "bloquear apos N minutos" no keychain de login, senao um build longo trava.');
}

async function checkSleep() {
  const res = await capture('/usr/bin/pmset', ['-g']);
  const linha = res.stdout.split('\n').find((l) => /^\s*sleep\s/.test(l)) ?? '';
  const minutos = Number(linha.trim().split(/\s+/)[1]);
  if (minutos === 0) return ok('Sono da maquina', 'Configurada para nunca dormir.');
  return fail('Sono da maquina', `Dorme depois de ${minutos} minuto(s) ociosa. O painel some junto.`,
    'sudo pmset -a sleep 0 disksleep 0');
}

async function checkDisk(cfg) {
  const res = await capture('/bin/df', ['-g', cfg.paths.workspacesRoot]);
  const livre = Number(res.stdout.trim().split('\n').pop()?.split(/\s+/)[3]);
  if (!Number.isFinite(livre)) return warn('Espaco em disco', 'Nao consegui medir.', null);
  if (livre >= cfg.limits.minFreeDiskGB) return ok('Espaco em disco', `${livre} GB livres.`);
  return fail('Espaco em disco', `${livre} GB livres, abaixo do minimo de ${cfg.limits.minFreeDiskGB} GB.`,
    'Libere espaco; builds sao recusados antes de comecar.');
}

function checkEnvFiles(cfg) {
  const faltando = [];
  for (const env of Object.values(cfg.environments)) {
    if (!env.enabled) continue;
    for (const f of env.files) if (f.required && !fs.existsSync(f.from)) faltando.push(`${env.name}: ${path.basename(f.from)}`);
  }
  if (!faltando.length) return ok('Secrets por ambiente', 'Todos os arquivos declarados existem.');
  return fail('Secrets por ambiente', `Faltando — ${faltando.join(', ')}.`,
    'Rode scripts/install.sh de novo apontando para o checkout do projeto.');
}

function checkLastUpload(store) {
  const sucesso = [...store.jobs].reverse().find((j) => j.state === 'success');
  if (sucesso) {
    return ok('Ultimo envio ao TestFlight',
      `Build #${sucesso.number}, ${sucesso.branch} / ${sucesso.environment}, ${sucesso.buildName} (${sucesso.buildNumber}).`);
  }
  return warn('Ultimo envio ao TestFlight', 'Nenhum build chegou ao TestFlight por este agent ainda.',
    'Faca um envio de stg daqui antes de viajar — e a unica prova de que a cadeia inteira funciona.');
}

export async function preflight(cfg, store) {
  const [repo, cert, asc, keychain, sono, disco] = await Promise.all([
    checkRepo(cfg),
    checkCertificate(),
    Promise.resolve(checkAppStoreKey(cfg)),
    checkKeychain(),
    checkSleep(),
    checkDisk(cfg),
  ]);
  return [repo, cert, checkProfiles(), asc, keychain, sono, disco, checkEnvFiles(cfg), checkLastUpload(store)];
}
