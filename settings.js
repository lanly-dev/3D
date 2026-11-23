// Settings tab (renderer): the local rigging engine's status and its setup
// log. Installs run in the main process, so this page never drives one
// itself — it asks for the current state, triggers an install, and mirrors
// whatever it is told.
const bridge = window.settingsApi;

const statusEl = document.getElementById('status');
const missingEl = document.getElementById('missing');
const installBtn = document.getElementById('install');
const openBtn = document.getElementById('open-folder');
const noteEl = document.getElementById('note');
const logEl = document.getElementById('log');
const logPathEl = document.getElementById('log-path');
const appLogEl = document.getElementById('app-log');
const appLogPathEl = document.getElementById('app-log-path');

const STATUS_LABEL = {
  ready: 'Installed',
  missing: 'Not installed',
  partial: 'Partly installed',
  unsupported: 'Unavailable',
};

let latest = null;

// Each log pane only repaints when its text changed, and only follows the
// tail if it was already at the bottom (so scrolling back to read is stable).
function paintLog(el, text, placeholder) {
  const shown = text && text.trim() ? text : placeholder;
  if (shown === el.textContent) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  el.textContent = shown;
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function render(state) {
  if (!state) return;
  latest = state;
  const st = state.status || {};
  statusEl.textContent = STATUS_LABEL[st.state] || st.state || 'Unknown';
  statusEl.dataset.state = st.state || '';

  const missing = st.missing || [];
  if (st.state === 'unsupported' && st.reason) {
    missingEl.hidden = false;
    missingEl.textContent = st.reason;
  } else if (missing.length) {
    missingEl.hidden = false;
    missingEl.textContent = `Missing: ${missing.join(', ')}`;
  } else {
    missingEl.hidden = true;
  }

  const ready = st.state === 'ready';
  const unsupported = st.state === 'unsupported';
  const busy = Boolean(state.installing);
  installBtn.hidden = ready || unsupported;
  installBtn.disabled = busy;
  installBtn.textContent = busy
    ? 'Installing…'
    : st.state === 'partial' ? 'Resume install' : 'Install engine';

  logPathEl.textContent = state.logPath || '';
  paintLog(logEl, state.log, 'No setup log yet — install the engine to see progress here.');

  appLogPathEl.textContent = state.appLogPath || '';
  paintLog(appLogEl, state.appLog, 'Nothing logged yet.');
}

async function refresh() {
  try {
    render(await bridge.getState());
  } catch {
    /* window closing — nothing to paint */
  }
}

installBtn.addEventListener('click', async () => {
  installBtn.disabled = true;
  installBtn.textContent = 'Installing…';
  noteEl.hidden = false;
  noteEl.textContent = 'Installing — this downloads several GB and can take a while.';
  try {
    const res = await bridge.install();
    if (res && res.message) {
      noteEl.hidden = false;
      noteEl.textContent = res.message;
    }
  } catch {
    noteEl.hidden = false;
    noteEl.textContent = 'Install failed — see the setup log below.';
  }
  await refresh();
});

openBtn.addEventListener('click', () => bridge.openFolder());

bridge.onState(render);
refresh();
// The install writes to a log file as it goes (pip output, downloads), so a
// cheap tail read keeps the panel live — but only while this tab is showing.
setInterval(() => {
  if (!document.hidden) refresh();
}, 1500);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
