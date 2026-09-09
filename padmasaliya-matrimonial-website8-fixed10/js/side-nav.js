// ---- Collapsible side navigation ----------------------------------------
// The dashboard sidebar is eleven links tall. On a phone it pushed the
// profiles a full screen down; on a laptop it eats a column the results
// could use. So it becomes a drawer everywhere: the button opens it, the
// button closes it, and on a phone tapping the page behind closes it too.
//
// Loaded on dashboard.html and create-profile.html, after main.js.

(function () {
  'use strict';

  const toggle = document.getElementById('navToggle');
  const nav    = document.getElementById('sideNav');
  const scrim  = document.getElementById('navScrim');
  if (!toggle || !nav) return;

  const KEY = 'padma_nav_open';
  const isOverlay = () => window.matchMedia('(max-width:1080px)').matches;

  function setOpen(open, remember) {
    document.body.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (scrim) scrim.hidden = !(open && isOverlay());
    // A drawer over the page traps scroll behind it; a docked one must not.
    document.body.style.overflow = (open && isOverlay()) ? 'hidden' : '';
    if (remember && !isOverlay()) {
      try { localStorage.setItem(KEY, open ? '1' : '0'); } catch (e) {}
    }
  }

  // On a laptop the drawer stays where the parent last left it. On a phone it
  // always starts closed — opening over the results by surprise helps nobody.
  function initial() {
    if (isOverlay()) return false;
    try { return localStorage.getItem(KEY) !== '0'; } catch (e) { return true; }
  }
  setOpen(initial(), false);

  toggle.addEventListener('click', () => {
    setOpen(!document.body.classList.contains('nav-open'), true);
  });

  if (scrim) scrim.addEventListener('click', () => setOpen(false, false));

  const closeBtn = document.getElementById('navClose');
  if (closeBtn) closeBtn.addEventListener('click', () => { setOpen(false, false); toggle.focus(); });

  // Escape closes it while it is covering the page.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOverlay() && document.body.classList.contains('nav-open')) {
      setOpen(false, false);
      toggle.focus();
    }
  });

  // Picking a destination on a phone should get out of the way by itself.
  nav.addEventListener('click', (e) => {
    if (!isOverlay()) return;
    if (e.target.closest('.s3-nav-item')) setOpen(false, false);
  });

  // Crossing the breakpoint (rotating a tablet, resizing a window) must not
  // leave the page scroll-locked behind a drawer that is now docked.
  let wasOverlay = isOverlay();
  window.addEventListener('resize', () => {
    const now = isOverlay();
    if (now === wasOverlay) return;
    wasOverlay = now;
    setOpen(now ? false : initial(), false);
  });
})();
