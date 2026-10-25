// Exporter tab: owns the folder, the API client and the engine. Mirrors state to
// chrome.storage.local (for the popup) and to the toolbar badge.
import { createApi } from './src/api.js';
import { createEngine } from './src/engine.js';
import { createFolderWriter, ensurePermission, loadHandle, saveHandle } from './src/folder.js';
import { badgeFor, countsRow, doneSummary, exporterControls, isActive, replyNotice, viewFor } from './src/ui-state.js';
import { el, setProgress, syncButtons } from './ui-dom.js';

const STORAGE_INTERVAL_MS = 250; // about 4 storage writes per second
const MAX_LOG_LINES = 200;
const SETTLED_PHASES = new Set(['idle', 'paused', 'done', 'stopped', 'error']);

const $ = (id) => document.getElementById(id);

let handle = null;
let folderReady = false;
let engine = null;
let running = false;
let starting = false; // set synchronously before any await so two Start requests cannot both get through
let state = null;
let loginNeeded = false;
let hasPreviousExport = false;
let notice = '';
let failureSignature = '';
let pendingWrite = null;
let writeTimer = null;
let rateTimer = null;

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

// ---- state persistence and badge ----

function writeNow(next) {
  clearTimeout(writeTimer);
  writeTimer = null;
  pendingWrite = null;
  const badge = badgeFor(next);
  chrome.storage.local.set({ state: next }).catch((e) => setNotice(`Could not save progress: ${errorMessage(e)}`));
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

function persist(next) {
  if (SETTLED_PHASES.has(next?.phase)) return writeNow(next);
  pendingWrite = next;
  if (!writeTimer) writeTimer = setTimeout(() => writeNow(pendingWrite), STORAGE_INTERVAL_MS);
}

function onState(next) {
  const justFinished = running && next.phase === 'done' && state?.phase !== 'done';
  state = next;
  persist(next);
  render();
  if (justFinished) openDoneDialog();
}

// ---- rendering ----

const show = (id, visible) => { $(id).hidden = !visible; };

function setNotice(text) {
  notice = text;
  render();
}

function context() {
  return { running, folderReady, hasHandle: Boolean(handle), starting, loginNeeded, hasPreviousExport, folderName: handle?.name ?? '' };
}

function renderBanner(banner) {
  show('banner', Boolean(banner));
  if (!banner) return;
  $('banner').dataset.tone = banner.tone;
  $('banner-text').textContent = banner.text;
  show('banner-link', Boolean(banner.login));
}

function renderChecklist(view) {
  show('checklist', view.view === 'setup');
  show('hint', view.view === 'setup');
  const row = $('row-login');
  if (view.loginNeeded) row.dataset.tone = 'danger';
  else delete row.dataset.tone;
  $('row-login-text').textContent = view.loginNeeded ? 'Logged out of chatgpt.com' : 'Logged in to chatgpt.com';
  show('row-login-link', view.loginNeeded);
}

function renderProgress(view) {
  show('progress', view.view === 'running' || view.view === 'paused');
  show('pct', view.percent !== null);
  $('pct').textContent = view.percent === null ? '' : `${view.percent}%`;
  $('progress-label').textContent = view.label;
  setProgress($('bar'), view.percent, view.indeterminate, view.label);
  $('current').textContent = view.current;
  const counts = countsRow(state);
  for (const key of ['saved', 'files', 'failed']) $(`count-${key}`).textContent = String(counts[key]);
  if (counts.failed > 0) $('stat-failed').dataset.nonzero = '';
  else delete $('stat-failed').dataset.nonzero;
}

function lastExportText() {
  const when = state?.finishedAt ? new Date(state.finishedAt) : null;
  const time = when && !Number.isNaN(when.getTime()) ? `${when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}, ` : '';
  return `Last export: ${time}${doneSummary(state, handle?.name).counts}`;
}

function renderFailures(failures, view) {
  const listed = failures.length > 0 && ['running', 'paused', 'error', 'done'].includes(view.view);
  show('failures-section', listed);
  $('failures-title').textContent = `${failures.length} ${failures.length === 1 ? 'chat needs' : 'chats need'} attention`;
  const signature = JSON.stringify(failures);
  if (signature !== failureSignature) {
    failureSignature = signature;
    $('failure-list').replaceChildren(...failures.map(failureRow));
  }
  const canRetry = exporterControls(state, { running, folderReady, starting }).retry === 'enabled';
  for (const button of $('failure-list').querySelectorAll('[data-action="retry-failed"]')) button.disabled = !canRetry;
}

function failureRow({ id, title, error }) {
  const item = el('li');
  const text = el('div', { class: 'failure-text' });
  text.append(el('span', { class: 'failure-title', text: title || 'Untitled' }), el('span', { class: 'failure-error', text: error || 'Unknown error' }));
  const buttons = el('div', { class: 'failure-buttons' });
  buttons.append(
    el('button', { class: 'btn btn-text', text: 'Retry', type: 'button', action: 'retry-failed' }),
    el('button', { class: 'btn btn-text', text: 'Skip', type: 'button', action: 'skip', id }),
  );
  item.append(text, buttons);
  return item;
}

function render() {
  const view = viewFor(state, context());
  $('title').textContent = view.title;
  $('subtitle').textContent = view.subtitle ?? '';
  show('subtitle', Boolean(view.subtitle));
  renderBanner(view.banner);
  renderChecklist(view);
  show('folder-pill', view.view === 'ready');
  $('folder-name').textContent = handle?.name ?? '';
  renderProgress(view);
  show('done-summary', view.view === 'done');
  if (view.view === 'done') $('done-text').textContent = lastExportText();
  $('notice').textContent = notice;
  show('notice', notice !== '');
  syncButtons($('primary-slot'), view.primary ? [view.primary] : []);
  syncButtons($('secondary-slot'), view.secondary);
  renderFailures(state?.failures ?? [], view);
  show('activity', ['running', 'paused', 'error', 'done'].includes(view.view));
}

// ---- done dialog ----

function openDoneDialog() {
  const dialog = $('done-dialog');
  if (dialog.open) return;
  const summary = doneSummary(state, handle?.name);
  $('dialog-message').textContent = summary.message;
  show('dialog-attention', Boolean(summary.attention));
  $('dialog-attention').lastElementChild.textContent = summary.attention ?? '';
  const failed = state?.failures?.length ?? 0;
  show('dialog-retry', failed > 0);
  $('dialog-retry').textContent = `Retry ${failed} failed`;
  dialog.showModal();
}

function afterDialogClose() {
  const target = $('primary-slot').querySelector('button') ?? $('title');
  target.focus();
}

const closeDialog = () => $('done-dialog').close();

// ---- log and rate limit line ----

function appendLog(line) {
  const log = $('log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  const text = typeof line === 'string' ? line : line?.message ?? JSON.stringify(line);
  log.append(el('div', { text: `${new Date().toLocaleTimeString()}  ${text}` }));
  while (log.childElementCount > MAX_LOG_LINES) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function onRetry({ waitMs, status }) {
  const seconds = Math.max(1, Math.round(waitMs / 1000));
  const rate = $('rate');
  rate.textContent = status === 429 ? `ChatGPT asked to slow down. Waiting ${seconds}s.` : `ChatGPT did not answer. Retrying in ${seconds}s.`;
  rate.hidden = false;
  clearTimeout(rateTimer);
  rateTimer = setTimeout(() => { rate.hidden = true; }, waitMs);
}

// ---- folder ----

async function setFolder(next, ready) {
  handle = next;
  folderReady = ready;
  hasPreviousExport = ready ? await createFolderWriter(next).exists('index.json').catch(() => false) : false;
  render();
}

async function chooseFolder() {
  try {
    const picked = await window.showDirectoryPicker({ mode: 'readwrite', id: 'takeout' });
    await saveHandle(picked);
    await setFolder(picked, true);
    setNotice('');
  } catch (error) {
    if (error?.name !== 'AbortError') setNotice(`Could not use that folder: ${errorMessage(error)}`);
  }
}

async function continueInFolder() {
  const permission = await ensurePermission(handle, { request: true });
  await setFolder(handle, permission === 'granted');
  if (permission !== 'granted') setNotice('Access to the folder was not granted. Choose the folder again.');
}

// ---- engine ----

function makeEngine() {
  const api = createApi({ onRetry });
  return createEngine({ api, writer: createFolderWriter(handle), onState, onLog: appendLog });
}

async function folderGranted() {
  if (!handle) return false;
  const granted = (await ensurePermission(handle)) === 'granted';
  if (granted !== folderReady) await setFolder(handle, granted);
  return granted;
}

async function startRun(mode) {
  if (running || starting) return { ok: false, reason: 'busy' };
  starting = true;
  render();
  try {
    if (!(await folderGranted())) return { ok: false, reason: 'pick-folder' };
    engine = makeEngine();
    running = true;
    setNotice('');
    engine.run({ mode }).catch(failRun).finally(finishRun);
    return { ok: true };
  } finally {
    starting = false;
    render();
  }
}

function failRun(error) {
  onState({ ...(state ?? {}), phase: 'error', error: errorMessage(error), errorKind: 'internal', current: null });
}

function finishRun() {
  running = false;
  if (pendingWrite) writeNow(pendingWrite);
  render();
}

async function skipChat(id) {
  if (starting) return { ok: false, reason: 'busy' };
  starting = true;
  render();
  try {
    if (!engine) {
      if (!(await folderGranted())) return { ok: false, reason: 'pick-folder' };
      engine = makeEngine();
    }
    await engine.skip(id);
    return { ok: true };
  } finally {
    starting = false;
    render();
  }
}

/**
 * @param {{ cmd: string, id?: string }} message from the popup or from buttons on this page
 * @returns {Promise<{ ok: boolean, reason?: string, message?: string }>}
 */
async function handleCommand({ cmd, id }) {
  try {
    switch (cmd) {
      case 'start':
        return await startRun('all');
      case 'resume':
        if (running) { engine.resume(); return { ok: true }; }
        return await startRun('all');
      case 'pause':
        engine?.pause();
        return engine ? { ok: true } : { ok: false, reason: 'idle' };
      case 'stop':
        engine?.stop();
        return engine ? { ok: true } : { ok: false, reason: 'idle' };
      case 'retry-failed':
        return await startRun('retry-failed');
      case 'skip':
        return await skipChat(id);
      case 'show-privacy':
        $('privacy').scrollIntoView({ behavior: 'smooth' });
        $('privacy').focus({ preventScroll: true });
        return { ok: true };
      default:
        return { ok: false, reason: 'unknown' };
    }
  } catch (error) {
    setNotice(errorMessage(error));
    return { ok: false, reason: 'error', message: errorMessage(error) };
  }
}

// Button clicks are user gestures, so they may ask for folder permission first.
async function startFromClick(cmd) {
  if (handle && !folderReady) await continueInFolder();
  await reportReply(handleCommand({ cmd }));
}

async function reportReply(pending) {
  const reply = await pending;
  if (!reply.ok && reply.reason !== 'error') setNotice(replyNotice(reply));
}

// ---- login check ----

async function checkLogin() {
  try {
    await createApi({}).session();
    loginNeeded = false;
  } catch (error) {
    loginNeeded = error?.kind === 'auth';
    if (!loginNeeded) notice = `Could not reach chatgpt.com: ${errorMessage(error)}`;
  }
  render();
}

// ---- startup ----

// A saved working or paused state with no engine means the tab was closed mid-run.
const interrupted = (saved) => (isActive(saved) || saved?.phase === 'paused' ? { ...saved, phase: 'paused', interrupted: true, current: null } : saved);

async function restoreState() {
  const { state: saved } = await chrome.storage.local.get('state');
  if (!saved) return render();
  state = interrupted(saved);
  if (state !== saved) writeNow(state);
  render();
}

async function restoreFolder() {
  const saved = await loadHandle().catch(() => null);
  if (!saved) return render();
  await setFolder(saved, (await ensurePermission(saved)) === 'granted');
}

const ACTIONS = {
  'choose-folder': () => chooseFolder(),
  'change-folder': () => chooseFolder(),
  'continue-folder': () => continueInFolder(),
  start: () => startFromClick('start'),
  resume: () => startFromClick('resume'),
  'retry-failed': () => startFromClick('retry-failed'),
  pause: () => handleCommand({ cmd: 'pause' }),
  stop: () => handleCommand({ cmd: 'stop' }),
  skip: (id) => reportReply(handleCommand({ cmd: 'skip', id })),
  login: () => window.open('https://chatgpt.com', '_blank', 'noopener,noreferrer'),
  'dialog-done': () => closeDialog(),
  'dialog-retry': () => { closeDialog(); startFromClick('retry-failed'); },
  'dialog-check': () => { closeDialog(); startFromClick('start'); },
};

function wireEvents() {
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) ACTIONS[button.dataset.action]?.(button.dataset.id);
  });
  $('done-dialog').addEventListener('close', afterDialogClose);
  // Best effort: the storage write is async but usually completes for an extension page that is closing.
  window.addEventListener('pagehide', () => {
    if (running && state) writeNow(interrupted(state));
  });
  window.addEventListener('beforeunload', (event) => {
    if (!running) return;
    event.preventDefault();
    event.returnValue = '';
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && loginNeeded) checkLogin();
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    handleCommand(message ?? {}).then(reply);
    return true;
  });
}

wireEvents();
await restoreState();
await restoreFolder();
checkLogin();
