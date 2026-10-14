(() => {
  'use strict';

  const fragment = window.location.hash.slice(1);
  let cleanAddress = false;
  try {
    window.history.replaceState(null, '', window.location.pathname);
    cleanAddress = true;
  } catch {}
  const params = new URLSearchParams(fragment);
  const token = params.get('token');
  const campaign = params.get('campaign');
  const id = params.get('id');
  const allowedFields = campaign && !id ? ['campaign', 'token'] : id && !campaign ? ['id', 'token'] : [];
  const validLink = cleanAddress && allowedFields.length === 2 &&
    [...params.keys()].length === 2 && [...params.keys()].every(key => allowedFields.includes(key)) &&
    /^[A-Za-z0-9_-]{8,80}$/.test(campaign || id || '') && /^[A-Za-z0-9_-]{43}$/.test(token || '');

  const byId = id => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');


  const slides = ['../horizontals/im1.jpg', '../horizontals/im2.jpg', '../horizontals/im3.jpg'];
  const backgrounds = [byId('bgA'), byId('bgB')];
  let currentSlide = 0;
  let activeBackground = 0;
  let slideTimer;
  function stopSlideshow() {
    window.clearInterval(slideTimer);
  }
  function startSlideshow() {
    stopSlideshow();
    if (reducedMotion.matches || document.hidden) return;
    slideTimer = window.setInterval(() => {
      currentSlide = (currentSlide + 1) % slides.length;
      const nextBackground = 1 - activeBackground;
      backgrounds[nextBackground].style.backgroundImage = `url('${slides[currentSlide]}')`;
      backgrounds[nextBackground].style.opacity = '1';
      backgrounds[activeBackground].style.opacity = '0';
      activeBackground = nextBackground;
    }, 5200);
  }
  reducedMotion.addEventListener('change', startSlideshow);
  document.addEventListener('visibilitychange', startSlideshow);
  startSlideshow();

  const endpoint = 'https://admin.cueconsociety.com/api/public/unsubscribe';
  const form = byId('request-form');
  const emailInput = byId('subscriber-email');
  const requestButton = byId('request-button');
  const confirmButton = byId('confirm-button');
  const retryButton = byId('retry-button');
  let busy = false;
  let readyToConfirm = false;

  function showStatus(element, message, kind = '') {
    element.textContent = message;
    element.className = `status ${kind}`.trim();
    if (message) element.focus();
  }

  function showPanel(panel) {
    form.hidden = panel !== 'request-form';
    byId('confirmation-panel').hidden = panel !== 'confirmation-panel';
    byId('result-panel').hidden = panel !== 'result-panel';
  }

  function showResult(heading, message, retry = false) {
    readyToConfirm = false;
    showPanel('result-panel');
    byId('result-heading').textContent = heading;
    byId('result-message').textContent = message;
    retryButton.hidden = !retry;
    byId('result-heading').focus();
  }

  function linkError() {
    showResult('Link unavailable', 'Open Unsubscribe from a CES email, or contact the board below.');
  }

  async function request(payload) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok !== true) {
        const error = new Error(response.status === 429 ? 'Please wait a moment before trying again.' :
          response.status === 400 || response.status === 404 || response.status === 410 ? 'This link is invalid or expired. Contact the board below.' :
            'We could not complete the request. Try again or contact the board below.');
        error.invalidLink = [400, 404, 410].includes(response.status);
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The request took too long. Try again or contact the board below.');
      if (error instanceof TypeError) throw new Error('We could not connect. Try again or contact the board below.');
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function inspectLink() {
    if (busy || !validLink || !id) return;
    busy = true;
    readyToConfirm = false;
    retryButton.disabled = true;
    byId('unsubscribe-content').setAttribute('aria-busy', 'true');
    try {
      const data = await request({ action: 'inspect', id, token });
      if (typeof data.confirmed !== 'boolean' || typeof data.email !== 'string' ||
          data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
        throw new Error('We could not verify this link. Try again or contact the board below.');
      }
      if (data.confirmed) {
        showResult('Request complete', 'This unsubscribe request has already been completed.');
        return;
      }
      byId('confirmation-email').textContent = data.email;
      showPanel('confirmation-panel');
      byId('confirmation-heading').focus();
      readyToConfirm = true;
    } catch (error) {
      showResult(error.invalidLink ? 'Link unavailable' : 'Unable to check the link', error.message, !error.invalidLink);
    } finally {
      busy = false;
      retryButton.disabled = false;
      byId('unsubscribe-content').removeAttribute('aria-busy');
    }
  }

  form.addEventListener('input', () => emailInput.removeAttribute('aria-invalid'));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !validLink || !campaign) return;
    const email = emailInput.value.trim();
    emailInput.value = email;
    if (!email || email.length > 254 || !emailInput.validity.valid || /[\r\n]/.test(email)) {
      showStatus(byId('request-status'), 'Enter the email address that received the newsletter.', 'error');
      emailInput.setAttribute('aria-invalid', 'true');
      emailInput.focus();
      return;
    }
    busy = true;
    requestButton.disabled = true;
    requestButton.textContent = 'Requesting…';
    form.setAttribute('aria-busy', 'true');
    byId('request-status').textContent = '';
    try {
      await request({ action: 'request', campaign, token, email });
      showResult('Request received', 'If this address received the newsletter and a confirmation can be sent, check its inbox. Use the private link there to unsubscribe.');
    } catch (error) {
      if (error.invalidLink) showResult('Link unavailable', error.message);
      else showStatus(byId('request-status'), error.message, 'error');
    } finally {
      busy = false;
      requestButton.disabled = false;
      requestButton.textContent = 'Send confirmation →';
      form.removeAttribute('aria-busy');
    }
  });

  confirmButton.addEventListener('click', async () => {
    if (busy || !readyToConfirm || !validLink || !id) return;
    busy = true;
    confirmButton.disabled = true;
    confirmButton.textContent = 'Confirming…';
    byId('confirmation-panel').setAttribute('aria-busy', 'true');
    byId('confirmation-status').textContent = '';
    try {
      const data = await request({ action: 'confirm', id, token });
      if (data.confirmed !== true) throw new Error('We could not confirm the request. Try again or contact the board below.');
      showResult('Request complete', 'Your unsubscribe request is complete.');
    } catch (error) {
      if (error.invalidLink) showResult('Link unavailable', error.message);
      else showStatus(byId('confirmation-status'), error.message, 'error');
    } finally {
      busy = false;
      confirmButton.disabled = false;
      confirmButton.textContent = 'Confirm unsubscribe →';
      byId('confirmation-panel').removeAttribute('aria-busy');
    }
  });

  retryButton.addEventListener('click', inspectLink);
  if (!validLink) linkError();
  else if (campaign) showPanel('request-form');
  else inspectLink();
})();
