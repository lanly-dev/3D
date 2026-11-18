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

const tabServices = document.getElementById('tab-services');
const tabAssistant = document.getElementById('tab-assistant');
const tabSettings = document.getElementById('tab-settings');
tabServices.addEventListener('click', () => bridge.switchSite('services'));
tabAssistant.addEventListener('click', () => bridge.switchSite('assistant'));
tabSettings.addEventListener('click', () => bridge.switchSite('settings'));

backBtn.disabled = true;
forwardBtn.disabled = true;

bridge.onState((state) => {
  if (state.site) {
    // The Services tab owns the four 3D sites; Assistant and Settings are
    // tabs of their own.
    tabServices.classList.toggle('active', state.site !== 'assistant' && state.site !== 'settings');
    tabAssistant.classList.toggle('active', state.site === 'assistant');
    tabSettings.classList.toggle('active', state.site === 'settings');
  }
  backBtn.disabled = !state.canGoBack;
  forwardBtn.disabled = !state.canGoForward;
  if (typeof state.zoomPct === 'number') {
    zoomResetBtn.textContent = `${state.zoomPct}%`;
    zoomOutBtn.disabled = !state.canZoomOut;
    zoomInBtn.disabled = !state.canZoomIn;
  }
});
