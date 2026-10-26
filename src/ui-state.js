// Pure mapping from engine state to what the popup and exporter page show. No DOM, no chrome.*.

const ACTIVE_PHASES = new Set(['account', 'listing', 'chats', 'finishing']);
const STALE_TEXT = 'Exporter tab closed. Open it to continue.';
const INTERRUPTED_TEXT = 'Interrupted: open the exporter and press Resume';
const OPEN = { id: 'open-exporter', label: 'Open exporter' };

const BADGE_COLORS = { working: '#2563eb', ok: '#15803d', problem: '#b91c1c', none: '#6b7280' };

/**
 * @param {{ phase?: string }|null|undefined} state
 * @returns {boolean} true while the engine is doing work (not paused, finished or idle)
 */
export function isActive(state) {
  return ACTIVE_PHASES.has(state?.phase);
}

const failureCount = (state) => state?.failures?.length ?? 0;

// Working or paused state that nobody is driving because the exporter tab is gone.
const isStale = (state, exporterOpen) => exporterOpen === false && (isActive(state) || state?.phase === 'paused');

const finished = (state) => (state.done ?? 0) + (state.partial ?? 0) + (state.failed ?? 0) + (state.skipped ?? 0);

/**
 * @param {object|null|undefined} state engine state
 * @returns {number|null} 0-100, or null when the bar should be indeterminate
 */
export function percent(state) {
  if (!state) return null;
  if (state.phase === 'done') return 100;
  if (state.phase === 'account' || state.phase === 'listing' || !state.total) return null;
  return Math.min(100, Math.round((finished(state) / state.total) * 100));
}

function chatsText(state) {
  if (!state.current) return 'Exporting chats';
  const position = Math.min(state.total || 0, finished(state) + 1);
  return `Exporting chat ${position} of ${state.total}: ${state.current.title}`;
}

/**
 * @param {object|null|undefined} state engine state
 * @param {{ exporterOpen?: boolean }} [opts]
 * @returns {string} the status line
 */
export function statusText(state, { exporterOpen = true } = {}) {
  if (isStale(state, exporterOpen)) return state.interrupted ? INTERRUPTED_TEXT : STALE_TEXT;
  switch (state?.phase) {
    case 'account':
      return 'Reading your account';
    case 'listing':
      return 'Listing your chats';
    case 'chats':
      return chatsText(state);
    case 'finishing':
      return 'Writing index and bundles';
    case 'paused':
      if (state.interrupted) return 'Interrupted: press Resume to continue';
      return state.errorKind === 'rate' && state.error ? state.error : 'Paused';
    case 'done':
      return failureCount(state) ? `Done, ${failureCount(state)} failed` : 'Done';
    case 'stopped':
      return 'Stopped';
    case 'error':
      return `Error: ${state.error || 'unknown problem'}`;
    default:
      return 'Not started';
  }
}

/**
 * @param {object|null|undefined} state engine state
 * @returns {{ saved: number, files: number, failed: number, skipped: number }}
 */
export function countsRow(state) {
  return {
    saved: (state?.done ?? 0) + (state?.partial ?? 0),
    files: state?.filesSaved ?? 0,
    failed: state?.failed ?? 0,
    skipped: state?.skipped ?? 0,
  };
}

function primaryFor(state) {
  switch (state?.phase) {
    case 'account':
    case 'listing':
    case 'chats':
    case 'finishing':
      return { id: 'pause', label: 'Pause' };
    case 'paused':
    case 'stopped':
      return { id: 'resume', label: 'Resume' };
    case 'done':
      return failureCount(state)
        ? { id: 'retry-failed', label: `Retry failed (${failureCount(state)})` }
        : OPEN;
    case 'error':
      if (state.errorKind === 'auth') return { id: 'login', label: 'Log in to ChatGPT' };
      return state.errorKind === 'shape' ? OPEN : { id: 'resume', label: 'Resume' };
    default:
      return { id: 'open-exporter', label: 'Start export' };
  }
}

/**
 * @param {object|null|undefined} state engine state
 * @param {{ exporterOpen?: boolean }} [opts]
 * @returns {{ id: string, label: string }} the one main button
 */
