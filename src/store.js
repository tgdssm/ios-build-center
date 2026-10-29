import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TERMINAL_STATES } from './config.js';
import { redact } from './redact.js';

const MAX_HISTORY = 50;
const MAX_MEMORY_LOG_LINES = 2000;

export class Store extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.jobs = [];
    this.nextNumber = 1;
    this.logs = new Map(); // jobId -> array of {t, line}
    fs.mkdirSync(path.dirname(cfg.paths.stateFile), { recursive: true });
    fs.mkdirSync(cfg.paths.logsRoot, { recursive: true });
    this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cfg.paths.stateFile, 'utf8'));
      this.jobs = raw.jobs ?? [];
      this.nextNumber = raw.nextNumber ?? 1;
    } catch {
      /* first run */
    }
    // Recover from a crash or a reboot: nothing can still be running in a fresh process.
    for (const job of this.jobs) {
      if (!TERMINAL_STATES.includes(job.state)) {
        job.state = 'failed';
        job.failedStage = job.failedStage ?? job.stage ?? 'unknown';
        job.error = 'O agent reiniciou enquanto este job estava em andamento.';
        job.finishedAt = job.finishedAt ?? new Date().toISOString();
      }
    }
    this.#persist();
  }

  #persist() {
    const tmp = `${this.cfg.paths.stateFile}.tmp`;
    const data = {
      nextNumber: this.nextNumber,
      jobs: this.jobs.slice(-MAX_HISTORY),
    };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.cfg.paths.stateFile);
  }

  audit(event) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    fs.appendFileSync(this.cfg.paths.auditFile, `${line}\n`);
  }

  create({ branch, environment, requestedBy, buildName, buildNumber }) {
    const job = {
      id: crypto.randomUUID(),
      number: this.nextNumber++,
      branch,
      environment,
      requestedBy,
      // Vem do pedido, nao de um contador do agent: quem pede escolhe e ve o que
      // vai subir. Um contador escondido ja inventou numeros uma vez aqui.
      buildName,
      buildNumber,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      state: 'queued',
      sha: null,
      shortSha: null,
      stages: [],
      error: null,
      failedStage: null,
      cancelRequested: false,
    };
    this.jobs.push(job);
    this.logs.set(job.id, []);
    this.#persist();
    this.audit({ event: 'job_requested', jobId: job.id, number: job.number, branch, environment, buildName, buildNumber, requestedBy });
    this.emit('job', job);
    return job;
  }

  update(jobId, patch) {
    const job = this.get(jobId);
    if (!job) return null;
    Object.assign(job, patch);
    this.#persist();
    this.emit('job', job);
    return job;
  }

  setState(jobId, state, extra = {}) {
    const job = this.get(jobId);
    if (!job) return null;
    if (job.state !== state) job.stages.push({ stage: state, at: new Date().toISOString() });
    return this.update(jobId, { state, ...extra });
  }

  get(jobId) {
    return this.jobs.find((j) => j.id === jobId) ?? null;
  }

  queued() {
    return this.jobs.filter((j) => j.state === 'queued');
  }

  running() {
    return this.jobs.find((j) => !TERMINAL_STATES.includes(j.state) && j.state !== 'queued') ?? null;
  }

  recent(limit = 20) {
    return this.jobs.slice(-limit).reverse();
  }

  appendLog(jobId, line) {
    const clean = redact(line).trimEnd();
    if (!clean) return;
    const entry = { t: new Date().toISOString(), line: clean };
    const buffer = this.logs.get(jobId) ?? [];
    buffer.push(entry);
    if (buffer.length > MAX_MEMORY_LOG_LINES) buffer.splice(0, buffer.length - MAX_MEMORY_LOG_LINES);
    this.logs.set(jobId, buffer);
    fs.appendFileSync(path.join(this.cfg.paths.logsRoot, `${jobId}.log`), `${entry.t} ${entry.line}\n`);
    this.emit('log', { jobId, ...entry });
  }

  logFor(jobId) {
    const inMemory = this.logs.get(jobId);
    if (inMemory) return inMemory;
    try {
      const file = path.join(this.cfg.paths.logsRoot, `${jobId}.log`);
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-MAX_MEMORY_LOG_LINES)
        .map((l) => {
          const sep = l.indexOf(' ');
          return { t: l.slice(0, sep), line: l.slice(sep + 1) };
        });
    } catch {
      return [];
    }
  }
}
