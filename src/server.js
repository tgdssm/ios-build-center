import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, TERMINAL_STATES } from './config.js';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { Sessions, verifyCode } from './auth.js';
import { verificarTotp } from './totp.js';
import { registerSecret } from './redact.js';
import * as git from './git.js';
import { preflight } from './preflight.js';

const cfg = loadConfig();
const store = new Store(cfg);
const runner = new Runner(cfg, store);
const sessions = new Sessions(cfg);
for (const user of cfg.users) registerSecret(user.hash);

// Usuario inexistente paga o mesmo scrypt que um real. Sem isso o login responde
// em ~2ms para nome que nao existe e ~34ms para nome que existe, e cronometrar as
// duas respostas entrega a lista de contas sem precisar acertar codigo nenhum.
const SOMBRA = { salt: 'f'.repeat(32), hash: '0'.repeat(64), totpSecret: null };

const branchCache = { items: [], fetchedAt: 0, refreshing: false, error: null };
const lastBuildByUser = new Map();
// Separate from the login limiter: a rejected token is a different kind of mistake
// from a wrong access code, and one should not lock the other out.
const credentialAttempts = new Map(); // ip -> {count, until}

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
};
const json = (res, status, data) =>
  send(res, status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8' });

const clientIp = (req) => {
  if (cfg.http.trustForwardedFor) {
    const forwarded = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
};

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function readJsonBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function publicJob(job) {
  return {
    id: job.id,
    number: job.number,
    branch: job.branch,
    environment: job.environment,
    requestedBy: job.requestedBy,
    requestedAt: job.requestedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    state: job.state,
    stages: job.stages,
    shortSha: job.shortSha,
    buildName: job.buildName ?? null,
    buildNumber: job.buildNumber ?? null,
    commitSubject: job.commitSubject ?? null,
    error: job.error,
    failedStage: job.failedStage,
    cancelRequested: job.cancelRequested,
    durationSeconds:
      job.startedAt && job.finishedAt
        ? Math.round((new Date(job.finishedAt) - new Date(job.startedAt)) / 1000)
        : null,
  };
}

async function refreshBranches(force = false) {
  const stale = Date.now() - branchCache.fetchedAt > 60_000;
  if (branchCache.refreshing || (!force && !stale && branchCache.items.length)) return branchCache.items;
  branchCache.refreshing = true;
  try {
    await git.ensureMirror(cfg);
    // A failed fetch must not empty the list. The mirror on disk still answers
    // for-each-ref perfectly well offline, and a stale list the person can act on
    // beats an empty one that looks like "this repo has no branches". We say it
    // is stale instead of pretending it is fresh.
    try {
      await git.fetchMirror(cfg);
      branchCache.error = null;
    } catch (err) {
      branchCache.error = err.message;
      console.error('[branches] fetch falhou, usando o mirror local:', err.message);
    }
    branchCache.items = await git.listBranches(cfg);
    branchCache.fetchedAt = Date.now();
  } catch (err) {
    branchCache.error = err.message;
    console.error('[branches]', err.message);
  } finally {
    branchCache.refreshing = false;
  }
  return branchCache.items;
}

// ---- SSE -------------------------------------------------------------------
const clients = new Set();
const broadcast = (event, data) => {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
};
store.on('job', (job) => {
  broadcast('job', publicJob(job));
  if (TERMINAL_STATES.includes(job.state)) broadcast('jobs', store.recent().map(publicJob));
});
store.on('log', (entry) => broadcast('log', entry));

// ---- static ----------------------------------------------------------------
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
};

// ---- routing ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  const ip = clientIp(req);

  try {
    if (req.method === 'GET' && STATIC[route]) {
      const [file, type] = STATIC[route];
      return send(res, 200, fs.readFileSync(path.join(ROOT, file)), { 'content-type': type });
    }

    if (route === '/api/login' && req.method === 'POST') {
      if (sessions.throttled(ip)) return json(res, 429, { error: 'Muitas tentativas. Tente de novo mais tarde.' });
      const body = await readJsonBody(req);
      const user = cfg.users.find((u) => u.name === body.name);
      const alvo = user ?? SOMBRA;
      const codigoOk = typeof body.code === 'string' && verifyCode(body.code, alvo.salt, alvo.hash);
      let ok = Boolean(user) && codigoOk;
      // Segundo fator depois do primeiro, e com a MESMA mensagem de erro la embaixo.
      // Responder "codigo 2FA invalido" confirmaria que o primeiro fator ja esta
      // certo, que e metade do trabalho de quem esta tentando entrar.
      if (ok && (user.totpSecret || cfg.security.requireTotp)) {
        if (!user.totpSecret) {
          ok = false; // requireTotp ligado e conta sem cadastrar: nao entra.
        } else {
          const contador = verificarTotp(user.totpSecret, body.totp);
          if (contador === null || sessions.totpUsado(user.name, contador)) ok = false;
          else sessions.marcarTotp(user.name, contador);
        }
      }
      if (!ok) {
        sessions.recordFailure(ip);
        store.audit({ event: 'login_failed', name: String(body.name ?? '').slice(0, 40), ip });
        return json(res, 401, { error: 'Usuario ou codigo invalido.' });
      }
      sessions.recordSuccess(ip);
      const { cookie, data } = sessions.issue(user);
      store.audit({ event: 'login', name: user.name, role: user.role, ip });
      const maxAge = cfg.limits.sessionHours * 3600;
      const flags = `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${cfg.http.secureCookies ? '; Secure' : ''}`;
      return send(res, 200, JSON.stringify({ name: user.name, role: user.role, csrf: data.csrf }), {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `bc_session=${cookie}; ${flags}`,
      });
    }

    // Everything below requires a session.
    const session = sessions.verify(readCookie(req, 'bc_session'));

    if (route === '/api/session' && req.method === 'GET') {
      return json(
        res,
        session ? 200 : 401,
        session ? { name: session.u, role: session.r ?? 'dev', csrf: session.csrf } : { error: 'unauthenticated' },
      );
    }
    if (!session) return json(res, 401, { error: 'unauthenticated' });

    const mutating = req.method === 'POST';
    if (mutating && req.headers['x-bc-csrf'] !== session.csrf) {
      return json(res, 403, { error: 'csrf' });
    }

    if (route === '/api/logout' && mutating) {
      return send(res, 204, '', { 'set-cookie': 'bc_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' });
    }

    if (route === '/api/bootstrap' && req.method === 'GET') {
      const branches = await refreshBranches(url.searchParams.get('refresh') === '1');
      const owner = session.r === 'owner';
      return json(res, 200, {
        user: session.u,
        role: session.r ?? 'dev',
        // Only the owner is told anything about the credential, and even then only
        // whether one exists and when it was written.
        credential: owner ? git.credentialInfo(cfg) : null,
        branches,
        branchesStale: Boolean(branchCache.error),
        branchesError: branchCache.error,
        defaultBranch: cfg.repo.defaultBranch,
        environments: Object.values(cfg.environments).map((e) => {
          const roleOk = !e.requiresRole || e.requiresRole === session.r;
          return {
            name: e.name,
            label: e.label,
            enabled: e.enabled && roleOk,
            lockedReason: !e.enabled
              ? e.lockedReason
              : roleOk
                ? null
                : `${e.label} so pode ser disparado pelo dono da maquina.`,
          };
        }),
        jobs: store.recent().map(publicJob),
      });
    }

    // So leitura, e so para o dono: diz o que falta configurar NESTA maquina antes
    // que falte no minuto 40 de um build, com alguem do outro lado do mundo.
    if (route === '/api/preflight' && req.method === 'GET') {
      if (session.r !== 'owner') return json(res, 403, { error: 'Somente o dono da maquina ve essa checagem.' });
      return json(res, 200, { checks: await preflight(cfg, store), at: new Date().toISOString() });
    }

    // O que o pubspec da branch declara. Existe para o formulario mostrar de onde
    // o numero sai, em vez de pedir que alguem digite as cegas.
    if (route === '/api/branch-version' && req.method === 'GET') {
      const wanted = String(url.searchParams.get('branch') ?? '');
      if (!git.looksLikeBranch(wanted)) return json(res, 400, { error: 'Nome de branch invalido.' });
      const known = await refreshBranches();
      if (!known.some((b) => b.name === wanted)) return json(res, 400, { error: 'Branch nao esta na lista permitida.' });
      try {
        return json(res, 200, await git.readVersion(cfg, wanted));
      } catch {
        return json(res, 200, { name: null, number: null });
      }
    }

    if (route === '/api/builds' && mutating) {
      const body = await readJsonBody(req);
      const branch = String(body.branch ?? '');
      const environment = String(body.environment ?? '');

      const env = cfg.environments[environment];
      if (!env) return json(res, 400, { error: 'Ambiente desconhecido.' });
      if (!env.enabled) return json(res, 403, { error: env.lockedReason });
      // Checado no servidor, a partir do papel que vem no cookie assinado. A UI
      // esconde o ambiente, mas esconder e cortesia — a recusa e aqui.
      if (env.requiresRole && session.r !== env.requiresRole) {
        store.audit({ event: 'build_denied', name: session.u, environment, reason: 'role', ip });
        return json(res, 403, { error: `${env.label} so pode ser disparado pelo dono da maquina.` });
      }
      if (!env.steps.length) return json(res, 400, { error: 'Ambiente sem passos de build configurados.' });

      // Versao e numero vem de quem pede, nunca de um contador escondido do agent.
      // Sao valores, nao flags: o formato e fechado aqui e so depois viram argumento.
      const buildName = String(body.buildName ?? '').trim();
      if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(buildName)) {
        return json(res, 400, { error: 'Versao invalida. Use o formato 5.1.1.' });
      }
      const buildNumber = Number(body.buildNumber);
      if (!Number.isInteger(buildNumber) || buildNumber < 1 || buildNumber > 2_000_000_000) {
        return json(res, 400, { error: 'Build number invalido. Use um inteiro positivo.' });
      }
      // Guarda barata contra o pior desperdicio possivel: compilar 40 minutos e so
      // entao a Apple recusar o upload por numero repetido.
      const jaUsado = store.jobs.find((j) => j.buildNumber === buildNumber && j.state === 'success');
      if (jaUsado) {
        return json(res, 409, { error: `O build number ${buildNumber} ja foi enviado pelo build #${jaUsado.number}.` });
      }

      if (!git.looksLikeBranch(branch)) return json(res, 400, { error: 'Nome de branch invalido.' });
      const branches = await refreshBranches();
      if (!branches.some((b) => b.name === branch)) {
        return json(res, 400, { error: 'Branch nao esta na lista permitida.' });
      }

      if (store.queued().length >= cfg.limits.maxQueue) {
        return json(res, 429, { error: 'Fila cheia. Aguarde os builds atuais terminarem.' });
      }
      const duplicate = store.jobs.find(
        (j) => !TERMINAL_STATES.includes(j.state) && j.branch === branch && j.environment === environment,
      );
      if (duplicate) {
        return json(res, 409, { error: `Ja existe o build #${duplicate.number} para essa branch e ambiente.` });
      }
      const last = lastBuildByUser.get(session.u) ?? 0;
      const wait = Math.ceil((cfg.limits.minSecondsBetweenBuilds * 1000 - (Date.now() - last)) / 1000);
      if (wait > 0) return json(res, 429, { error: `Aguarde ${wait}s antes de pedir outro build.` });
      lastBuildByUser.set(session.u, Date.now());

      const job = store.create({ branch, environment, requestedBy: session.u, buildName, buildNumber });
      setImmediate(() => runner.pump());
      return json(res, 202, publicJob(job));
    }

    // Replaces the token the agent uses to read the repository. This exists so that
    // a PAT expiring while the owner is away does not require a terminal on the Mac
    // — which is the one thing this whole system is supposed to avoid needing.
    //
    // Bounds on what this route can do, all of them on purpose:
    //   - owner only, and the role comes from the signed cookie, never the body;
    //   - it writes ONE file, the agent's own store under ~/build-agent, never the
    //     account's ~/.git-credentials, and never anything else;
    //   - the value is not logged, not echoed back, not kept in memory after the
    //     call, and not readable through any route;
    //   - a rejected token leaves the previous one in place (see git.setCredential).
    if (route === '/api/credential' && mutating) {
      if (session.r !== 'owner') {
        store.audit({ event: 'credential_denied', name: session.u, ip });
        return json(res, 403, { error: 'Somente o dono da maquina pode trocar esse token.' });
      }
      const limit = credentialAttempts.get(ip);
      if (limit && limit.count >= 5 && limit.until > Date.now()) {
        return json(res, 429, { error: 'Muitas tentativas. Espere alguns minutos.' });
      }

      const body = await readJsonBody(req, 2048);
      const token = typeof body.pat === 'string' ? body.pat.trim() : '';
      // Shape only. Printable, no spaces, plausible length — enough to catch a
      // truncated paste without the server ever reasoning about the contents.
      if (!/^[\x21-\x7e]{20,400}$/.test(token)) {
        return json(res, 400, { error: 'Isso nao parece um token. Cole o valor inteiro, sem espacos.' });
      }
      // Safety net, not the primary defence: if this value ever turned up in a log
      // line by some path we did not foresee, redact() now masks it.
      registerSecret(token);

      try {
        await git.setCredential(cfg, token);
      } catch (err) {
        const entry = credentialAttempts.get(ip) ?? { count: 0, until: 0 };
        entry.count += 1;
        entry.until = Date.now() + 10 * 60_000;
        credentialAttempts.set(ip, entry);
        store.audit({ event: 'credential_rejected', name: session.u, ip });
        return json(res, 400, { error: err.message, detail: err.detail ?? null });
      }

      credentialAttempts.delete(ip);
      store.audit({ event: 'credential_updated', name: session.u, ip });
      console.log(`[credential] token do repositorio atualizado por ${session.u}`);
      await refreshBranches(true);
      return json(res, 200, {
        ok: true,
        credential: git.credentialInfo(cfg),
        branches: branchCache.items.length,
        branchesStale: Boolean(branchCache.error),
        branchesError: branchCache.error,
      });
    }

    const cancelMatch = route.match(/^\/api\/jobs\/([0-9a-f-]{36})\/cancel$/);
    if (cancelMatch && mutating) {
      const ok = runner.requestCancel(cancelMatch[1]);
      return json(res, ok ? 202 : 409, ok ? { ok: true } : { error: 'Este job nao pode ser cancelado agora.' });
    }

    const logMatch = route.match(/^\/api\/jobs\/([0-9a-f-]{36})\/log$/);
    if (logMatch && req.method === 'GET') {
      const job = store.get(logMatch[1]);
      if (!job) return json(res, 404, { error: 'not found' });
      return json(res, 200, { job: publicJob(job), lines: store.logFor(job.id) });
    }

    if (route === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return undefined;
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[http]', err.message);
    return json(res, 400, { error: 'Requisicao invalida.' });
  }
});

server.listen(cfg.http.port, cfg.http.host, () => {
  console.log(`iOS Build Center em http://${cfg.http.host}:${cfg.http.port}`);
  console.log(`Repo mirror: ${cfg.repo.mirrorPath}`);
  console.log(`Ambientes: ${Object.values(cfg.environments).map((e) => `${e.name}${e.enabled ? '' : ' (bloqueado)'}`).join(', ')}`);
  refreshBranches(true);
  runner.pump();
});

const shutdown = () => {
  runner.draining = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