export function primaryAction(state, { exporterOpen = true } = {}) {
  return isStale(state, exporterOpen) ? OPEN : primaryFor(state);
}

/**
 * @param {object|null|undefined} state engine state
 * @param {{ exporterOpen?: boolean }} [opts]
 * @returns {Array<{ id: string, label: string }>} smaller buttons next to the main one
 */
export function secondaryActions(state, { exporterOpen = true } = {}) {
  if (isStale(state, exporterOpen) || !state || state.phase === 'idle') return [];
  const extras = [];
  if (isActive(state) || state.phase === 'paused') extras.push({ id: 'stop', label: 'Stop' });
  if (state.phase === 'error' && state.errorKind === 'auth') extras.push({ id: 'resume', label: 'Resume' });
  const openTab = primaryFor(state).id === 'open-exporter' ? [] : [{ id: 'open-exporter', label: 'Open exporter tab' }];
  return [...extras, ...openTab];
}

/**
 * @param {object|null|undefined} state engine state
 * @returns {{ text: string, color: string }} toolbar badge
 */
export function badgeFor(state) {
  const pct = percent(state);
  if (isActive(state)) {
    return { text: pct === null ? '' : `${pct}%`, color: BADGE_COLORS.working };
  }
  if (state?.phase === 'error') return { text: '!', color: BADGE_COLORS.problem };
  if (state?.phase === 'done') {
    return failureCount(state)
      ? { text: '!', color: BADGE_COLORS.problem }
      : { text: '✓', color: BADGE_COLORS.ok };
  }
  return { text: '', color: BADGE_COLORS.none };
}

/**
 * Which exporter-page buttons to show. Start and Resume need a folder with permission. Retry only needs a saved
 * folder: Chrome drops access when the tab reopens, and clicking Retry asks for it again.
 * @param {object|null|undefined} state engine state
 * @param {{ running: boolean, folderReady: boolean, starting?: boolean }} opts running = an engine run is alive in
 *   this tab, starting = a run is being set up (buttons that begin work stay disabled so it cannot start twice)
 * @returns {Record<'start'|'pause'|'resume'|'stop'|'retry', 'hidden'|'disabled'|'enabled'>}
 */
export function exporterControls(state, { running, folderReady, starting = false }) {
  const needsFolder = (visible) => (!visible ? 'hidden' : folderReady && !starting ? 'enabled' : 'disabled');
  const phase = state?.phase;
  const paused = running && phase === 'paused';
  const resumable = !running && ['paused', 'stopped', 'error'].includes(phase);
  return {
    start: needsFolder(!running && !resumable),
    pause: running && isActive(state) ? 'enabled' : 'hidden',
    resume: paused ? 'enabled' : needsFolder(resumable),
    stop: running ? 'enabled' : 'hidden',
    retry: !running && failureCount(state) > 0 ? (starting ? 'disabled' : 'enabled') : 'hidden',
  };
}

const REPLY_NOTICES = {
  'pick-folder': 'Choose a folder in the exporter tab first.',
  busy: 'An export is already running.',
  idle: 'No export is running.',
  'no-exporter': 'The exporter tab did not respond. Open it to continue.',
  'no-reply': 'The exporter tab did not respond. Open it to continue.',
};

/**
 * @param {{ ok: boolean, reason?: string, message?: string }} reply from the exporter tab
 * @returns {string} what to tell the user ('' on success)
 */
export function replyNotice(reply) {
  if (reply.ok) return '';
  return REPLY_NOTICES[reply.reason] ?? (reply.message || 'The exporter could not do that.');
}

// ---- view models: one mapping from engine state to what each page shows ----

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * @param {object|null|undefined} state engine state
 * @param {string} folderName name of the chosen folder ('' when unknown)
 * @returns {{ counts: string, message: string, attention: string|null }} finished-run copy
 */
