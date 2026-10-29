const PIPELINE = [
  ['preparing', 'Preparar workspace'],
  ['fetching', 'Atualizar repositorio'],
  ['checking_out', 'Checkout'],
  ['installing_dependencies', 'Dependencias'],
  ['building', 'Build'],
  ['archiving', 'Archive'],
  ['uploading', 'Upload TestFlight'],
];
const TERMINAL = ['success', 'failed', 'cancelled'];

const state = {
  csrf: null,
  role: 'dev',
  credential: null,
  listOpen: false,
  branches: [],
  environments: [],
  jobs: [],
  selectedBranch: null,
  selectedEnv: null,
  watching: null,
  events: null,
};

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.method === 'POST') {
    headers['content-type'] = 'application/json';
    headers['x-bc-csrf'] = state.csrf;
  }
  const res = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Erro ${res.status}`);
    err.detail = body.detail ?? null;
    throw err;
  }
  return body;
}

// ---- login -----------------------------------------------------------------
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  try {
    const body = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        name: $('login-name').value.trim(),
        code: $('login-code').value,
        totp: $('login-totp').value.trim(),
      }),
    });
    state.csrf = body.csrf;
    $('login-code').value = '';
    $('login-totp').value = '';
    await enterApp(body.name, body.role);
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

async function enterApp(name, role) {
  state.role = role ?? 'dev';
  $('login').classList.add('hidden');
  $('main').classList.remove('hidden');
  $('who').textContent = role === 'owner' ? `${name} (dono)` : name;
  await bootstrap();
  connectEvents();
}

// ---- bootstrap --------------------------------------------------------------
async function bootstrap(refresh = false) {
  const data = await api(`/api/bootstrap${refresh ? '?refresh=1' : ''}`);
  state.branches = data.branches;
  state.branchesStale = data.branchesStale;
  state.branchesError = data.branchesError;
  state.environments = data.environments;
  state.jobs = data.jobs;
  state.role = data.role ?? state.role;
  state.credential = data.credential;
  if (!state.selectedBranch && data.branches.some((b) => b.name === data.defaultBranch)) {
    state.selectedBranch = data.defaultBranch;
  }
  if (!state.selectedEnv) {
    state.selectedEnv = data.environments.find((e) => e.enabled)?.name ?? null;
  }
  renderBranches();
  renderEnvironments();
  renderHistory();
  renderAdmin();
  // Primeira carga: o campo ja mostra a branch padrao e a versao que ela declara.
  // Nao sobrescreve o que a pessoa ja digitou.
  if (state.selectedBranch && !$('build-name').value) {
    $('branch-search').value = state.selectedBranch;
    loadVersion(state.selectedBranch);
  }
  const active = state.jobs.find((j) => !TERMINAL.includes(j.state));
  watch(active ?? state.jobs[0] ?? null);
}

// ---- branches ---------------------------------------------------------------
$('branch-search').addEventListener('input', () => {
  // O campo e a verdade. Se o texto deixou de ser a branch escolhida, a escolha cai
  // junto: campo mostrando uma coisa e build mandando outra e o pior resultado
  // possivel aqui. Texto que bate exatamente com uma branch ja seleciona (paste).
  const typed = $('branch-search').value.trim();
  if (typed !== state.selectedBranch) {
    state.selectedBranch = state.branches.some((b) => b.name === typed) ? typed : null;
  }
  state.listOpen = true;
  renderBranches();
});
$('branch-search').addEventListener('focus', () => {
  state.listOpen = true;
  renderBranches();
});
// Clicar fora fecha: a lista e um dropdown, nao um painel permanente.
document.addEventListener('click', (event) => {
  if (!state.listOpen) return;
  if ($('branch-search').contains(event.target) || $('branch-list').contains(event.target)) return;
  state.listOpen = false;
  renderBranches();
});
$('refresh-branches').addEventListener('click', async () => {
  $('branch-count').textContent = 'atualizando...';
  await bootstrap(true);
});

function renderBranches() {
  const query = $('branch-search').value.trim().toLowerCase();
  // Se o texto e exatamente a branch ja escolhida, ele nao e uma busca — e o rotulo
  // do que esta selecionado. Filtrar por ele deixaria a lista com um item so e
  // obrigaria a apagar o campo na mao para ver as outras.
  const rotulo = state.selectedBranch && query === state.selectedBranch.toLowerCase();
  const matches = (rotulo ? state.branches : state.branches.filter((b) => b.name.toLowerCase().includes(query)))
    .slice(0, 50);
  const list = $('branch-list');
  list.replaceChildren();
  for (const branch of matches) {
    const item = el('li', null);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(branch.name === state.selectedBranch));
    item.append(el('span', 'grow', branch.name));
    item.append(el('span', null, timeAgo(branch.lastCommit)));
    item.addEventListener('click', () => {
      state.selectedBranch = branch.name;
      $('branch-search').value = branch.name; // escolher preenche o campo
      state.listOpen = false;                 // ...e fecha a lista
      renderBranches();
      loadVersion(branch.name);
    });
    list.append(item);
  }
  if (!matches.length) list.append(el('li', null, 'Nenhuma branch encontrada.'));
  list.classList.toggle('hidden', !state.listOpen);
  // Never let a failed fetch read as "this repo has no branches": say the list is
  // from the local mirror and why, so the person knows what they are looking at.
  const count = $('branch-count');
  count.textContent = `${state.branches.length} branches`;
  count.classList.toggle('stale', Boolean(state.branchesStale));
  if (state.branchesStale) {
    count.textContent = state.branches.length
      ? `${state.branches.length} branches (lista local, nao atualizada)`
      : 'Nao foi possivel ler as branches';
    count.title = state.branchesError || '';
  } else {
    count.title = '';
  }
  updateBuildButton();
}

function renderEnvironments() {
  const container = $('environments');
  container.replaceChildren();
  for (const env of state.environments) {
    const node = el('div', `env${env.enabled ? '' : ' locked'}${state.selectedEnv === env.name ? ' selected' : ''}`);
    node.append(el('span', null, env.enabled ? (state.selectedEnv === env.name ? '●' : '○') : '🔒'));
    node.append(el('span', 'grow', env.label));
    if (env.enabled) {
      node.addEventListener('click', () => {
        state.selectedEnv = env.name;
        renderEnvironments();
        updateBuildButton();
      });
    } else {
      node.title = env.lockedReason ?? '';
    }
    container.append(node);
  }
}

// Le o que a branch declara no pubspec e preenche os campos. Nao e autoridade: e o
// ponto de partida, para ninguem ter que adivinhar o numero de cabeca.
async function loadVersion(branch) {
  $('version-source').textContent = 'lendo o pubspec da branch...';
  try {
    const v = await api(`/api/branch-version?branch=${encodeURIComponent(branch)}`);
    if (!v.name) {
      $('version-source').textContent = `Nao consegui ler o pubspec de ${branch}. Preencha os dois campos na mao.`;
    } else {
      $('build-name').value = v.name;
      if (v.number != null) $('build-number').value = String(v.number);
      $('version-source').textContent = v.number != null
        ? `No pubspec de ${branch}: ${v.name}+${v.number}. Confira o build number — a Apple recusa numero repetido.`
        : `No pubspec de ${branch}: ${v.name}, sem build number declarado.`;
    }
  } catch (err) {
    $('version-source').textContent = err.message;
  }
  updateBuildButton();
}

const NAME_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const NUMBER_RE = /^\d{1,10}$/;
$('build-name').addEventListener('input', updateBuildButton);
$('build-number').addEventListener('input', updateBuildButton);

function updateBuildButton() {
  const running = state.jobs.some((j) => !TERMINAL.includes(j.state));
  const nameOk = NAME_RE.test($('build-name').value.trim());
  const numberOk = NUMBER_RE.test($('build-number').value.trim());
  $('build').disabled = !state.selectedBranch || !state.selectedEnv || !nameOk || !numberOk;
  $('build').textContent = running ? 'ADICIONAR A FILA' : 'BUILD & SEND TO TESTFLIGHT';
}

$('build').addEventListener('click', async () => {
  $('build-error').textContent = '';
  $('build').disabled = true;
  try {
    const job = await api('/api/builds', {
      method: 'POST',
      body: JSON.stringify({
        branch: state.selectedBranch,
        environment: state.selectedEnv,
        buildName: $('build-name').value.trim(),
        buildNumber: Number($('build-number').value.trim()),
      }),
    });
    upsertJob(job);
    watch(job);
  } catch (err) {
    $('build-error').textContent = err.message;
  } finally {
    updateBuildButton();
  }
});

// ---- current build ----------------------------------------------------------
function watch(job) {
  state.watching = job?.id ?? null;
  renderCurrent();
  $('log').textContent = '';
  if (job) {
    api(`/api/jobs/${job.id}/log`).then(({ lines }) => {
      if (state.watching !== job.id) return;
      $('log').textContent = lines.map((l) => `${l.t.slice(11, 19)} ${l.line}`).join('\n');
      $('log').scrollTop = $('log').scrollHeight;
    });
  }
}

function renderCurrent() {
  const job = state.jobs.find((j) => j.id === state.watching);
  const container = $('current');
  container.replaceChildren();
  if (!job) {
    container.append(el('p', 'hint', 'Nenhum build ainda.'));
    return;
  }

  const head = el('p', 'meta');
  head.append(el('b', null, `#${job.number} ${job.branch}`));
  head.append(document.createTextNode(` · ${job.environment} `));
  head.append(badge(job));
  container.append(head);

  if (job.buildNumber) {
    container.append(el('p', 'meta', `Sobe como ${job.buildName ?? '?'} (${job.buildNumber})`));
  }
  if (job.shortSha) {
    container.append(el('p', 'meta', `Commit ${job.shortSha}${job.commitSubject ? ` — ${job.commitSubject}` : ''}`));
  }
  container.append(el('p', 'hint', `Pedido por ${job.requestedBy} · ${new Date(job.requestedAt).toLocaleString()}`));

  const reached = new Set(job.stages.map((s) => s.stage));
  const list = el('ul', 'stages');
  for (const [stage, label] of PIPELINE) {
    const isCurrent = job.state === stage;
    const isDone = reached.has(stage) && !isCurrent;
    const isFailed = job.failedStage === stage;
    // Um ambiente pode nao usar todos os estagios (ex.: `flutter build ipa` ja
    // arquiva e exporta). Num job terminado, estagio nao alcancado = nao usado.
    const skipped = TERMINAL.includes(job.state) && !reached.has(stage) && !isFailed;
    const icon = isFailed ? '✕' : isDone ? '✓' : isCurrent ? '●' : skipped ? '–' : '○';
    const label2 = skipped ? `${label} (nao usado)` : label;
    list.append(el('li', isFailed ? 'failed' : isCurrent ? 'active' : isDone ? 'done' : '', `${icon} ${label2}`));
  }
  container.append(list);

  if (job.state === 'success') {
    container.append(el('p', 'meta', `SUCESSO em ${formatDuration(job.durationSeconds)} · enviado ao TestFlight.`));
  }
  if (job.state === 'failed') {
    container.append(el('p', 'error', `FALHOU em ${job.failedStage}: ${job.error ?? ''}`));
  }
  if (!TERMINAL.includes(job.state)) {
    const cancel = el('button', 'danger', job.cancelRequested ? 'Cancelando...' : 'CANCELAR BUILD');
    cancel.disabled = Boolean(job.cancelRequested);
    cancel.addEventListener('click', () => api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {}));
    container.append(cancel);
  }
}

