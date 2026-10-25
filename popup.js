// Popup: a mirror of the exporter's state plus buttons that send it commands.
import { popupView, replyNotice } from './src/ui-state.js';
import { setProgress, syncButtons } from './ui-dom.js';

const GOTO_LOGIN = 'https://chatgpt.com';
const EXPORTER_URL = chrome.runtime.getURL('exporter.html');
const FOCUS_EXPORTER_REASONS = new Set(['pick-folder', 'no-exporter', 'no-reply']);

const $ = (id) => document.getElementById(id);

let state = null;
let exporterOpen = true;
let notice = '';

async function exporterTabs() {
  return chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [EXPORTER_URL] });
}

async function openExporter() {
  const [tab] = await exporterTabs();
  if (!tab) {
    await chrome.tabs.create({ url: 'exporter.html' });
    return;
  }
  await chrome.tabs.update(tab.tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

async function send(message) {
  try {
    return (await chrome.runtime.sendMessage(message)) ?? { ok: false, reason: 'no-reply' };
  } catch {
    return { ok: false, reason: 'no-exporter' };
  }
}

async function command(cmd, extra = {}) {
  if (!exporterOpen) return openExporter();
  const reply = await send({ cmd, ...extra });
  if (reply.ok) return setNotice('');
  setNotice(replyNotice(reply));
  return FOCUS_EXPORTER_REASONS.has(reply.reason) ? openExporter() : undefined;
}

const ACTIONS = {
  'open-exporter': () => openExporter(),
  'check-new': async () => {
    await command('start');
    if (exporterOpen) await openExporter();
  },
  login: () => chrome.tabs.create({ url: GOTO_LOGIN }),
  pause: () => command('pause'),
  resume: () => command('resume'),
  stop: () => command('stop'),
};

function setNotice(text) {
  notice = text;
  render();
}

const show = (id, visible) => { $(id).hidden = !visible; };

function renderBanner(banner) {
  show('banner', Boolean(banner));
  if (!banner) return;
  $('banner').dataset.tone = banner.tone;
  $('banner-text').textContent = banner.text;
}

function renderProgress(view) {
  show('progress', view.showProgress);
  show('pct', view.percent !== null);
  $('pct').textContent = view.percent === null ? '' : `${view.percent}%`;
  $('progress-label').textContent = view.label;
  setProgress($('bar'), view.percent, view.indeterminate, view.label);
  for (const [key, value] of Object.entries(view.stats)) $(`count-${key}`).textContent = String(value);
  if (view.stats.failed > 0) $('stat-failed').dataset.nonzero = '';
  else delete $('stat-failed').dataset.nonzero;
}

function render() {
  const view = popupView(state, { exporterOpen });
  $('title').textContent = view.title;
  show('tick', view.view === 'done');
  $('line').textContent = view.line;
  show('line', view.line !== '');
  renderBanner(view.banner);
  renderProgress(view);
  $('notice').textContent = notice;
  show('notice', notice !== '');
  syncButtons($('primary-slot'), view.primary ? [{ tone: 'primary', ...view.primary }] : []);
  syncButtons($('secondary-slot'), view.secondary);
}

async function refresh(next) {
  state = next ?? null;
  exporterOpen = (await exporterTabs()).length > 0;
  render();
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (button) ACTIONS[button.dataset.action]?.();
});

$('privacy').addEventListener('click', async (event) => {
  event.preventDefault();
  const open = (await exporterTabs()).length > 0;
  await openExporter();
  if (open) await send({ cmd: 'show-privacy' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) refresh(changes.state.newValue);
});

chrome.storage.local.get('state').then(({ state: saved }) => refresh(saved));