export function doneSummary(state, folderName) {
  const chats = plural(countsRow(state).saved, 'chat');
  const files = plural(state?.filesSaved ?? 0, 'file');
  const failed = failureCount(state);
  return {
    counts: `${chats}, ${files}`,
    message: `${chats} and ${files} saved to ${folderName || 'your folder'}.`,
    attention: failed ? `${plural(failed, 'chat')} ${failed === 1 ? 'needs' : 'need'} attention` : null,
  };
}

function reasonText(state) {
  if (state.interrupted) return 'Interrupted: the tab was closed';
  if (state.phase === 'stopped') return 'Stopped';
  return state.errorKind === 'rate' && state.error ? state.error : 'Paused';
}

function bannerFor(state) {
  if (state?.phase === 'error') return { tone: 'danger', text: state.error || 'Unknown problem' };
  if (state?.phase === 'paused' || state?.phase === 'stopped') return { tone: 'warning', text: reasonText(state) };
  return null;
}

function progressLabel(state, short) {
  switch (state?.phase) {
    case 'account':
      return 'Preparing: reading your account';
    case 'listing':
      return 'Listing your chats';
    case 'finishing':
      return 'Writing index and bundles';
    case 'chats': {
      if (!state.current) return 'Exporting chats';
      const position = `chat ${Math.min(state.total || 0, finished(state) + 1)} of ${state.total}`;
      return short ? `Chat ${position.slice(5)}` : `Exporting ${position}`;
    }
    default:
      return state?.total ? `${finished(state)} of ${state.total} chats` : '';
  }
}

function progressFields(state, short) {
  const pct = percent(state);
  return {
    percent: pct,
    indeterminate: pct === null && isActive(state),
    showProgress: pct !== null || isActive(state),
    label: progressLabel(state, short),
  };
}

const EXPORTER_VIEWS = { account: 'running', listing: 'running', chats: 'running', finishing: 'running', paused: 'paused', stopped: 'paused', error: 'error', done: 'done' };
const TITLES = {
  setup: 'Export your ChatGPT chats',
  ready: 'Export your ChatGPT chats',
  running: 'Exporting your chats',
  paused: 'Export paused',
  error: 'Export failed',
  done: 'Export complete',
};
const INTRO = 'Saves chats, images and settings to a folder on your computer.';

function exporterActions(view, state, { folderName, hasPreviousExport }, controls) {
  const make = (id, label, tone, key) => ({
    id, label, tone, disabled: key ? controls[key] === 'disabled' : false, hidden: key ? controls[key] === 'hidden' : false,
  });
  const stop = make('stop', 'Stop', 'danger-text', 'stop');
  const failed = failureCount(state);
  switch (view) {
    case 'setup':
      return { primary: make('choose-folder', 'Choose a folder', 'primary'), secondary: [] };
    case 'ready':
      return { primary: make('start', hasPreviousExport ? 'Update export' : 'Start export', 'primary', 'start'), secondary: [] };
    case 'running':
      return { primary: null, secondary: [make('pause', 'Pause', 'default', 'pause'), stop] };
    case 'paused':
      return { primary: make('resume', 'Resume', 'primary', 'resume'), secondary: [stop] };
    case 'error':
      return state.errorKind === 'auth'
        ? { primary: make('login', 'Log in to ChatGPT', 'primary'), secondary: [make('resume', 'Try again', 'default', 'resume')] }
        : { primary: make('resume', 'Try again', 'primary', 'resume'), secondary: [] };
    default:
      return {
        primary: make('start', 'Check for new chats', 'primary', 'start'),
        secondary: failed ? [make('retry-failed', `Retry ${failed} failed`, 'default', 'retry')] : [],
      };
  }
}

const visible = ({ hidden, ...action }) => action;

/**
 * @param {object|null|undefined} state engine state
 * @param {{ running?: boolean, folderReady?: boolean, hasHandle?: boolean, starting?: boolean, loginNeeded?: boolean,
 *   hasPreviousExport?: boolean, folderName?: string }} [ctx] page facts the engine state does not know
 * @returns {object} exporter view model: view, title, subtitle, banner, progress fields, current, loginNeeded,
 *   primary (or null) and secondary buttons ({ id, label, tone, disabled })
 */
