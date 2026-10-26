import { describe, expect, test } from 'bun:test';
import {
  badgeFor,
  countsRow,
  doneSummary,
  exporterControls,
  isActive,
  percent,
  primaryAction,
  replyNotice,
  secondaryActions,
  popupView,
  statusText,
  viewFor,
} from '../src/ui-state.js';

const base = {
  phase: 'chats',
  total: 480,
  done: 100,
  partial: 20,
  failed: 8,
  skipped: 3,
  filesSaved: 55,
  current: { id: 'a', title: 'Trip plan' },
  failures: [],
  error: null,
  errorKind: null,
};
const withState = (patch) => ({ ...base, ...patch });

describe('isActive', () => {
  test('true for working phases only', () => {
    for (const phase of ['account', 'listing', 'chats', 'finishing']) expect(isActive({ phase })).toBe(true);
    for (const phase of ['idle', 'paused', 'done', 'stopped', 'error']) expect(isActive({ phase })).toBe(false);
    expect(isActive(null)).toBe(false);
  });
});

describe('percent', () => {
  test('counts done, partial, failed and skipped over total', () => {
    expect(percent(base)).toBe(Math.round((131 / 480) * 100));
  });
  test('is null (indeterminate) while reading the account or listing', () => {
    expect(percent(withState({ phase: 'account', total: 0 }))).toBeNull();
    expect(percent(withState({ phase: 'listing' }))).toBeNull();
  });
  test('is null when there is no state or no total yet', () => {
    expect(percent(null)).toBeNull();
    expect(percent(withState({ total: 0 }))).toBeNull();
  });
  test('is 100 when done and never above 100', () => {
    expect(percent(withState({ phase: 'done', total: 10, done: 10, partial: 0, failed: 0, skipped: 0 }))).toBe(100);
    expect(percent(withState({ total: 10, done: 20 }))).toBe(100);
  });
});

describe('statusText', () => {
  test('not started without state or when idle', () => {
    expect(statusText(null)).toBe('Not started');
    expect(statusText({ phase: 'idle' })).toBe('Not started');
  });
  test('names the chat being exported with its position', () => {
    expect(statusText(base)).toBe('Exporting chat 132 of 480: Trip plan');
  });
  test('does not run past the total', () => {
    expect(statusText(withState({ total: 131 }))).toBe('Exporting chat 131 of 131: Trip plan');
  });
  test('falls back when there is no current chat', () => {
    expect(statusText(withState({ current: null }))).toBe('Exporting chats');
  });
  test('early phases', () => {
    expect(statusText(withState({ phase: 'account' }))).toBe('Reading your account');
    expect(statusText(withState({ phase: 'listing' }))).toBe('Listing your chats');
    expect(statusText(withState({ phase: 'finishing' }))).toBe('Writing index and bundles');
  });
  test('paused, interrupted, done, stopped', () => {
    expect(statusText(withState({ phase: 'paused' }))).toBe('Paused');
    expect(statusText(withState({ phase: 'paused', interrupted: true }))).toBe('Interrupted: press Resume to continue');
    expect(statusText(withState({ phase: 'done' }))).toBe('Done');
    expect(statusText(withState({ phase: 'done', failures: [{}, {}] }))).toBe('Done, 2 failed');
    expect(statusText(withState({ phase: 'stopped' }))).toBe('Stopped');
  });
  test('a rate-limit pause shows the error message', () => {
    const s = withState({ phase: 'paused', errorKind: 'rate', error: 'ChatGPT keeps rate limiting. Resume in a few minutes.' });
    expect(statusText(s)).toBe('ChatGPT keeps rate limiting. Resume in a few minutes.');
    expect(statusText({ ...s, error: null })).toBe('Paused');
  });
  test('error shows its message', () => {
    expect(statusText(withState({ phase: 'error', error: 'Log in first' }))).toBe('Error: Log in first');
    expect(statusText(withState({ phase: 'error' }))).toBe('Error: unknown problem');
  });
  test('a working state with the exporter tab closed is stale', () => {
    expect(statusText(base, { exporterOpen: false })).toBe('Exporter tab closed. Open it to continue.');
    expect(statusText(withState({ phase: 'paused' }), { exporterOpen: false })).toBe(
      'Exporter tab closed. Open it to continue.',
    );
  });
  test('an interrupted run with the exporter tab closed says how to continue', () => {
    expect(statusText(withState({ phase: 'paused', interrupted: true }), { exporterOpen: false })).toBe(
      'Interrupted: open the exporter and press Resume',
    );
  });
  test('finished states stay readable when the tab is closed', () => {
    expect(statusText(withState({ phase: 'done' }), { exporterOpen: false })).toBe('Done');
    expect(statusText(null, { exporterOpen: false })).toBe('Not started');
  });
});

