// Services sub-tab strip (renderer): one button per 3D site grouped under
// the nav bar's Services tab. State lives in the main process; this just
// forwards clicks and reflects the active service it is sent.
const bridge = window.servicesApi;

const NAMES = ['hunyuan', 'mixamo', 'polypizza', 'meshy'];
for (const name of NAMES) {
  document.getElementById(`svc-${name}`).addEventListener('click', () => bridge.setService(name));
}

bridge.onState((state) => {
  if (!state || !state.active) return;
  for (const name of NAMES) {
    document.getElementById(`svc-${name}`).classList.toggle('active', state.active === name);
  }
});
