// sidebar-shell.js
// Unified responsive collapsible sidebar controller for desktop icon-rail & mobile off-canvas drawer

const STORAGE_KEY = 'feastport_sidebar_collapsed';
const STYLE_ID = 'feastport-sidebar-css';

function ensureSidebarStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @media (max-width: 1023.98px) {
      [data-app-sidebar] {
        position: fixed;
        top: 0;
        bottom: 0;
        left: 0;
        width: 16rem;
        z-index: 45;
        transform: translateX(-100%);
        transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      [data-app-sidebar][data-mobile-open="true"] {
        transform: translateX(0);
        box-shadow: 0 20px 25px -5px rgba(15, 23, 42, 0.15);
      }
      [data-app-sidebar-backdrop] {
        position: fixed;
        inset: 0;
        z-index: 40;
        background: rgba(15, 23, 42, 0.45);
        opacity: 0;
        pointer-events: none;
        transition: opacity 200ms ease;
      }
      [data-app-sidebar-backdrop][data-open="true"] {
        opacity: 1;
        pointer-events: auto;
      }
    }

    @media (min-width: 1024px) {
      [data-app-sidebar-backdrop],
      [data-sidebar-close] {
        display: none !important;
      }
      [data-app-sidebar] {
        position: sticky;
        top: 0;
        height: 100vh;
        width: 16rem;
        flex-shrink: 0;
        transform: translateX(0) !important;
        transition: width 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      [data-app-sidebar][data-collapsed="true"] {
        width: 4.5rem;
      }
      [data-app-sidebar][data-collapsed="true"] [data-sidebar-label],
      [data-app-sidebar][data-collapsed="true"] [data-sidebar-hide-collapsed] {
        display: none !important;
      }
      [data-app-sidebar][data-collapsed="true"] [data-sidebar-header] {
        justify-content: center;
        padding-left: 0.75rem;
        padding-right: 0.75rem;
      }
      [data-app-sidebar][data-collapsed="true"] [data-sidebar-nav] {
        padding-left: 0.625rem;
        padding-right: 0.625rem;
      }
      [data-app-sidebar][data-collapsed="true"] [data-sidebar-item] {
        justify-content: center;
        padding-left: 0;
        padding-right: 0;
        position: relative;
      }
      [data-app-sidebar][data-collapsed="true"] [data-sidebar-badge]:not(.hidden) {
        position: absolute;
        top: 0.25rem;
        right: 0.3rem;
        min-width: 1.05rem;
        height: 1.05rem;
        padding: 0 0.25rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 9px;
        line-height: 1;
        border-radius: 9999px;
      }
      [data-app-sidebar][data-collapsed="true"] [data-sidebar-footer] {
        padding-left: 0.625rem;
        padding-right: 0.625rem;
      }
      [data-app-sidebar][data-collapsed="true"] [data-sidebar-footer-grid] {
        grid-template-columns: 1fr;
      }
    }

    @media print {
      [data-app-sidebar],
      [data-app-sidebar-backdrop] {
        display: none !important;
      }
    }
  `;
  document.head.appendChild(style);
}

function readCollapsedPreference() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCollapsedPreference(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
  } catch {}
}

export function initCollapsibleSidebar({
  sidebarSelector = '[data-app-sidebar]',
  backdropSelector = '[data-app-sidebar-backdrop]',
  toggleSelector = '[data-sidebar-toggle]',
  closeSelector = '[data-sidebar-close]'
} = {}) {
  ensureSidebarStyles();

  const sidebar = document.querySelector(sidebarSelector);
  const backdrop = document.querySelector(backdropSelector);
  const desktopQuery = window.matchMedia('(min-width: 1024px)');

  if (!sidebar) {
    return {
      closeMobile: () => {},
      openMobile: () => {},
      toggleSidebar: () => {},
      setDesktopCollapsed: () => {}
    };
  }

  let desktopCollapsed = readCollapsedPreference();
  let mobileOpen = false;

  // Add helpful tooltips on sidebar items for desktop collapsed mode
  sidebar.querySelectorAll('[data-sidebar-item]').forEach((item) => {
    if (!item.getAttribute('title')) {
      const label = item.querySelector('[data-sidebar-label]')?.textContent?.trim();
      if (label) item.setAttribute('title', label);
    }
  });

  const PANEL_CLOSE_PATHS = '<rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M9 3v18"></path><path d="m16 15-3-3 3-3"></path>';
  const PANEL_OPEN_PATHS = '<rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M9 3v18"></path><path d="m14 9 3 3-3 3"></path>';

  function updateToggleButtons() {
    const isDesktop = desktopQuery.matches;
    const expanded = isDesktop ? !desktopCollapsed : mobileOpen;
    document.querySelectorAll(toggleSelector).forEach((btn) => {
      btn.setAttribute('aria-expanded', String(expanded));
      btn.setAttribute('title', isDesktop ? (desktopCollapsed ? 'Expand sidebar' : 'Collapse sidebar') : (mobileOpen ? 'Close menu' : 'Open menu'));
      const desktopIcon = btn.querySelector('[data-toggle-icon-desktop]');
      if (desktopIcon) {
        desktopIcon.setAttribute('data-lucide', desktopCollapsed ? 'panel-left-open' : 'panel-left-close');
        if (desktopIcon.tagName.toLowerCase() === 'svg') {
          desktopIcon.innerHTML = desktopCollapsed ? PANEL_OPEN_PATHS : PANEL_CLOSE_PATHS;
        }
      }
    });
    window.lucide?.createIcons?.();
  }

  function applyState() {
    sidebar.dataset.collapsed = desktopCollapsed ? 'true' : 'false';
    sidebar.dataset.mobileOpen = mobileOpen ? 'true' : 'false';
    if (backdrop) {
      backdrop.dataset.open = mobileOpen ? 'true' : 'false';
      backdrop.classList.toggle('hidden', !mobileOpen);
    }
    if (!desktopQuery.matches) {
      document.body.style.overflow = mobileOpen ? 'hidden' : '';
    } else {
      document.body.style.overflow = '';
    }
    updateToggleButtons();
  }

  function openMobile() {
    mobileOpen = true;
    applyState();
  }

  function closeMobile() {
    if (!mobileOpen) return;
    mobileOpen = false;
    applyState();
  }

  function setDesktopCollapsed(next) {
    desktopCollapsed = Boolean(next);
    writeCollapsedPreference(desktopCollapsed);
    applyState();
  }

  function toggleSidebar() {
    if (desktopQuery.matches) {
      setDesktopCollapsed(!desktopCollapsed);
    } else {
      mobileOpen = !mobileOpen;
      applyState();
    }
  }

  if (!sidebar.dataset.sidebarWired) {
    sidebar.dataset.sidebarWired = 'true';

    document.addEventListener('click', (event) => {
      if (event.target.closest(toggleSelector)) {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (event.target.closest(closeSelector) || (backdrop && event.target === backdrop)) {
        event.preventDefault();
        closeMobile();
        return;
      }
      const clickedNavItem = event.target.closest('[data-app-sidebar] [data-sidebar-item]');
      if (clickedNavItem && !desktopQuery.matches) {
        closeMobile();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && mobileOpen) closeMobile();
    });

    const handleBreakpointChange = () => {
      if (desktopQuery.matches && mobileOpen) mobileOpen = false;
      applyState();
    };
    if (typeof desktopQuery.addEventListener === 'function') {
      desktopQuery.addEventListener('change', handleBreakpointChange);
    } else if (typeof desktopQuery.addListener === 'function') {
      desktopQuery.addListener(handleBreakpointChange);
    }
  }

  applyState();

  return {
    closeMobile,
    openMobile,
    toggleSidebar,
    setDesktopCollapsed
  };
}
