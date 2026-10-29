import fs from 'node:fs';
import path from 'node:path';
import { capture, run, killTree } from './exec.js';
import { registerSecret } from './redact.js';
import * as git from './git.js';

// Marcas de "preciso de um humano": prompt de senha, keychain trancado, TTY ausente.
const PROMPT_RE = /password:|passphrase|user interaction is not allowed|errSecInteractionNotAllowed|could not read Password|terminal prompts disabled|no tty|not a terminal|authentication required/i;

const STEP_LABELS = {
  installing_dependencies: 'Dependencias',
  building: 'Build',
  archiving: 'Archive',
  uploading: 'Upload TestFlight',
};

/** Reads KEY=value lines from a file owned by the build account; values are masked in logs. */
function loadSecrets(file) {
  if (!file || !fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    out[key] = value;
    registerSecret(value);
  }
  return out;
}

async function freeGigabytes(dir) {
  const res = await capture('/bin/df', ['-k', dir]);
  const line = res.stdout.split('\n').pop() ?? '';
  const available = Number(line.trim().split(/\s+/)[3]);
  return Number.isFinite(available) ? available / 1024 / 1024 : Infinity;
}

export class Runner {
  constructor(cfg, store) {
    this.cfg = cfg;
    this.store = store;
    this.current = null; // { jobId, signalRef }
    this.draining = false;
  }

  /** Single worker loop: at most one build runs at a time, by construction. */
  async pump() {
    if (this.current || this.draining) return;
    const next = this.store.queued()[0];
    if (!next) return;
    this.current = { jobId: next.id, signalRef: { child: null } };
    try {
      await this.#runJob(next);
    } catch (err) {
      this.#fail(next, next.state, err.message);
    } finally {
      this.current = null;
      setImmediate(() => this.pump());
    }
  }

  requestCancel(jobId) {
    const job = this.store.get(jobId);
    if (!job) return false;
    if (job.state === 'queued') {
      this.store.setState(jobId, 'cancelled', { finishedAt: new Date().toISOString() });
      this.store.audit({ event: 'job_cancelled', jobId, number: job.number, while: 'queued' });
      return true;
    }
    if (this.current?.jobId !== jobId) return false;
    this.store.update(jobId, { cancelRequested: true });
    this.log(job, 'Cancelamento solicitado, encerrando o passo atual...');
    killTree(this.current.signalRef.child, 'SIGTERM');
    setTimeout(() => killTree(this.current?.signalRef.child, 'SIGKILL'), 15_000);
    return true;
  }

  log(job, line) {
    this.store.appendLog(job.id, line);
  }

