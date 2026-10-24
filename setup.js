// MeshCoder setup window (renderer): collects the one-time Hugging Face
// token, starts/cancels the main-process setup run, and renders its
// streamed log + phase/progress state.
const bridge = window.setupApi;

const tokenInput = document.getElementById('token');
const openPageBtn = document.getElementById('open-page');
const barFill = document.getElementById('bar-fill');
const phaseEl = document.getElementById('phase');
const logEl = document.getElementById('log');
const startBtn = document.getElementById('start');
const cancelBtn = document.getElementById('cancel');
const closeBtn = document.getElementById('close');

const MAX_LOG_LINES = 600;

function appendLog(line) {
  logEl.textContent += `${line}\n`;
  const lines = logEl.textContent.split('\n');
  if (lines.length > MAX_LOG_LINES) {
    logEl.textContent = lines.slice(lines.length - MAX_LOG_LINES).join('\n');
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function setRunning(running) {
  startBtn.disabled = running;
  tokenInput.disabled = running;
  cancelBtn.disabled = !running;
}

openPageBtn.addEventListener('click', () => bridge.openModelPage());

startBtn.addEventListener('click', async () => {
  setRunning(true);
  appendLog('Starting setup…');
  const result = await bridge.start(tokenInput.value.trim());
  if (result && !result.ok && result.message !== 'Setup is already running') {
    // The failure itself is detailed in the log + state from the main side.
  }
  setRunning(false);
});

cancelBtn.addEventListener('click', () => {
  appendLog('Cancelling…');
  bridge.cancel();
});

closeBtn.addEventListener('click', () => window.close());

bridge.onLog((line) => appendLog(line));

bridge.onState((state) => {
  if (!state) return;
  phaseEl.textContent = state.label || state.phase || '';
  if (typeof state.pct === 'number' && state.pct >= 0) {
    barFill.classList.remove('indeterminate');
    barFill.style.width = `${state.pct}%`;
  } else if (state.phase === 'running') {
    barFill.classList.add('indeterminate');
  } else {
    barFill.classList.remove('indeterminate');
    if (state.phase === 'done') barFill.style.width = '100%';
  }
  if (state.phase === 'done' || state.phase === 'error' || state.phase === 'cancelled') {
    setRunning(false);
  }
});
