import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { segredoValido } from './totp.js';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const STAGES = [
  'queued',
  'preparing',
  'fetching',
  'checking_out',
  'installing_dependencies',
  'building',
  'archiving',
  'uploading',
];
export const TERMINAL_STATES = ['success', 'failed', 'cancelled'];
const CONFIGURABLE_STAGES = new Set([
  'installing_dependencies',
  'building',
  'archiving',
  'uploading',
]);

const expand = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.resolve(ROOT, p));

function fail(msg) {
  throw new Error(`config: ${msg}`);
}

// Only this file decides what may be executed. Nothing from an HTTP request ever
// becomes a program name, an argument that is not a validated branch/environment,
// or a path. Keep it that way.
function validateStep(step, envName, index) {
  const where = `environments.${envName}.steps[${index}]`;
  if (!CONFIGURABLE_STAGES.has(step.stage)) {
    fail(`${where}.stage must be one of ${[...CONFIGURABLE_STAGES].join(', ')}`);
  }
  if (typeof step.program !== 'string' || !step.program.startsWith('/')) {
    fail(`${where}.program must be an absolute path (no shell lookup, no shell string)`);
  }
  if (!Array.isArray(step.args) || step.args.some((a) => typeof a !== 'string')) {
    fail(`${where}.args must be an array of strings`);
  }
  if (step.cwd !== undefined && (typeof step.cwd !== 'string' || step.cwd.startsWith('/') || step.cwd.includes('..'))) {
    fail(`${where}.cwd must be a relative path inside the worktree`);
  }
  if (step.env !== undefined && (typeof step.env !== 'object' || step.env === null)) {
    fail(`${where}.env must be an object`);
  }
  return {
    stage: step.stage,
    label: step.label || step.stage,
    program: step.program,
    args: step.args,
    cwd: step.cwd || '.',
    env: step.env || {},
    timeoutMinutes: step.timeoutMinutes,
  };
}

// Files the agent injects into the fresh worktree before any step runs (secrets,
// signing material). Declared here only — a request can never name a file.
function validateFile(entry, envName, index) {
  const where = `environments.${envName}.files[${index}]`;
  if (typeof entry.from !== 'string') fail(`${where}.from must be a string`);
  // Expand "~" first, then demand the RESOLVED path be absolute: the guarantee we
  // want is about where the file really is, not about how it was spelled.
  const from = expand(entry.from);
  if (!from.startsWith('/')) fail(`${where}.from must resolve to an absolute path`);
  if (typeof entry.to !== 'string' || entry.to.startsWith('/') || entry.to.includes('..')) {
    fail(`${where}.to must be a relative path inside the worktree`);
  }
  return { from, to: entry.to, required: entry.required !== false };
}

// Two roles only. "dev" asks for builds; "owner" can also replace the token the
// agent uses to read the repository. Nothing else differs, and neither role can
// name a command, a path or a file.
export const ROLES = ['dev', 'owner'];

function validateUser(entry, index) {
  const where = `users[${index}]`;
  if (!entry || typeof entry !== 'object') fail(`${where} must be an object`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(entry.name ?? '')) fail(`${where}.name is not a safe identifier`);
  if (!/^[0-9a-f]{32}$/.test(entry.salt ?? '')) fail(`${where}.salt must be 32 hex characters`);
  if (!/^[0-9a-f]{64}$/.test(entry.hash ?? '')) fail(`${where}.hash must be 64 hex characters`);
  // The default is the LOWER privilege on purpose: a config written before roles
  // existed, or one with the field misspelled, yields a plain dev. Becoming the
  // owner has to be written out deliberately, never inherited by accident.
  const role = entry.role ?? 'dev';
  if (!ROLES.includes(role)) fail(`${where}.role must be one of ${ROLES.join(', ')}`);
  // Segundo fator por conta. Opcional no objeto para nao quebrar uma config escrita
  // antes dele existir — mas security.requireTotp recusa o login de quem nao tem,
  // e e esse par que deve estar ligado quando o painel ficar publico.
  const totpSecret = entry.totpSecret ?? null;
  if (totpSecret !== null && !segredoValido(totpSecret)) {
    fail(`${where}.totpSecret must be base32 (A-Z and 2-7, 16-64 chars)`);
  }
  return { name: entry.name, salt: entry.salt, hash: entry.hash, role, totpSecret };
}