describe('countsRow', () => {
  test('saved is done plus partial', () => {
    expect(countsRow(base)).toEqual({ saved: 120, files: 55, failed: 8, skipped: 3 });
  });
  test('zeros without state', () => {
    expect(countsRow(null)).toEqual({ saved: 0, files: 0, failed: 0, skipped: 0 });
  });
});

describe('primaryAction', () => {
  test('start export when there is no state or idle', () => {
    expect(primaryAction(null)).toEqual({ id: 'open-exporter', label: 'Start export' });
    expect(primaryAction({ phase: 'idle' })).toEqual({ id: 'open-exporter', label: 'Start export' });
  });
  test('pause while running', () => {
    for (const phase of ['account', 'listing', 'chats', 'finishing']) {
      expect(primaryAction(withState({ phase }))).toEqual({ id: 'pause', label: 'Pause' });
    }
  });
  test('resume when paused', () => {
    expect(primaryAction(withState({ phase: 'paused' }))).toEqual({ id: 'resume', label: 'Resume' });
  });
  test('retry failed with the count when done with failures', () => {
    const failures = [{}, {}, {}];
    expect(primaryAction(withState({ phase: 'done', failures }))).toEqual({
      id: 'retry-failed',
      label: 'Retry failed (3)',
    });
  });
  test('open exporter when done clean', () => {
    expect(primaryAction(withState({ phase: 'done' }))).toEqual({ id: 'open-exporter', label: 'Open exporter' });
  });
  test('auth error asks to log in', () => {
    const s = withState({ phase: 'error', error: 'x', errorKind: 'auth' });
    expect(primaryAction(s)).toEqual({ id: 'login', label: 'Log in to ChatGPT' });
  });
  test('other errors resume; shape errors cannot be resumed', () => {
    expect(primaryAction(withState({ phase: 'error', errorKind: 'rate' }))).toEqual({ id: 'resume', label: 'Resume' });
    expect(primaryAction(withState({ phase: 'error', errorKind: 'shape' }))).toEqual({
      id: 'open-exporter',
      label: 'Open exporter',
    });
  });
  test('a rate-limit pause offers Resume', () => {
    expect(primaryAction(withState({ phase: 'paused', errorKind: 'rate', error: 'x' }))).toEqual({ id: 'resume', label: 'Resume' });
  });
  test('stopped can be resumed', () => {
    expect(primaryAction(withState({ phase: 'stopped' }))).toEqual({ id: 'resume', label: 'Resume' });
  });
  test('closed exporter tab turns a working state into open exporter', () => {
    expect(primaryAction(base, { exporterOpen: false })).toEqual({ id: 'open-exporter', label: 'Open exporter' });
    expect(primaryAction(withState({ phase: 'paused' }), { exporterOpen: false })).toEqual({
      id: 'open-exporter',
      label: 'Open exporter',
    });
  });
});

describe('secondaryActions', () => {
  test('stop and open exporter tab while running or paused', () => {
    const ids = (s, o) => secondaryActions(s, o).map((a) => a.id);
    expect(ids(base)).toEqual(['stop', 'open-exporter']);
    expect(ids(withState({ phase: 'paused' }))).toEqual(['stop', 'open-exporter']);
  });
  test('auth error offers Resume next to the login button', () => {
    const s = withState({ phase: 'error', errorKind: 'auth' });
    expect(secondaryActions(s).map((a) => a.id)).toEqual(['resume', 'open-exporter']);
  });
  test('no duplicate open exporter when it is already the primary', () => {
    expect(secondaryActions(null)).toEqual([]);
    expect(secondaryActions(withState({ phase: 'done' }))).toEqual([]);
  });
  test('done with failures keeps an open exporter link', () => {
    expect(secondaryActions(withState({ phase: 'done', failures: [{}] })).map((a) => a.id)).toEqual(['open-exporter']);
  });
  test('stale state offers nothing but the primary open button', () => {
    expect(secondaryActions(base, { exporterOpen: false })).toEqual([]);
  });
});

