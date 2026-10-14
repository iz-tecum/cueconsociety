(() => {
  'use strict';

  const topbar = document.getElementById('topbar');
  const toggle = topbar?.querySelector('.nav-toggle');
  const nav = document.getElementById('mobileNav');
  const about = document.getElementById('aboutDrop');
  const aboutButton = document.getElementById('aboutBtn');
  const menu = document.getElementById('aboutMenu');
  const hero = document.getElementById('hero');
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
  if (!topbar || !toggle || !nav || !about || !aboutButton || !menu) return;

  const mobile = window.matchMedia('(max-width: 920px)');
  const hover = window.matchMedia('(hover: hover) and (pointer: fine)');
  const links = [...menu.querySelectorAll('a')];
  let menuOpen = false;
  let aboutOpen = false;

  function setAboutOpen(open) {
    aboutOpen = open && (!mobile.matches || menuOpen);
    about.classList.toggle('is-open', aboutOpen);
    aboutButton.setAttribute('aria-expanded', String(aboutOpen));
    menu.setAttribute('aria-hidden', String(!aboutOpen));
    menu.inert = !aboutOpen;
  }

  function setMenuOpen(open) {
    menuOpen = mobile.matches && open;
    topbar.classList.toggle('nav-open', menuOpen);
    toggle.setAttribute('aria-expanded', String(menuOpen));
    toggle.setAttribute('aria-label', menuOpen ? 'Close menu' : 'Open menu');
    nav.inert = mobile.matches && !menuOpen;
    if (nav.inert) nav.setAttribute('aria-hidden', 'true');
    else nav.removeAttribute('aria-hidden');
    if (!menuOpen) setAboutOpen(false);
  }

  function closeNavigation() {
    setAboutOpen(false);
    setMenuOpen(false);
  }

  function setNavState() {
    if (hero) topbar.classList.toggle('is-solid', hero.getBoundingClientRect().bottom <= 71);
  }

  toggle.addEventListener('click', () => setMenuOpen(!menuOpen));
  toggle.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' || !mobile.matches) return;
    event.preventDefault();
    setMenuOpen(true);
    aboutButton.focus();
  });
  aboutButton.addEventListener('click', () => setAboutOpen(!aboutOpen));
  aboutButton.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setAboutOpen(true);
    (event.key === 'ArrowDown' ? links[0] : links.at(-1))?.focus();
  });
  menu.addEventListener('keydown', event => {
    const index = links.indexOf(document.activeElement);
    if (index < 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 :
      (index + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
    links[next].focus();
  });
  about.addEventListener('mouseenter', () => {
    if (!mobile.matches && hover.matches) setAboutOpen(true);
  });
  about.addEventListener('mouseleave', () => {
    if (!mobile.matches && hover.matches && !about.contains(document.activeElement)) setAboutOpen(false);
  });
  about.addEventListener('focusout', event => {
    if (!about.contains(event.relatedTarget)) setAboutOpen(false);
  });
  nav.addEventListener('click', event => {
    if (event.target.closest('a')) closeNavigation();
  });
  document.addEventListener('pointerdown', event => {
    if (topbar.contains(event.target)) return;
    const focusWillBeHidden = mobile.matches ? nav.contains(document.activeElement) : menu.contains(document.activeElement);
    closeNavigation();
    if (focusWillBeHidden) (mobile.matches ? toggle : aboutButton).focus();
  });
  document.addEventListener('focusin', event => {
    if (!topbar.contains(event.target)) closeNavigation();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (aboutOpen) {
      event.preventDefault();
      setAboutOpen(false);
      aboutButton.focus();
    } else if (menuOpen) {
      event.preventDefault();
      setMenuOpen(false);
      toggle.focus();
    }
  });
  mobile.addEventListener('change', () => {
    const focusWasInNav = nav.contains(document.activeElement);
    closeNavigation();
    if (mobile.matches && focusWasInNav) toggle.focus();
    else if (!mobile.matches && document.activeElement === toggle) aboutButton.focus();
  });
  window.addEventListener('scroll', setNavState, { passive: true });
  window.addEventListener('resize', setNavState);
  closeNavigation();
  setNavState();
})();
