import { app, auth, db } from './firebase-config.js';
import { initAdminAuth } from './admin-auth.js';
import { cachedGetDoc, invalidateCache } from './data-cache.js';
import { initImageUploads, assertPayloadSize, normalizeGallerySlots } from './image-upload.js';
import { normalizeBranding, brandingName, applyBase64Image, clearBrandingCache } from './branding-config.js';
import { normalizeFestSetup } from './fest-config.js';
import { parseCriteria, validateEvent, eventToFirestore, normalizeResultMethod, normalizeStage } from './event-utils.js';
import { normalizeRegistrationConfig } from './registration-utils.js';
import { defaultScoringRules, normalizeScoringRules, buildTeamScoreLedger } from './score-utils.js';
import { escapeHtml, printPage, resolveDisplayName } from './admin-utils.js';
import {
  defaultChestConfig,
  normalizeChestConfig,
  chestSeriesKey,
  parseChestSeed,
  resolveNextAutoChestNo,
  validateManualChestNo,
  DEFAULT_CLASS_LIST,
  defaultCategoryClassificationConfig,
  normalizeCategoryClassificationConfig,
  getStudentFieldVisibility,
  normalizeClassValue,
  resolveCategoryFromStudentInputs,
  studentClassValue,
  studentDobValue,
  buildStudentDetailsPatch
} from './admin-students.js';
import { createAdminResultsController } from './admin-results.js';
import { createAdminExcelController } from './admin-excel.js';
import { initCollapsibleSidebar } from './sidebar-shell.js';
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth as getSecondaryAuth, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut as signOutSecondary } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

const byId = (id) => document.getElementById(id);
const h = escapeHtml;
let sidebarShell = null;

let state = {
  homeConfig: {},
  generalConfig: {},
  festSetup: normalizeFestSetup(),
  registrationConfig: normalizeRegistrationConfig(),
  scheduleConfig: {},
  scoringRules: defaultScoringRules(),
  chestNumberConfig: defaultChestConfig(),
  chestDraftConfig: defaultChestConfig(),
  categoryClassification: defaultCategoryClassificationConfig(),
  categoryClassificationDraft: defaultCategoryClassificationConfig(),
  teams: [],
  teamColors: {},
  teamDisplayNames: {},
  categories: [],
  categoryDisplayNames: {},
  stages: [],
  days: [],
  students: [],
  events: [],
  registrations: [],
  registrationRequests: [],
  scheduleBreaks: [],
  accessUsers: [],
  judgeAssignments: [],
  judgeScores: [],
  results: [],
  notifications: [],
  tvConfig: {},
  tvControl: {},
  tvSelectedResultIds: new Set()
};

let activeTab = 'overview';
const activeSubTabs = {
  setup: 'identity',
  registrations: 'entries',
  results: 'assign'
};
let resultsController = null;
let excelController = null;

const teamName = (key) => resolveDisplayName(state.teamDisplayNames, key, key);
const categoryName = (key) => resolveDisplayName(state.categoryDisplayNames, key, key);
const toSlugKey = (raw) =>
  String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

function bindAutoSlugKey(labelId, keyId) {
  const labelEl = byId(labelId);
  const keyEl = byId(keyId);
  if (!labelEl || !keyEl) return;
  labelEl.addEventListener('input', () => {
    if (keyEl.dataset.manualEdited === 'true') return;
    keyEl.value = toSlugKey(labelEl.value);
  });
  keyEl.addEventListener('input', () => {
    keyEl.dataset.manualEdited = keyEl.value.trim() ? 'true' : 'false';
  });
}

function syncScoringGradesPanelVisibility() {
  const enabled = Boolean(byId('score-enable-grades')?.checked);
  byId('score-grades-panel')?.classList.toggle('hidden', !enabled);
}

function gradeRowHtml(type, g = {}) {
  const minPct = Number.isFinite(Number(g.minimumPercentage)) ? Number(g.minimumPercentage) : 60;
  const pts = Number.isFinite(Number(g.value)) ? Number(g.value) : 0;
  return `
    <div data-grade-row="${h(type)}" data-grade-key="${h(g.key || '')}" class="grid grid-cols-[1fr_78px_78px_28px] items-center gap-2">
      <input type="text" data-grade-field="label" value="${h(g.label || '')}" placeholder="e.g. A Grade" class="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
      <input type="number" data-grade-field="minimumPercentage" min="0" max="100" step="0.1" value="${minPct}" class="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 font-mono-num text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
      <input type="number" data-grade-field="value" min="0" step="0.5" value="${pts}" class="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 font-mono-num text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
      <button type="button" data-remove-grade-row="${h(type)}" title="Remove grade" class="flex h-7 w-7 items-center justify-center rounded-md border border-red-200 bg-red-50 text-xs font-bold text-red-600 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/70">✕</button>
    </div>
  `;
}

function renderScoringGradesEditor(sr = state.scoringRules) {
  const normalized = normalizeScoringRules(sr);
  const singleList = byId('grades-list-single');
  const groupList = byId('grades-list-group');
  if (singleList) {
    singleList.innerHTML = (normalized.configs?.Single?.grades || []).map((g) => gradeRowHtml('Single', g)).join('');
  }
  if (groupList) {
    groupList.innerHTML = (normalized.configs?.Group?.grades || []).map((g) => gradeRowHtml('Group', g)).join('');
  }
  syncScoringGradesPanelVisibility();
}

function appendGradeRow(type) {
  const list = byId(type === 'Group' ? 'grades-list-group' : 'grades-list-single');
  if (!list) return;
  const rows = [...list.querySelectorAll('[data-grade-row]')];
  const idx = rows.length;
  const nextLetter = idx < 26 ? `${String.fromCharCode(65 + idx)} Grade` : `Grade ${idx + 1}`;
  const mins = rows.map((r) => Number(r.querySelector('[data-grade-field="minimumPercentage"]')?.value)).filter(Number.isFinite);
  const minPct = mins.length ? Math.max(0, Math.min(...mins) - 10) : 80;
  list.insertAdjacentHTML('beforeend', gradeRowHtml(type, {
    key: `${type.toLowerCase()}_grade_${Date.now()}_${idx + 1}`,
    label: nextLetter,
    minimumPercentage: minPct,
    value: 0
  }));
  list.lastElementChild?.querySelector('[data-grade-field="label"]')?.focus();
}

function collectGradeRows(type) {
  const list = byId(type === 'Group' ? 'grades-list-group' : 'grades-list-single');
  if (!list) return { ok: true, grades: [] };
  const rows = [...list.querySelectorAll('[data-grade-row]')];
  const grades = [];
  const seenLabels = new Set();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const label = String(row.querySelector('[data-grade-field="label"]')?.value || '').trim();
    const minPct = Number(row.querySelector('[data-grade-field="minimumPercentage"]')?.value);
    const value = Number(row.querySelector('[data-grade-field="value"]')?.value);
    if (!label) return { ok: false, error: `${type} Grade row #${i + 1}: Grade Letter is required.` };
    const normLabel = label.toLowerCase();
    if (seenLabels.has(normLabel)) return { ok: false, error: `${type} Grades contain duplicate label "${label}".` };
    seenLabels.add(normLabel);
    if (!Number.isFinite(minPct) || minPct < 0 || minPct > 100) {
      return { ok: false, error: `${type} Grade "${label}": Min % must be between 0 and 100.` };
    }
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, error: `${type} Grade "${label}": Points must be 0 or greater.` };
    }
    const slug = toSlugKey(label) || String(i + 1);
    const existingKey = String(row.dataset.gradeKey || '').trim();
    grades.push({
      key: existingKey || `${type.toLowerCase()}_grade_${slug}`,
      order: i + 1,
      label,
      minimumPercentage: minPct,
      value
    });
  }
  return { ok: true, grades };
}

function closeModal(id) {
  const el = byId(id);
  if (!el) return;
  el.classList.add('hidden');
  el.classList.remove('flex');
}

function openModal(id) {
  const el = byId(id);
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('flex');
}

