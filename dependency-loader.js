const dependencyCatalog = {
    tailwind: { globalName: 'tailwind', label: 'Tailwind Play CDN' },
    lucide: { globalName: 'lucide', label: 'Lucide Icons', fallback: 'https://unpkg.com/lucide@1.25.0' }
};

const loadedFallbacks = new Map();
const LOAD_TIMEOUT_MS = 5000;
const hasDependency = (spec) => spec.test ? spec.test() : Boolean(window[spec.globalName]);

function loadFallback(src) {
    if (loadedFallbacks.has(src)) return loadedFallbacks.get(src);
    const promise = new Promise((resolve) => {
        const script = document.createElement('script');
        let settled = false;
        const finish = (ok, message) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            if (message) console.warn(message);
            resolve(ok);
        };
        const timer = window.setTimeout(() => finish(false, `Timed out loading ${src}`), LOAD_TIMEOUT_MS);
        script.src = src;
        script.async = false;
        script.onload = () => finish(true);
        script.onerror = () => finish(false, `Failed to load ${src}`);
        document.head.appendChild(script);
    });
    loadedFallbacks.set(src, promise);
    return promise;
}

function reportDependencyWarning(message) {
    console.warn(message);
    if (window.showToast) {
        window.showToast(message, 'error');
        return;
    }
    window.adminDependencyWarnings = window.adminDependencyWarnings || [];
    window.adminDependencyWarnings.push(message);
}

window.ensureAdminDependencies = async (names = Object.keys(dependencyCatalog)) => {
    const status = {};
    for (const name of names) {
        const spec = dependencyCatalog[name];
        if (!spec) continue;
        if (!hasDependency(spec) && spec.fallback) {
            await loadFallback(spec.fallback);
        }
        status[name] = hasDependency(spec);
        if (!status[name]) reportDependencyWarning(`${spec.label} failed to load. Some UI icons may be unavailable.`);
    }
    window.adminDependencyStatus = { ...(window.adminDependencyStatus || {}), ...status };
    return status;
};

window.adminDependencyCatalog = dependencyCatalog;
