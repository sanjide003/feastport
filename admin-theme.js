(function initFeastportAdminTheme() {
  const STORAGE_KEY = 'feastport_admin_theme';
  const DARK_QUERY = '(prefers-color-scheme: dark)';

  window.tailwind = window.tailwind || {};
  window.tailwind.config = {
    ...(window.tailwind.config || {}),
    darkMode: 'class'
  };

  function getStoredTheme() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value === 'dark' || value === 'light' ? value : null;
    } catch {
      return null;
    }
  }

  function setStoredTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignore storage quota / private-mode restrictions
    }
  }

  function getSystemTheme() {
    try {
      return window.matchMedia && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }

  function resolveTheme() {
    return getStoredTheme() || getSystemTheme();
  }

  function syncToggleButton(theme) {
    const btn = document.getElementById('btn-admin-theme');
    if (!btn) return;
    const isDark = theme === 'dark';
    const nextAction = isDark ? 'Switch to light mode' : 'Switch to dark mode';

    btn.setAttribute('aria-pressed', String(isDark));
    btn.setAttribute('aria-label', nextAction);
    btn.setAttribute('title', nextAction);

    const labelEl = btn.querySelector('[data-theme-label]');
    if (labelEl) {
      labelEl.textContent = isDark ? 'Light Mode' : 'Dark Mode';
    }

    const iconWrap = btn.querySelector('[data-theme-icon-wrap]');
    if (iconWrap) {
      iconWrap.innerHTML = isDark
        ? '<i data-lucide="sun" class="h-3.5 w-3.5 shrink-0"></i>'
        : '<i data-lucide="moon" class="h-3.5 w-3.5 shrink-0"></i>';
    }
  }

  function applyTheme(theme, { refreshIcons = false } = {}) {
    const resolved = theme === 'dark' ? 'dark' : 'light';
    const isDark = resolved === 'dark';
    const root = document.documentElement;

    root.classList.toggle('dark', isDark);
    root.style.colorScheme = resolved;
    root.dataset.theme = resolved;

    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', isDark ? '#0B1120' : '#F8FAFC');
    }

    syncToggleButton(resolved);
    if (refreshIcons) {
      window.lucide?.createIcons?.();
    }
    return resolved;
  }

  function toggleTheme() {
    const current = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    setStoredTheme(next);
    return applyTheme(next, { refreshIcons: true });
  }

  // Apply synchronously before first paint
  const initialTheme = resolveTheme();
  applyTheme(initialTheme);

  // Sync button markup once DOM is parsed
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      syncToggleButton(resolveTheme());
      window.lucide?.createIcons?.();
    }, { once: true });
  } else {
    syncToggleButton(initialTheme);
  }

  // Follow OS theme changes live when no manual override is saved
  try {
    const media = window.matchMedia && window.matchMedia(DARK_QUERY);
    if (media) {
      const onSystemThemeChange = (event) => {
        if (getStoredTheme()) return;
        applyTheme(event.matches ? 'dark' : 'light', { refreshIcons: true });
      };
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', onSystemThemeChange);
      } else if (typeof media.addListener === 'function') {
        media.addListener(onSystemThemeChange);
      }
    }
  } catch {
    // Ignore media listener issues
  }

  window.feastportAdminTheme = {
    getTheme: () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
    getStoredTheme,
    applyTheme: (theme) => applyTheme(theme, { refreshIcons: true }),
    toggleTheme,
    syncToggleButton: () => syncToggleButton(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
  };
})();
