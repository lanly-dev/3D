// Prepare Blender window (renderer): starts/cancels the main-process
// preparation run and renders its streamed log + phase state. Mirrors
// the MeshCoder setup window, minus the token step.
const bridge = window.prepApi;

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
  cancelBtn.disabled = !running;
}

startBtn.addEventListener('click', async () => {
  setRunning(true);
  appendLog('Preparing Blender…');
  await bridge.start();
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
