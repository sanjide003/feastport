const toggle = document.getElementById('mobile-nav-toggle');
const drawer = document.getElementById('mobile-nav-drawer');

function setOpen(open) {
  drawer.classList.toggle('hidden', !open);
  toggle.setAttribute('aria-expanded', String(open));
}

toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
drawer.addEventListener('click', (event) => {
  if (event.target.closest('a')) setOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
    setOpen(false);
    toggle.focus();
  }
});