  #fail(job, stage, message) {
    this.store.setState(job.id, 'failed', {
      failedStage: stage,
      error: message,
      finishedAt: new Date().toISOString(),
    });
    this.log(job, `FALHOU em ${stage}: ${message}`);
    this.store.audit({ event: 'job_finished', jobId: job.id, number: job.number, result: 'failed', stage, message });
  }

  #cancelled(job) {
    const fresh = this.store.get(job.id);
    return Boolean(fresh?.cancelRequested);
  }

  async #runJob(job) {
    const env = this.cfg.environments[job.environment];
    const worktree = path.join(this.cfg.paths.workspacesRoot, job.id);
    const artifacts = path.join(worktree, '.build-center-artifacts');
    this.store.update(job.id, { startedAt: new Date().toISOString() });
    this.store.audit({ event: 'job_started', jobId: job.id, number: job.number, branch: job.branch, environment: job.environment });

    try {
      // --- preparing -------------------------------------------------------
      this.store.setState(job.id, 'preparing');
      this.log(job, `Build #${job.number} — ${job.branch} / ${env.label}`);
      this.log(job, `Vai subir como ${job.buildName} (${job.buildNumber}), pedido por ${job.requestedBy}`);
      fs.mkdirSync(this.cfg.paths.workspacesRoot, { recursive: true });
      const free = await freeGigabytes(this.cfg.paths.workspacesRoot);
      this.log(job, `Espaco livre: ${free.toFixed(1)} GB`);
      if (free < this.cfg.limits.minFreeDiskGB) {
        await this.cleanupWorkspaces(0, job);
        const after = await freeGigabytes(this.cfg.paths.workspacesRoot);
        if (after < this.cfg.limits.minFreeDiskGB) {
          throw new Error(`Espaco em disco insuficiente (${after.toFixed(1)} GB livres).`);
        }
      }
      await this.cleanupWorkspaces(this.cfg.limits.keepWorkspaces, job);
      await git.ensureMirror(this.cfg, (l) => this.log(job, l));
      if (this.#cancelled(job)) return this.#finishCancelled(job, worktree);

      // --- fetching --------------------------------------------------------
      this.store.setState(job.id, 'fetching');
      this.log(job, 'Atualizando repositorio');
      await git.fetchMirror(this.cfg);
      const sha = await git.resolveBranch(this.cfg, job.branch);
      const subject = await git.commitSubject(this.cfg, sha);
      this.store.update(job.id, { sha, shortSha: sha.slice(0, 7), commitSubject: subject });
      this.log(job, `Commit resolvido: ${sha.slice(0, 7)} ${subject}`);
      this.store.audit({ event: 'commit_resolved', jobId: job.id, number: job.number, sha });
      if (this.#cancelled(job)) return this.#finishCancelled(job, worktree);

      // --- checking_out ----------------------------------------------------
      this.store.setState(job.id, 'checking_out');
      this.log(job, 'Preparando workspace isolado');
      await git.addWorktree(this.cfg, worktree, sha);
      fs.mkdirSync(artifacts, { recursive: true });
      this.#injectFiles(job, env, worktree);
      if (this.#cancelled(job)) return this.#finishCancelled(job, worktree);

      // --- configured steps -------------------------------------------------
      const secrets = loadSecrets(this.cfg.secretsFile);
      for (const step of env.steps) {
        if (this.#cancelled(job)) return this.#finishCancelled(job, worktree);
        this.store.setState(job.id, step.stage);
        this.log(job, `== ${STEP_LABELS[step.stage] ?? step.stage} ==`);
        const ok = await this.#runStep(job, step, { worktree, artifacts, sha, secrets });
        if (this.#cancelled(job)) return this.#finishCancelled(job, worktree);
        if (!ok) {
          this.#fail(job, step.stage, `O passo "${STEP_LABELS[step.stage] ?? step.stage}" terminou com erro.`);
          this.#keepForPostMortem(job, worktree);
          return;
        }
      }

      this.store.setState(job.id, 'success', { finishedAt: new Date().toISOString() });
      this.log(job, 'Build concluido e enviado ao TestFlight.');
      this.store.audit({ event: 'job_finished', jobId: job.id, number: job.number, result: 'success', sha });
      await this.#cleanupJobWorktree(job, worktree);
    } catch (err) {
      this.#fail(job, this.store.get(job.id)?.state ?? 'preparing', err.message);
      this.#keepForPostMortem(job, worktree);
    }
  }

  /**
   * Copies the declared files (secrets, signing material) into the fresh worktree.
   * Destinations are validated at config load; `to` can never come from a request.
   */
  #injectFiles(job, env, worktree) {
    for (const entry of env.files) {
      const target = path.resolve(worktree, entry.to);
      if (!target.startsWith(`${worktree}/`)) throw new Error('Destino de arquivo escapa do workspace.');
      if (!fs.existsSync(entry.from)) {
        if (entry.required) throw new Error(`Arquivo obrigatorio ausente: ${path.basename(entry.from)}`);
        this.log(job, `Arquivo opcional ausente, seguindo sem ele: ${entry.to}`);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(entry.from, target);
      fs.chmodSync(target, 0o600);
      this.log(job, `Arquivo de ambiente instalado: ${entry.to}`);
    }
  }

  async #runStep(job, step, ctx) {
    const substitutions = {
      '{{worktree}}': ctx.worktree,
      '{{artifacts}}': ctx.artifacts,
      '{{archive}}': path.join(ctx.artifacts, 'App.xcarchive'),
      '{{export}}': path.join(ctx.artifacts, 'export'),
      '{{branch}}': job.branch,
      '{{environment}}': job.environment,
      '{{sha}}': ctx.sha,
      '{{shortSha}}': ctx.sha.slice(0, 7),
      '{{jobId}}': job.id,
      '{{buildNumber}}': String(job.buildNumber),
      '{{buildName}}': String(job.buildName),
    };
    const substitute = (value) =>
      Object.entries(substitutions).reduce((acc, [token, replacement]) => acc.split(token).join(replacement), value);

    const args = step.args.map(substitute);
    const cwd = path.resolve(ctx.worktree, step.cwd);
    if (!cwd.startsWith(ctx.worktree)) throw new Error('cwd do passo escapa do workspace.');

    // A deliberately small environment: the build never inherits the agent's own env.
    const stepEnv = {
      PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin',
             ...this.cfg.toolchainPath].join(':'),
      HOME: process.env.HOME,
      LANG: 'en_US.UTF-8',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      CI: '1',
      BUILD_CENTER_BRANCH: job.branch,
      BUILD_CENTER_ENVIRONMENT: job.environment,
      BUILD_CENTER_COMMIT: ctx.sha,
      BUILD_CENTER_BUILD_NUMBER: String(job.buildNumber),
      BUILD_CENTER_BUILD_NAME: String(job.buildName),
      BUILD_CENTER_ARTIFACTS: ctx.artifacts,
      ...ctx.secrets,
      ...Object.fromEntries(Object.entries(step.env).map(([k, v]) => [k, substitute(v)])),
    };

    this.log(job, `$ ${path.basename(step.program)} ${args.join(' ')}`);
    // O stdin de todo filho e /dev/null (ver exec.js), entao nada aqui consegue
    // perguntar nada: uma ferramenta que tenta ler senha recebe EOF e falha com um
    // erro que raramente diz "faltou credencial". Quando esse padrao aparece, o log
    // diz com todas as letras — e diz tambem que a resposta nao e dar a senha.
    let pediuInteracao = false;
    const result = await run({
      program: step.program,
      args,
      cwd,
      env: stepEnv,
      onLine: (line) => {
        if (PROMPT_RE.test(line)) pediuInteracao = true;
        this.log(job, line);
      },
      timeoutMs: (step.timeoutMinutes ?? this.cfg.limits.jobTimeoutMinutes) * 60_000,
      signalRef: this.current?.signalRef,
    });
    if (result.timedOut) this.log(job, 'Passo interrompido por timeout.');
    if (result.error) this.log(job, `Erro ao executar o passo: ${result.error}`);
    if (result.code !== 0 && pediuInteracao) {
      this.log(job, 'Algo neste passo tentou pedir senha ou interacao. O agent roda sem terminal e');
      this.log(job, 'nao tem como responder — de proposito. Isso e configuracao faltando, nao senha:');
      this.log(job, 'rode o pre-voo no painel para ver qual item esta vermelho.');
    }
    return result.code === 0;
  }

  async #finishCancelled(job, worktree) {
    this.store.setState(job.id, 'cancelled', { finishedAt: new Date().toISOString() });
    this.log(job, 'Build cancelado.');
    this.store.audit({ event: 'job_finished', jobId: job.id, number: job.number, result: 'cancelled' });
    await this.#cleanupJobWorktree(job, worktree);
  }

  // A build that failed is the one case where the workspace is worth money: the
  // .xcarchive, the Pods, the logs of the tool that broke. Removing it here threw
  // away exactly the evidence needed — flutter had just said "open the xcarchive
  // in Xcode" and the directory was gone a second later. Retention is enforced by
  // cleanupWorkspaces() before the next build instead, so this stays bounded.
  #keepForPostMortem(job, worktree) {
    if (!fs.existsSync(worktree)) return;
    this.log(job, `Workspace preservado para diagnostico: ${worktree}`);
    this.log(job, `Sera removido quando passar de ${this.cfg.limits.keepWorkspaces} workspaces guardados.`);
  }

  async #cleanupJobWorktree(job, worktree) {
    try {
      if (fs.existsSync(worktree)) await git.removeWorktree(this.cfg, worktree);
    } catch {
      /* best effort; the retention pass below picks up leftovers */
    }
  }

  /** Removes all but the newest `keep` workspaces. Only ever touches workspacesRoot. */
  async cleanupWorkspaces(keep, job) {
    const root = this.cfg.paths.workspacesRoot;
    if (!fs.existsSync(root)) return;
    const activeId = this.current?.jobId;
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[0-9a-f-]{36}$/.test(e.name) && e.name !== activeId)
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(root, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const entry of entries.slice(keep)) {
      const target = path.join(root, entry.name);
      if (path.dirname(target) !== root) continue; // paranoia: never escape the root
      if (job) this.log(job, `Removendo workspace antigo ${entry.name.slice(0, 8)}`);
      try {
        await git.removeWorktree(this.cfg, target);
      } catch {
        /* ignore */
      }
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}
