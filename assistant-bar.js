// Assistant sub-tab strip (renderer): three buttons, one per hosted
// assistant. State lives in the main process; this forwards clicks
// and reflects the active assistant it is sent.
const bridge = window.assistantApi;

const NAMES = ['copilot', 'gemini', 'claude'];
for (const name of NAMES) {
  document.getElementById(`asst-${name}`).addEventListener('click', () => bridge.setAssistant(name));
}

bridge.onState((state) => {
  if (!state || !state.active) return;
  for (const name of NAMES) {
    document.getElementById(`asst-${name}`).classList.toggle('active', state.active === name);
  }
});
