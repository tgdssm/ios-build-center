import fs from 'node:fs';
import path from 'node:path';
import { capture } from './exec.js';
import { isAllowedBranch } from './config.js';
import { redact } from './redact.js';

const GIT = '/usr/bin/git';

// Conservative: what git itself accepts is wider than what we want to see here.
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._][A-Za-z0-9._\/-]{0,120}$/;

export function looksLikeBranch(name) {
  return typeof name === 'string' && BRANCH_RE.test(name) && !name.endsWith('/') && !name.endsWith('.lock');
}

function gitEnv(cfg) {
  // The agent gets its OWN credential store and is forbidden from touching the
  // account's ~/.git-credentials. This is not tidiness: the "store" helper ERASES
  // an entry when the server answers 401, so one failed fetch here would wipe the
  // credential the person uses for their own work. That happened once during
  // testing — build #2 fetched fine, build #3 got a 401, and afterwards neither
  // the mirror nor the person's own checkout could authenticate.
  //
  // credential.helper="" clears every helper inherited from the global config;
  // the second entry then sets the only one the agent may use.
  const store = credentialStorePath(cfg);
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: '0', // never block on a credential prompt
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? '',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: `store --file=${store}`,
  };
}

export async function ensureMirror(cfg, onLine = () => {}) {
  if (fs.existsSync(path.join(cfg.repo.mirrorPath, 'HEAD'))) return;
  fs.mkdirSync(path.dirname(cfg.repo.mirrorPath), { recursive: true });
  onLine('Clonando mirror do repositorio (primeira execucao, pode demorar)');
  const res = await capture(GIT, ['clone', '--mirror', cfg.repo.url, cfg.repo.mirrorPath], {
    env: gitEnv(cfg),
    timeoutMs: 30 * 60_000,
  });
  if (res.code !== 0) throw new Error('Falha ao clonar o mirror do repositorio.');
}

export async function fetchMirror(cfg) {
  const res = await capture(GIT, ['--git-dir', cfg.repo.mirrorPath, 'remote', 'update', '--prune'], {
    env: gitEnv(cfg),
    timeoutMs: 10 * 60_000,
  });
  if (res.code !== 0) throw new Error('Falha ao atualizar o repositorio (git remote update).');
}

export async function listBranches(cfg) {
  const res = await capture(
    GIT,
    ['--git-dir', cfg.repo.mirrorPath, 'for-each-ref', '--format=%(refname:short)%09%(committerdate:iso8601)', 'refs/heads/'],
    { env: gitEnv(cfg) },
  );
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, date] = line.split('\t');
      return { name, lastCommit: date };
    })
    .filter((b) => looksLikeBranch(b.name) && isAllowedBranch(cfg, b.name))
    .sort((a, b) => new Date(b.lastCommit) - new Date(a.lastCommit));
}

export async function resolveBranch(cfg, branch) {
  if (!looksLikeBranch(branch)) throw new Error('Nome de branch invalido.');
  if (!isAllowedBranch(cfg, branch)) throw new Error('Branch fora da lista permitida.');
  // `--` and the refs/heads/ prefix keep this from resolving anything but a branch.
  const res = await capture(GIT, ['--git-dir', cfg.repo.mirrorPath, 'rev-parse', '--verify', `refs/heads/${branch}`], {
    env: gitEnv(cfg),
  });
  if (res.code !== 0 || !/^[0-9a-f]{40}$/.test(res.stdout)) {
    throw new Error(`Branch nao encontrada no repositorio: ${branch}`);
  }
  return res.stdout;
}

/**
 * Le a versao declarada no pubspec.yaml de uma branch, direto do mirror.
 *
 * Serve para o painel mostrar de onde o numero sai, em vez de pedir que alguem
 * digite as cegas. Nao e autoridade sobre nada: e o que esta escrito na branch, e
 * quem pede o build decide se e isso mesmo que vai subir.
 */
