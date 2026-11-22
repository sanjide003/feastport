import { app, auth, db } from './firebase-config.js';
import { initAdminAuth } from './admin-auth.js';
import { cachedGetDoc, invalidateCache } from './data-cache.js';
import { initImageUploads, assertPayloadSize, normalizeGallerySlots } from './image-upload.js';
import { normalizeBranding, brandingName, applyBase64Image, clearBrandingCache } from './branding-config.js';
import { normalizeFestSetup } from './fest-config.js';
import { parseCriteria, validateEvent, eventToFirestore } from './event-utils.js';
import { normalizeRegistrationConfig } from './registration-utils.js';
import { defaultScoringRules, normalizeScoringRules, buildTeamScoreLedger } from './score-utils.js';
import { escapeHtml, printPage, resolveDisplayName } from './admin-utils.js';
import {
  defaultChestConfig,
  normalizeChestConfig,
  chestSeriesKey,
  parseChestSeed,
  resolveNextAutoChestNo,
  validateManualChestNo
} from './admin-students.js';
import { createAdminResultsController } from './admin-results.js';
import { createAdminExcelController } from './admin-excel.js';
import { initCollapsibleSidebar } from './sidebar-shell.js';
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth as getSecondaryAuth, createUserWithEmailAndPassword, signOut as signOutSecondary } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
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
  results: []
};

