// Top navigation bar buttons (renderer). All state lives in the main
// process; this just forwards clicks and greys the arrows out.
const bridge = window.navApi;

const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn = document.getElementById('reload');

backBtn.addEventListener('click', () => bridge.back());
forwardBtn.addEventListener('click', () => bridge.forward());
reloadBtn.addEventListener('click', () => bridge.reload());

backBtn.disabled = true;
forwardBtn.disabled = true;

bridge.onState((state) => {
  backBtn.disabled = !state.canGoBack;
  forwardBtn.disabled = !state.canGoForward;
});