export function viewFor(state, ctx = {}) {
  const { running = false, folderReady = false, hasHandle = false, starting = false, loginNeeded = false, hasPreviousExport = false, folderName = '' } = ctx;
  const view = !hasHandle && !running ? 'setup' : EXPORTER_VIEWS[state?.phase] ?? 'ready';
  const controls = exporterControls(state, { running, folderReady, starting });
  const actions = exporterActions(view, state, { folderName, hasPreviousExport }, controls);
  let primary = actions.primary && !actions.primary.hidden ? visible(actions.primary) : null;
  if (primary && hasHandle && !folderReady && !running && view !== 'setup') {
    primary = { id: 'continue-folder', label: `Continue in ${folderName}`, tone: 'primary', disabled: false };
  }
  const loginBanner = loginNeeded && (view === 'ready' || view === 'done') ? { tone: 'danger', text: 'You are logged out of ChatGPT.', login: true } : null;
  const showsProgress = view === 'running' || view === 'paused';
  return {
    view,
    title: TITLES[view],
    subtitle: view === 'setup' ? INTRO : view === 'ready' ? (hasPreviousExport ? 'Picks up new and changed chats only.' : 'Saves chats, images and settings to the folder below.') : null,
    banner: view === 'setup' ? null : bannerFor(state) ?? loginBanner,
    ...(showsProgress ? progressFields(state, false) : { percent: null, indeterminate: false, showProgress: false, label: '' }),
    current: view === 'running' ? state?.current?.title ?? '' : '',
    loginNeeded,
    primary,
    secondary: actions.secondary.filter((a) => !a.hidden).map(visible),
  };
}

const OPEN_TEXT = { id: 'open-exporter', label: 'Open exporter', tone: 'text' };
const stats = (state) => {
  const { saved, files, failed } = countsRow(state);
  return { saved, files, failed };
};

function popupBase(state) {
  return { banner: null, ...progressFields(state, true), stats: stats(state), line: '', secondary: [] };
}

function popupDone(state, exporterOpen) {
  const summary = doneSummary(state, '');
  return {
    ...popupBase(state),
    view: 'done',
    title: TITLES.done,
    line: summary.counts,
    showProgress: false,
    primary: exporterOpen ? { id: 'check-new', label: 'Check for new chats' } : { id: 'open-exporter', label: 'Open exporter' },
    secondary: summary.attention ? [{ id: 'open-exporter', label: summary.attention, tone: 'danger-text' }] : [],
  };
}

/**
 * @param {object|null|undefined} state engine state
 * @param {{ exporterOpen?: boolean }} [opts]
 * @returns {object} popup view model: view, title, line, banner, progress fields, stats, primary (or null)
 *   and secondary buttons ({ id, label, tone })
 */
export function popupView(state, { exporterOpen = true } = {}) {
  const phase = state?.phase;
  if (!state || phase === 'idle') {
    return { ...popupBase(state), view: 'idle', title: 'Export your chats', line: 'Saves your ChatGPT chats, images and settings to a folder. More AI chat apps coming soon.', showProgress: false, primary: { id: 'open-exporter', label: 'Open exporter' } };
  }
  if (phase === 'done') return popupDone(state, exporterOpen);
  const view = EXPORTER_VIEWS[phase] ?? 'idle';
  const base = { ...popupBase(state), view, title: TITLES[view] };
  if (phase === 'error') {
    return { ...base, showProgress: false, banner: bannerFor(state), primary: primaryAction(state, { exporterOpen }) };
  }
  if (isStale(state, exporterOpen)) {
    return { ...base, banner: { tone: 'warning', text: statusText(state, { exporterOpen }) }, primary: { id: 'open-exporter', label: 'Open exporter' } };
  }
  if (view === 'running') {
    return { ...base, primary: null, secondary: [{ id: 'pause', label: 'Pause', tone: 'default' }, OPEN_TEXT] };
  }
  return {
    ...base,
    banner: bannerFor(state),
    primary: { id: 'resume', label: 'Resume' },
    secondary: state.interrupted || phase === 'stopped' ? [] : [{ id: 'stop', label: 'Stop', tone: 'text' }],
  };
}