let activeTab = 'overview';
const activeSubTabs = {
  setup: 'identity',
  registrations: 'entries',
  results: 'assign',
  system: 'staff'
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
    resultsSnap
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
    getDocs(collection(db, 'results'))
  ]);

  state.homeConfig = homeDoc || {};
  state.generalConfig = genDoc || {};
  state.festSetup = normalizeFestSetup(state.generalConfig.festSetup || {});
  state.registrationConfig = normalizeRegistrationConfig(regCfgDoc || {});
  state.scheduleConfig = schedCfgDoc || {};
  state.scoringRules = normalizeScoringRules(scoringDoc || {});
  state.chestNumberConfig = normalizeChestConfig(state.generalConfig.chestNumberConfig || {});
  state.chestDraftConfig = normalizeChestConfig(state.chestNumberConfig);
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

  applyAdminBranding();
  populateSelectOptions();
  hydrateSetupForms();
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

  renderChestNumberSetup();
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

  const filtered = state.students.filter((s) => {
    if (team && s.team !== team) return false;
    if (cat && s.category !== cat) return false;
    if (search && !`${s.name || ''} ${s.chestNo || ''}`.toLowerCase().includes(search)) return false;
    return true;
  }).sort((a, b) => String(a.chestNo || '').localeCompare(String(b.chestNo || ''), undefined, { numeric: true }));

  byId('std-count-label').textContent = `${filtered.length} students`;
  byId('students-tbody').innerHTML = filtered.length ? filtered.map((s) => `
    <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/60">
      <td class="px-3 py-2.5 font-mono-num font-bold text-slate-900 dark:text-slate-100">${h(s.chestNo || '—')}</td>
      <td class="px-3 py-2.5 font-semibold text-slate-900 dark:text-slate-100">${h(s.name)}</td>
      <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">${h(teamName(s.team))}</td>
      <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">${h(categoryName(s.category))}</td>
      <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">${h(s.gender || 'Boys')}</td>
      <td class="px-3 py-2.5 text-right space-x-1.5 whitespace-nowrap">
        <button type="button" data-admin-action="edit-student" data-id="${h(s.id)}" class="rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-900 dark:text-blue-400 dark:hover:bg-slate-800">Edit</button>
        <button type="button" data-admin-action="delete-student" data-id="${h(s.id)}" class="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/70 dark:bg-red-950/50 dark:text-red-400 dark:hover:bg-red-950/80">Delete</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400 dark:text-slate-500">No students match this filter.</td></tr>';
}

function renderEvents() {
  const search = (byId('filter-ev-search')?.value || '').trim().toLowerCase();
  const cat = byId('filter-ev-cat')?.value || '';
  const gender = byId('filter-ev-gender')?.value || '';

  const filtered = state.events.filter((e) => {
    if (cat && e.category !== cat) return false;
    if (gender && e.gender !== gender) return false;
    if (search && !`${e.name || ''} ${e.code || ''}`.toLowerCase().includes(search)) return false;
    return true;
  }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  byId('ev-count-label').textContent = `${filtered.length} events`;
  byId('events-tbody').innerHTML = filtered.length ? filtered.map((e) => `
    <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/60">
      <td class="px-3 py-2.5 font-semibold text-slate-900 dark:text-slate-100">${h(e.name)}${e.status && e.status !== 'active' ? ` <span class="text-[10px] font-bold uppercase text-amber-700 dark:text-amber-400">(${h(e.status)})</span>` : ''}</td>
      <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">${h(categoryName(e.category || 'General'))}</td>
      <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">${h(e.gender || 'Both')}</td>
      <td class="px-3 py-2.5 font-mono-num text-slate-700 dark:text-slate-300">${h(e.type || 'Single')} (${e.limit || 1}×${e.groupSize || 1})</td>
      <td class="px-3 py-2.5 text-slate-700 dark:text-slate-300">${h(e.stage || 'On-Stage')}</td>
      <td class="px-3 py-2.5 text-right space-x-1.5 whitespace-nowrap">
        <button type="button" data-admin-action="edit-event" data-id="${h(e.id)}" class="rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-900 dark:text-blue-400 dark:hover:bg-slate-800">Edit</button>
        <button type="button" data-admin-action="delete-event" data-id="${h(e.id)}" class="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 dark:border-red-900/70 dark:bg-red-950/50 dark:text-red-400 dark:hover:bg-red-950/80">Delete</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400 dark:text-slate-500">No events match this filter.</td></tr>';
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
  const map = new Map();
  state.accessUsers.forEach((u) => {
    const key = `${u.role}:${u.email || u.username || u.id}`;
    if (!map.has(key) || u.authUid) map.set(key, u);
  });
  const list = [...map.values()].sort((a, b) => (a.role || '').localeCompare(b.role || ''));
  byId('access-list').innerHTML = list.length ? list.map((u) => {
    const docId = u.authUid || u.docId || u.id;
    const active = u.active !== false;
    return `
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-2 dark:border-slate-800 dark:bg-slate-800/60">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="truncate font-bold text-slate-900 dark:text-slate-100">${h(u.displayName || u.username)}</p>
            <p class="text-[11px] text-slate-600 dark:text-slate-300">${h(u.role)} ${u.team ? `• ${h(teamName(u.team))} (${h(u.genderScope || 'Both')})` : ''}</p>
            <p class="truncate text-[11px] text-slate-400 dark:text-slate-400">${h(u.email || u.username || '')}</p>
          </div>
          <span class="rounded px-2 py-0.5 text-[10px] font-bold uppercase ${active ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-950/70 dark:text-red-300'}">${active ? 'Active' : 'Inactive'}</span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button type="button" data-admin-action="edit-access" data-id="${h(docId)}" class="rounded border border-slate-200 bg-white px-2.5 py-1 font-semibold text-blue-700 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-900 dark:text-blue-400 dark:hover:bg-slate-800">Edit</button>
          <button type="button" data-admin-action="toggle-access" data-id="${h(docId)}" class="rounded border border-slate-200 bg-white px-2.5 py-1 font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">${active ? 'Deactivate' : 'Activate'}</button>
          <button type="button" data-admin-action="delete-access" data-id="${h(docId)}" class="rounded border border-red-200 bg-white px-2.5 py-1 font-semibold text-red-700 hover:bg-red-50 dark:border-red-900/70 dark:bg-slate-900 dark:text-red-400 dark:hover:bg-red-950/60">Delete</button>
        </div>
      </div>
    `;
  }).join('') : '<p class="text-xs text-slate-400 dark:text-slate-500">No staff accounts created yet.</p>';
}