export async function readVersion(cfg, branch) {
  if (!looksLikeBranch(branch) || !isAllowedBranch(cfg, branch)) throw new Error('Nome de branch invalido.');
  const res = await capture(GIT, ['--git-dir', cfg.repo.mirrorPath, 'show', `refs/heads/${branch}:pubspec.yaml`], {
    env: gitEnv(cfg),
  });
  if (res.code !== 0) return { name: null, number: null };
  const match = res.stdout.match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)(?:\+([0-9]+))?/m);
  if (!match) return { name: null, number: null };
  return { name: match[1], number: match[2] ? Number(match[2]) : null };
}

export async function addWorktree(cfg, worktreePath, sha) {
  const res = await capture(GIT, ['--git-dir', cfg.repo.mirrorPath, 'worktree', 'add', '--detach', worktreePath, sha], {
    env: gitEnv(cfg),
    timeoutMs: 10 * 60_000,
  });
  if (res.code !== 0) throw new Error('Falha ao preparar o workspace isolado (git worktree).');
}

export async function removeWorktree(cfg, worktreePath) {
  await capture(GIT, ['--git-dir', cfg.repo.mirrorPath, 'worktree', 'remove', '--force', worktreePath], {
    env: gitEnv(cfg),
  });
  await capture(GIT, ['--git-dir', cfg.repo.mirrorPath, 'worktree', 'prune'], { env: gitEnv(cfg) });
}

export async function commitSubject(cfg, sha) {
  const res = await capture(GIT, ['--git-dir', cfg.repo.mirrorPath, 'log', '-1', '--format=%s', sha], { env: gitEnv(cfg) });
  return res.code === 0 ? res.stdout.split('\n')[0] : '';
}

/**
 * The agent's own credential store. Deliberately NOT ~/.git-credentials: see the
 * comment in gitEnv() for what sharing that file cost us once.
 */
export function credentialStorePath(cfg) {
  return path.join(path.dirname(cfg.paths.stateFile), 'git-credentials');
}

/** Whether a token is stored and when it was written. Never its value. */
export function credentialInfo(cfg) {
  try {
    const stat = fs.statSync(credentialStorePath(cfg));
    return { present: stat.size > 0, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { present: false, updatedAt: null };
  }
}

/**
 * Replaces the token the agent uses to read the repository, after proving it works.
 *
 * Three properties here are deliberate:
 *
 *  - The candidate is tested against a TEMPORARY store and only replaces the real
 *    one on success, by rename, which is atomic. A truncated paste therefore cannot
 *    take down a credential that was still working. That is the exact opposite of
 *    what the "store" helper does unattended, where a single 401 erases the entry.
 *  - The token is written by this process with fs, mode 600. It never becomes an
 *    argv entry, never reaches a child process's command line, and is never logged.
 *  - Only this file ever touches the file. The HTTP layer hands over a string and
 *    gets back nothing but success or a message.
 */
export async function setCredential(cfg, token) {
  const target = credentialStorePath(cfg);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const url = new URL(cfg.repo.url);
  const username = url.username || 'token';
  const probe = path.join(dir, `.git-credentials.candidate.${process.pid}`);
  const line = `${url.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(token)}@${url.host}\n`;
  fs.writeFileSync(probe, line, { mode: 0o600 });

  try {
    const res = await capture(GIT, ['ls-remote', '--heads', cfg.repo.url, cfg.repo.defaultBranch], {
      env: { ...gitEnv(cfg), GIT_CONFIG_VALUE_1: `store --file=${probe}` },
      timeoutMs: 60_000,
    });
    if (res.code !== 0) {
      const err = new Error('O servidor do repositorio nao aceitou esse token.');
      // git prints the URL without the password, and the token only ever existed
      // inside the probe file — but redact() runs anyway before this is shown.
      err.detail = redact(res.stdout).slice(0, 400);
      throw err;
    }
    fs.renameSync(probe, target);
  } finally {
    if (fs.existsSync(probe)) fs.unlinkSync(probe);
  }
}