function showToast(msg, type = 'success') {
  const el = byId('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `fixed bottom-5 right-5 z-[110] rounded-lg border px-4 py-3 text-xs font-semibold shadow-lg ${
    type === 'error'
      ? 'border-red-700 bg-red-700 text-white dark:border-red-600 dark:bg-red-700'
      : 'border-slate-800 bg-slate-900 text-white dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
  }`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3200);
}

function confirmAction(msg, { title = 'Confirm Action', okLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'danger' } = {}) {
  return new Promise((resolve) => {
    const modal = byId('admin-confirm-modal');
    const titleEl = byId('confirm-modal-title');
    const msgEl = byId('confirm-modal-message');
    const okBtn = byId('confirm-modal-ok');
    const cancelBtn = byId('confirm-modal-cancel');
    const iconBox = byId('confirm-modal-icon');
    if (!modal || !okBtn || !cancelBtn) return resolve(false);

    titleEl.textContent = title;
    msgEl.textContent = msg;
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.className = tone === 'primary'
      ? 'rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500'
      : 'rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500';
    if (iconBox) {
      iconBox.className = tone === 'primary'
        ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800/70 dark:bg-blue-950/60 dark:text-blue-400'
        : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-red-200 bg-red-50 text-red-700 dark:border-red-800/70 dark:bg-red-950/60 dark:text-red-400';
    }

    const cleanup = (result) => {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      closeModal('admin-confirm-modal');
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === modal) cleanup(false); };
    const onKey = (e) => { if (e.key === 'Escape') cleanup(false); };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    openModal('admin-confirm-modal');
    window.lucide?.createIcons?.();
    okBtn.focus();
  });
}

function promptAction({ title = 'Enter Details', message = '', defaultValue = '', placeholder = '', minLength = 0, okLabel = 'Submit' } = {}) {
  return new Promise((resolve) => {
    const modal = byId('admin-prompt-modal');
    const form = byId('admin-prompt-form');
    const titleEl = byId('prompt-modal-title');
    const msgEl = byId('prompt-modal-message');
    const inputEl = byId('prompt-modal-input');
    const errEl = byId('prompt-modal-error');
    const okBtn = byId('prompt-modal-ok');
    const cancelBtn = byId('prompt-modal-cancel');
    if (!modal || !form || !inputEl) return resolve(null);

    titleEl.textContent = title;
    msgEl.textContent = message;
    inputEl.value = defaultValue || '';
    inputEl.placeholder = placeholder || '';
    okBtn.textContent = okLabel;
    errEl.textContent = '';
    errEl.classList.add('hidden');

    const cleanup = (value) => {
      form.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      closeModal('admin-prompt-modal');
      resolve(value);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      const val = inputEl.value.trim();
      if (minLength > 0 && val.length < minLength) {
        errEl.textContent = `Please enter at least ${minLength} characters.`;
        errEl.classList.remove('hidden');
        inputEl.focus();
        return;
      }
      cleanup(val);
    };
    const onCancel = () => cleanup(null);
    const onBackdrop = (e) => { if (e.target === modal) cleanup(null); };
    const onKey = (e) => { if (e.key === 'Escape') cleanup(null); };

    form.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    openModal('admin-prompt-modal');
    inputEl.focus();
    inputEl.select();
  });
}

function applyAdminBranding() {
  const b = normalizeBranding(state.homeConfig);
  const title = b.configured ? brandingName(b) : 'Feastport Admin';
  const setText = (id, t) => { const el = byId(id); if (el) el.textContent = t; };
  setText('admin-loader-fest-name', title);
  setText('admin-sidebar-fest-name', title);
  applyBase64Image(byId('admin-loader-logo'), b.logoUrl, byId('admin-loader-logo-fallback'));
  applyBase64Image(byId('admin-sidebar-logo'), b.logoUrl, byId('admin-sidebar-logo-fallback'));
  byId('admin-setup-required')?.classList.toggle('hidden', b.configured && state.teams.length > 0 && state.categories.length > 0);
}

async function loadAllAdminData(force = false) {
  if (force) invalidateCache();
  byId('admin-sync-status').textContent = 'Syncing data…';
  const [
    homeDoc,
    genDoc,
    regCfgDoc,
    schedCfgDoc,
    scoringDoc,
    studentsSnap,
    eventsSnap,
    regsSnap,
    reqsSnap,
    breaksSnap,
    accessSnap,
    assignSnap,
    scoresSnap,
    resultsSnap,
    notifsSnap,
    tvCfgDoc,
    tvCtrlDoc
  ] = await Promise.all([
    cachedGetDoc(db, 'settings', 'home_config', { ttlMs: 60000 }),
    cachedGetDoc(db, 'settings', 'general', { ttlMs: 60000 }),
    cachedGetDoc(db, 'settings', 'registration_config', { ttlMs: 60000 }),
    cachedGetDoc(db, 'settings', 'schedule_config', { ttlMs: 60000 }),
    cachedGetDoc(db, 'settings', 'scoring_rules', { ttlMs: 60000 }),
    getDocs(collection(db, 'students')),
    getDocs(collection(db, 'events')),
    getDocs(collection(db, 'registrations')),
    getDocs(collection(db, 'registrationRequests')),
    getDocs(collection(db, 'scheduleBreaks')),
    getDocs(collection(db, 'accessUsers')),
    getDocs(collection(db, 'judgeAssignments')),
    getDocs(collection(db, 'judgeScores')),
    getDocs(collection(db, 'results')),
    getDocs(collection(db, 'notifications')).catch(() => ({ docs: [] })),
    cachedGetDoc(db, 'settings', 'tv_config', { ttlMs: 60000 }),
    cachedGetDoc(db, 'settings', 'tv_control', { ttlMs: 30000 })
  ]);

  state.homeConfig = homeDoc || {};
  state.generalConfig = genDoc || {};
  state.festSetup = normalizeFestSetup(state.generalConfig.festSetup || {});
  state.registrationConfig = normalizeRegistrationConfig(regCfgDoc || {});
  state.scheduleConfig = schedCfgDoc || {};
  state.scoringRules = normalizeScoringRules(scoringDoc || {});
  state.chestNumberConfig = normalizeChestConfig(state.generalConfig.chestNumberConfig || {});
  state.chestDraftConfig = normalizeChestConfig(state.chestNumberConfig);
  state.categoryClassification = normalizeCategoryClassificationConfig(
    state.generalConfig.categoryClassification || {},
    state.festSetup.eligibleClasses
  );
  state.categoryClassificationDraft = normalizeCategoryClassificationConfig(state.categoryClassification);
  state.teams = state.generalConfig.teams || [];
  state.teamColors = state.generalConfig.teamColors || {};
  state.teamDisplayNames = state.generalConfig.teamDisplayNames || {};
  state.categories = state.generalConfig.categories || [];
  state.categoryDisplayNames = state.generalConfig.categoryDisplayNames || {};
  state.stages = state.generalConfig.stages || [];
  state.days = state.generalConfig.days || [];

  state.students = studentsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.events = eventsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.registrations = regsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.registrationRequests = reqsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.scheduleBreaks = breaksSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.accessUsers = accessSnap.docs.map((d) => ({ id: d.id, docId: d.id, ...d.data() }));
  state.judgeAssignments = assignSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.judgeScores = scoresSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.results = resultsSnap.docs.map((d) => ({ id: d.id, eventId: d.data().eventId || d.id, ...d.data() }));
  state.notifications = notifsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  state.tvConfig = tvCfgDoc || {};
  state.tvControl = tvCtrlDoc || {};
  state.tvSelectedResultIds = new Set(state.tvControl.selectedResultIds || []);

  applyAdminBranding();
  populateSelectOptions();
  hydrateSetupForms();
  hydrateTvForms();
  renderAll();
  byId('admin-sync-status').textContent = `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function populateSelectOptions() {
  const teamOpts = `<option value="">Select Team</option>` + state.teams.map((t) => `<option value="${h(t)}">${h(teamName(t))}</option>`).join('');
  const teamFilterOpts = `<option value="">All Teams</option>` + state.teams.map((t) => `<option value="${h(t)}">${h(teamName(t))}</option>`).join('');
  const catOpts = `<option value="">Select Category</option>` + state.categories.map((c) => `<option value="${h(c)}">${h(categoryName(c))}</option>`).join('');
  const catFilterOpts = `<option value="">All Categories</option>` + state.categories.map((c) => `<option value="${h(c)}">${h(categoryName(c))}</option>`).join('');

  document.querySelectorAll('.select-team').forEach((el) => { const v = el.value; el.innerHTML = teamOpts; if (v) el.value = v; });
  document.querySelectorAll('.select-team-filter').forEach((el) => { const v = el.value; el.innerHTML = teamFilterOpts; if (v) el.value = v; });
  document.querySelectorAll('.select-cat').forEach((el) => { const v = el.value; el.innerHTML = catOpts; if (v) el.value = v; });
  document.querySelectorAll('.select-cat-filter').forEach((el) => { const v = el.value; el.innerHTML = catFilterOpts; if (v) el.value = v; });

  const clsList = state.categoryClassification?.classes?.length ? state.categoryClassification.classes : DEFAULT_CLASS_LIST;
  const populateClassSelect = (el) => {
    if (!el) return;
    const prev = el.value;
    const opts = ['<option value="">Select Class</option>', ...clsList.map((c) => `<option value="${h(c)}">${h(c)}</option>`)];
    if (prev && !clsList.some((c) => c.toLowerCase() === prev.toLowerCase())) {
      opts.push(`<option value="${h(prev)}">${h(prev)}</option>`);
    }
    el.innerHTML = opts.join('');
    if (prev) el.value = prev;
  };
  populateClassSelect(byId('inp-std-class'));
  populateClassSelect(byId('edit-std-class'));

  const notifTeam = byId('notif-team');
  if (notifTeam) {
    notifTeam.innerHTML = `<option value="All">All Teams</option>` + state.teams.map((t) => `<option value="${h(t)}">${h(teamName(t))}</option>`).join('');
  }
  const regEv = byId('reg-filter-event');
  if (regEv) {
    const prev = regEv.value;
    regEv.innerHTML = `<option value="all" selected>All Events</option>` + state.events.map((e) => `<option value="${h(e.id)}">${h(e.name)}</option>`).join('');
    if (prev) regEv.value = prev;
  }
}

function hydrateSetupForms() {
  const hc = state.homeConfig || {};
  const setVal = (id, v) => { const el = byId(id); if (el) el.value = v ?? ''; };
  setVal('public-home-name1', hc.festName1 || '');
  setVal('public-home-name2', hc.festName2 || '');
  setVal('public-home-tagline', hc.tagline || '');
  setVal('public-home-about-sub', hc.aboutSubtitle || '');
  setVal('public-home-about-text', hc.aboutText || '');
  setVal('public-home-footer', hc.footerText || '');
  setVal('public-home-logo-link', hc.logoUrl || '');
  setVal('public-home-gallery', JSON.stringify(hc.galleryImages || []));
  window.refreshImageUploadPreviews?.();

  const rc = state.registrationConfig;
  setVal('reg-cfg-status', rc.globalStatus || 'open');
  if (byId('reg-cfg-enabled')) byId('reg-cfg-enabled').checked = rc.studentApplicationsEnabled !== false;
  setVal('limit-single', rc.participationLimits?.single?.mode === 'custom' ? rc.participationLimits.single.limit : 0);
  setVal('limit-group', rc.participationLimits?.group?.mode === 'custom' ? rc.participationLimits.group.limit : 0);
  setVal('limit-total', rc.participationLimits?.total?.mode === 'custom' ? rc.participationLimits.total.limit : 0);

  const lockTs = Number(state.scheduleConfig?.registrationLockAt || rc.finalizationLockAt || 0);
  if (lockTs > 0 && byId('schedule-registration-lock')) {
    const d = new Date(lockTs - new Date().getTimezoneOffset() * 60000);
    byId('schedule-registration-lock').value = d.toISOString().slice(0, 16);
  }

  const sr = state.scoringRules;
  setVal('pts-single-1', sr.configs?.Single?.points?.[0]?.value ?? 5);
  setVal('pts-single-2', sr.configs?.Single?.points?.[1]?.value ?? 3);
  setVal('pts-single-3', sr.configs?.Single?.points?.[2]?.value ?? 1);
  setVal('pts-group-1', sr.configs?.Group?.points?.[0]?.value ?? 10);
  setVal('pts-group-2', sr.configs?.Group?.points?.[1]?.value ?? 7);
  setVal('pts-group-3', sr.configs?.Group?.points?.[2]?.value ?? 5);
  if (byId('score-enable-grades')) byId('score-enable-grades').checked = sr.enabled?.grades === true;
  setVal('policy-multi-judge', sr.policies?.multipleJudgeMethod || 'average');
  renderScoringGradesEditor(sr);
}

function renderOverview() {
  const activeEvents = state.events.filter((e) => !['draft', 'archived'].includes(e.status));
  const published = state.results.filter((r) => !r.status || r.status === 'published');
  const submittedCount = state.judgeScores.filter((s) => s.status === 'submitted' && s.publishStatus !== 'published').length;

  byId('kpi-students').textContent = String(state.students.length);
  byId('kpi-events').textContent = String(activeEvents.length);
  byId('kpi-registrations').textContent = String(state.registrations.length);
  byId('kpi-published').textContent = String(published.length);

  const badge = byId('badge-submitted-sheets');
  if (submittedCount > 0) {
    badge.textContent = String(submittedCount);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const assignedEventIds = new Set(state.judgeAssignments.filter((a) => a.active !== false).map((a) => a.eventId));
  const withoutJudge = activeEvents.filter((e) => !assignedEventIds.has(e.id)).length;
  const unscheduled = activeEvents.filter((e) => !e.scheduleDate || !e.time).length;
  const pendingReqs = state.registrationRequests.filter((r) => r.status === 'pending').length;

  byId('admin-readiness').innerHTML = `
    <div class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-slate-700 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-300"><span>Teams Configured</span><strong class="font-mono-num text-slate-900 dark:text-slate-100">${state.teams.length}</strong></div>
    <div class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-slate-700 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-300"><span>Events without Judges</span><strong class="font-mono-num ${withoutJudge ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}">${withoutJudge}</strong></div>
    <div class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-slate-700 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-300"><span>Unscheduled Events</span><strong class="font-mono-num ${unscheduled ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}">${unscheduled}</strong></div>
    <div class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-slate-700 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-300"><span>Pending Student Requests</span><strong class="font-mono-num text-slate-900 dark:text-slate-100">${pendingReqs}</strong></div>
    <div class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-slate-700 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-300"><span>Submitted Judge Sheets Awaiting Publish</span><strong class="font-mono-num text-blue-700 dark:text-blue-400">${submittedCount}</strong></div>
  `;

  const ledger = buildTeamScoreLedger(published, () => '', state.events);
  const scores = {};
  state.teams.forEach((t) => { scores[t] = 0; });
  ledger.forEach((row) => { scores[row.team] = (scores[row.team] || 0) + Number(row.points || 0); });
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  byId('overview-standings').innerHTML = ranked.length ? ranked.map(([team, pts], i) => `
    <div class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800 dark:bg-slate-800/40">
      <span class="font-semibold text-slate-900 dark:text-slate-100">#${i + 1} ${h(state.teamDisplayNames?.[team] || team)}</span>
      <span class="font-mono-num font-bold text-blue-700 dark:text-blue-400">${pts} pts</span>
    </div>
  `).join('') : '<p class="text-slate-400 dark:text-slate-500">No teams configured yet.</p>';

  const pages = [
    ['index.html', 'Public Home'],
    ['results.html', 'Public Results'],
    ['register.html', 'Student Registration'],
    ['team.html', 'Team Leader Portal'],
    ['judge.html', 'Judge Scoring Desk'],
    ['tv.html', 'Live TV Display'],
    ['tv-control.html', 'TV Control Room'],
    ['login.html', 'Staff Sign In']
  ];
  byId('portal-links-grid').innerHTML = pages.map(([url, label]) => `
    <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs dark:border-slate-800 dark:bg-slate-800/60">
      <a href="${h(url)}" target="_blank" rel="noopener noreferrer" class="font-semibold text-slate-800 hover:text-blue-700 dark:text-slate-200 dark:hover:text-blue-400">${h(label)}</a>
      <button type="button" data-admin-action="copy-link" data-url="${h(url)}" class="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800">Copy</button>
    </div>
  `).join('');
}

function renderSetupLists() {
  byId('created-teams-list').innerHTML = state.teams.length ? state.teams.map((t) => `
    <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-800/40">
      <div class="flex items-center gap-2 min-w-0">
        <span class="h-3.5 w-3.5 shrink-0 rounded-full border border-slate-300 dark:border-slate-600" style="background:${h(state.teamColors?.[t] || '#1D4ED8')}"></span>
        <span class="font-bold text-slate-900 dark:text-slate-100 truncate">${h(teamName(t))}</span>
        <span class="font-mono-num text-[11px] text-slate-400 dark:text-slate-400">Key: ${h(t)}</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" data-admin-action="edit-team" data-team="${h(t)}" class="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-900 dark:text-blue-400 dark:hover:bg-slate-800">Edit</button>
        <button type="button" data-admin-action="remove-team" data-team="${h(t)}" class="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/70 dark:bg-red-950/50 dark:text-red-400 dark:hover:bg-red-950/80">Remove</button>
      </div>
    </div>
  `).join('') : '<p class="text-xs text-slate-400 dark:text-slate-500">No teams added yet.</p>';

  byId('created-categories-list').innerHTML = state.categories.length ? state.categories.map((c) => `
    <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-800/40">
      <div class="flex items-center gap-2 min-w-0">
        <span class="font-bold text-slate-900 dark:text-slate-100 truncate">${h(categoryName(c))}</span>
        <span class="font-mono-num text-[11px] text-slate-400 dark:text-slate-400">Key: ${h(c)}</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" data-admin-action="edit-category" data-cat="${h(c)}" class="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-900 dark:text-blue-400 dark:hover:bg-slate-800">Edit</button>
        <button type="button" data-admin-action="remove-category" data-cat="${h(c)}" class="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/70 dark:bg-red-950/50 dark:text-red-400 dark:hover:bg-red-950/80">Remove</button>
      </div>
    </div>
  `).join('') : '<p class="text-xs text-slate-400 dark:text-slate-500">No categories added yet.</p>';

  byId('created-stages-days').innerHTML = (state.stages.length || state.days.length) ? `
    ${state.stages.map((s) => `
      <span class="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 font-semibold text-blue-900 dark:border-blue-800/70 dark:bg-blue-950/50 dark:text-blue-200">
        <span>Stage: ${h(s)}</span>
        <button type="button" data-admin-action="edit-stage" data-stage="${h(s)}" class="text-blue-700 hover:underline dark:text-blue-400">Edit</button>
        <button type="button" data-admin-action="remove-stage" data-stage="${h(s)}" class="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300" aria-label="Remove stage">✕</button>
      </span>
    `).join('')}
    ${state.days.map((d, idx) => `
      <span class="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-900 dark:border-emerald-800/70 dark:bg-emerald-950/50 dark:text-emerald-200">
        <span>Day: ${h(d.label && d.label !== d.date ? `${d.label} (${d.date})` : (d.date || d))}</span>
        <button type="button" data-admin-action="edit-day" data-day-index="${idx}" class="text-emerald-700 hover:underline dark:text-emerald-400">Edit</button>
        <button type="button" data-admin-action="remove-day" data-date="${h(d.date || d)}" class="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300" aria-label="Remove day">✕</button>
      </span>
    `).join('')}
  ` : '<p class="text-xs text-slate-400 dark:text-slate-500">No stages or festival days added yet.</p>';

  renderCategoryClassificationSetup();
  renderChestNumberSetup();
}

function captureCategoryClassificationDraftFromDom() {
  const draft = state.categoryClassificationDraft || normalizeCategoryClassificationConfig(state.categoryClassification);
  const checkedRadio = document.querySelector('input[name="cat-cls-mode"]:checked');
  if (checkedRadio && ['manual', 'class', 'dob'].includes(checkedRadio.value)) {
    draft.mode = checkedRadio.value;
  }
  const showClsEl = byId('cat-cls-show-class');
  const showDobEl = byId('cat-cls-show-dob');
  if (showClsEl) draft.showClassInManual = Boolean(showClsEl.checked);
  if (showDobEl) draft.showDobInManual = Boolean(showDobEl.checked);

  draft.dobRules = draft.dobRules && typeof draft.dobRules === 'object' ? draft.dobRules : {};
  document.querySelectorAll('#cat-cls-mapping-list input[data-dob-cat]').forEach((inp) => {
    const cat = inp.dataset.dobCat;
    const bound = inp.dataset.dobBound;
    if (!cat || !['from', 'to'].includes(bound)) return;
    if (!draft.dobRules[cat]) draft.dobRules[cat] = { from: '', to: '' };
    draft.dobRules[cat][bound] = inp.value.trim();
  });

  state.categoryClassificationDraft = draft;
  return draft;
}

function renderCategoryClassificationSetup() {
  const card = byId('category-classification-card');
  if (!card) return;

  const draft = state.categoryClassificationDraft || normalizeCategoryClassificationConfig(state.categoryClassification);
  document.querySelectorAll('input[name="cat-cls-mode"]').forEach((r) => {
    r.checked = r.value === draft.mode;
  });

  const showClassEl = byId('cat-cls-show-class');
  const showDobEl = byId('cat-cls-show-dob');
  if (showClassEl) showClassEl.checked = Boolean(draft.showClassInManual);
  if (showDobEl) showDobEl.checked = Boolean(draft.showDobInManual);

  byId('cat-cls-manual-options')?.classList.toggle('hidden', draft.mode !== 'manual');
  const showClassEditor = draft.mode === 'class' || (draft.mode === 'manual' && draft.showClassInManual);
  byId('cat-cls-classes-card')?.classList.toggle('hidden', !showClassEditor);

  const classesListEl = byId('cat-cls-classes-list');
  if (classesListEl) {
    const classes = draft.classes || [...DEFAULT_CLASS_LIST];
    classesListEl.innerHTML = classes.length
      ? classes.map((cls) => `
          <span class="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            <span>${h(cls)}</span>
            <button type="button" data-remove-class="${h(cls)}" title="Remove class ${h(cls)}" class="ml-0.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400">✕</button>
          </span>
        `).join('')
      : '<p class="text-[11px] text-slate-400 dark:text-slate-500">No classes added. Click "Reset Default (1–+2)" or add a custom class above.</p>';
  }

  const mappingWrap = byId('cat-cls-mapping-wrap');
  const mappingTitle = byId('cat-cls-mapping-title');
  const mappingSub = byId('cat-cls-mapping-sub');
  const mappingList = byId('cat-cls-mapping-list');
  if (!mappingWrap || !mappingList) return;

  if (draft.mode === 'manual') {
    mappingWrap.classList.add('hidden');
    mappingList.innerHTML = '';
    return;
  }

  mappingWrap.classList.remove('hidden');
  if (!state.categories.length) {
    if (mappingTitle) mappingTitle.textContent = draft.mode === 'class' ? 'Class → Category Mapping' : 'Date of Birth → Category Mapping';
    if (mappingSub) mappingSub.textContent = '';
    mappingList.innerHTML = '<div class="rounded-lg border border-dashed border-amber-300 bg-amber-50/70 p-4 text-xs text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-300">Add at least one Category above before configuring automatic classification rules.</div>';
    return;
  }

  if (draft.mode === 'class') {
    if (mappingTitle) mappingTitle.textContent = 'Class → Category Mapping';
    if (mappingSub) mappingSub.textContent = 'Select which Classes belong to each Category. Clicking a class already assigned to another Category moves it cleanly here.';

    const ownerByClass = new Map();
    state.categories.forEach((c) => {
      (draft.classRules?.[c] || []).forEach((cls) => ownerByClass.set(cls.toLowerCase(), c));
    });

    const classes = draft.classes || [];
    mappingList.innerHTML = state.categories.map((catKey) => {
      const assigned = new Set((draft.classRules?.[catKey] || []).map((c) => c.toLowerCase()));
      return `
        <div class="rounded-lg border border-slate-200 bg-slate-50/60 p-3.5 space-y-2.5 dark:border-slate-800 dark:bg-slate-800/40">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2 text-xs">
              <span class="font-bold text-slate-900 dark:text-slate-100">${h(categoryName(catKey))}</span>
              <span class="font-mono-num text-[11px] text-slate-400">(${h(catKey)})</span>
            </div>
            <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400">${assigned.size} class(es) selected</span>
          </div>
          <div class="flex flex-wrap gap-1.5">
            ${classes.map((cls) => {
              const clsLower = cls.toLowerCase();
              const isSelected = assigned.has(clsLower);
              const otherOwner = !isSelected ? ownerByClass.get(clsLower) : '';
              const btnCls = isSelected
                ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-600'
                : otherOwner
                  ? 'border-slate-200 bg-white/60 text-slate-400 hover:border-blue-400 hover:text-slate-700 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-500 dark:hover:text-slate-200'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-blue-500 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-blue-500';
              return `
                <button type="button" data-map-cat="${h(catKey)}" data-map-class="${h(cls)}"
                  title="${otherOwner ? `Currently assigned to ${h(categoryName(otherOwner))} — click to move here` : ''}"
                  class="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-semibold transition ${btnCls}">
                  <span>${h(cls)}</span>
                  ${otherOwner ? `<span class="text-[10px] opacity-75">(${h(categoryName(otherOwner))})</span>` : ''}
                </button>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');
    return;
  }

  // mode === 'dob'
  if (mappingTitle) mappingTitle.textContent = 'Date of Birth (DOB) → Category Mapping';
  if (mappingSub) mappingSub.textContent = 'Set inclusive From Date and To Date boundaries for each Category. Leave a boundary blank for an open-ended side.';
  mappingList.innerHTML = state.categories.map((catKey) => {
    const rule = draft.dobRules?.[catKey] || { from: '', to: '' };
    return `
      <div class="rounded-lg border border-slate-200 bg-slate-50/60 p-3.5 dark:border-slate-800 dark:bg-slate-800/40">
        <div class="grid items-end gap-3 sm:grid-cols-[180px_1fr_1fr_auto]">
          <div class="pb-1">
            <span class="block text-xs font-bold text-slate-900 dark:text-slate-100">${h(categoryName(catKey))}</span>
            <span class="font-mono-num text-[11px] text-slate-400">Key: ${h(catKey)}</span>
          </div>
          <label class="block text-[11px] font-semibold text-slate-600 dark:text-slate-300">From Date (Inclusive)
            <input type="date" data-dob-cat="${h(catKey)}" data-dob-bound="from" value="${h(rule.from || '')}" class="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono-num text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
          </label>
          <label class="block text-[11px] font-semibold text-slate-600 dark:text-slate-300">To Date (Inclusive)
            <input type="date" data-dob-cat="${h(catKey)}" data-dob-bound="to" value="${h(rule.to || '')}" class="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono-num text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
          </label>
          <button type="button" data-dob-clear="${h(catKey)}" class="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800">Clear</button>
        </div>
      </div>
    `;
  }).join('');
}

function captureChestDraftFromDom() {
  const draft = state.chestDraftConfig || normalizeChestConfig(state.chestNumberConfig);
  const enabledEl = byId('chest-cfg-enabled');
  const splitCatEl = byId('chest-cfg-split-category');
  const splitGenEl = byId('chest-cfg-split-gender');
  if (enabledEl) draft.enabled = enabledEl.checked;
  if (splitCatEl) draft.splitByCategory = splitCatEl.checked;
  if (splitGenEl) draft.splitByGender = splitGenEl.checked;
  draft.series = draft.series && typeof draft.series === 'object' ? draft.series : {};
  document.querySelectorAll('#chest-series-matrix input[data-chest-series-key]').forEach((inp) => {
    const key = inp.dataset.chestSeriesKey;
    if (!key) return;
    const val = inp.value.trim();
    if (val) draft.series[key] = val;
    else delete draft.series[key];
  });
  state.chestDraftConfig = draft;
  return draft;
}

function renderChestNumberSetup() {
  const enabledEl = byId('chest-cfg-enabled');
  const splitCatEl = byId('chest-cfg-split-category');
  const splitGenEl = byId('chest-cfg-split-gender');
  const optionsWrap = byId('chest-cfg-options-wrap');
  const disabledNote = byId('chest-cfg-disabled-note');
  const matrixEl = byId('chest-series-matrix');
  if (!enabledEl || !matrixEl) return;

  const draft = state.chestDraftConfig || normalizeChestConfig(state.chestNumberConfig);
  enabledEl.checked = Boolean(draft.enabled);
  if (splitCatEl) splitCatEl.checked = Boolean(draft.splitByCategory);
  if (splitGenEl) splitGenEl.checked = Boolean(draft.splitByGender);

  optionsWrap?.classList.toggle('hidden', !draft.enabled);
  optionsWrap?.classList.toggle('flex', Boolean(draft.enabled));
  disabledNote?.classList.toggle('hidden', Boolean(draft.enabled));
  matrixEl.classList.toggle('hidden', !draft.enabled);

  if (!draft.enabled) {
    matrixEl.innerHTML = '';
    return;
  }

  if (!state.teams.length) {
    matrixEl.innerHTML = '<div class="rounded-lg border border-dashed border-amber-300 bg-amber-50/70 p-4 text-xs text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-300">Add at least one Team above to configure starting chest numbers.</div>';
    return;
  }

  if (draft.splitByCategory && !state.categories.length) {
    matrixEl.innerHTML = '<div class="rounded-lg border border-dashed border-amber-300 bg-amber-50/70 p-4 text-xs text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-300">Add at least one Category in <strong>Categories &amp; Venues</strong> before configuring per-category chest numbers.</div>';
    return;
  }

  const inputCls = 'w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono-num text-xs font-semibold text-slate-900 placeholder:font-sans placeholder:font-normal placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500';
  const makeInput = (team, category, gender, label) => {
    const key = chestSeriesKey({
      team,
      category,
      gender,
      splitByCategory: draft.splitByCategory,
      splitByGender: draft.splitByGender
    });
    const val = draft.series?.[key] || '';
    const sample = draft.splitByGender ? (gender === 'Girls' ? 'e.g. G101' : 'e.g. B101') : 'e.g. 101 or R101';
    return `
      <label class="block text-[11px] font-semibold text-slate-600 dark:text-slate-300">
        ${label ? `<span class="mb-1 block">${h(label)}</span>` : ''}
        <input type="text" maxlength="32" data-chest-series-key="${h(key)}" value="${h(val)}" placeholder="${sample}" class="${inputCls}">
      </label>
    `;
  };

  if (!draft.splitByCategory && !draft.splitByGender) {
    matrixEl.innerHTML = `
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        ${state.teams.map((t) => `
          <div class="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2 dark:border-slate-800 dark:bg-slate-800/40">
            <div class="flex items-center gap-2 text-xs">
              <span class="h-3 w-3 shrink-0 rounded-full border border-slate-300 dark:border-slate-600" style="background:${h(state.teamColors?.[t] || '#1D4ED8')}"></span>
              <span class="font-bold text-slate-900 dark:text-slate-100 truncate">${h(teamName(t))}</span>
              <span class="font-mono-num text-[11px] text-slate-400">(${h(t)})</span>
            </div>
            ${makeInput(t, '', 'Boys', 'Starting Chest No.')}
          </div>
        `).join('')}
      </div>
    `;
    return;
  }

  if (!draft.splitByCategory && draft.splitByGender) {
    matrixEl.innerHTML = `
      <div class="grid gap-3 sm:grid-cols-2">
        ${state.teams.map((t) => `
          <div class="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2.5 dark:border-slate-800 dark:bg-slate-800/40">
            <div class="flex items-center gap-2 text-xs">
              <span class="h-3 w-3 shrink-0 rounded-full border border-slate-300 dark:border-slate-600" style="background:${h(state.teamColors?.[t] || '#1D4ED8')}"></span>
              <span class="font-bold text-slate-900 dark:text-slate-100 truncate">${h(teamName(t))}</span>
              <span class="font-mono-num text-[11px] text-slate-400">(${h(t)})</span>
            </div>
            <div class="grid grid-cols-2 gap-2.5">
              ${makeInput(t, '', 'Boys', 'Boys Starting No.')}
              ${makeInput(t, '', 'Girls', 'Girls Starting No.')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
    return;
  }

  if (draft.splitByCategory && !draft.splitByGender) {
    matrixEl.innerHTML = `
      <div class="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table class="w-full text-left text-xs">
          <thead class="border-b border-slate-200 bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-800/70 dark:text-slate-400">
            <tr>
              <th class="px-3 py-2.5 min-w-[150px]">Team / House</th>
              ${state.categories.map((c) => `<th class="px-3 py-2.5 min-w-[140px]">${h(categoryName(c))}</th>`).join('')}
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
            ${state.teams.map((t) => `
              <tr>
                <td class="px-3 py-2.5 font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                  <span class="inline-flex items-center gap-2">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background:${h(state.teamColors?.[t] || '#1D4ED8')}"></span>
                    ${h(teamName(t))}
                  </span>
                </td>
                ${state.categories.map((c) => `<td class="px-3 py-2">${makeInput(t, c, 'Boys', '')}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
    return;
  }

  // splitByCategory && splitByGender
  matrixEl.innerHTML = `
    <div class="grid gap-3 lg:grid-cols-2">
      ${state.teams.map((t) => `
        <div class="rounded-lg border border-slate-200 bg-slate-50/60 p-3.5 space-y-3 dark:border-slate-800 dark:bg-slate-800/40">
          <div class="flex items-center gap-2 text-xs border-b border-slate-200 pb-2 dark:border-slate-700">
            <span class="h-3 w-3 shrink-0 rounded-full border border-slate-300 dark:border-slate-600" style="background:${h(state.teamColors?.[t] || '#1D4ED8')}"></span>
            <span class="font-bold text-slate-900 dark:text-slate-100 truncate">${h(teamName(t))}</span>
            <span class="font-mono-num text-[11px] text-slate-400">(${h(t)})</span>
          </div>
          <div class="space-y-2.5">
            ${state.categories.map((c) => `
              <div class="grid items-end gap-2 sm:grid-cols-[120px_1fr_1fr]">
                <span class="text-xs font-bold text-slate-700 dark:text-slate-200 truncate pb-1.5">${h(categoryName(c))}</span>
                ${makeInput(t, c, 'Boys', 'Boys')}
                ${makeInput(t, c, 'Girls', 'Girls')}
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderStudents() {
  const search = (byId('filter-std-search')?.value || '').trim().toLowerCase();
  const team = byId('filter-std-team')?.value || '';
  const cat = byId('filter-std-cat')?.value || '';

  const vis = getStudentFieldVisibility(state.categoryClassification);
  const showMetaCol = vis.showClass || vis.showDob || state.students.some((s) => studentClassValue(s) || studentDobValue(s));
  byId('th-std-meta')?.classList.toggle('hidden', !showMetaCol);

  const filtered = state.students.filter((s) => {
    if (team && s.team !== team) return false;
    if (cat && s.category !== cat) return false;
    if (search && !`${s.name || ''} ${s.chestNo || ''} ${studentClassValue(s)} ${studentDobValue(s)}`.toLowerCase().includes(search)) return false;
    return true;
  }).sort((a, b) => String(a.chestNo || '').localeCompare(String(b.chestNo || ''), undefined, { numeric: true }));

  byId('std-count-label').textContent = `${filtered.length} students`;
  byId('students-tbody').innerHTML = filtered.length ? filtered.map((s) => {
    const clsVal = studentClassValue(s);
    const dobVal = studentDobValue(s);
    const metaParts = [];
    if (clsVal) metaParts.push(`<span class="font-semibold text-slate-800 dark:text-slate-200">${h(clsVal)}</span>`);
    if (dobVal) metaParts.push(`<span class="font-mono-num text-[11px] text-slate-500 dark:text-slate-400">${h(dobVal)}</span>`);
    const metaCell = showMetaCol
      ? `<td class="px-3 py-2.5 text-slate-700 dark:text-slate-300 whitespace-nowrap">${metaParts.length ? metaParts.join('<span class="mx-1 text-slate-300 dark:text-slate-600">•</span>') : '—'}</td>`
      : '';
    return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/60">
        <td class="px-3 py-2.5 font-mono-num font-bold text-slate-900 dark:text-slate-100">${h(s.chestNo || '—')}</td>
        <td class="px-3 py-2.5 font-semibold text-slate-900 dark:text-slate-100">${h(s.name)}</td>
        ${metaCell}
        <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">${h(teamName(s.team))}</td>
        <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">${h(categoryName(s.category))}</td>
        <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">${h(s.gender || 'Boys')}</td>
        <td class="px-3 py-2.5 text-right space-x-1.5 whitespace-nowrap">
          <button type="button" data-admin-action="edit-student" data-id="${h(s.id)}" class="rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-900 dark:text-blue-400 dark:hover:bg-slate-800">Edit</button>
          <button type="button" data-admin-action="delete-student" data-id="${h(s.id)}" class="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/70 dark:bg-red-950/50 dark:text-red-400 dark:hover:bg-red-950/80">Delete</button>
        </td>
      </tr>
    `;
  }).join('') : `<tr><td colspan="${showMetaCol ? 7 : 6}" class="px-4 py-8 text-center text-slate-400 dark:text-slate-500">No students match this filter.</td></tr>`;
}

const METHOD_LABELS = {
  criteria: 'Criteria Scoring',
  direct_rank: 'Direct Rank',
  manual: 'Manual',
  objective: 'Objective / Quiz',
  time: 'Time Based',
  count: 'Count Based',
  elimination: 'Elimination',
  display_only: 'Display Only'
};

function formatJudgingMethodLabel(rawMethod, name = '') {
  const norm = normalizeResultMethod(rawMethod || 'criteria', name);
  return METHOD_LABELS[norm] || norm;
}

function renderEvents() {
  const search = (byId('filter-ev-search')?.value || '').trim().toLowerCase();
  const cat = byId('filter-ev-cat')?.value || '';
  const gender = byId('filter-ev-gender')?.value || '';
  const stage = byId('filter-ev-stage')?.value || '';
  const method = byId('filter-ev-method')?.value || '';

  const filtered = state.events.filter((e) => {
    const evStage = normalizeStage(e.stage || 'On-Stage');
    const evMethod = normalizeResultMethod(e.resultMethod || 'criteria', e.name);
    if (cat && e.category !== cat) return false;
    if (gender && e.gender !== gender) return false;
    if (stage && evStage !== stage) return false;
    if (method && evMethod !== method) return false;
    if (search && !`${e.name || ''} ${e.code || ''}`.toLowerCase().includes(search)) return false;
    return true;
  }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  byId('ev-count-label').textContent = `${filtered.length} events`;
  byId('events-tbody').innerHTML = filtered.length ? filtered.map((e) => {
    const methodLabel = formatJudgingMethodLabel(e.resultMethod, e.name);
    const critCount = Array.isArray(e.criteria) ? e.criteria.length : 0;
    return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/60">
        <td class="px-3 py-2.5 font-semibold text-slate-900 dark:text-slate-100">${h(e.name)}${e.status && !['active', 'validated'].includes(e.status) ? ` <span class="text-[10px] font-bold uppercase text-amber-700 dark:text-amber-400">(${h(e.status)})</span>` : ''}</td>
        <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">${h(categoryName(e.category || 'General'))}</td>
        <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">${h(e.gender || 'Both')}</td>
        <td class="px-3 py-2.5 font-mono-num text-slate-700 dark:text-slate-300">${h(e.type || 'Single')} (${e.limit || 1}×${e.groupSize || 1})</td>
        <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">${h(normalizeStage(e.stage || 'On-Stage'))}</td>
        <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">
          <span class="inline-flex items-center rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">${h(methodLabel)}${critCount ? ` (${critCount})` : ''}</span>
        </td>
        <td class="px-3 py-2.5 text-right space-x-1.5 whitespace-nowrap">
          <button type="button" data-admin-action="edit-event" data-id="${h(e.id)}" class="rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-900 dark:text-blue-400 dark:hover:bg-slate-800">Edit</button>
          <button type="button" data-admin-action="delete-event" data-id="${h(e.id)}" class="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/70 dark:bg-red-950/50 dark:text-red-400 dark:hover:bg-red-950/80">Delete</button>
        </td>
      </tr>
    `;
  }).join('') : '<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400 dark:text-slate-500">No events match this filter.</td></tr>';
}

function renderRegistrations() {
  const evFilter = byId('reg-filter-event')?.value || 'all';
  const teamFilter = byId('reg-filter-team')?.value || '';

  const targetEvents = state.events.filter((e) => !['draft', 'archived'].includes(e.status) && (evFilter === 'all' || e.id === evFilter));
  const regs = state.registrations.filter((r) => (!teamFilter || r.team === teamFilter) && (evFilter === 'all' || r.eventId === evFilter));
  byId('reg-summary-count').textContent = `${regs.length} team entries`;

  byId('admin-registrations-list').innerHTML = targetEvents.length ? targetEvents.map((ev) => {
    const evRegs = regs.filter((r) => r.eventId === ev.id);
    return `
      <article class="rounded-xl border border-slate-200 bg-white p-4 space-y-3 dark:border-slate-800 dark:bg-slate-900">
        <div class="flex items-start justify-between gap-2">
          <div>
            <h3 class="font-display text-sm font-bold text-slate-900 dark:text-slate-100">${h(ev.name)}</h3>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">${h(categoryName(ev.category || ''))} • ${h(ev.gender || 'Both')} • ${h(ev.type || 'Single')}</p>
          </div>
          <button type="button" data-admin-action="open-admin-reg" data-event-id="${h(ev.id)}" class="rounded-lg bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 whitespace-nowrap dark:bg-blue-950/60 dark:text-blue-400 dark:hover:bg-blue-950">+ Add Entry</button>
        </div>
        <div class="space-y-1.5 text-xs">
          ${evRegs.length ? evRegs.map((r) => {
            const names = (r.studentIds || []).map((sid) => state.students.find((s) => s.id === sid)?.name || sid);
            return `
              <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-slate-700 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300">
                <span class="truncate"><strong class="text-slate-900 dark:text-slate-100">${h(teamName(r.team))}</strong> #${r.slotIndex || 1}: ${h(names.join(', ') || 'Empty')}</span>
                <div class="flex items-center gap-2 shrink-0">
                  <button type="button" data-admin-action="edit-reg" data-id="${h(r.id)}" class="text-blue-700 font-semibold hover:underline dark:text-blue-400">Edit</button>
                  <button type="button" data-admin-action="delete-reg" data-id="${h(r.id)}" class="text-red-600 font-semibold hover:underline dark:text-red-400">Remove</button>
                </div>
              </div>
            `;
          }).join('') : '<p class="text-slate-400 dark:text-slate-500">No teams registered yet.</p>'}
        </div>
      </article>
    `;
  }).join('') : '<p class="col-span-full text-center text-xs text-slate-400 dark:text-slate-500">No events found.</p>';

  const pending = state.registrationRequests.filter((r) => r.status === 'pending');
  const pendingBadge = byId('badge-pending-requests');
  if (pendingBadge) {
    if (pending.length > 0) {
      pendingBadge.textContent = String(pending.length);
      pendingBadge.classList.remove('hidden');
    } else {
      pendingBadge.classList.add('hidden');
    }
  }
  byId('admin-requests-list').innerHTML = pending.length ? pending.map((r) => {
    const evNames = (r.eventIds || []).map((id) => state.events.find((e) => e.id === id)?.name || id);
    return `
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-2 text-slate-800 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200">
        <div class="flex items-center justify-between">
          <strong>${h(r.name)} (${h(teamName(r.team))})</strong>
          <span class="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-950/70 dark:text-amber-300">PENDING</span>
        </div>
        <p class="text-slate-600 dark:text-slate-400">${h(evNames.join(', '))}</p>
        <div class="flex justify-end gap-2">
          <button type="button" data-admin-action="reject-req" data-id="${h(r.id)}" class="rounded border border-red-200 bg-white px-2.5 py-1 font-semibold text-red-700 hover:bg-red-50 dark:border-red-900/70 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950/60">Reject</button>
          <button type="button" data-admin-action="approve-req" data-id="${h(r.id)}" class="rounded bg-blue-700 px-2.5 py-1 font-semibold text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500">Approve</button>
        </div>
      </div>
    `;
  }).join('') : '<p class="text-xs text-slate-400 dark:text-slate-500">No pending student self-registration requests.</p>';
}

function renderSchedule() {
  const stageOpts = (selected) => `<option value="">Select Stage</option>` + [...new Set(['Main Stage', ...state.stages])].map((s) => `<option value="${h(s)}" ${selected === s ? 'selected' : ''}>${h(s)}</option>`).join('');
  byId('schedule-builder-body').innerHTML = state.events.filter((e) => !['draft', 'archived'].includes(e.status)).map((e) => `
    <tr data-sched-row="${h(e.id)}" class="hover:bg-slate-50 dark:hover:bg-slate-800/60">
      <td class="px-3 py-2 font-semibold text-slate-900 dark:text-slate-100">${h(e.name)}<br><span class="text-[11px] font-normal text-slate-500 dark:text-slate-400">${h(categoryName(e.category || ''))} • ${h(e.gender || '')}</span></td>
      <td class="px-3 py-2"><input data-sched-date="${h(e.id)}" type="date" value="${h(e.scheduleDate || '')}" class="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"></td>
      <td class="px-3 py-2"><select data-sched-stage="${h(e.id)}" class="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">${stageOpts(e.scheduleStage || e.stage || '')}</select></td>
      <td class="px-3 py-2"><input data-sched-time="${h(e.id)}" type="time" value="${h(e.time || '')}" class="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"></td>
      <td class="px-3 py-2"><input data-sched-dur="${h(e.id)}" type="number" min="5" max="300" value="${Number(e.scheduleDuration || e.duration || 30)}" class="w-16 rounded border border-slate-200 bg-white px-2 py-1 font-mono-num text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"></td>
      <td class="px-3 py-2 text-right"><button type="button" data-admin-action="save-schedule-row" data-id="${h(e.id)}" class="rounded bg-blue-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500">Save</button></td>
    </tr>
  `).join('');

  byId('breaks-list').innerHTML = state.scheduleBreaks.length ? state.scheduleBreaks.map((b) => `
    <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300">
      <span><strong class="text-slate-900 dark:text-slate-100">${h(b.title)}</strong> • ${h(b.date)} (${h(b.startTime)} – ${h(b.endTime)})</span>
      <div class="flex items-center gap-2 shrink-0">
        <button type="button" data-admin-action="edit-break" data-id="${h(b.id)}" class="text-blue-700 font-semibold hover:underline dark:text-blue-400">Edit</button>
        <button type="button" data-admin-action="delete-break" data-id="${h(b.id)}" class="text-red-600 font-semibold hover:underline dark:text-red-400">Remove</button>
      </div>
    </div>
  `).join('') : '<p class="text-slate-400 dark:text-slate-500">No schedule breaks configured.</p>';
}

function renderAccessList() {
  const search = (byId('filter-staff-search')?.value || '').trim().toLowerCase();
  const roleFilter = byId('filter-staff-role')?.value || '';
  const map = new Map();
  state.accessUsers.forEach((u) => {
    const key = `${u.role}:${u.email || u.username || u.id}`;
    if (!map.has(key) || u.authUid) map.set(key, u);
  });
  const all = [...map.values()].sort((a, b) => (a.role || '').localeCompare(b.role || '') || (a.displayName || '').localeCompare(b.displayName || ''));
  const list = all.filter((u) => {
    if (roleFilter === 'admin') {
      if (!['admin', 'superAdmin'].includes(u.role)) return false;
    } else if (roleFilter && u.role !== roleFilter) {
      return false;
    }
    if (search && !`${u.displayName || ''} ${u.username || ''} ${u.email || ''} ${u.team || ''} ${u.role || ''}`.toLowerCase().includes(search)) {
      return false;
    }
    return true;
  });

  if (byId('staff-count-label')) byId('staff-count-label').textContent = `${list.length} account${list.length === 1 ? '' : 's'}`;
  const currentUid = auth.currentUser?.uid || '';
  const roleLabels = { teamLeader: 'Team Leader', judge: 'Judge', admin: 'Admin', superAdmin: 'Super Admin' };

  byId('access-list').innerHTML = list.length ? list.map((u) => {
    const docId = u.authUid || u.docId || u.id;
    const active = u.active !== false;
    const isSelf = Boolean(currentUid && docId === currentUid);
    const hasRealEmail = Boolean(u.email && !String(u.email).endsWith('@fest.local'));
    return `
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-2 dark:border-slate-800 dark:bg-slate-800/60">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="truncate font-bold text-slate-900 dark:text-slate-100">${h(u.displayName || u.username)}${isSelf ? ' <span class="text-[10px] font-bold text-blue-700 dark:text-blue-400">(You)</span>' : ''}</p>
            <p class="text-[11px] text-slate-600 dark:text-slate-300">${h(roleLabels[u.role] || u.role)}${u.team ? ` • ${h(teamName(u.team))} (${h(u.genderScope || 'Both')})` : ''}</p>
            <p class="truncate text-[11px] text-slate-500 dark:text-slate-400">Login: ${h(u.username || u.email || '')}${u.email && u.username && !u.email.startsWith(`${u.username}@fest.local`) ? ` (${h(u.email)})` : ''}</p>
          </div>
          <span class="rounded px-2 py-0.5 text-[10px] font-bold uppercase ${active ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-950/70 dark:text-red-300'}">${active ? 'Active' : 'Inactive'}</span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button type="button" data-admin-action="edit-access" data-id="${h(docId)}" class="rounded border border-slate-200 bg-white px-2.5 py-1 font-semibold text-blue-700 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-900 dark:text-blue-400 dark:hover:bg-slate-800">Edit</button>
          <button type="button" data-admin-action="toggle-access" data-id="${h(docId)}" ${isSelf ? 'disabled title="Cannot deactivate your active session"' : ''} class="rounded border border-slate-200 bg-white px-2.5 py-1 font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">${active ? 'Deactivate' : 'Activate'}</button>
          ${hasRealEmail ? `<button type="button" data-admin-action="reset-access-password" data-id="${h(docId)}" class="rounded border border-slate-200 bg-white px-2.5 py-1 font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">Reset Pass</button>` : ''}
          <button type="button" data-admin-action="delete-access" data-id="${h(docId)}" ${isSelf ? 'disabled title="Cannot delete your active session"' : ''} class="rounded border border-red-200 bg-white px-2.5 py-1 font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed dark:border-red-900/70 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950/60">Delete</button>
        </div>
      </div>
    `;
  }).join('') : '<p class="col-span-full text-xs text-slate-400 dark:text-slate-500">No staff accounts match this filter.</p>';
}

const TV_SECTION_DEFS = [
  ['logo', 'Festival Logo'],
  ['name', 'TV Title'],
  ['subtitle', 'Subtitle'],
  ['clock', 'Live Clock'],
  ['ticker', 'Scrolling Ticker'],
  ['officialLatest', 'Latest Published Result'],
  ['leaderboard', 'Team Standings'],
  ['recentResults', 'Recent Results'],
  ['announcements', 'Announcements'],
  ['media', 'Media Wall'],
  ['videos', 'Video Playback']
];

function hydrateTvForms() {
  const cfg = state.tvConfig || {};
  const ctrl = state.tvControl || {};
  const bg = cfg.background || {};
  const setVal = (id, v) => { const el = byId(id); if (el) el.value = v ?? ''; };
  setVal('admin-tv-title', cfg.title || 'FEST LIVE');
  setVal('admin-tv-bg-color', bg.color || '#0B1120');
  setVal('admin-tv-ticker', cfg.ticker || '');
  setVal('admin-tv-announcements', (cfg.announcements || []).join('\n'));
  setVal('admin-tv-bg-image', bg.imageUrl || '');
  setVal('admin-tv-bg-video', bg.videoUrl || '');
  setVal('admin-tv-slides', (bg.slides || []).join('\n'));
  setVal('admin-tv-videos', (bg.videos || []).join('\n'));
  setVal('admin-tv-mode', ctrl.mode || 'dashboard');
  setVal('admin-tv-animation', ctrl.animationStyle || 'cinematic');
  setVal('admin-tv-order', ctrl.resultOrder || 'latest');
  setVal('admin-tv-interrupt', ctrl.interruptPolicy || cfg.interruptPolicy || 'after-current');
}

function renderTvPanel() {
  const ctrl = state.tvControl || {};
  const cfg = state.tvConfig || {};
  const mode = byId('admin-tv-mode')?.value || ctrl.mode || 'dashboard';
  if (byId('admin-tv-stat-mode')) byId('admin-tv-stat-mode').textContent = String(mode).toUpperCase();
  if (byId('admin-tv-stat-queue')) byId('admin-tv-stat-queue').textContent = String(state.tvSelectedResultIds.size);
  if (byId('admin-tv-stat-updated')) {
    const ts = Number(ctrl.updatedAt || cfg.updatedAt || 0);
    byId('admin-tv-stat-updated').textContent = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Not set';
  }

  const secGrid = byId('admin-tv-sections-grid');
  if (secGrid) {
    const savedShow = { ...(cfg.show || {}), ...(ctrl.content || {}) };
    secGrid.innerHTML = TV_SECTION_DEFS.map(([key, label]) => `
      <label class="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 font-semibold text-slate-700 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-200">
        <input type="checkbox" data-admin-tv-sec="${h(key)}" ${savedShow[key] !== false ? 'checked' : ''} class="h-4 w-4 rounded border-slate-300 text-blue-700 dark:border-slate-600 dark:bg-slate-800">
        <span>${h(label)}</span>
      </label>
    `).join('');
  }

  const resList = byId('admin-tv-results-list');
  if (resList) {
    const published = state.results
      .filter((r) => !r.status || r.status === 'published')
      .slice()
      .sort((a, b) => Number(b.publishedAt || b.updatedAt || 0) - Number(a.publishedAt || a.updatedAt || 0));
    resList.innerHTML = published.length ? published.map((r) => {
      const id = r.eventId || r.id;
      const ev = state.events.find((e) => e.id === id);
      const winners = (r.places || []).flatMap((p) => (p.winners || []).map((wid) => r.winnerDetails?.[wid]?.name || wid)).slice(0, 3);
      return `
        <label class="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 p-2.5 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-800/50 dark:hover:bg-slate-800">
          <input type="checkbox" data-admin-tv-result="${h(id)}" ${state.tvSelectedResultIds.has(id) ? 'checked' : ''} class="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 dark:border-slate-600 dark:bg-slate-800">
          <div class="min-w-0 flex-1">
            <p class="truncate font-bold text-slate-900 dark:text-slate-100">${h(ev?.name || r.eventName || id)}</p>
            <p class="truncate text-[11px] text-slate-500 dark:text-slate-400">${h(categoryName(ev?.category || r.category || ''))}${winners.length ? ` • ${h(winners.join(', '))}` : ''}</p>
          </div>
        </label>
      `;
    }).join('') : '<p class="text-xs text-slate-400 dark:text-slate-500">No published results available to queue yet.</p>';
  }
}

function renderNotices() {
  const list = state.notifications || [];
  if (byId('notices-count-label')) byId('notices-count-label').textContent = `${list.length} notice${list.length === 1 ? '' : 's'}`;
  const container = byId('notices-list');
  if (!container) return;
  container.innerHTML = list.length ? list.map((n) => {
    const dt = n.createdAt ? new Date(Number(n.createdAt)).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
    const target = n.team === 'All' || !n.team ? 'All Teams' : teamName(n.team);
    return `
      <div class="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-800/60">
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="rounded bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase text-blue-800 dark:bg-blue-950/70 dark:text-blue-300">${h(target)}</span>
            <strong class="text-slate-900 dark:text-slate-100">${h(n.title || 'Festival Notice')}</strong>
            ${dt ? `<span class="font-mono-num text-[11px] text-slate-400 dark:text-slate-500">${h(dt)}</span>` : ''}
          </div>
          <p class="text-slate-700 dark:text-slate-300">${h(n.message || '')}</p>
        </div>
        <button type="button" data-admin-action="delete-notice" data-id="${h(n.id)}" class="shrink-0 rounded border border-red-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50 dark:border-red-900/70 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950/60">Delete</button>
      </div>
    `;
  }).join('') : '<p class="text-xs text-slate-400 dark:text-slate-500">No team notices sent yet.</p>';
}

function renderResetCounts() {
  const scheduledEventsCount = state.events.filter((e) => e.scheduleDate || e.time || e.scheduleStage).length;
  const nonAdminCount = state.accessUsers.filter((u) => !['admin', 'superAdmin'].includes(u.role)).length;
  const counts = {
    registrations: state.registrations.length + state.registrationRequests.length,
    results: state.results.length + state.judgeScores.length,
    students: state.students.length,
    events: state.events.length,
    schedule: state.scheduleBreaks.length + scheduledEventsCount,
    notices: state.notifications.length,
    nonAdminStaff: nonAdminCount
  };
  Object.entries(counts).forEach(([scope, val]) => {
    const el = document.querySelector(`[data-reset-count="${scope}"]`);
    if (el) el.textContent = String(val);
  });
}

function renderAll() {
  renderOverview();
  renderSetupLists();
  syncStudentFieldVisibility();
  renderStudents();
  syncStudentChestInput();
  renderEvents();
  renderRegistrations();
  renderSchedule();
  renderAccessList();
  renderTvPanel();
  renderNotices();
  renderResetCounts();
  resultsController?.renderAll();
  excelController?.renderAllWorkspaces();
  window.lucide?.createIcons?.();
}

function setSubTab(group, subtab) {
  if (!activeSubTabs[group] || !subtab) return;
  activeSubTabs[group] = subtab;
  document.querySelectorAll(`[data-subtab-group="${group}"]`).forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.subtab === subtab));
  });
  document.querySelectorAll(`[data-subtab-panel-group="${group}"]`).forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.subtabPanel !== subtab);
  });
  window.lucide?.createIcons?.();
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.admin-view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${tab}`));
  const titles = {
    overview: 'Operational Overview',
    setup: 'Festival Setup',
    students: 'Students Roster',
    events: 'Events Management',
    registrations: 'Registrations & Requests',
    schedule: 'Schedule & Breaks',
    results: 'Judging & Result Publishing',
    staff: 'Staff & Login Management',
    tv: 'Live TV & Broadcast Control',
    notices: 'Team Notices & Announcements',
    reset: 'Data Reset & Maintenance'
  };
  byId('admin-page-title').textContent = titles[tab] || 'Admin Console';
  sidebarShell?.closeMobile?.();
  window.lucide?.createIcons?.();
}

// Secondary Auth user creator (does not sign out Admin)
const normalizeUsername = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, '_');
async function createAccessAuthUser(email, password) {
  const secApp = initializeApp(app.options, `access-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const secAuth = getSecondaryAuth(secApp);
  try {
    const cred = await createUserWithEmailAndPassword(secAuth, email, password);
    await signOutSecondary(secAuth).catch(() => {});
    return cred.user.uid;
  } finally {
    await deleteApp(secApp).catch(() => {});
  }
}

function setFieldLockedStyle(el, locked) {
  if (!el) return;
  el.disabled = locked;
  if (locked) {
    el.classList.remove('bg-white', 'text-slate-900', 'dark:bg-slate-800', 'dark:text-slate-100');
    el.classList.add('bg-slate-100', 'text-slate-500', 'dark:bg-slate-950/70', 'dark:text-slate-400', 'cursor-not-allowed');
  } else {
    el.classList.remove('bg-slate-100', 'text-slate-500', 'dark:bg-slate-950/70', 'dark:text-slate-400', 'cursor-not-allowed');
    el.classList.add('bg-white', 'text-slate-900', 'dark:bg-slate-800', 'dark:text-slate-100');
  }
}

function setReadOnlyLockedStyle(el, locked) {
  if (!el) return;
  el.readOnly = locked;
  el.tabIndex = locked ? -1 : 0;
  if (locked) {
    el.classList.remove('bg-white', 'text-slate-900', 'dark:bg-slate-800', 'dark:text-slate-100');
    el.classList.add('bg-slate-100', 'text-slate-600', 'dark:bg-slate-950/70', 'dark:text-slate-300', 'cursor-not-allowed');
  } else {
    el.classList.remove('bg-slate-100', 'text-slate-600', 'dark:bg-slate-950/70', 'dark:text-slate-300', 'cursor-not-allowed');
    el.classList.add('bg-white', 'text-slate-900', 'dark:bg-slate-800', 'dark:text-slate-100');
  }
}

function syncStudentChestInput() {
  const chestEl = byId('inp-std-chest');
  const genBtn = byId('btn-gen-chest');
  const lockBadge = byId('std-chest-lock-badge');
  const hintEl = byId('std-chest-auto-hint');
  if (!chestEl) return;

  const cfg = state.chestNumberConfig || defaultChestConfig();
  if (!cfg.enabled) {
    setReadOnlyLockedStyle(chestEl, false);
    if (genBtn) {
      genBtn.disabled = false;
      genBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
    lockBadge?.classList.add('hidden');
    hintEl?.classList.add('hidden');
    return;
  }

  setReadOnlyLockedStyle(chestEl, true);
  if (genBtn) {
    genBtn.disabled = true;
    genBtn.classList.add('opacity-50', 'cursor-not-allowed');
  }
  lockBadge?.classList.remove('hidden');

  const res = resolveNextAutoChestNo({
    config: cfg,
    students: state.students,
    team: byId('inp-std-team')?.value || '',
    category: byId('inp-std-cat')?.value || '',
    gender: byId('inp-std-gender')?.value || 'Boys'
  });

  if (res.ok) {
    chestEl.value = res.chestNo;
    if (hintEl) {
      hintEl.textContent = `Auto-assigned from rule "${res.seed}" (next highest + 1).`;
      hintEl.className = 'text-[11px] font-medium text-emerald-700 dark:text-emerald-400';
    }
  } else {
    chestEl.value = '';
    if (hintEl) {
      hintEl.textContent = res.reason;
      hintEl.className = 'text-[11px] font-medium text-amber-700 dark:text-amber-400';
    }
  }
}

function syncStudentFieldVisibility() {
  const cfg = state.categoryClassification || defaultCategoryClassificationConfig();
  const { showClass, showDob } = getStudentFieldVisibility(cfg);
  byId('wrap-std-class')?.classList.toggle('hidden', !showClass);
  byId('wrap-std-dob')?.classList.toggle('hidden', !showDob);
  byId('wrap-edit-std-class')?.classList.toggle('hidden', !showClass);
  byId('wrap-edit-std-dob')?.classList.toggle('hidden', !showDob);
  if (!showClass && byId('inp-std-class')) byId('inp-std-class').value = '';
  if (!showDob && byId('inp-std-dob')) byId('inp-std-dob').value = '';
  if (cfg.mode === 'manual') {
    const addHint = byId('std-cat-auto-hint');
    if (addHint) { addHint.textContent = ''; addHint.classList.add('hidden'); }
    const editHint = byId('edit-std-cat-auto-hint');
    if (editHint) { editHint.textContent = ''; editHint.classList.add('hidden'); }
  }
}

function applyAutoCategoryForForm(prefix = 'inp') {
  const cfg = state.categoryClassification || defaultCategoryClassificationConfig();
  const isEdit = prefix === 'edit';
  const classEl = byId(isEdit ? 'edit-std-class' : 'inp-std-class');
  const dobEl = byId(isEdit ? 'edit-std-dob' : 'inp-std-dob');
  const catEl = byId(isEdit ? 'edit-std-cat' : 'inp-std-cat');
  const hintEl = byId(isEdit ? 'edit-std-cat-auto-hint' : 'std-cat-auto-hint');
  if (!catEl || !hintEl) return;

  if (cfg.mode === 'manual') {
    hintEl.textContent = '';
    hintEl.classList.add('hidden');
    return;
  }

  const classValue = classEl?.value || '';
  const dobValue = dobEl?.value || '';
  const res = resolveCategoryFromStudentInputs({
    config: cfg,
    categories: state.categories,
    classValue,
    dobValue
  });

  if (res.matched && state.categories.includes(res.category)) {
    catEl.value = res.category;
    hintEl.textContent = `Auto-selected "${categoryName(res.category)}" from ${cfg.mode === 'class' ? `Class ${classValue}` : `DOB ${dobValue}`}. You can change Category manually if needed.`;
    hintEl.className = 'text-[11px] font-medium text-blue-700 dark:text-blue-400';
    hintEl.classList.remove('hidden');
    if (!isEdit) syncStudentChestInput();
  } else if ((cfg.mode === 'class' && classValue) || (cfg.mode === 'dob' && dobValue)) {
    hintEl.textContent = `No ${cfg.mode === 'class' ? 'Class' : 'DOB'} rule matched this input — please select Category manually.`;
    hintEl.className = 'text-[11px] font-medium text-amber-700 dark:text-amber-400';
    hintEl.classList.remove('hidden');
  } else {
    hintEl.textContent = '';
    hintEl.classList.add('hidden');
  }
}

function resetStaffForm() {
  byId('access-edit-uid').value = '';
  byId('access-uid').value = '';
  setFieldLockedStyle(byId('access-identifier'), false);
  setFieldLockedStyle(byId('access-password'), false);
  ['access-name', 'access-identifier', 'access-password', 'access-title', 'access-phone'].forEach((id) => {
    const el = byId(id);
    if (el) el.value = '';
  });
  if (byId('access-role')) byId('access-role').value = 'teamLeader';
  if (byId('access-gender')) byId('access-gender').value = 'Both';
  if (byId('access-active')) byId('access-active').checked = true;
  byId('access-team-wrap')?.classList.remove('hidden');
  byId('access-gender-wrap')?.classList.remove('hidden');
  byId('access-edit-banner')?.classList.add('hidden');
  byId('btn-cancel-access-edit')?.classList.add('hidden');
  if (byId('btn-save-access')) byId('btn-save-access').textContent = 'Save Staff Account';
}

function loadStaffIntoForm(docId) {
  const u = state.accessUsers.find((x) => (x.authUid || x.docId || x.id) === docId);
  if (!u) return;
  byId('access-edit-uid').value = docId;
  byId('access-uid').value = u.authUid || docId;
  byId('access-role').value = u.role || 'teamLeader';
  byId('access-name').value = u.displayName || u.username || '';
  byId('access-identifier').value = u.email || u.username || '';
  setFieldLockedStyle(byId('access-identifier'), true);
  byId('access-password').value = '';
  setFieldLockedStyle(byId('access-password'), true);
  byId('access-team').value = u.team || '';
  byId('access-gender').value = u.genderScope || 'Both';
  byId('access-title').value = u.title || '';
  byId('access-phone').value = u.phone || '';
  byId('access-active').checked = u.active !== false;
  const isLeader = byId('access-role').value === 'teamLeader';
  byId('access-team-wrap')?.classList.toggle('hidden', !isLeader);
  byId('access-gender-wrap')?.classList.toggle('hidden', !isLeader);
  const banner = byId('access-edit-banner');
  if (banner) {
    banner.textContent = `Editing staff account: ${u.displayName || u.username} (login email/password stays unchanged).`;
    banner.classList.remove('hidden');
  }
  byId('btn-cancel-access-edit')?.classList.remove('hidden');
  if (byId('btn-save-access')) byId('btn-save-access').textContent = 'Update Staff Account';
  byId('access-name')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveStaffAccount() {
  const editUid = byId('access-edit-uid')?.value.trim();
  const role = byId('access-role').value;
  const displayName = byId('access-name').value.trim();
  const identifier = byId('access-identifier').value.trim();
  const password = byId('access-password').value.trim();
  const team = role === 'teamLeader' ? byId('access-team').value : '';
  const genderScope = role === 'teamLeader' ? byId('access-gender').value : '';
  const title = byId('access-title').value.trim();
  const phone = byId('access-phone').value.trim();
  const active = byId('access-active').checked;

  if (!displayName) return showToast('Display name is required', 'error');
  if (role === 'teamLeader' && !team) return showToast('Select a team for Team Leader', 'error');

  if (editUid) {
    const existing = state.accessUsers.find((x) => (x.authUid || x.docId || x.id) === editUid);
    if (!existing) return showToast('Staff account not found', 'error');
    const now = Date.now();
    const prevRole = existing.role;
    const username = normalizeUsername(existing.username || displayName);
    const email = existing.email || '';
    const emailKey = email ? `email_${normalizeUsername(email).replace(/[^a-z0-9_@.-]/g, '_')}` : '';
    const patch = {
      role,
      displayName,
      phone,
      team,
      genderScope,
      title: title || (role === 'teamLeader' ? 'Team Leader' : role),
      active,
      updatedAt: now
    };
    try {
      await setDoc(doc(db, 'accessUsers', editUid), patch, { merge: true });
      if (username) await setDoc(doc(db, 'accessUsernames', username), { ...patch, accessDocId: editUid }, { merge: true }).catch(() => {});
      if (emailKey) await setDoc(doc(db, 'accessUsernames', emailKey), { ...patch, accessDocId: editUid }, { merge: true }).catch(() => {});

      if (prevRole !== role) {
        if (prevRole === 'teamLeader') await deleteDoc(doc(db, 'teamLeaders', editUid)).catch(() => {});
        if (prevRole === 'judge') await deleteDoc(doc(db, 'judges', editUid)).catch(() => {});
        if (['admin', 'superAdmin'].includes(prevRole)) {
          await deleteDoc(doc(db, 'adminUsers', editUid)).catch(() => {});
          if (username) await deleteDoc(doc(db, 'adminUsernames', username)).catch(() => {});
        }
      }
      if (role === 'teamLeader') {
        await setDoc(doc(db, 'teamLeaders', editUid), { uid: editUid, authUid: editUid, username, displayName, phone, team, genderScope: genderScope || 'Both', title: patch.title, active, updatedAt: now }, { merge: true });
      } else if (role === 'judge') {
        await setDoc(doc(db, 'judges', editUid), { uid: editUid, authUid: editUid, username, name: displayName, phone, active, updatedAt: now }, { merge: true });
      } else if (['admin', 'superAdmin'].includes(role)) {
        await setDoc(doc(db, 'adminUsers', editUid), { username, email, displayName, role, active, updatedAt: now }, { merge: true });
        if (username) {
          await setDoc(doc(db, 'adminUsernames', username), { uid: editUid, username, email, role, active, updatedAt: now }, { merge: true }).catch(() => {});
        }
      }

      Object.assign(existing, patch);
      resetStaffForm();
      renderAccessList();
      renderResetCounts();
      resultsController?.renderAll();
      showToast(`Updated staff account: ${displayName}`);
    } catch (err) {
      console.error(err);
      showToast('Failed to update staff account', 'error');
    }
    return;
  }

  if (!identifier) return showToast('Username or email is required', 'error');
  if (password.length < 6) return showToast('Password must be at least 6 characters', 'error');

  const email = identifier.includes('@') ? identifier.toLowerCase() : `${normalizeUsername(identifier)}@fest.local`;
  const username = identifier.includes('@') ? normalizeUsername(identifier.split('@')[0]) : normalizeUsername(identifier);
  const emailKey = `email_${normalizeUsername(email).replace(/[^a-z0-9_@.-]/g, '_')}`;

  try {
    const authUid = await createAccessAuthUser(email, password);
    const now = Date.now();
    const profile = {
      username,
      email,
      role,
      displayName,
      authUid,
      accessPassword: deleteField(),
      phone,
      team,
      genderScope,
      title: title || (role === 'teamLeader' ? 'Team Leader' : role),
      active,
      updatedAt: now
    };
    await setDoc(doc(db, 'accessUsers', authUid), profile, { merge: true });
    await setDoc(doc(db, 'accessUsernames', username), { ...profile, accessDocId: authUid }, { merge: true });
    await setDoc(doc(db, 'accessUsernames', emailKey), { ...profile, accessDocId: authUid }, { merge: true });

    if (role === 'teamLeader') {
      await setDoc(doc(db, 'teamLeaders', authUid), { uid: authUid, authUid, username, displayName, phone, team, genderScope: genderScope || 'Both', title: profile.title, active, updatedAt: now }, { merge: true });
    } else if (role === 'judge') {
      await setDoc(doc(db, 'judges', authUid), { uid: authUid, authUid, username, name: displayName, phone, active, updatedAt: now }, { merge: true });
    } else if (['admin', 'superAdmin'].includes(role)) {
      await setDoc(doc(db, 'adminUsers', authUid), { username, email, displayName, role, active, updatedAt: now }, { merge: true });
      if (username) {
        await setDoc(doc(db, 'adminUsernames', username), { uid: authUid, username, email, role, active, updatedAt: now }, { merge: true }).catch(() => {});
      }
    }

    state.accessUsers.push({ id: authUid, docId: authUid, ...profile });
    resetStaffForm();
    renderAccessList();
    renderResetCounts();
    resultsController?.renderAll();
    showToast(`Created ${role} account: ${displayName}`);
  } catch (err) {
    console.error(err);
    showToast(err.code === 'auth/email-already-in-use' ? 'Username/email already exists in Auth' : 'Failed to create staff account', 'error');
  }
}

async function openAdminRegModal(eventId, regId = '') {
  const ev = state.events.find((e) => e.id === eventId);
  if (!ev) return;
  const existingReg = regId ? state.registrations.find((r) => r.id === regId) : null;
  const isEditing = Boolean(existingReg);

  byId('admin-reg-modal-title').textContent = isEditing ? `Edit Entry #${existingReg.slotIndex || 1} — ${ev.name}` : `Assign Entry — ${ev.name}`;
  byId('admin-reg-modal-sub').textContent = `${categoryName(ev.category)} • ${ev.gender} • ${ev.type}`;

  byId('admin-reg-modal-body').innerHTML = `
    <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">Team
      <select id="admin-reg-team" ${isEditing ? 'disabled' : ''} class="mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 ${isEditing ? 'bg-slate-100 text-slate-600 dark:bg-slate-800/70 dark:text-slate-400 cursor-not-allowed' : 'bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100'} px-3 py-2 text-xs">
        ${state.teams.map((t) => `<option value="${h(t)}">${h(teamName(t))}</option>`).join('')}
      </select>
    </label>
    <div id="admin-reg-students" class="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2 text-xs dark:border-slate-800 dark:bg-slate-950/40"></div>
    <div class="flex justify-end gap-2">
      <button id="btn-cancel-admin-reg" type="button" class="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">Cancel</button>
      <button id="btn-save-admin-reg" type="button" class="rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500">${isEditing ? 'Update Entry' : 'Save Entry'}</button>
    </div>
  `;

  if (existingReg?.team) byId('admin-reg-team').value = existingReg.team;
  const preselectedIds = new Set(existingReg?.studentIds || []);

  const renderChecklist = () => {
    const team = byId('admin-reg-team').value;
    const list = state.students.filter((s) => s.team === team && (!ev.category || ev.category === 'All' || ev.category === 'General' || s.category === ev.category) && (!ev.gender || ev.gender === 'Both' || s.gender === ev.gender));
    byId('admin-reg-students').innerHTML = list.length ? list.map((s) => `
      <label class="flex items-center justify-between rounded px-2 py-1.5 hover:bg-slate-50 cursor-pointer text-slate-800 dark:text-slate-200 dark:hover:bg-slate-800/60">
        <span class="flex items-center gap-2"><input type="checkbox" name="admin-reg-pick" value="${h(s.id)}" ${preselectedIds.has(s.id) ? 'checked' : ''} class="rounded border-slate-300 dark:border-slate-600 dark:bg-slate-800"><strong>${h(s.name)}</strong></span>
        <span class="font-mono-num text-slate-500 dark:text-slate-400">${h(s.chestNo || '')}</span>
      </label>
    `).join('') : '<p class="p-3 text-center text-slate-400 dark:text-slate-500">No eligible students in this team.</p>';
  };

  byId('admin-reg-team').addEventListener('change', renderChecklist);
  byId('btn-cancel-admin-reg').addEventListener('click', () => closeModal('admin-reg-modal'));
  renderChecklist();

  byId('btn-save-admin-reg').addEventListener('click', async () => {
    const team = byId('admin-reg-team').value;
    const picked = [...document.querySelectorAll('input[name="admin-reg-pick"]:checked')].map((i) => i.value);
    if (!picked.length) return showToast('Select at least one student', 'error');
    const now = Date.now();
    if (isEditing) {
      const patch = {
        studentIds: picked,
        lastUpdatedAt: now,
        lastUpdatedByUid: auth.currentUser?.uid || ''
      };
      await updateDoc(doc(db, 'registrations', existingReg.id), patch);
      Object.assign(existingReg, patch);
      closeModal('admin-reg-modal');
      renderRegistrations();
      renderOverview();
      showToast('Registration entry updated');
      return;
    }

    const existingSlots = state.registrations.filter((r) => r.eventId === ev.id && r.team === team).length;
    const slotIndex = existingSlots + 1;
    const payload = {
      eventId: ev.id,
      eventName: ev.name || '',
      team,
      slotIndex,
      studentIds: picked,
      participantIds: [],
      registrationSource: 'admin-final-entry',
      createdAt: now,
      createdByUid: auth.currentUser?.uid || '',
      lastUpdatedAt: now
    };
    const docRef = await addDoc(collection(db, 'registrations'), payload);
    state.registrations.push({ id: docRef.id, ...payload });
    closeModal('admin-reg-modal');
    renderRegistrations();
    renderOverview();
    showToast('Registration entry added');
  });

  openModal('admin-reg-modal');
}

async function commitBatchOps(ops = []) {
  const CHUNK_SIZE = 300;
  for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + CHUNK_SIZE)) {
      if (op.type === 'delete') batch.delete(op.ref);
      else if (op.type === 'update') batch.update(op.ref, op.data);
      else if (op.type === 'set') batch.set(op.ref, op.data, { merge: Boolean(op.merge) });
    }
    await batch.commit();
  }
}

async function safeResetScope(scopeName) {
  const scopes = {
    registrations: ['registrations', 'registrationRequests', 'registrationApplications'],
    results: ['results', 'resultRevisions', 'teamScoreLedgers', 'judgeScores', 'publicJudgingStatuses'],
    students: ['students'],
    events: ['events', 'judgeAssignments'],
    schedule: ['scheduleBreaks'],
    notices: ['notifications'],
    nonAdminStaff: ['teamLeaders', 'judges', 'accessUsers', 'accessUsernames'],
    logsAndBackups: ['auditLogs', 'deletedBackups']
  };
  const cols = scopes[scopeName];
  if (!cols) return;

  const isLogsScope = scopeName === 'logsAndBackups';
  const promptMsg = scopeName === 'schedule'
    ? 'Remove all schedule breaks and clear schedule dates, stages, and times from all events? A backup will be archived first.'
    : scopeName === 'nonAdminStaff'
      ? 'Remove all Team Leader and Judge profiles while keeping active Admin accounts? A backup will be archived first.'
      : isLogsScope
        ? 'Permanently clear auditLogs and deletedBackups?'
        : `Archive and permanently clear ${cols.join(', ')}?`;

  if (!await confirmAction(promptMsg, { title: 'Confirm Data Reset', okLabel: isLogsScope ? 'Clear Logs & Backups' : 'Archive & Clear' })) return;

  let totalDeleted = 0;
  try {
    for (const colName of cols) {
      const snap = await getDocs(collection(db, colName));
      if (snap.empty) continue;
      let targetDocs = snap.docs;
      if (scopeName === 'nonAdminStaff' && (colName === 'accessUsers' || colName === 'accessUsernames')) {
        targetDocs = snap.docs.filter((d) => !['admin', 'superAdmin'].includes(d.data()?.role));
      }
      if (!targetDocs.length) continue;

      if (!isLogsScope) {
        await addDoc(collection(db, 'deletedBackups'), {
          collection: colName,
          scope: scopeName,
          count: targetDocs.length,
          createdAt: Date.now(),
          uid: auth.currentUser?.uid || '',
          items: targetDocs.slice(0, 100).map((d) => ({ id: d.id, ...d.data() }))
        });
      }
      await commitBatchOps(targetDocs.map((d) => ({ type: 'delete', ref: d.ref })));
      totalDeleted += targetDocs.length;
    }

    if (scopeName === 'schedule') {
      const evSnap = await getDocs(collection(db, 'events'));
      const evOps = evSnap.docs.map((d) => ({
        type: 'update',
        ref: d.ref,
        data: {
          scheduleDate: deleteField(),
          scheduleDay: deleteField(),
          scheduleDayId: deleteField(),
          scheduleStage: deleteField(),
          scheduleStageId: deleteField(),
          time: deleteField(),
          scheduleDuration: deleteField(),
          scheduleEndTime: deleteField(),
          scheduleNotes: deleteField(),
          scheduleOrder: deleteField(),
          scheduleStatus: 'unscheduled',
          duration: 0,
          updatedAt: Date.now()
        }
      }));
      if (evOps.length) {
        await commitBatchOps(evOps);
        totalDeleted += evOps.length;
      }
    }

    if (!isLogsScope) {
      await addDoc(collection(db, 'auditLogs'), {
        action: 'data-reset-scope',
        scope: scopeName,
        collections: cols,
        count: totalDeleted,
        uid: auth.currentUser?.uid || '',
        timestamp: Date.now()
      }).catch(() => {});
    }

    await loadAllAdminData(true);
    await resultsController?.syncPublicSummary(state.results);
    showToast(`Reset complete (${scopeName}: ${totalDeleted} record(s) processed)`);
  } catch (err) {
    console.error(err);
    showToast(`Failed to reset ${scopeName}`, 'error');
  }
}

async function resetTeamData() {
  const team = byId('reset-team-select')?.value || '';
  if (!team) return showToast('Select a team to clear', 'error');
  const label = teamName(team);
  const ok = await confirmAction(
    `Archive and delete all students, registrations, requests, and notices for "${label}" (Key: ${team})? Other teams will not be affected.`,
    { title: 'Clear Team Data', okLabel: `Clear ${label}` }
  );
  if (!ok) return;

  try {
    const ops = [];
    const targetCols = ['students', 'registrations', 'registrationRequests', 'notifications'];
    for (const colName of targetCols) {
      const snap = await getDocs(collection(db, colName));
      const matched = snap.docs.filter((d) => d.data()?.team === team);
      if (!matched.length) continue;
      await addDoc(collection(db, 'deletedBackups'), {
        collection: colName,
        scope: `team:${team}`,
        count: matched.length,
        createdAt: Date.now(),
        uid: auth.currentUser?.uid || '',
        items: matched.slice(0, 100).map((d) => ({ id: d.id, ...d.data() }))
      });
      matched.forEach((d) => ops.push({ type: 'delete', ref: d.ref }));
    }
    await commitBatchOps(ops);
    await addDoc(collection(db, 'auditLogs'), {
      action: 'team-data-reset',
      team,
      count: ops.length,
      uid: auth.currentUser?.uid || '',
      timestamp: Date.now()
    }).catch(() => {});
    await loadAllAdminData(true);
    await resultsController?.syncPublicSummary(state.results);
    showToast(`Cleared ${ops.length} record(s) for ${label}`);
  } catch (err) {
    console.error(err);
    showToast('Failed to clear team data', 'error');
  }
}

function bindEvents() {
  initImageUploads(document);
  sidebarShell = initCollapsibleSidebar();
  byId('btn-admin-theme')?.addEventListener('click', () => window.feastportAdminTheme?.toggleTheme?.());
  window.feastportAdminTheme?.syncToggleButton?.();
  ['edit-team-modal', 'edit-category-modal', 'edit-stage-modal', 'edit-day-modal', 'edit-student-modal', 'edit-event-modal', 'edit-break-modal', 'edit-assignment-modal', 'admin-reg-modal'].forEach((id) => {
    byId(id)?.addEventListener('click', (e) => { if (e.target === byId(id)) closeModal(id); });
  });
  byId('btn-admin-refresh')?.addEventListener('click', () => loadAllAdminData(true).then(() => showToast('Synced')));

  // Branding save
  byId('btn-save-branding')?.addEventListener('click', async () => {
    const nextHome = {
      festName1: byId('public-home-name1').value.trim(),
      festName2: byId('public-home-name2').value.trim(),
      tagline: byId('public-home-tagline').value.trim(),
      aboutSubtitle: byId('public-home-about-sub').value.trim(),
      aboutText: byId('public-home-about-text').value.trim(),
      footerText: byId('public-home-footer').value.trim(),
      logoUrl: byId('public-home-logo-link').value.trim(),
      galleryImages: normalizeGallerySlots(byId('public-home-gallery').value),
      setupCompleted: true,
      updatedAt: Date.now()
    };
    assertPayloadSize(nextHome, 'Festival branding');
    await setDoc(doc(db, 'settings', 'home_config'), nextHome, { merge: true });
    state.homeConfig = nextHome;
    clearBrandingCache();
    invalidateCache('home_config');
    applyAdminBranding();
    showToast('Festival identity saved');
  });

  // Teams / Categories / Stages / Days
  const saveGeneral = async (patch, msg) => {
    await setDoc(doc(db, 'settings', 'general'), { ...patch, updatedAt: Date.now() }, { merge: true });
    state.generalConfig = { ...state.generalConfig, ...patch };
    invalidateCache('general');
    populateSelectOptions();
    renderAll();
    showToast(msg);
  };

  ['chest-cfg-enabled', 'chest-cfg-split-category', 'chest-cfg-split-gender'].forEach((id) => {
    byId(id)?.addEventListener('change', () => {
      captureChestDraftFromDom();
      renderChestNumberSetup();
    });
  });

  byId('chest-series-matrix')?.addEventListener('input', (e) => {
    const inp = e.target.closest('input[data-chest-series-key]');
    if (!inp) return;
    const key = inp.dataset.chestSeriesKey;
    if (!state.chestDraftConfig.series) state.chestDraftConfig.series = {};
    const val = inp.value.trim();
    if (val) state.chestDraftConfig.series[key] = val;
    else delete state.chestDraftConfig.series[key];
  });

  byId('btn-save-chest-config')?.addEventListener('click', async () => {
    const draft = captureChestDraftFromDom();
    const visibleInputs = [...document.querySelectorAll('#chest-series-matrix input[data-chest-series-key]')];
    let validSeedsCount = 0;

    for (const inp of visibleInputs) {
      const val = inp.value.trim();
      if (!val) continue;
      if (!parseChestSeed(val)) {
        inp.focus();
        return showToast(`Invalid starting chest format "${val}". Must end with digits (e.g. 101 or R101).`, 'error');
      }
      validSeedsCount += 1;
    }

    if (draft.enabled && state.teams.length > 0 && visibleInputs.length > 0 && validSeedsCount === 0) {
      return showToast('Enter at least one valid starting chest number before saving.', 'error');
    }

    const nextCfg = normalizeChestConfig(draft);
    state.chestNumberConfig = nextCfg;
    state.chestDraftConfig = normalizeChestConfig(nextCfg);
    await saveGeneral(
      { chestNumberConfig: nextCfg },
      nextCfg.enabled ? 'Automated chest numbering rules saved' : 'Automated chest numbering disabled'
    );
  });

  // Category Classification & Student Fields setup events
  byId('category-classification-card')?.addEventListener('change', (e) => {
    if (e.target.matches('input[name="cat-cls-mode"], #cat-cls-show-class, #cat-cls-show-dob')) {
      captureCategoryClassificationDraftFromDom();
      renderCategoryClassificationSetup();
      return;
    }
    if (e.target.matches('input[data-dob-cat]')) {
      captureCategoryClassificationDraftFromDom();
    }
  });

  const addNewClassToDraft = () => {
    const inp = byId('inp-new-class-label');
    const raw = (inp?.value || '').trim();
    if (!raw) return showToast('Enter a Class label (e.g. 11, +1, LKG)', 'error');
    const draft = captureCategoryClassificationDraftFromDom();
    if (draft.classes.some((c) => c.toLowerCase() === raw.toLowerCase())) {
      return showToast(`Class "${raw}" is already in the list.`, 'error');
    }
    draft.classes.push(raw);
    if (inp) inp.value = '';
    renderCategoryClassificationSetup();
  };

  byId('btn-add-class-item')?.addEventListener('click', addNewClassToDraft);
  byId('inp-new-class-label')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addNewClassToDraft();
    }
  });

  byId('btn-reset-class-list')?.addEventListener('click', () => {
    const draft = captureCategoryClassificationDraftFromDom();
    draft.classes = [...DEFAULT_CLASS_LIST];
    const allowedSet = new Set(draft.classes.map((c) => c.toLowerCase()));
    if (draft.classRules && typeof draft.classRules === 'object') {
      Object.keys(draft.classRules).forEach((cat) => {
        draft.classRules[cat] = (draft.classRules[cat] || []).filter((c) => allowedSet.has(c.toLowerCase()));
        if (!draft.classRules[cat].length) delete draft.classRules[cat];
      });
    }
    renderCategoryClassificationSetup();
    showToast('Class list reset to default (1–+2). Click Save Category Rules to persist.');
  });

  byId('category-classification-card')?.addEventListener('click', (e) => {
    const removeClsBtn = e.target.closest('button[data-remove-class]');
    if (removeClsBtn) {
      const target = removeClsBtn.dataset.removeClass;
      const draft = captureCategoryClassificationDraftFromDom();
      draft.classes = draft.classes.filter((c) => c !== target);
      if (draft.classRules && typeof draft.classRules === 'object') {
        Object.keys(draft.classRules).forEach((cat) => {
          draft.classRules[cat] = (draft.classRules[cat] || []).filter((c) => c.toLowerCase() !== target.toLowerCase());
          if (!draft.classRules[cat].length) delete draft.classRules[cat];
        });
      }
      renderCategoryClassificationSetup();
      return;
    }

    const mapBtn = e.target.closest('button[data-map-cat][data-map-class]');
    if (mapBtn) {
      const catKey = mapBtn.dataset.mapCat;
      const clsVal = mapBtn.dataset.mapClass;
      const clsLower = clsVal.toLowerCase();
      const draft = captureCategoryClassificationDraftFromDom();
      draft.classRules = draft.classRules && typeof draft.classRules === 'object' ? draft.classRules : {};
      const currentList = draft.classRules[catKey] || [];
      const alreadyHere = currentList.some((c) => c.toLowerCase() === clsLower);

      Object.keys(draft.classRules).forEach((k) => {
        draft.classRules[k] = (draft.classRules[k] || []).filter((c) => c.toLowerCase() !== clsLower);
        if (!draft.classRules[k].length) delete draft.classRules[k];
      });

      if (!alreadyHere) {
        draft.classRules[catKey] = [...(draft.classRules[catKey] || []), clsVal];
      }
      renderCategoryClassificationSetup();
      return;
    }

    const clearDobBtn = e.target.closest('button[data-dob-clear]');
    if (clearDobBtn) {
      const catKey = clearDobBtn.dataset.dobClear;
      const draft = captureCategoryClassificationDraftFromDom();
      if (draft.dobRules) delete draft.dobRules[catKey];
      renderCategoryClassificationSetup();
    }
  });

  byId('btn-save-category-rules')?.addEventListener('click', async () => {
    const draft = captureCategoryClassificationDraftFromDom();
    if (draft.mode === 'dob') {
      for (const catKey of state.categories) {
        const rule = draft.dobRules?.[catKey];
        if (rule?.from && rule?.to && rule.from > rule.to) {
          return showToast(`"${categoryName(catKey)}": From Date must be on or before To Date.`, 'error');
        }
      }
    }
    const nextCfg = normalizeCategoryClassificationConfig(draft, draft.classes);
    state.categoryClassification = nextCfg;
    state.categoryClassificationDraft = normalizeCategoryClassificationConfig(nextCfg);

    const updatedFields = Array.isArray(state.festSetup.studentFields)
      ? state.festSetup.studentFields.map((f) => (f.key === 'class' ? { ...f, options: [...nextCfg.classes] } : { ...f }))
      : [];
    const nextFestSetup = normalizeFestSetup({
      ...state.festSetup,
      eligibleClasses: [...nextCfg.classes],
      studentFields: updatedFields
    });
    state.festSetup = nextFestSetup;

    const modeLabel = nextCfg.mode === 'class' ? 'Auto by Class' : nextCfg.mode === 'dob' ? 'Auto by DOB' : 'Manual Selection';
    await saveGeneral(
      { categoryClassification: nextCfg, festSetup: nextFestSetup },
      `Category rules saved (${modeLabel})`
    );
  });

  bindAutoSlugKey('inp-new-team-label', 'inp-new-team');
  bindAutoSlugKey('inp-new-category-label', 'inp-new-category');

  byId('btn-add-team')?.addEventListener('click', async () => {
    const labelEl = byId('inp-new-team-label');
    const keyEl = byId('inp-new-team');
    const rawLabel = labelEl?.value.trim() || '';
    const rawKey = keyEl?.value.trim() || '';
    const key = (rawKey ? rawKey.replace(/\s+/g, '_') : toSlugKey(rawLabel));
    const label = rawLabel || key;
    const color = byId('inp-new-team-color').value || '#1D4ED8';
    if (!key || !/^[a-zA-Z0-9_-]+$/.test(key)) {
      return showToast('Enter a valid Team Name or Key (letters, numbers, _ or -)', 'error');
    }
    if (state.teams.some((t) => t.toLowerCase() === key.toLowerCase())) {
      return showToast('Team Key already exists. Edit the Key or update the existing team.', 'error');
    }
    state.teams.push(key);
    state.teamColors[key] = color;
    state.teamDisplayNames[key] = label;
    if (keyEl) {
      keyEl.value = '';
      keyEl.dataset.manualEdited = 'false';
    }
    if (labelEl) labelEl.value = '';
    await saveGeneral({ teams: state.teams, teamColors: state.teamColors, teamDisplayNames: state.teamDisplayNames }, 'Team added');
  });

  byId('edit-team-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = byId('edit-team-key').value.trim();
    const label = byId('edit-team-label').value.trim() || key;
    const color = byId('edit-team-color').value || '#1D4ED8';
    if (!key || !state.teams.includes(key)) return;
    state.teamDisplayNames[key] = label;
    state.teamColors[key] = color;
    closeModal('edit-team-modal');
    await saveGeneral({ teamDisplayNames: state.teamDisplayNames, teamColors: state.teamColors }, 'Team display name updated');
  });
  byId('btn-close-edit-team')?.addEventListener('click', () => closeModal('edit-team-modal'));
  byId('btn-cancel-edit-team')?.addEventListener('click', () => closeModal('edit-team-modal'));

  byId('btn-add-category')?.addEventListener('click', async () => {
    const labelEl = byId('inp-new-category-label');
    const keyEl = byId('inp-new-category');
    const rawLabel = labelEl?.value.trim() || '';
    const rawKey = keyEl?.value.trim() || '';
    const key = (rawKey ? rawKey.replace(/\s+/g, '_') : toSlugKey(rawLabel));
    const label = rawLabel || key;
    if (!key || !/^[a-zA-Z0-9_-]+$/.test(key)) {
      return showToast('Enter a valid Category Name or Key (letters, numbers, _ or -)', 'error');
    }
    if (state.categories.some((c) => c.toLowerCase() === key.toLowerCase())) {
      return showToast('Category Key already exists. Edit the Key or update the existing category.', 'error');
    }
    state.categories.push(key);
    state.categoryDisplayNames[key] = label;
    if (keyEl) {
      keyEl.value = '';
      keyEl.dataset.manualEdited = 'false';
    }
    if (labelEl) labelEl.value = '';
    await saveGeneral({ categories: state.categories, categoryDisplayNames: state.categoryDisplayNames }, 'Category added');
  });

  byId('edit-category-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = byId('edit-cat-key').value.trim();
    const label = byId('edit-cat-label').value.trim() || key;
    if (!key || !state.categories.includes(key)) return;
    state.categoryDisplayNames[key] = label;
    closeModal('edit-category-modal');
    await saveGeneral({ categoryDisplayNames: state.categoryDisplayNames }, 'Category display name updated');
  });
  byId('btn-close-edit-category')?.addEventListener('click', () => closeModal('edit-category-modal'));
  byId('btn-cancel-edit-category')?.addEventListener('click', () => closeModal('edit-category-modal'));

  byId('btn-add-stage')?.addEventListener('click', async () => {
    const stage = byId('setup-stage-name').value.trim();
    if (!stage) return showToast('Enter a stage name', 'error');
    if (state.stages.some((s) => s.toLowerCase() === stage.toLowerCase())) {
      return showToast('Stage already exists', 'error');
    }
    state.stages.push(stage);
    byId('setup-stage-name').value = '';
    await saveGeneral({ stages: state.stages }, 'Stage added');
  });

  byId('edit-stage-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldName = byId('edit-stage-old').value;
    const newName = byId('edit-stage-name').value.trim();
    if (!newName) return showToast('Stage name is required', 'error');
    if (oldName !== newName && state.stages.some((s) => s.toLowerCase() === newName.toLowerCase())) {
      return showToast('Another stage already uses that name', 'error');
    }
    state.stages = state.stages.map((s) => (s === oldName ? newName : s));
    const affectedEvents = state.events.filter((ev) => ev.scheduleStage === oldName);
    if (affectedEvents.length) {
      const batch = writeBatch(db);
      affectedEvents.forEach((ev) => {
        batch.update(doc(db, 'events', ev.id), { scheduleStage: newName, updatedAt: Date.now() });
        ev.scheduleStage = newName;
      });
      await batch.commit();
      invalidateCache('events_all');
    }
    closeModal('edit-stage-modal');
    await saveGeneral({ stages: state.stages }, 'Stage updated');
  });
  byId('btn-close-edit-stage')?.addEventListener('click', () => closeModal('edit-stage-modal'));
  byId('btn-cancel-edit-stage')?.addEventListener('click', () => closeModal('edit-stage-modal'));

  byId('btn-add-day')?.addEventListener('click', async () => {
    const date = byId('setup-day-date').value;
    if (!date) return showToast('Select a date', 'error');
    if (state.days.some((d) => (d.date || d) === date)) return showToast('Date already added', 'error');
    state.days.push({ date, label: date });
    byId('setup-day-date').value = '';
    await saveGeneral({ days: state.days }, 'Festival day added');
  });

  byId('edit-day-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const idx = Number(byId('edit-day-index').value);
    const date = byId('edit-day-date').value;
    const label = byId('edit-day-label').value.trim() || date;
    if (!date || Number.isNaN(idx) || !state.days[idx]) return;
    state.days[idx] = { date, label };
    closeModal('edit-day-modal');
    await saveGeneral({ days: state.days }, 'Festival day updated');
  });
  byId('btn-close-edit-day')?.addEventListener('click', () => closeModal('edit-day-modal'));
  byId('btn-cancel-edit-day')?.addEventListener('click', () => closeModal('edit-day-modal'));

  // Registration & Scoring Save
  byId('btn-save-reg-config')?.addEventListener('click', async () => {
    const singleLim = Number(byId('limit-single').value || 0);
    const groupLim = Number(byId('limit-group').value || 0);
    const totalLim = Number(byId('limit-total').value || 0);
    const lockVal = byId('schedule-registration-lock').value;
    const lockAt = lockVal ? new Date(lockVal).getTime() : null;
    const regPayload = {
      ...state.registrationConfig,
      globalStatus: byId('reg-cfg-status').value,
      studentApplicationsEnabled: byId('reg-cfg-enabled').checked,
      registrationPortalEnabled: byId('reg-cfg-enabled').checked,
      finalizationLockAt: lockAt || 0,
      participationLimits: {
        ...state.registrationConfig.participationLimits,
        single: { enabled: true, mode: singleLim > 0 ? 'custom' : 'unlimited', limit: singleLim },
        group: { enabled: true, mode: groupLim > 0 ? 'custom' : 'unlimited', limit: groupLim },
        total: { enabled: true, mode: totalLim > 0 ? 'custom' : 'unlimited', limit: totalLim }
      },
      updatedAt: Date.now()
    };
    await Promise.all([
      setDoc(doc(db, 'settings', 'registration_config'), regPayload, { merge: true }),
      setDoc(doc(db, 'settings', 'schedule_config'), { registrationLockAt: lockAt, updatedAt: Date.now() }, { merge: true })
    ]);
    state.registrationConfig = normalizeRegistrationConfig(regPayload);
    invalidateCache('registration_config');
    invalidateCache('schedule_config');
    showToast('Registration policy & lock saved');
  });

  byId('score-enable-grades')?.addEventListener('change', syncScoringGradesPanelVisibility);
  byId('btn-add-grade-single')?.addEventListener('click', () => appendGradeRow('Single'));
  byId('btn-add-grade-group')?.addEventListener('click', () => appendGradeRow('Group'));
  byId('score-grades-panel')?.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-remove-grade-row]');
    if (!removeBtn) return;
    const row = removeBtn.closest('[data-grade-row]');
    const list = row?.parentElement;
    if (!row || !list) return;
    if (list.querySelectorAll('[data-grade-row]').length <= 1) {
      return showToast('Keep at least one grade level or turn off Enable Grades.', 'error');
    }
    row.remove();
  });

  byId('btn-save-scoring')?.addEventListener('click', async () => {
    const pointValues = ['pts-single-1', 'pts-single-2', 'pts-single-3', 'pts-group-1', 'pts-group-2', 'pts-group-3']
      .map((id) => Number(byId(id)?.value ?? 0));
    if (pointValues.some((v) => !Number.isFinite(v) || v < 0)) {
      return showToast('Position points must be 0 or greater.', 'error');
    }

    const gradesEnabled = Boolean(byId('score-enable-grades')?.checked);
    const singleGradesRes = collectGradeRows('Single');
    if (!singleGradesRes.ok) return showToast(singleGradesRes.error, 'error');
    const groupGradesRes = collectGradeRows('Group');
    if (!groupGradesRes.ok) return showToast(groupGradesRes.error, 'error');

    if (gradesEnabled && (!singleGradesRes.grades.length || !groupGradesRes.grades.length)) {
      return showToast('Configure at least one grade for both Single and Group events.', 'error');
    }

    const base = normalizeScoringRules(state.scoringRules);
    base.configs.Single.points[0].value = pointValues[0];
    base.configs.Single.points[1].value = pointValues[1];
    base.configs.Single.points[2].value = pointValues[2];
    base.configs.Group.points[0].value = pointValues[3];
    base.configs.Group.points[1].value = pointValues[4];
    base.configs.Group.points[2].value = pointValues[5];
    base.configs.Single.grades = singleGradesRes.grades;
    base.configs.Group.grades = groupGradesRes.grades;
    base.enabled.grades = gradesEnabled;
    base.policies.multipleJudgeMethod = byId('policy-multi-judge').value;
    base.policies.directRankGradeMode = gradesEnabled ? 'manual' : 'disabled';

    const next = normalizeScoringRules(base);
    await setDoc(doc(db, 'settings', 'scoring_rules'), { ...next, updatedAt: Date.now() }, { merge: false });
    state.scoringRules = next;
    invalidateCache('scoring_rules');
    renderScoringGradesEditor(next);
    resultsController?.renderAll();
    showToast('Scoring rules saved');
  });

  // Students
  ['inp-std-team', 'inp-std-gender'].forEach((id) => {
    byId(id)?.addEventListener('change', syncStudentChestInput);
  });
  byId('inp-std-cat')?.addEventListener('change', () => {
    const cfg = state.categoryClassification;
    const hintEl = byId('std-cat-auto-hint');
    if (cfg?.mode !== 'manual' && hintEl) {
      const auto = resolveCategoryFromStudentInputs({
        config: cfg,
        categories: state.categories,
        classValue: byId('inp-std-class')?.value || '',
        dobValue: byId('inp-std-dob')?.value || ''
      });
      if (auto.matched && byId('inp-std-cat')?.value !== auto.category) {
        hintEl.textContent = `Manual override: "${categoryName(byId('inp-std-cat').value)}" selected instead of "${categoryName(auto.category)}".`;
        hintEl.className = 'text-[11px] font-medium text-slate-600 dark:text-slate-300';
        hintEl.classList.remove('hidden');
      }
    }
    syncStudentChestInput();
  });
  byId('inp-std-class')?.addEventListener('change', () => applyAutoCategoryForForm('inp'));
  byId('inp-std-dob')?.addEventListener('change', () => applyAutoCategoryForForm('inp'));
  byId('edit-std-class')?.addEventListener('change', () => applyAutoCategoryForForm('edit'));
  byId('edit-std-dob')?.addEventListener('change', () => applyAutoCategoryForForm('edit'));
  byId('edit-std-cat')?.addEventListener('change', () => {
    const cfg = state.categoryClassification;
    const hintEl = byId('edit-std-cat-auto-hint');
    if (cfg?.mode !== 'manual' && hintEl) {
      const auto = resolveCategoryFromStudentInputs({
        config: cfg,
        categories: state.categories,
        classValue: byId('edit-std-class')?.value || '',
        dobValue: byId('edit-std-dob')?.value || ''
      });
      if (auto.matched && byId('edit-std-cat')?.value !== auto.category) {
        hintEl.textContent = `Manual override: "${categoryName(byId('edit-std-cat').value)}" selected instead of "${categoryName(auto.category)}".`;
        hintEl.className = 'text-[11px] font-medium text-slate-600 dark:text-slate-300';
        hintEl.classList.remove('hidden');
      }
    }
  });

  byId('btn-gen-chest')?.addEventListener('click', () => {
    if (state.chestNumberConfig?.enabled) return syncStudentChestInput();
    const taken = new Set(state.students.map((s) => String(s.chestNo || '').trim().toLowerCase()).filter(Boolean));
    const nums = state.students.map((s) => Number(String(s.chestNo || '').replace(/\D/g, ''))).filter(Number.isFinite);
    let next = (nums.length ? Math.max(...nums) : 100) + 1;
    while (taken.has(String(next))) next += 1;
    byId('inp-std-chest').value = String(next);
  });

  byId('form-student')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = byId('inp-std-name').value.trim();
    const team = byId('inp-std-team').value;
    const category = byId('inp-std-cat').value;
    const gender = byId('inp-std-gender').value;
    const classValue = normalizeClassValue(byId('inp-std-class')?.value || '', state.categoryClassification?.classes);
    const dobValue = byId('inp-std-dob')?.value?.trim() || '';
    const photoData = byId('inp-std-photo-data').value.trim();

    let chestNo = byId('inp-std-chest').value.trim();
    if (state.chestNumberConfig?.enabled) {
      const autoRes = resolveNextAutoChestNo({
        config: state.chestNumberConfig,
        students: state.students,
        team,
        category,
        gender
      });
      if (!autoRes.ok) return showToast(autoRes.reason, 'error');
      chestNo = autoRes.chestNo;
    }

    const chestCheck = validateManualChestNo(chestNo, state.students);
    if (!chestCheck.ok) return showToast(chestCheck.error, 'error');
    chestNo = chestCheck.chestNo;

    const details = buildStudentDetailsPatch({}, { classValue, dobValue });
    const payload = {
      name,
      chestNo,
      team,
      category,
      gender,
      photoData,
      ...(Object.keys(details).length ? { details } : {}),
      updatedAt: Date.now()
    };
    const docRef = await addDoc(collection(db, 'students'), payload);
    state.students.push({ id: docRef.id, ...payload });
    if (state.chestNumberConfig?.enabled) {
      byId('inp-std-name').value = '';
      if (byId('inp-std-photo-file')) byId('inp-std-photo-file').value = '';
    } else {
      e.target.reset();
    }
    if (byId('inp-std-class')) byId('inp-std-class').value = '';
    if (byId('inp-std-dob')) byId('inp-std-dob').value = '';
    const addHint = byId('std-cat-auto-hint');
    if (addHint) { addHint.textContent = ''; addHint.classList.add('hidden'); }
    byId('inp-std-photo-data').value = '';
    window.refreshImageUploadPreviews?.();
    renderStudents();
    syncStudentChestInput();
    renderOverview();
    await resultsController?.syncPublicSummary(state.results);
    showToast(`Added student: ${name} (${chestNo})`);
  });

  ['filter-std-search', 'filter-std-team', 'filter-std-cat'].forEach((id) => byId(id)?.addEventListener('input', renderStudents));

  byId('edit-student-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = byId('edit-std-id').value;
    const existing = state.students.find((s) => s.id === id);
    const name = byId('edit-std-name').value.trim();
    const chestCheck = validateManualChestNo(byId('edit-std-chest').value, state.students, id);
    if (!chestCheck.ok) return showToast(chestCheck.error, 'error');
    const chestNo = chestCheck.chestNo;
    const classValue = normalizeClassValue(byId('edit-std-class')?.value || '', state.categoryClassification?.classes);
    const dobValue = byId('edit-std-dob')?.value?.trim() || '';
    const details = buildStudentDetailsPatch(existing?.details, { classValue, dobValue });
    const patch = {
      name,
      chestNo,
      team: byId('edit-std-team').value,
      category: byId('edit-std-cat').value,
      gender: byId('edit-std-gender').value,
      photoData: byId('edit-std-photo-data')?.value.trim() || '',
      showPhotoInResults: byId('edit-std-show-photo')?.checked !== false,
      details,
      updatedAt: Date.now()
    };
    await updateDoc(doc(db, 'students', id), patch);
    const idx = state.students.findIndex((s) => s.id === id);
    if (idx >= 0) state.students[idx] = { ...state.students[idx], ...patch };
    closeModal('edit-student-modal');
    renderStudents();
    syncStudentChestInput();
    renderRegistrations();
    resultsController?.renderAll();
    showToast('Student updated');
  });
  byId('btn-clear-edit-std-photo')?.addEventListener('click', () => {
    if (byId('edit-std-photo-data')) byId('edit-std-photo-data').value = '';
    if (byId('edit-std-photo-file')) byId('edit-std-photo-file').value = '';
    window.refreshImageUploadPreviews?.();
  });
  byId('btn-close-edit-student')?.addEventListener('click', () => closeModal('edit-student-modal'));
  byId('btn-cancel-edit-student')?.addEventListener('click', () => closeModal('edit-student-modal'));

  // Events
  byId('form-event')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = byId('inp-ev-name').value.trim();
    if (!name) return showToast('Event Name is required', 'error');
    const category = byId('inp-ev-cat').value;
    const gender = byId('inp-ev-gender').value;
    const type = byId('inp-ev-type').value;
    const limit = Number(byId('inp-ev-limit').value || 1);
    const groupSize = Number(byId('inp-ev-grpsize').value || 1);
    const stage = byId('inp-ev-stage').value;
    const resultMethod = normalizeResultMethod(byId('inp-ev-method').value, name);
    const maximumMark = Number(byId('inp-ev-maxmark').value || 100);
    const parsedCriteria = parseCriteria(byId('inp-ev-criteria').value);

    if (parsedCriteria.unparsed.length) {
      byId('inp-ev-criteria')?.focus();
      return showToast(`Invalid criteria line "${parsedCriteria.unparsed[0]}". Enter one per line as "Name - Marks" (e.g. Content - 40).`, 'error');
    }

    const candidate = {
      name,
      category,
      gender,
      type,
      entriesPerTeam: limit,
      membersPerEntry: groupSize,
      stage,
      resultMethod,
      maximumMark,
      criteria: parsedCriteria.criteria,
      criteriaUnparsed: parsedCriteria.unparsed
    };
    const validation = validateEvent(candidate, { ...state.festSetup, categories: state.categories }, state.events);
    if (validation.errors.length) return showToast(validation.errors[0], 'error');
    const payload = eventToFirestore(candidate, { setup: state.festSetup, validation });
    const docRef = await addDoc(collection(db, 'events'), payload);
    state.events.push({ id: docRef.id, ...payload });

    invalidateCache('events_all');
    e.target.reset();
    if (byId('inp-ev-limit')) byId('inp-ev-limit').value = '1';
    if (byId('inp-ev-grpsize')) byId('inp-ev-grpsize').value = '1';
    if (byId('inp-ev-maxmark')) byId('inp-ev-maxmark').value = '100';
    populateSelectOptions();
    renderEvents();
    renderSchedule();
    renderRegistrations();
    renderOverview();
    renderResetCounts();
    resultsController?.renderAll();
    showToast(`Created event: ${name}`);
  });

  ['filter-ev-search', 'filter-ev-cat', 'filter-ev-gender', 'filter-ev-stage', 'filter-ev-method'].forEach((id) => {
    const el = byId(id);
    if (!el) return;
    el.addEventListener('input', renderEvents);
    el.addEventListener('change', renderEvents);
  });

  byId('edit-event-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = byId('edit-ev-id').value;
    const existing = state.events.find((ev) => ev.id === id) || {};
    const name = byId('edit-ev-name').value.trim();
    const category = byId('edit-ev-cat').value;
    const gender = byId('edit-ev-gender').value;
    const type = byId('edit-ev-type').value;
    const stage = byId('edit-ev-stage').value;
    const limit = Number(byId('edit-ev-limit').value || 1);
    const groupSize = Number(byId('edit-ev-grpsize').value || 1);
    const resultMethod = normalizeResultMethod(byId('edit-ev-method').value || 'criteria', name);
    const maximumMark = Number(byId('edit-ev-maxmark').value || 100);
    const status = byId('edit-ev-status').value || 'active';
    const parsedCriteria = parseCriteria(byId('edit-ev-criteria').value || '');

    if (parsedCriteria.unparsed.length) {
      byId('edit-ev-criteria')?.focus();
      return showToast(`Invalid criteria line "${parsedCriteria.unparsed[0]}". Enter one per line as "Name - Marks" (e.g. Content - 40).`, 'error');
    }

    const candidate = {
      ...existing,
      id,
      name,
      category,
      gender,
      type,
      entriesPerTeam: limit,
      membersPerEntry: groupSize,
      stage,
      resultMethod,
      maximumMark,
      criteria: parsedCriteria.criteria,
      criteriaUnparsed: parsedCriteria.unparsed,
      status
    };
    const validation = validateEvent(candidate, { ...state.festSetup, categories: state.categories }, state.events);
    if (validation.errors.length) return showToast(validation.errors[0], 'error');

    const patch = {
      name,
      category,
      gender,
      type,
      stage,
      limit,
      groupSize,
      maximumMembers: groupSize,
      resultMethod,
      maximumMark,
      criteria: parsedCriteria.criteria,
      status,
      updatedAt: Date.now()
    };
    await updateDoc(doc(db, 'events', id), patch);
    const idx = state.events.findIndex((ev) => ev.id === id);
    if (idx >= 0) state.events[idx] = { ...state.events[idx], ...patch };
    invalidateCache('events_all');
    closeModal('edit-event-modal');
    renderEvents();
    renderSchedule();
    renderRegistrations();
    renderOverview();
    resultsController?.renderAll();
    showToast('Event updated');
  });
  byId('btn-close-edit-event')?.addEventListener('click', () => closeModal('edit-event-modal'));
  byId('btn-cancel-edit-event')?.addEventListener('click', () => closeModal('edit-event-modal'));

  ['reg-filter-event', 'reg-filter-team'].forEach((id) => byId(id)?.addEventListener('change', renderRegistrations));
  byId('btn-close-admin-reg')?.addEventListener('click', () => closeModal('admin-reg-modal'));

  // Schedule breaks & print
  byId('btn-print-schedule')?.addEventListener('click', () => printPage('schedule'));
  byId('btn-add-break')?.addEventListener('click', async () => {
    const title = byId('brk-title').value.trim();
    const date = byId('brk-date').value;
    const startTime = byId('brk-start').value;
    const endTime = byId('brk-end').value;
    if (!title || !date || !startTime || !endTime) return showToast('Fill break title, date, start, and end times', 'error');
    const payload = { title, date, startTime, endTime, stage: 'All Stages', stages: ['All Stages'], active: true, createdAt: Date.now(), updatedAt: Date.now() };
    const docRef = await addDoc(collection(db, 'scheduleBreaks'), payload);
    state.scheduleBreaks.push({ id: docRef.id, ...payload });
    invalidateCache('schedule_breaks');
    ['brk-title', 'brk-date', 'brk-start', 'brk-end'].forEach((id) => { byId(id).value = ''; });
    renderSchedule();
    showToast('Schedule break added');
  });

  byId('edit-break-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = byId('edit-brk-id').value;
    const patch = {
      title: byId('edit-brk-title').value.trim(),
      date: byId('edit-brk-date').value,
      startTime: byId('edit-brk-start').value,
      endTime: byId('edit-brk-end').value,
      updatedAt: Date.now()
    };
    if (!patch.title || !patch.date || !patch.startTime || !patch.endTime) return showToast('All break fields are required', 'error');
    await updateDoc(doc(db, 'scheduleBreaks', id), patch);
    const item = state.scheduleBreaks.find((b) => b.id === id);
    if (item) Object.assign(item, patch);
    invalidateCache('schedule_breaks');
    closeModal('edit-break-modal');
    renderSchedule();
    showToast('Schedule break updated');
  });
  byId('btn-close-edit-break')?.addEventListener('click', () => closeModal('edit-break-modal'));
  byId('btn-cancel-edit-break')?.addEventListener('click', () => closeModal('edit-break-modal'));

  // Staff access
  byId('access-role')?.addEventListener('change', () => {
    const isLeader = byId('access-role').value === 'teamLeader';
    byId('access-team-wrap')?.classList.toggle('hidden', !isLeader);
    byId('access-gender-wrap')?.classList.toggle('hidden', !isLeader);
  });
  byId('btn-toggle-access-pass')?.addEventListener('click', () => {
    const inp = byId('access-password');
    const btn = byId('btn-toggle-access-pass');
    if (!inp || !btn) return;
    const isPass = inp.type === 'password';
    inp.type = isPass ? 'text' : 'password';
    btn.textContent = isPass ? 'Hide' : 'Show';
  });
  byId('btn-save-access')?.addEventListener('click', saveStaffAccount);
  byId('btn-clear-access')?.addEventListener('click', resetStaffForm);
  byId('btn-cancel-access-edit')?.addEventListener('click', resetStaffForm);
  ['filter-staff-search', 'filter-staff-role'].forEach((id) => {
    const el = byId(id);
    if (!el) return;
    el.addEventListener('input', renderAccessList);
    el.addEventListener('change', renderAccessList);
  });

  // Live TV Config & Broadcast
  const tvLines = (id) => (byId(id)?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const collectTvShow = () => Object.fromEntries(
    TV_SECTION_DEFS.map(([k]) => [k, document.querySelector(`[data-admin-tv-sec="${k}"]`)?.checked !== false])
  );
  byId('admin-tv-mode')?.addEventListener('change', () => {
    if (byId('admin-tv-stat-mode')) byId('admin-tv-stat-mode').textContent = (byId('admin-tv-mode').value || 'dashboard').toUpperCase();
  });
  byId('admin-tv-results-list')?.addEventListener('change', (e) => {
    if (!e.target.matches('[data-admin-tv-result]')) return;
    const rid = e.target.dataset.adminTvResult;
    if (e.target.checked) state.tvSelectedResultIds.add(rid);
    else state.tvSelectedResultIds.delete(rid);
    if (byId('admin-tv-stat-queue')) byId('admin-tv-stat-queue').textContent = String(state.tvSelectedResultIds.size);
  });
  byId('btn-admin-tv-select-all')?.addEventListener('click', () => {
    state.results.filter((r) => !r.status || r.status === 'published').forEach((r) => state.tvSelectedResultIds.add(r.eventId || r.id));
    renderTvPanel();
  });
  byId('btn-admin-tv-clear-all')?.addEventListener('click', () => {
    state.tvSelectedResultIds.clear();
    renderTvPanel();
  });
  byId('btn-admin-save-tv-config')?.addEventListener('click', async () => {
    try {
      const payload = {
        title: byId('admin-tv-title')?.value.trim() || 'FEST LIVE',
        ticker: byId('admin-tv-ticker')?.value.trim() || '',
        announcements: tvLines('admin-tv-announcements'),
        interruptPolicy: byId('admin-tv-interrupt')?.value || 'after-current',
        show: collectTvShow(),
        background: {
          color: byId('admin-tv-bg-color')?.value || '#0B1120',
          imageUrl: byId('admin-tv-bg-image')?.value.trim() || '',
          videoUrl: byId('admin-tv-bg-video')?.value.trim() || '',
          slides: tvLines('admin-tv-slides'),
          videos: tvLines('admin-tv-videos')
        },
        updatedAt: Date.now(),
        updatedByUid: auth.currentUser?.uid || ''
      };
      await setDoc(doc(db, 'settings', 'tv_config'), payload, { merge: true });
      state.tvConfig = payload;
      invalidateCache('tv_config');
      renderTvPanel();
      showToast('TV display settings saved');
    } catch (err) {
      console.error(err);
      showToast('Failed to save TV settings', 'error');
    }
  });
  byId('btn-admin-send-tv-live')?.addEventListener('click', async () => {
    try {
      const payload = {
        mode: byId('admin-tv-mode')?.value || 'dashboard',
        animationStyle: byId('admin-tv-animation')?.value || 'cinematic',
        resultOrder: byId('admin-tv-order')?.value || 'latest',
        interruptPolicy: byId('admin-tv-interrupt')?.value || 'after-current',
        selectedResultIds: [...state.tvSelectedResultIds],
        content: collectTvShow(),
        afterQueue: 'dashboard',
        updatedAt: Date.now(),
        updatedByUid: auth.currentUser?.uid || ''
      };
      await setDoc(doc(db, 'settings', 'tv_control'), payload, { merge: true });
      state.tvControl = payload;
      invalidateCache('tv_control');
      renderTvPanel();
      showToast('Broadcast settings sent live to TV');
    } catch (err) {
      console.error(err);
      showToast('Failed to update live TV control', 'error');
    }
  });

  // Notifications
  byId('btn-send-notif')?.addEventListener('click', async () => {
    const team = byId('notif-team').value || 'All';
    const title = byId('notif-title')?.value.trim() || 'Festival Notice';
    const message = byId('notif-message').value.trim();
    if (!message) return showToast('Enter a notice message', 'error');
    const payload = {
      team,
      title,
      message,
      createdAt: Date.now(),
      createdByUid: auth.currentUser?.uid || ''
    };
    try {
      const docRef = await addDoc(collection(db, 'notifications'), payload);
      state.notifications.unshift({ id: docRef.id, ...payload });
      if (byId('notif-title')) byId('notif-title').value = '';
      byId('notif-message').value = '';
      renderNotices();
      renderResetCounts();
      showToast(`Notice sent to ${team === 'All' ? 'All Teams' : teamName(team)}`);
    } catch (err) {
      console.error(err);
      showToast('Failed to send notice', 'error');
    }
  });
  byId('btn-reset-team')?.addEventListener('click', resetTeamData);

  // Reset scopes & Delegated Actions
  document.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) return switchTab(tabBtn.dataset.tab);

    const subBtn = e.target.closest('[data-subtab-group]');
    if (subBtn && activeSubTabs[subBtn.dataset.subtabGroup]) {
      return setSubTab(subBtn.dataset.subtabGroup, subBtn.dataset.subtab);
    }

    const resetBtn = e.target.closest('[data-reset-scope]');
    if (resetBtn) return safeResetScope(resetBtn.dataset.resetScope);

    const actBtn = e.target.closest('[data-admin-action]');
    if (!actBtn) return;
    const action = actBtn.dataset.adminAction;

    if (action === 'copy-link') {
      const fullUrl = new URL(actBtn.dataset.url, window.location.href).href;
      await navigator.clipboard.writeText(fullUrl);
      return showToast('Portal link copied');
    }
    if (action === 'edit-team') {
      const key = actBtn.dataset.team;
      byId('edit-team-key').value = key;
      byId('edit-team-label').value = state.teamDisplayNames?.[key] || key;
      byId('edit-team-color').value = state.teamColors?.[key] || '#1D4ED8';
      openModal('edit-team-modal');
    }
    if (action === 'remove-team') {
      const key = actBtn.dataset.team;
      const ok = await confirmAction(
        `Remove team "${teamName(key)}" (Key: ${key}) from setup? Existing student or result records referencing this key will not be deleted.`,
        { title: 'Remove Team / House', okLabel: 'Remove Team' }
      );
      if (!ok) return;
      state.teams = state.teams.filter((t) => t !== key);
      delete state.teamDisplayNames[key];
      delete state.teamColors[key];
      await saveGeneral({ teams: state.teams, teamDisplayNames: state.teamDisplayNames, teamColors: state.teamColors }, 'Team removed');
    }
    if (action === 'edit-category') {
      const key = actBtn.dataset.cat;
      byId('edit-cat-key').value = key;
      byId('edit-cat-label').value = state.categoryDisplayNames?.[key] || key;
      openModal('edit-category-modal');
    }
    if (action === 'remove-category') {
      const key = actBtn.dataset.cat;
      const ok = await confirmAction(
        `Remove category "${categoryName(key)}" (Key: ${key}) from setup? Existing events and students using this key remain intact.`,
        { title: 'Remove Category', okLabel: 'Remove Category' }
      );
      if (!ok) return;
      state.categories = state.categories.filter((c) => c !== key);
      delete state.categoryDisplayNames[key];
      await saveGeneral({ categories: state.categories, categoryDisplayNames: state.categoryDisplayNames }, 'Category removed');
    }
    if (action === 'edit-stage') {
      const s = actBtn.dataset.stage;
      byId('edit-stage-old').value = s;
      byId('edit-stage-name').value = s;
      openModal('edit-stage-modal');
    }
    if (action === 'remove-stage') {
      const s = actBtn.dataset.stage;
      const ok = await confirmAction(`Remove stage "${s}" from setup?`, { title: 'Remove Stage', okLabel: 'Remove' });
      if (!ok) return;
      state.stages = state.stages.filter((x) => x !== s);
      await saveGeneral({ stages: state.stages }, 'Stage removed');
    }
    if (action === 'edit-day') {
      const idx = Number(actBtn.dataset.dayIndex);
      const item = state.days[idx];
      if (!item) return;
      byId('edit-day-index').value = String(idx);
      byId('edit-day-date').value = item.date || item || '';
      byId('edit-day-label').value = item.label || item.date || '';
      openModal('edit-day-modal');
    }
    if (action === 'remove-day') {
      const dt = actBtn.dataset.date;
      const ok = await confirmAction(`Remove festival day "${dt}" from setup?`, { title: 'Remove Festival Day', okLabel: 'Remove' });
      if (!ok) return;
      state.days = state.days.filter((d) => (d.date || d) !== dt);
      await saveGeneral({ days: state.days }, 'Day removed');
    }
    if (action === 'edit-student') {
      const s = state.students.find((x) => x.id === actBtn.dataset.id);
      if (!s) return;
      const vis = getStudentFieldVisibility(state.categoryClassification);
      const clsVal = studentClassValue(s);
      const dobVal = studentDobValue(s);
      byId('edit-std-id').value = s.id;
      byId('edit-std-name').value = s.name || '';
      byId('edit-std-chest').value = s.chestNo || '';
      byId('edit-std-team').value = s.team || '';
      byId('edit-std-cat').value = s.category || '';
      byId('edit-std-gender').value = s.gender || 'Boys';
      const editClsEl = byId('edit-std-class');
      if (editClsEl) {
        if (clsVal && ![...editClsEl.options].some((o) => o.value === clsVal)) {
          editClsEl.insertAdjacentHTML('beforeend', `<option value="${h(clsVal)}">${h(clsVal)}</option>`);
        }
        editClsEl.value = clsVal;
      }
      if (byId('edit-std-dob')) byId('edit-std-dob').value = dobVal;
      byId('wrap-edit-std-class')?.classList.toggle('hidden', !(vis.showClass || Boolean(clsVal)));
      byId('wrap-edit-std-dob')?.classList.toggle('hidden', !(vis.showDob || Boolean(dobVal)));
      const editHint = byId('edit-std-cat-auto-hint');
      if (editHint) { editHint.textContent = ''; editHint.classList.add('hidden'); }
      if (byId('edit-std-photo-data')) byId('edit-std-photo-data').value = s.photoData || '';
      if (byId('edit-std-photo-file')) byId('edit-std-photo-file').value = '';
      if (byId('edit-std-show-photo')) byId('edit-std-show-photo').checked = s.showPhotoInResults !== false;
      window.refreshImageUploadPreviews?.();
      openModal('edit-student-modal');
    }
    if (action === 'delete-student') {
      const s = state.students.find((x) => x.id === actBtn.dataset.id);
      if (!s) return;
      const ok = await confirmAction(
        `Permanently delete student "${s.name}" (Chest #${s.chestNo || '—'})?`,
        { title: 'Delete Student', okLabel: 'Delete Student' }
      );
      if (!ok) return;
      await deleteDoc(doc(db, 'students', s.id));
      state.students = state.students.filter((x) => x.id !== s.id);
      renderStudents();
      syncStudentChestInput();
      renderRegistrations();
      renderOverview();
      await resultsController?.syncPublicSummary(state.results);
      showToast('Student deleted');
    }
    if (action === 'edit-event') {
      const ev = state.events.find((x) => x.id === actBtn.dataset.id);
      if (!ev) return;
      byId('edit-ev-id').value = ev.id;
      byId('edit-ev-name').value = ev.name || '';
      byId('edit-ev-cat').value = ev.category || '';
      byId('edit-ev-gender').value = ev.gender || 'Both';
      byId('edit-ev-type').value = ev.type || 'Single';
      byId('edit-ev-stage').value = normalizeStage(ev.stage || 'On-Stage');
      byId('edit-ev-limit').value = ev.limit || 1;
      byId('edit-ev-grpsize').value = ev.groupSize || 1;
      if (byId('edit-ev-method')) byId('edit-ev-method').value = normalizeResultMethod(ev.resultMethod || 'criteria', ev.name);
      if (byId('edit-ev-maxmark')) byId('edit-ev-maxmark').value = ev.maximumMark || 100;
      if (byId('edit-ev-status')) byId('edit-ev-status').value = ev.status === 'validated' ? 'active' : (ev.status || 'active');
      if (byId('edit-ev-criteria')) {
        byId('edit-ev-criteria').value = Array.isArray(ev.criteria) && ev.criteria.length
          ? ev.criteria.map((c) => `${c.name} - ${c.maximumMark}`).join('\n')
          : '';
      }
      openModal('edit-event-modal');
    }
    if (action === 'delete-event') {
      const ev = state.events.find((x) => x.id === actBtn.dataset.id);
      if (!ev) return;
      const ok = await confirmAction(
        `Permanently delete event "${ev.name}" and its linked registrations, judge assignments, and judge scores?`,
        { title: 'Delete Event', okLabel: 'Delete Event' }
      );
      if (!ok) return;
      const batch = writeBatch(db);
      batch.delete(doc(db, 'events', ev.id));
      state.registrations.filter((r) => r.eventId === ev.id).forEach((r) => batch.delete(doc(db, 'registrations', r.id)));
      state.judgeAssignments.filter((a) => a.eventId === ev.id).forEach((a) => batch.delete(doc(db, 'judgeAssignments', a.id)));
      state.judgeScores.filter((s) => s.eventId === ev.id).forEach((s) => batch.delete(doc(db, 'judgeScores', s.id)));
      await batch.commit();
      state.events = state.events.filter((x) => x.id !== ev.id);
      state.registrations = state.registrations.filter((r) => r.eventId !== ev.id);
      state.judgeAssignments = state.judgeAssignments.filter((a) => a.eventId !== ev.id);
      state.judgeScores = state.judgeScores.filter((s) => s.eventId !== ev.id);
      invalidateCache('events_all');
      renderAll();
      showToast('Event deleted');
    }
    if (action === 'open-admin-reg') openAdminRegModal(actBtn.dataset.eventId);
    if (action === 'edit-reg') {
      const reg = state.registrations.find((r) => r.id === actBtn.dataset.id);
      if (reg) openAdminRegModal(reg.eventId, reg.id);
    }
    if (action === 'delete-reg') {
      const reg = state.registrations.find((r) => r.id === actBtn.dataset.id);
      const ok = await confirmAction(
        `Remove registration entry #${reg?.slotIndex || 1} for ${teamName(reg?.team || '')}?`,
        { title: 'Remove Registration Entry', okLabel: 'Remove Entry' }
      );
      if (!ok) return;
      await deleteDoc(doc(db, 'registrations', actBtn.dataset.id));
      state.registrations = state.registrations.filter((r) => r.id !== actBtn.dataset.id);
      renderRegistrations();
      renderOverview();
      showToast('Registration removed');
    }
    if (action === 'reject-req') {
      const req = state.registrationRequests.find((x) => x.id === actBtn.dataset.id);
      const ok = await confirmAction(
        `Reject registration request from "${req?.name || 'Student'}"?`,
        { title: 'Reject Request', okLabel: 'Reject' }
      );
      if (!ok) return;
      await updateDoc(doc(db, 'registrationRequests', actBtn.dataset.id), { status: 'rejected', decisionAt: Date.now(), decisionByUid: auth.currentUser?.uid || '' });
      if (req) req.status = 'rejected';
      renderRegistrations();
      showToast('Request rejected');
    }
    if (action === 'approve-req') {
      const r = state.registrationRequests.find((x) => x.id === actBtn.dataset.id);
      if (!r) return;
      const now = Date.now();
      for (const eid of r.eventIds || []) {
        const ev = state.events.find((x) => x.id === eid);
        const regPayload = {
          eventId: eid,
          eventName: ev?.name || '',
          team: r.team,
          slotIndex: 1,
          studentIds: [r.relatedStudentId],
          participantIds: [],
          registrationSource: 'admin-approved-request',
          createdAt: now,
          createdByUid: auth.currentUser?.uid || '',
          lastUpdatedAt: now
        };
        const docRef = await addDoc(collection(db, 'registrations'), regPayload);
        state.registrations.push({ id: docRef.id, ...regPayload });
      }
      await updateDoc(doc(db, 'registrationRequests', r.id), { status: 'selected', decisionAt: now, decisionByUid: auth.currentUser?.uid || '' });
      r.status = 'selected';
      renderRegistrations();
      renderOverview();
      showToast('Request approved & registered');
    }
    if (action === 'save-schedule-row') {
      const id = actBtn.dataset.id;
      const scheduleDate = document.querySelector(`[data-sched-date="${id}"]`)?.value || '';
      const scheduleStage = document.querySelector(`[data-sched-stage="${id}"]`)?.value || '';
      const time = document.querySelector(`[data-sched-time="${id}"]`)?.value || '';
      const scheduleDuration = Number(document.querySelector(`[data-sched-dur="${id}"]`)?.value || 30);
      const patch = {
        scheduleDate,
        scheduleStage,
        time,
        scheduleDuration,
        scheduleStatus: scheduleDate && time ? 'scheduled' : 'unscheduled',
        updatedAt: Date.now()
      };
      await updateDoc(doc(db, 'events', id), patch);
      const ev = state.events.find((x) => x.id === id);
      if (ev) Object.assign(ev, patch);
      invalidateCache('events_all');
      showToast('Schedule row saved');
    }
    if (action === 'edit-break') {
      const b = state.scheduleBreaks.find((x) => x.id === actBtn.dataset.id);
      if (!b) return;
      byId('edit-brk-id').value = b.id;
      byId('edit-brk-title').value = b.title || '';
      byId('edit-brk-date').value = b.date || '';
      byId('edit-brk-start').value = b.startTime || '';
      byId('edit-brk-end').value = b.endTime || '';
      openModal('edit-break-modal');
    }
    if (action === 'delete-break') {
      const b = state.scheduleBreaks.find((x) => x.id === actBtn.dataset.id);
      const ok = await confirmAction(
        `Remove schedule break "${b?.title || 'this break'}"?`,
        { title: 'Remove Schedule Break', okLabel: 'Remove Break' }
      );
      if (!ok) return;
      await deleteDoc(doc(db, 'scheduleBreaks', actBtn.dataset.id));
      state.scheduleBreaks = state.scheduleBreaks.filter((item) => item.id !== actBtn.dataset.id);
      invalidateCache('schedule_breaks');
      renderSchedule();
      showToast('Break removed');
    }
    if (action === 'edit-access') {
      loadStaffIntoForm(actBtn.dataset.id);
    }
    if (action === 'reset-access-password') {
      const u = state.accessUsers.find((x) => (x.authUid || x.docId || x.id) === actBtn.dataset.id);
      if (!u?.email || String(u.email).endsWith('@fest.local')) {
        return showToast('Password reset email is only available for accounts using a real email address.', 'error');
      }
      const ok = await confirmAction(
        `Send a Firebase password reset email to ${u.email}?`,
        { title: 'Send Password Reset Email', okLabel: 'Send Email', tone: 'primary' }
      );
      if (!ok) return;
      try {
        await sendPasswordResetEmail(auth, u.email);
        showToast(`Password reset email sent to ${u.email}`);
      } catch (err) {
        console.error(err);
        showToast('Failed to send password reset email', 'error');
      }
    }
    if (action === 'toggle-access') {
      const id = actBtn.dataset.id;
      if (auth.currentUser?.uid && id === auth.currentUser.uid) {
        return showToast('Cannot deactivate your own active admin account.', 'error');
      }
      const u = state.accessUsers.find((x) => (x.authUid || x.docId || x.id) === id);
      if (!u) return;
      const next = u.active === false;
      const label = next ? 'Activate' : 'Deactivate';
      const ok = await confirmAction(
        `${label} staff account "${u.displayName || u.username}"?`,
        { title: `${label} Staff Account`, okLabel: label, tone: next ? 'primary' : 'danger' }
      );
      if (!ok) return;
      const patch = { active: next, updatedAt: Date.now() };
      try {
        await updateDoc(doc(db, 'accessUsers', id), patch);
        const username = normalizeUsername(u.username || '');
        const emailKey = u.email ? `email_${normalizeUsername(u.email).replace(/[^a-z0-9_@.-]/g, '_')}` : '';
        if (username) await setDoc(doc(db, 'accessUsernames', username), patch, { merge: true }).catch(() => {});
        if (emailKey) await setDoc(doc(db, 'accessUsernames', emailKey), patch, { merge: true }).catch(() => {});
        if (u.role === 'teamLeader') await setDoc(doc(db, 'teamLeaders', id), patch, { merge: true }).catch(() => {});
        if (u.role === 'judge') await setDoc(doc(db, 'judges', id), patch, { merge: true }).catch(() => {});
        if (['admin', 'superAdmin'].includes(u.role)) {
          await setDoc(doc(db, 'adminUsers', id), patch, { merge: true }).catch(() => {});
          if (username) await setDoc(doc(db, 'adminUsernames', username), patch, { merge: true }).catch(() => {});
        }
        u.active = next;
        renderAccessList();
        resultsController?.renderAll();
        showToast(next ? 'Account activated' : 'Account deactivated');
      } catch (err) {
        console.error(err);
        showToast('Failed to update staff account status', 'error');
      }
    }
    if (action === 'delete-access') {
      const id = actBtn.dataset.id;
      if (auth.currentUser?.uid && id === auth.currentUser.uid) {
        return showToast('Cannot delete your own active admin account.', 'error');
      }
      const u = state.accessUsers.find((x) => (x.authUid || x.docId || x.id) === id);
      if (!u) return;
      const ok = await confirmAction(
        `Delete staff access for "${u.displayName || u.username}" (${u.role})?`,
        { title: 'Delete Staff Account', okLabel: 'Delete Account' }
      );
      if (!ok) return;
      try {
        const username = normalizeUsername(u.username || '');
        const emailKey = u.email ? `email_${normalizeUsername(u.email).replace(/[^a-z0-9_@.-]/g, '_')}` : '';
        await deleteDoc(doc(db, 'accessUsers', id));
        if (username) await deleteDoc(doc(db, 'accessUsernames', username)).catch(() => {});
        if (emailKey) await deleteDoc(doc(db, 'accessUsernames', emailKey)).catch(() => {});
        if (u.role === 'teamLeader') await deleteDoc(doc(db, 'teamLeaders', id)).catch(() => {});
        if (u.role === 'judge') await deleteDoc(doc(db, 'judges', id)).catch(() => {});
        if (['admin', 'superAdmin'].includes(u.role)) {
          await deleteDoc(doc(db, 'adminUsers', id)).catch(() => {});
          if (username) await deleteDoc(doc(db, 'adminUsernames', username)).catch(() => {});
        }
        state.accessUsers = state.accessUsers.filter((x) => (x.authUid || x.docId || x.id) !== id);
        if (byId('access-edit-uid')?.value === id) resetStaffForm();
        renderAccessList();
        renderResetCounts();
        resultsController?.renderAll();
        showToast('Staff account deleted');
      } catch (err) {
        console.error(err);
        showToast('Failed to delete staff account', 'error');
      }
    }
    if (action === 'delete-notice') {
      const id = actBtn.dataset.id;
      const n = state.notifications.find((x) => x.id === id);
      const ok = await confirmAction(
        `Delete notice "${n?.title || 'Festival Notice'}"?`,
        { title: 'Delete Team Notice', okLabel: 'Delete' }
      );
      if (!ok) return;
      try {
        await deleteDoc(doc(db, 'notifications', id));
        state.notifications = state.notifications.filter((x) => x.id !== id);
        renderNotices();
        renderResetCounts();
        showToast('Notice deleted');
      } catch (err) {
        console.error(err);
        showToast('Failed to delete notice', 'error');
      }
    }
  });
}

initAdminAuth({
  onReady: async () => {
    resultsController = createAdminResultsController(() => state, {
      toast: showToast,
      confirm: confirmAction,
      prompt: promptAction,
      setSubTab,
      updateState: (patch) => Object.assign(state, patch)
    });
    excelController = createAdminExcelController(() => state, {
      db,
      toast: showToast,
      confirm: confirmAction,
      onCommitted: async (scope) => {
        populateSelectOptions();
        renderAll();
        if (scope === 'students') {
          await resultsController?.syncPublicSummary(state.results);
        }
      }
    });
    bindEvents();
    await loadAllAdminData();
    byId('app-loader')?.classList.add('hide');
    byId('app-layout')?.classList.remove('hidden');
    byId('app-layout')?.classList.add('flex');
    window.feastportAdminTheme?.syncToggleButton?.();
    window.lucide?.createIcons?.();
  }
});
