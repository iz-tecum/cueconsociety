(function () {
  'use strict';
  const frame = document.getElementById('ces-google-calendar');
  if (!frame || !window.matchMedia) return;
  const mobile = window.matchMedia('(max-width: 620px)');
  function updateView() {
    const source = new URL(frame.src);
    const mode = mobile.matches ? 'AGENDA' : 'MONTH';
    if (source.searchParams.get('mode') === mode) return;
    source.searchParams.set('mode', mode);
    frame.src = source.href;
  }
  updateView();
  mobile.addEventListener('change', updateView);
})();
