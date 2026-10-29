// Escreve o config da demo com os caminhos da maquina onde foi rodado.
// Existe como arquivo separado porque precisa do hashCode do proprio projeto —
// a demo usa o mesmo caminho de autenticacao que a instalacao real, so com um
// codigo publicado de proposito.
import fs from 'node:fs';
import path from 'node:path';
import { hashCode } from '../src/auth.js';

const [raiz, demo, codigo] = process.argv.slice(2);
if (!raiz || !demo || !codigo) {
  console.error('uso: demo-config.mjs <raiz-do-projeto> <diretorio-da-demo> <codigo>');
  process.exit(1);
}

const passo = (stage, rotulo, segundos) => ({
  stage,
  label: rotulo,
  program: path.join(raiz, 'mock', 'step.sh'),
  args: [rotulo, String(segundos)],
});

const ambiente = (label, segundos) => ({
  label,
  enabled: true,
  steps: [
    passo('installing_dependencies', 'dependencias', segundos),
    passo('building', 'compilando', segundos + 2),
    passo('uploading', 'enviando', segundos),
  ],
});

const cfg = {
  // Porta diferente da instalacao real de proposito: quem ja tem o agent rodando
  // em 8787 consegue subir a demo ao lado sem derrubar nada.
  http: { host: '127.0.0.1', port: 8788, secureCookies: false, trustForwardedFor: false },
  repo: {
    url: path.join(demo, 'src-repo'),
    mirrorPath: path.join(demo, 'agent', 'repo.git'),
    defaultBranch: 'develop',
    branchAllowPatterns: ['^develop$', '^main$', '^feat/', '^fix/', '^release/'],
  },
  toolchainPath: [],
  paths: {
    workspacesRoot: path.join(demo, 'agent', 'workspaces'),
    logsRoot: path.join(demo, 'agent', 'logs'),
    stateFile: path.join(demo, 'agent', 'state.json'),
    auditFile: path.join(demo, 'agent', 'audit.jsonl'),
  },
  limits: {
    maxConcurrentBuilds: 1,
    maxQueue: 5,
    minSecondsBetweenBuilds: 0,
    minFreeDiskGB: 1,
    keepWorkspaces: 2,
    jobTimeoutMinutes: 10,
    sessionHours: 12,
  },
  // Sem segundo fator na demo: o objetivo e ver a fila e o log, nao cadastrar
  // um autenticador. Numa instalacao real o useradd cadastra sempre.
  security: { requireTotp: false },
  environments: {
    development: ambiente('Development', 2),
    staging: ambiente('Staging', 3),
    production: {
      label: 'Production',
      enabled: false,
      lockedReason: 'Producao fica trancada na demo, para mostrar como o bloqueio aparece.',
      steps: [],
    },
  },
  secretsFile: null,
  users: [{ name: 'dev-remoto', role: 'dev', ...hashCode(codigo) }],
};

fs.writeFileSync(path.join(demo, 'config.json'), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
console.log('    ' + path.join(demo, 'config.json'));
