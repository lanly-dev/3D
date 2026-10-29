'use strict';

// The main process calls window.showToast(message) via executeJavaScript;
// view visibility and the auto-hide timer live in the main process.
window.showToast = (message) => {
  const el = document.getElementById('toast');
  el.textContent = String(message || '');
  el.classList.remove('show');
  void el.offsetWidth; // restart the transition on repeat messages
  el.classList.add('show');
};