function renderAll() {
  renderOverview();
  renderSetupLists();
  renderStudents();
  syncStudentChestInput();
  renderEvents();
  renderRegistrations();
  renderSchedule();
  renderAccessList();
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
    system: 'Staff Access, TV & Maintenance'
  };
  byId('admin-page-title').textContent = titles[tab] || 'Admin Console';
  sidebarShell?.closeMobile?.();
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
    const username = existing.username || normalizeUsername(displayName);
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
    await setDoc(doc(db, 'accessUsers', editUid), patch, { merge: true });
    if (username) await setDoc(doc(db, 'accessUsernames', username), { ...patch, accessDocId: editUid }, { merge: true }).catch(() => {});
    if (emailKey) await setDoc(doc(db, 'accessUsernames', emailKey), { ...patch, accessDocId: editUid }, { merge: true }).catch(() => {});

    if (prevRole !== role) {
      if (prevRole === 'teamLeader') await deleteDoc(doc(db, 'teamLeaders', editUid)).catch(() => {});
      if (prevRole === 'judge') await deleteDoc(doc(db, 'judges', editUid)).catch(() => {});
      if (['admin', 'superAdmin'].includes(prevRole)) await deleteDoc(doc(db, 'adminUsers', editUid)).catch(() => {});
    }
    if (role === 'teamLeader') {
      await setDoc(doc(db, 'teamLeaders', editUid), { uid: editUid, authUid: editUid, username, displayName, phone, team, genderScope: genderScope || 'Both', title: patch.title, active, updatedAt: now }, { merge: true });
    } else if (role === 'judge') {
      await setDoc(doc(db, 'judges', editUid), { uid: editUid, authUid: editUid, username, name: displayName, phone, active, updatedAt: now }, { merge: true });
    } else if (['admin', 'superAdmin'].includes(role)) {
      await setDoc(doc(db, 'adminUsers', editUid), { username, email, displayName, role, active, updatedAt: now }, { merge: true });
    }

    Object.assign(existing, patch);
    resetStaffForm();
    renderAccessList();
    resultsController?.renderAll();
    showToast(`Updated staff account: ${displayName}`);
    return;
  }

  if (!identifier) return showToast('Username or email is required', 'error');
  if (password.length < 6) return showToast('Password must be at least 6 characters', 'error');

  const email = identifier.includes('@') ? identifier.toLowerCase() : `${normalizeUsername(identifier)}@fest.local`;
  const username = identifier.includes('@') ? normalizeUsername(identifier.split('@')[0]) : normalizeUsername(identifier);
  const emailKey = `email_${normalizeUsername(email).replace(/[^a-z0-9_@.-]/g, '_')}`;

  try {
    const authUid = await createAccessAuthUser(email, password);
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
      updatedAt: Date.now()
    };
    await setDoc(doc(db, 'accessUsers', authUid), profile, { merge: true });
    await setDoc(doc(db, 'accessUsernames', username), { ...profile, accessDocId: authUid }, { merge: true });
    await setDoc(doc(db, 'accessUsernames', emailKey), { ...profile, accessDocId: authUid }, { merge: true });

    if (role === 'teamLeader') {
      await setDoc(doc(db, 'teamLeaders', authUid), { uid: authUid, authUid, username, displayName, phone, team, genderScope: genderScope || 'Both', title: profile.title, active, updatedAt: Date.now() }, { merge: true });
    } else if (role === 'judge') {
      await setDoc(doc(db, 'judges', authUid), { uid: authUid, authUid, username, name: displayName, phone, active, updatedAt: Date.now() }, { merge: true });
    } else if (['admin', 'superAdmin'].includes(role)) {
      await setDoc(doc(db, 'adminUsers', authUid), { username, email, displayName, role, active, updatedAt: Date.now() }, { merge: true });
    }

    state.accessUsers.push({ id: authUid, docId: authUid, ...profile });
    resetStaffForm();
    renderAccessList();
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

