// Top navigation bar (renderer): back / forward / reload and the site
// view's zoom controls. All state lives in the main process; this just
// forwards clicks and reflects the state it is sent.
const bridge = window.navApi;

const backBtn = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn = document.getElementById('reload');
const zoomOutBtn = document.getElementById('zoom-out');
const zoomInBtn = document.getElementById('zoom-in');
const zoomResetBtn = document.getElementById('zoom-reset');

backBtn.addEventListener('click', () => bridge.back());
forwardBtn.addEventListener('click', () => bridge.forward());
reloadBtn.addEventListener('click', () => bridge.reload());
zoomOutBtn.addEventListener('click', () => bridge.zoomOut());
zoomInBtn.addEventListener('click', () => bridge.zoomIn());
zoomResetBtn.addEventListener('click', () => bridge.zoomReset());

const tabHunyuan = document.getElementById('tab-hunyuan');
const tabMixamo = document.getElementById('tab-mixamo');
const tabPolyPizza = document.getElementById('tab-polypizza');
tabHunyuan.addEventListener('click', () => bridge.switchSite('hunyuan'));
tabMixamo.addEventListener('click', () => bridge.switchSite('mixamo'));
tabPolyPizza.addEventListener('click', () => bridge.switchSite('polypizza'));

backBtn.disabled = true;
forwardBtn.disabled = true;

bridge.onState((state) => {
  if (state.site) {
    tabHunyuan.classList.toggle('active', state.site === 'hunyuan');
    tabMixamo.classList.toggle('active', state.site === 'mixamo');
    tabPolyPizza.classList.toggle('active', state.site === 'polypizza');
  }
  backBtn.disabled = !state.canGoBack;
  forwardBtn.disabled = !state.canGoForward;
  if (typeof state.zoomPct === 'number') {
    zoomResetBtn.textContent = `${state.zoomPct}%`;
    zoomOutBtn.disabled = !state.canZoomOut;
    zoomInBtn.disabled = !state.canZoomIn;
  }
});
