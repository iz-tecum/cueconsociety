(() => {
  'use strict';

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

  const endpoint = document.querySelector('meta[name="ces-newsletter-api"]')?.content || '/api/newsletter';
  const form = byId('newsletter-form');
  const status = byId('form-status');
  const submitButton = byId('subscribe-button');
  const emailInput = byId('subscriber-email');
  const nameInput = byId('subscriber-name');
  const consentInput = byId('subscriber-consent');
  const interestInputs = [...form.querySelectorAll('input[name="interests"]')];
  const startedAt = Date.now();
  let busy = false;

  function showStatus(element, message, kind = '') {
    element.textContent = message;
    element.className = `status ${kind}`.trim();
    if (message) element.focus();
  }

  function validationError(message, input) {
    showStatus(status, message, 'error');
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    }
  }

  async function request(payload) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        if (response.status === 429) throw new Error('Please wait a moment before trying again.');
        if (response.status >= 500) throw new Error('The mailing list is temporarily unavailable. Please try again later or contact the board.');
        throw new Error(typeof data.error === 'string' ? data.error : 'We could not save your request. Please try again.');
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The request took too long. Your details are still here. Please try again.');
      if (error instanceof TypeError) throw new Error('We could not connect. Check your connection and try again.');
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  form.addEventListener('input', event => {
    event.target.removeAttribute('aria-invalid');
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const email = emailInput.value.trim();
    emailInput.value = email;
    const interests = interestInputs.filter(input => input.checked).map(input => input.value);
    form.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid'));
    if (!email || !emailInput.validity.valid) return validationError('Enter a valid email address to join the list.', emailInput);
    if (nameInput.value.trim().length > 100) return validationError('Please keep your name under 100 characters.', nameInput);
    if (!consentInput.checked) return validationError('Please check the box to agree to receive CES emails.', consentInput);
    busy = true;
    submitButton.disabled = true;
    submitButton.textContent = 'Joining…';
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Saving your request…';
    status.className = 'status';
    try {
      const data = await request({
        action: 'subscribe',
        name: nameInput.value.trim(),
        email,
        interests,
        consent: true,
        website: byId('website').value,
        startedAt
      });
      if (typeof data.manageToken === 'string' && data.manageToken) {
        const manageUrl = new URL('/newsletter/', window.location.origin);
        manageUrl.search = '';
        manageUrl.hash = new URLSearchParams({ email, token: data.manageToken }).toString();
        byId('manage-link').value = manageUrl.href;
        byId('manage-link-panel').hidden = false;
      }
      form.hidden = true;
      byId('signup-success').hidden = false;
      byId('success-heading').focus();
    } catch (error) {
      showStatus(status, error.message, 'error');
    } finally {
      busy = false;
      submitButton.disabled = false;
      submitButton.textContent = 'Join the mailing list →';
      form.removeAttribute('aria-busy');
    }
  });

  byId('copy-link').addEventListener('click', async () => {
    const input = byId('manage-link');
    try {
      await navigator.clipboard.writeText(input.value);
      byId('copy-status').textContent = 'Link copied. Save it somewhere private.';
    } catch {
      input.focus();
      input.select();
      byId('copy-status').textContent = 'Select and copy this link, then save it somewhere private.';
    }
  });

  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const queryParams = new URLSearchParams(window.location.search);
  const manageEmail = hashParams.get('email') || queryParams.get('email');
  const manageToken = hashParams.get('token') || queryParams.get('token');
  if (manageEmail && manageToken) {
    form.hidden = true;
    byId('unsubscribe-panel').hidden = false;
    byId('unsubscribe-email').textContent = manageEmail;
    byId('page-title').textContent = 'Your subscription';
    document.title = 'CES | Your Subscription';
    if (queryParams.has('token')) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.search = '';
      cleanUrl.hash = new URLSearchParams({ email: manageEmail, token: manageToken }).toString();
      history.replaceState(null, '', cleanUrl.href);
    }
    byId('unsubscribe-button').addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      const button = byId('unsubscribe-button');
      const unsubscribeStatus = byId('unsubscribe-status');
      button.disabled = true;
      button.textContent = 'Saving…';
      showStatus(unsubscribeStatus, 'Saving your request…');
      try {
        await request({ action: 'unsubscribe', email: manageEmail, token: manageToken });
        showStatus(unsubscribeStatus, 'Request received. If this link is valid, CES updates to this address will stop.', 'success');
        button.hidden = true;
      } catch (error) {
        showStatus(unsubscribeStatus, error.message, 'error');
      } finally {
        busy = false;
        button.disabled = false;
        button.textContent = 'Unsubscribe';
      }
    });
  }
})();