function badge(job) {
  const label = TERMINAL.includes(job.state) ? job.state : job.state === 'queued' ? 'queued' : 'running';
  return el('span', `badge ${label}`, TERMINAL.includes(job.state) ? job.state : job.state);
}

function renderHistory() {
  const list = $('history');
  list.replaceChildren();
  for (const job of state.jobs) {
    const item = el('li');
    item.append(badge(job));
    item.append(el('span', 'grow', `#${job.number} ${job.branch} · ${job.environment}`));
    item.append(el('span', 'when', timeAgo(job.requestedAt)));
    item.addEventListener('click', () => watch(job));
    list.append(item);
  }
  if (!state.jobs.length) list.append(el('li', 'hint', 'Sem builds ainda.'));
}

function upsertJob(job) {
  const index = state.jobs.findIndex((j) => j.id === job.id);
  if (index >= 0) state.jobs[index] = job;
  else state.jobs.unshift(job);
  renderHistory();
  renderCurrent();
  updateBuildButton();
}

// ---- dono: token do repositorio ---------------------------------------------
// Este bloco nao existe para quem entra como dev: o cartao fica escondido e a rota
// recusa de todo jeito. Esconder a interface e cortesia, nao a protecao.
function renderAdmin() {
  const card = $('admin-card');
  if (state.role !== 'owner') {
    card.classList.add('hidden');
    $('preflight-card').classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  $('preflight-card').classList.remove('hidden');
  const cred = state.credential ?? {};
  const stored = cred.present ? `Token gravado ha ${timeAgo(cred.updatedAt)}` : 'Nenhum token gravado';
  const health = state.branchesStale
    ? 'o git NAO esta conseguindo autenticar no repositorio'
    : 'o git esta autenticando normalmente';
  $('cred-status').textContent = `${stored} — ${health}.`;
  $('cred-status').classList.toggle('stale', Boolean(state.branchesStale));
}

$('cred-save').addEventListener('click', async () => {
  const field = $('cred-pat');
  const pat = field.value.trim();
  $('cred-msg').textContent = '';
  $('cred-ok').textContent = '';
  if (!pat) return;
  const button = $('cred-save');
  button.disabled = true;
  button.textContent = 'Testando no Azure...';
  try {
    const body = await api('/api/credential', { method: 'POST', body: JSON.stringify({ pat }) });
    $('cred-ok').textContent = `Token aceito e gravado. ${body.branches} branches lidas do repositorio.`;
    await bootstrap(true);
  } catch (err) {
    $('cred-msg').textContent = err.detail ? `${err.message} ${err.detail}` : err.message;
  } finally {
    // O valor sai do campo nos dois casos. Um token recusado quase sempre e um
    // paste cortado, e nao vale manter um segredo vivo no DOM esperando o retry.
    field.value = '';
    button.disabled = false;
    button.textContent = 'Testar e gravar';
  }
});

// ---- pre-voo ----------------------------------------------------------------
// Roda sob demanda: sao comandos do sistema (security, pmset, git) e nao faz sentido
// dispara-los a cada render.
const MARCA = { ok: '\u2713', warn: '!', fail: '\u2715' };

$('preflight-run').addEventListener('click', runPreflight);

async function runPreflight() {
  const botao = $('preflight-run');
  botao.disabled = true;
  botao.textContent = 'Conferindo...';
  try {
    const { checks } = await api('/api/preflight');
    const lista = $('preflight');
    lista.replaceChildren();
    for (const c of checks) {
      const item = el('li', c.state);
      item.append(el('span', 'marca', MARCA[c.state] ?? '?'));
      const corpo = el('div', 'corpo');
      corpo.append(el('div', 'rotulo', c.label));
      corpo.append(el('div', 'detalhe', c.detail));
      if (c.fix) corpo.append(el('div', 'conserto', c.fix));
      item.append(corpo);
      lista.append(item);
    }
    const ruins = checks.filter((c) => c.state === 'fail').length;
    botao.textContent = ruins ? `Conferir de novo (${ruins} pendente${ruins > 1 ? 's' : ''})` : 'Conferir de novo';
  } catch (err) {
    $('preflight').replaceChildren(el('li', 'fail', err.message));
    botao.textContent = 'Conferir agora';
  } finally {
    botao.disabled = false;
  }
}

// ---- live updates -----------------------------------------------------------
// Um stream ao vivo nao tem replay: o que mudou enquanto a aba esteve fora nunca
// chega. Sem ressincronizar na volta, a tela congela no ultimo estado visto — um
// build que saiu de "queued" durante a queda continua "queued" para sempre, e quem
// olha conclui que a fila travou enquanto a maquina esta compilando.
async function resyncJobs() {
  try {
    const data = await api('/api/bootstrap');
    state.jobs = data.jobs;
    renderHistory();
    const atual = state.jobs.find((j) => j.id === state.watching);
    if (atual && !TERMINAL.includes(atual.state)) watch(atual);
    else if (!atual) watch(state.jobs.find((j) => !TERMINAL.includes(j.state)) ?? state.jobs[0] ?? null);
    else renderCurrent();
  } catch {
    // Sessao morta ou rede fora: o onerror do stream ja trata esses dois casos.
  }
}

function connectEvents(resync = false) {
  state.events?.close();
  const source = new EventSource('/api/events');
  state.events = source;
  if (resync) source.addEventListener('open', resyncJobs);
  source.addEventListener('job', (event) => upsertJob(JSON.parse(event.data)));
  source.addEventListener('log', (event) => {
    const entry = JSON.parse(event.data);
    if (entry.jobId !== state.watching) return;
    const pane = $('log');
    const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    pane.textContent += `${pane.textContent ? '\n' : ''}${entry.t.slice(11, 19)} ${entry.line}`;
    if (atBottom) pane.scrollTop = pane.scrollHeight;
  });
  source.onerror = async () => {
    source.close();
    // Nao reconectar as cegas. A chave que assina os cookies e nova a cada processo,
    // entao todo restart do agent invalida as sessoes abertas — e o retry cego virava
    // um 401 a cada 5 segundos, para sempre, numa aba esquecida aberta. Conferimos a
    // sessao uma vez: se ela morreu, voltamos para a tela de login em vez de insistir.
    try {
      await api('/api/session');
    } catch {
      location.reload();
      return;
    }
    setTimeout(() => connectEvents(true), 5000);
  };
}

// Voltar para a aba e o outro momento em que o estado pode estar velho: o navegador
// suspende conexao e timers de aba em segundo plano, e no celular isso e a regra.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.events?.readyState === EventSource.CLOSED) return; // o retry ja cuida
  if (state.jobs.some((j) => !TERMINAL.includes(j.state))) resyncJobs();
});

// ---- helpers ----------------------------------------------------------------
function timeAgo(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (seconds < 60) return 'agora';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatDuration(seconds) {
  if (seconds == null) return '—';
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

// ---- boot -------------------------------------------------------------------
try {
  const session = await api('/api/session');
  state.csrf = session.csrf;
  await enterApp(session.name, session.role);
} catch {
  $('login').classList.remove('hidden');
}