export function loadConfig(file) {
  const configPath = file || process.env.BUILD_CENTER_CONFIG || path.join(ROOT, 'config.json');
  if (!fs.existsSync(configPath)) fail(`${configPath} not found (copy config.example.json)`);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const cfg = {
    configPath,
    http: {
      host: raw.http?.host ?? '127.0.0.1',
      port: raw.http?.port ?? 8787,
      secureCookies: raw.http?.secureCookies !== false,
      trustForwardedFor: raw.http?.trustForwardedFor === true,
    },
    repo: {
      url: raw.repo?.url,
      mirrorPath: expand(raw.repo?.mirrorPath ?? '~/build-agent/repo.git'),
      defaultBranch: raw.repo?.defaultBranch ?? 'develop',
      branchAllowPatterns: (raw.repo?.branchAllowPatterns ?? ['.']).map((p) => new RegExp(p)),
    },
    // Directories appended to the build's PATH. The base PATH stays minimal; the
    // operator declares the toolchains a build needs (rbenv for CocoaPods, for
    // example) instead of the agent inheriting whatever the login shell has.
    toolchainPath: (raw.toolchainPath ?? []).map((p, i) => {
      if (typeof p !== 'string') fail(`toolchainPath[${i}] must be a string`);
      const dir = expand(p);
      if (!dir.startsWith('/')) fail(`toolchainPath[${i}] must resolve to an absolute path`);
      return dir;
    }),
    paths: {
      workspacesRoot: expand(raw.paths?.workspacesRoot ?? '~/build-agent/workspaces'),
      logsRoot: expand(raw.paths?.logsRoot ?? '~/build-agent/logs'),
      stateFile: expand(raw.paths?.stateFile ?? '~/build-agent/state.json'),
      auditFile: expand(raw.paths?.auditFile ?? '~/build-agent/audit.jsonl'),
    },
    limits: {
      maxConcurrentBuilds: 1, // deliberately not configurable above 1
      maxQueue: raw.limits?.maxQueue ?? 5,
      minSecondsBetweenBuilds: raw.limits?.minSecondsBetweenBuilds ?? 60,
      minFreeDiskGB: raw.limits?.minFreeDiskGB ?? 25,
      keepWorkspaces: raw.limits?.keepWorkspaces ?? 3,
      jobTimeoutMinutes: raw.limits?.jobTimeoutMinutes ?? 60,
      sessionHours: raw.limits?.sessionHours ?? 12,
    },
    environments: {},
    // Interruptor unico para a diferenca entre "painel em casa" e "painel na
    // internet". Ligado, ninguem entra sem segundo fator — nem uma conta antiga
    // que ficou sem cadastrar.
    security: { requireTotp: raw.security?.requireTotp === true },
    users: (raw.users ?? []).map(validateUser),
    secretsFile: raw.secretsFile ? expand(raw.secretsFile) : null,
  };

  if (!cfg.repo.url) fail('repo.url is required');

  for (const [name, env] of Object.entries(raw.environments ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) fail(`environment name "${name}" is not a safe identifier`);
    cfg.environments[name] = {
      name,
      label: env.label ?? name,
      enabled: env.enabled === true,
      lockedReason: env.lockedReason ?? 'Este ambiente esta bloqueado.',
      // Papel minimo para disparar este ambiente. null = qualquer pessoa logada.
      // Existe para ambientes que carregam secret de verdade: liberar o ambiente e
      // liberar para todo mundo sao duas decisoes diferentes.
      requiresRole: ((r) => {
        if (r == null) return null;
        if (!ROLES.includes(r)) fail(`environments.${name}.requiresRole must be one of ${ROLES.join(', ')}`);
        return r;
      })(env.requiresRole),
      files: (env.files ?? []).map((f, i) => validateFile(f, name, i)),
      steps: (env.steps ?? []).map((s, i) => validateStep(s, name, i)),
    };
  }
  if (!Object.keys(cfg.environments).length) fail('at least one environment is required');

  return cfg;
}

export function isAllowedBranch(cfg, branch) {
  return cfg.repo.branchAllowPatterns.some((re) => re.test(branch));
}