async function safeResetScope(scopeName) {
  const scopes = {
    registrations: ['registrations', 'registrationRequests', 'registrationApplications'],
    results: ['results', 'resultRevisions', 'teamScoreLedgers', 'judgeScores', 'publicJudgingStatuses'],
    students: ['students'],
    events: ['events', 'judgeAssignments']
  };
  const cols = scopes[scopeName];
  if (!cols) return;
  if (!await confirmAction(`Archive and permanently clear ${cols.join(', ')}?`, { title: 'Confirm System Reset', okLabel: 'Archive & Clear' })) return;

  for (const colName of cols) {
    const snap = await getDocs(collection(db, colName));
    if (snap.empty) continue;
    await addDoc(collection(db, 'deletedBackups'), {
      collection: colName,
      scope: scopeName,
      count: snap.size,
      createdAt: Date.now(),
      uid: auth.currentUser?.uid || '',
      items: snap.docs.slice(0, 100).map((d) => ({ id: d.id, ...d.data() }))
    });
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await loadAllAdminData(true);
  await resultsController?.syncPublicSummary(state.results);
  showToast(`Cleared ${scopeName} cleanly (backup archived)`);
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
  ['inp-std-team', 'inp-std-cat', 'inp-std-gender'].forEach((id) => {
    byId(id)?.addEventListener('change', syncStudentChestInput);
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

    const payload = { name, chestNo, team, category, gender, photoData, updatedAt: Date.now() };
    const docRef = await addDoc(collection(db, 'students'), payload);
    state.students.push({ id: docRef.id, ...payload });
    if (state.chestNumberConfig?.enabled) {
      byId('inp-std-name').value = '';
      if (byId('inp-std-photo-file')) byId('inp-std-photo-file').value = '';
    } else {
      e.target.reset();
    }
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
    const name = byId('edit-std-name').value.trim();
    const chestCheck = validateManualChestNo(byId('edit-std-chest').value, state.students, id);
    if (!chestCheck.ok) return showToast(chestCheck.error, 'error');
    const chestNo = chestCheck.chestNo;
    const patch = {
      name,
      chestNo,
      team: byId('edit-std-team').value,
      category: byId('edit-std-cat').value,
      gender: byId('edit-std-gender').value,
      photoData: byId('edit-std-photo-data')?.value.trim() || '',
      showPhotoInResults: byId('edit-std-show-photo')?.checked !== false,
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
    const names = byId('inp-ev-names').value.split('\n').map((s) => s.trim()).filter(Boolean);
    const category = byId('inp-ev-cat').value;
    const gender = byId('inp-ev-gender').value;
    const type = byId('inp-ev-type').value;
    const limit = Number(byId('inp-ev-limit').value || 1);
    const groupSize = Number(byId('inp-ev-grpsize').value || 1);
    const stage = byId('inp-ev-stage').value;
    const resultMethod = byId('inp-ev-method').value;
    const maximumMark = Number(byId('inp-ev-maxmark').value || 100);
    const parsedCriteria = parseCriteria(byId('inp-ev-criteria').value);

    for (const name of names) {
      const candidate = {
        name, category, gender, type, entriesPerTeam: limit, membersPerEntry: groupSize,
        stage, resultMethod, maximumMark, criteria: parsedCriteria.criteria
      };
      const validation = validateEvent(candidate, { ...state.festSetup, categories: state.categories }, state.events);
      if (validation.errors.length) return showToast(`${name}: ${validation.errors[0]}`, 'error');
      const payload = eventToFirestore(candidate, { setup: state.festSetup, validation });
      const docRef = await addDoc(collection(db, 'events'), payload);
      state.events.push({ id: docRef.id, ...payload });
    }
    invalidateCache('events_all');
    e.target.reset();
    populateSelectOptions();
    renderEvents();
    renderSchedule();
    renderRegistrations();
    renderOverview();
    resultsController?.renderAll();
    showToast(`Created ${names.length} event(s)`);
  });

  ['filter-ev-search', 'filter-ev-cat', 'filter-ev-gender'].forEach((id) => byId(id)?.addEventListener('input', renderEvents));

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
    const resultMethod = byId('edit-ev-method').value || 'criteria';
    const maximumMark = Number(byId('edit-ev-maxmark').value || 100);
    const status = byId('edit-ev-status').value || 'active';
    const parsedCriteria = parseCriteria(byId('edit-ev-criteria').value || '');

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
  byId('btn-save-access')?.addEventListener('click', saveStaffAccount);
  byId('btn-clear-access')?.addEventListener('click', resetStaffForm);
  byId('btn-cancel-access-edit')?.addEventListener('click', resetStaffForm);

  // Notifications
  byId('btn-send-notif')?.addEventListener('click', async () => {
    const team = byId('notif-team').value || 'All';
    const message = byId('notif-message').value.trim();
    if (!message) return showToast('Enter a notice message', 'error');
    await addDoc(collection(db, 'notifications'), { team, title: 'Festival Notice', message, createdAt: Date.now(), createdByUid: auth.currentUser?.uid || '' });
    byId('notif-message').value = '';
    showToast(`Notice sent to ${team === 'All' ? 'All Teams' : teamName(team)}`);
  });

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
      byId('edit-std-id').value = s.id;
      byId('edit-std-name').value = s.name || '';
      byId('edit-std-chest').value = s.chestNo || '';
      byId('edit-std-team').value = s.team || '';
      byId('edit-std-cat').value = s.category || '';
      byId('edit-std-gender').value = s.gender || 'Boys';
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
      byId('edit-ev-stage').value = ev.stage || 'On-Stage';
      byId('edit-ev-limit').value = ev.limit || 1;
      byId('edit-ev-grpsize').value = ev.groupSize || 1;
      if (byId('edit-ev-method')) byId('edit-ev-method').value = ev.resultMethod || 'criteria';
      if (byId('edit-ev-maxmark')) byId('edit-ev-maxmark').value = ev.maximumMark || 100;
      if (byId('edit-ev-status')) byId('edit-ev-status').value = ev.status || 'active';
      if (byId('edit-ev-criteria')) {
        byId('edit-ev-criteria').value = Array.isArray(ev.criteria) && ev.criteria.length
          ? ev.criteria.map((c) => `${c.name} - ${c.maximumMark}`).join('; ')
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
    if (action === 'toggle-access') {
      const u = state.accessUsers.find((x) => (x.authUid || x.docId || x.id) === actBtn.dataset.id);
      if (!u) return;
      const next = u.active === false;
      const label = next ? 'Activate' : 'Deactivate';
      const ok = await confirmAction(
        `${label} staff account "${u.displayName || u.username}"?`,
        { title: `${label} Staff Account`, okLabel: label, tone: next ? 'primary' : 'danger' }
      );
      if (!ok) return;
      const patch = { active: next, updatedAt: Date.now() };
      await updateDoc(doc(db, 'accessUsers', actBtn.dataset.id), patch);
      if (u.role === 'teamLeader') await setDoc(doc(db, 'teamLeaders', actBtn.dataset.id), patch, { merge: true });
      if (u.role === 'judge') await setDoc(doc(db, 'judges', actBtn.dataset.id), patch, { merge: true });
      if (['admin', 'superAdmin'].includes(u.role)) await setDoc(doc(db, 'adminUsers', actBtn.dataset.id), patch, { merge: true });
      u.active = next;
      renderAccessList();
      resultsController?.renderAll();
      showToast(next ? 'Account activated' : 'Account deactivated');
    }
    if (action === 'delete-access') {
      const u = state.accessUsers.find((x) => (x.authUid || x.docId || x.id) === actBtn.dataset.id);
      if (!u) return;
      const ok = await confirmAction(
        `Delete staff access for "${u.displayName || u.username}" (${u.role})?`,
        { title: 'Delete Staff Account', okLabel: 'Delete Account' }
      );
      if (!ok) return;
      const id = actBtn.dataset.id;
      await deleteDoc(doc(db, 'accessUsers', id));
      if (u.username) await deleteDoc(doc(db, 'accessUsernames', u.username)).catch(() => {});
      if (u.role === 'teamLeader') await deleteDoc(doc(db, 'teamLeaders', id)).catch(() => {});
      if (u.role === 'judge') await deleteDoc(doc(db, 'judges', id)).catch(() => {});
      if (['admin', 'superAdmin'].includes(u.role)) await deleteDoc(doc(db, 'adminUsers', id)).catch(() => {});
      state.accessUsers = state.accessUsers.filter((x) => (x.authUid || x.docId || x.id) !== id);
      if (byId('access-edit-uid')?.value === id) resetStaffForm();
      renderAccessList();
      resultsController?.renderAll();
      showToast('Staff account deleted');
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