describe('badgeFor', () => {
  test('percent while running', () => {
    expect(badgeFor(base).text).toBe('27%');
  });
  test('empty while reading the account (no percent yet)', () => {
    expect(badgeFor(withState({ phase: 'account', total: 0 })).text).toBe('');
  });
  test('check mark when done clean, bang when done with failures', () => {
    expect(badgeFor(withState({ phase: 'done' })).text).toBe('✓');
    expect(badgeFor(withState({ phase: 'done', failures: [{}] })).text).toBe('!');
  });
  test('bang on error', () => {
    expect(badgeFor(withState({ phase: 'error' })).text).toBe('!');
  });
  test('empty when idle, stopped or missing', () => {
    expect(badgeFor(null).text).toBe('');
    expect(badgeFor({ phase: 'idle' }).text).toBe('');
    expect(badgeFor(withState({ phase: 'stopped' })).text).toBe('');
  });
  test('every badge has a color', () => {
    expect(badgeFor(base).color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(badgeFor(null).color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('exporterControls', () => {
  const free = { running: false, folderReady: true };
  const busy = { running: true, folderReady: true };

  test('fresh page: only Start is shown', () => {
    expect(exporterControls(null, free)).toEqual({
      start: 'enabled', pause: 'hidden', resume: 'hidden', stop: 'hidden', retry: 'hidden',
    });
  });
  test('Start and Resume are disabled until a folder is ready', () => {
    const c = exporterControls(withState({ phase: 'done', failures: [{}] }), { running: false, folderReady: false });
    expect(c.start).toBe('disabled');
  });
  test('Retry stays enabled when folder access lapsed, since the click asks for it again', () => {
    const c = exporterControls(withState({ phase: 'done', failures: [{}] }), { running: false, folderReady: false });
    expect(c.retry).toBe('enabled');
  });
  test('while working: Pause and Stop', () => {
    expect(exporterControls(base, busy)).toEqual({
      start: 'hidden', pause: 'enabled', resume: 'hidden', stop: 'enabled', retry: 'hidden',
    });
  });
  test('paused while the engine is alive: Resume and Stop', () => {
    const c = exporterControls(withState({ phase: 'paused' }), busy);
    expect([c.resume, c.stop, c.pause, c.start]).toEqual(['enabled', 'enabled', 'hidden', 'hidden']);
  });
  test('interrupted or stopped with no engine: Resume replaces Start, no Stop', () => {
    for (const patch of [{ phase: 'paused', interrupted: true }, { phase: 'stopped' }, { phase: 'error' }]) {
      const c = exporterControls(withState(patch), free);
      expect([c.resume, c.start, c.stop]).toEqual(['enabled', 'hidden', 'hidden']);
    }
  });
  test('done with failures: Start again and Retry failed', () => {
    const c = exporterControls(withState({ phase: 'done', failures: [{}] }), free);
    expect([c.start, c.retry, c.resume]).toEqual(['enabled', 'enabled', 'hidden']);
  });
});

describe('exporterControls while starting', () => {
  test('Start, Resume and Retry are disabled, nothing else appears', () => {
    const opts = { running: false, folderReady: true, starting: true };
    expect(exporterControls(null, opts).start).toBe('disabled');
    const c = exporterControls(withState({ phase: 'done', failures: [{}] }), opts);
    expect([c.start, c.retry, c.pause, c.stop]).toEqual(['disabled', 'disabled', 'hidden', 'hidden']);
    expect(exporterControls(withState({ phase: 'stopped' }), opts).resume).toBe('disabled');
  });
});

describe('replyNotice', () => {
  test('maps known reasons to clear messages', () => {
    expect(replyNotice({ ok: false, reason: 'pick-folder' })).toBe('Choose a folder in the exporter tab first.');
    expect(replyNotice({ ok: false, reason: 'busy' })).toBe('An export is already running.');
    expect(replyNotice({ ok: false, reason: 'idle' })).toBe('No export is running.');
  });
  test('no reply from the exporter tab', () => {
    for (const reason of ['no-exporter', 'no-reply']) {
      expect(replyNotice({ ok: false, reason })).toBe('The exporter tab did not respond. Open it to continue.');
    }
  });
  test('other replies show their own message, else a generic one', () => {
    expect(replyNotice({ ok: false, reason: 'error', message: 'Disk full' })).toBe('Disk full');
    expect(replyNotice({ ok: false, reason: 'unknown' })).toBe('The exporter could not do that.');
  });
  test('success has no notice', () => {
    expect(replyNotice({ ok: true })).toBe('');
  });
});

describe('viewFor (exporter)', () => {
  const ready = { running: false, folderReady: true, hasHandle: true, folderName: 'Backup' };
  const ids = (list) => list.map((a) => a.id);

  test('setup: no folder yet, only Choose a folder', () => {
    const v = viewFor(null, { running: false, folderReady: false, hasHandle: false });
    expect(v.view).toBe('setup');
    expect(v.title).toBe('Export your ChatGPT chats');
    expect(v.primary).toMatchObject({ id: 'choose-folder', label: 'Choose a folder', disabled: false });
    expect(v.secondary).toEqual([]);
    expect(v.showProgress).toBe(false);
  });
  test('ready: Start export, or Update export when the folder holds a previous export', () => {
    expect(viewFor(null, ready).primary).toMatchObject({ id: 'start', label: 'Start export', disabled: false });
    const update = viewFor({ phase: 'idle' }, { ...ready, hasPreviousExport: true });
    expect(update.view).toBe('ready');
    expect(update.primary.label).toBe('Update export');
    expect(update.subtitle).toBe('Picks up new and changed chats only.');
  });
  test('ready: a saved folder that needs permission offers Continue in <name>', () => {
    const v = viewFor(null, { ...ready, folderReady: false });
    expect(v.primary).toMatchObject({ id: 'continue-folder', label: 'Continue in Backup' });
  });
  test('ready: logged out shows a login banner', () => {
    expect(viewFor(null, { ...ready, loginNeeded: true }).banner).toMatchObject({ tone: 'danger', login: true });
  });
  test('ready: Start is disabled while a run is being set up', () => {
    expect(viewFor(null, { ...ready, starting: true }).primary.disabled).toBe(true);
  });
  test('running: no primary, Pause and a quiet Stop, progress and label', () => {
    const v = viewFor(base, { ...ready, running: true });
    expect(v.view).toBe('running');
    expect(v.primary).toBeNull();
    expect(ids(v.secondary)).toEqual(['pause', 'stop']);
    expect(v.secondary[1].tone).toBe('danger-text');
    expect(v.showProgress).toBe(true);
    expect(v.indeterminate).toBe(false);
    expect(v.percent).toBe(27);
    expect(v.label).toBe('Exporting chat 132 of 480');
    expect(v.current).toBe('Trip plan');
    expect(v.banner).toBeNull();
  });
  test('running: account and listing phases are indeterminate with their own label', () => {
    const account = viewFor(withState({ phase: 'account', total: 0, current: null }), { ...ready, running: true });
    expect(account.indeterminate).toBe(true);
    expect(account.label).toBe('Preparing: reading your account');
    expect(viewFor(withState({ phase: 'listing' }), { ...ready, running: true }).label).toBe('Listing your chats');
  });
  test('paused with a live engine: warning banner, Resume primary, Stop', () => {
    const v = viewFor(withState({ phase: 'paused' }), { ...ready, running: true });
    expect(v.view).toBe('paused');
    expect(v.banner).toEqual({ tone: 'warning', text: 'Paused' });
    expect(v.primary).toMatchObject({ id: 'resume', label: 'Resume' });
    expect(ids(v.secondary)).toEqual(['stop']);
  });
  test('rate-limit pause shows the error message', () => {
    const s = withState({ phase: 'paused', errorKind: 'rate', error: 'ChatGPT keeps rate limiting.' });
    expect(viewFor(s, { ...ready, running: true }).banner.text).toBe('ChatGPT keeps rate limiting.');
  });
  test('interrupted: no engine, so no Stop', () => {
    const v = viewFor(withState({ phase: 'paused', interrupted: true }), ready);
    expect(v.banner.text).toBe('Interrupted: the tab was closed');
    expect(v.primary.id).toBe('resume');
    expect(v.secondary).toEqual([]);
  });
  test('stopped maps to the paused view', () => {
    const v = viewFor(withState({ phase: 'stopped' }), ready);
    expect(v.view).toBe('paused');
    expect(v.banner.text).toBe('Stopped');
    expect(v.primary.id).toBe('resume');
  });
  test('auth error: login primary, Try again secondary', () => {
    const v = viewFor(withState({ phase: 'error', error: 'Not logged in', errorKind: 'auth' }), ready);
    expect(v.view).toBe('error');
    expect(v.banner).toEqual({ tone: 'danger', text: 'Not logged in' });
    expect(v.primary).toMatchObject({ id: 'login', label: 'Log in to ChatGPT' });
    expect(v.secondary[0]).toMatchObject({ id: 'resume', label: 'Try again' });
  });
  test('other error: Try again primary', () => {
    const v = viewFor(withState({ phase: 'error', error: 'Boom', errorKind: 'shape' }), ready);
    expect(v.primary).toMatchObject({ id: 'resume', label: 'Try again' });
    expect(v.secondary).toEqual([]);
  });
  test('done: Check for new chats primary, Retry N failed secondary', () => {
    const clean = viewFor(withState({ phase: 'done' }), ready);
    expect(clean.view).toBe('done');
    expect(clean.primary).toMatchObject({ id: 'start', label: 'Check for new chats' });
    expect(clean.secondary).toEqual([]);
    const bad = viewFor(withState({ phase: 'done', failures: [{}, {}] }), ready);
    expect(bad.secondary[0]).toMatchObject({ id: 'retry-failed', label: 'Retry 2 failed' });
  });
  test('without a saved folder and no live engine the page is back to setup', () => {
    expect(viewFor(withState({ phase: 'done' }), { running: false, folderReady: false, hasHandle: false }).view).toBe('setup');
  });
});

describe('doneSummary', () => {
  test('counts chats and files with plurals and the folder name', () => {
    const s = withState({ phase: 'done', done: 6, partial: 1, filesSaved: 72, failures: [] });
    expect(doneSummary(s, 'Backup')).toEqual({
      counts: '7 chats, 72 files',
      message: '7 chats and 72 files saved to Backup.',
      attention: null,
    });
  });
  test('singular forms and failures', () => {
    const s = withState({ phase: 'done', done: 1, partial: 0, filesSaved: 1, failures: [{}] });
    const out = doneSummary(s, '');
    expect(out.message).toBe('1 chat and 1 file saved to your folder.');
    expect(out.attention).toBe('1 chat needs attention');
    expect(doneSummary(withState({ failures: [{}, {}, {}] }), 'x').attention).toBe('3 chats need attention');
  });
});

describe('popupView', () => {
  test('idle: one primary Open exporter', () => {
    const v = popupView(null, { exporterOpen: true });
    expect(v).toMatchObject({ view: 'idle', title: 'Export your chats', line: 'Saves your ChatGPT chats, images and settings to a folder. More AI chat apps coming soon.' });
    expect(v.primary).toEqual({ id: 'open-exporter', label: 'Open exporter' });
    expect(v.secondary).toEqual([]);
  });
  test('running: no primary, Pause plus Open exporter text', () => {
    const v = popupView(base, { exporterOpen: true });
    expect(v.view).toBe('running');
    expect(v.primary).toBeNull();
    expect(v.label).toBe('Chat 132 of 480');
    expect(v.percent).toBe(27);
    expect(v.secondary.map((a) => a.id)).toEqual(['pause', 'open-exporter']);
  });
  test('paused: warning, Resume, Stop', () => {
    const v = popupView(withState({ phase: 'paused' }), { exporterOpen: true });
    expect(v.banner).toEqual({ tone: 'warning', text: 'Paused' });
    expect(v.primary.id).toBe('resume');
    expect(v.secondary.map((a) => a.id)).toEqual(['stop']);
  });
  test('closed exporter tab: Open exporter is the only button', () => {
    const v = popupView(base, { exporterOpen: false });
    expect(v.banner.text).toBe('Exporter tab closed. Open it to continue.');
    expect(v.primary).toEqual({ id: 'open-exporter', label: 'Open exporter' });
    expect(v.secondary).toEqual([]);
  });
  test('error: danger line and recovery', () => {
    const v = popupView(withState({ phase: 'error', error: 'Log in', errorKind: 'auth' }), { exporterOpen: true });
    expect(v.banner).toEqual({ tone: 'danger', text: 'Log in' });
    expect(v.primary.id).toBe('login');
  });
  test('done: summary, attention link and Check for new chats', () => {
    const s = withState({ phase: 'done', done: 7, partial: 0, filesSaved: 72, failures: [{}, {}, {}] });
    const v = popupView(s, { exporterOpen: true });
    expect(v).toMatchObject({ view: 'done', title: 'Export complete', line: '7 chats, 72 files' });
    expect(v.primary).toEqual({ id: 'check-new', label: 'Check for new chats' });
    expect(v.secondary).toEqual([{ id: 'open-exporter', label: '3 chats need attention', tone: 'danger-text' }]);
    expect(popupView(s, { exporterOpen: false }).primary.id).toBe('open-exporter');
  });
});
