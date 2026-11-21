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
let resultsController = null;
let excelController = null;

const teamName = (key) => resolveDisplayName(state.teamDisplayNames, key, key);
const categoryName = (key) => resolveDisplayName(state.categoryDisplayNames, key, key);

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
    type === 'error' ? 'border-red-700 bg-red-700 text-white' : 'border-slate-800 bg-slate-900 text-white'
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
      ? 'rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800'
      : 'rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700';
    if (iconBox) {
      iconBox.className = tone === 'primary'
        ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-blue-700'
        : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-red-200 bg-red-50 text-red-700';
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
    <div class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2"><span>Teams Configured</span><strong class="font-mono-num">${state.teams.length}</strong></div>
    <div class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2"><span>Events without Judges</span><strong class="font-mono-num ${withoutJudge ? 'text-amber-600' : 'text-emerald-700'}">${withoutJudge}</strong></div>
    <div class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2"><span>Unscheduled Events</span><strong class="font-mono-num ${unscheduled ? 'text-amber-600' : 'text-emerald-700'}">${unscheduled}</strong></div>
    <div class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2"><span>Pending Student Requests</span><strong class="font-mono-num">${pendingReqs}</strong></div>
    <div class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2"><span>Submitted Judge Sheets Awaiting Publish</span><strong class="font-mono-num text-blue-700">${submittedCount}</strong></div>
  `;

  const ledger = buildTeamScoreLedger(published, () => '', state.events);
  const scores = {};
  state.teams.forEach((t) => { scores[t] = 0; });
  ledger.forEach((row) => { scores[row.team] = (scores[row.team] || 0) + Number(row.points || 0); });
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  byId('overview-standings').innerHTML = ranked.length ? ranked.map(([team, pts], i) => `
    <div class="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
      <span class="font-semibold text-slate-900">#${i + 1} ${h(state.teamDisplayNames?.[team] || team)}</span>
      <span class="font-mono-num font-bold text-blue-700">${pts} pts</span>
    </div>
  `).join('') : '<p class="text-slate-400">No teams configured yet.</p>';

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
    <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs">
      <a href="${h(url)}" target="_blank" rel="noopener noreferrer" class="font-semibold text-slate-800 hover:text-blue-700">${h(label)}</a>
      <button type="button" data-admin-action="copy-link" data-url="${h(url)}" class="rounded border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-100">Copy</button>
    </div>
  `).join('');
}

function renderSetupLists() {
  byId('created-teams-list').innerHTML = state.teams.length ? state.teams.map((t) => `
    <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs">
      <div class="flex items-center gap-2 min-w-0">
        <span class="h-3.5 w-3.5 shrink-0 rounded-full border border-slate-300" style="background:${h(state.teamColors?.[t] || '#1D4ED8')}"></span>
        <span class="font-bold text-slate-900 truncate">${h(teamName(t))}</span>
        <span class="font-mono-num text-[11px] text-slate-400">Key: ${h(t)}</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" data-admin-action="edit-team" data-team="${h(t)}" class="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50">Edit</button>
        <button type="button" data-admin-action="remove-team" data-team="${h(t)}" class="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100">Remove</button>
      </div>
    </div>
  `).join('') : '<p class="text-xs text-slate-400">No teams added yet.</p>';

  byId('created-categories-list').innerHTML = state.categories.length ? state.categories.map((c) => `
    <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs">
      <div class="flex items-center gap-2 min-w-0">
        <span class="font-bold text-slate-900 truncate">${h(categoryName(c))}</span>
        <span class="font-mono-num text-[11px] text-slate-400">Key: ${h(c)}</span>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button type="button" data-admin-action="edit-category" data-cat="${h(c)}" class="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50">Edit</button>
        <button type="button" data-admin-action="remove-category" data-cat="${h(c)}" class="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100">Remove</button>
      </div>
    </div>
  `).join('') : '<p class="text-xs text-slate-400">No categories added yet.</p>';

  byId('created-stages-days').innerHTML = (state.stages.length || state.days.length) ? `
    ${state.stages.map((s) => `
      <span class="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 font-semibold text-blue-900">
        <span>Stage: ${h(s)}</span>
        <button type="button" data-admin-action="edit-stage" data-stage="${h(s)}" class="text-blue-700 hover:underline">Edit</button>
        <button type="button" data-admin-action="remove-stage" data-stage="${h(s)}" class="text-red-600 hover:text-red-800" aria-label="Remove stage">✕</button>
      </span>
    `).join('')}
    ${state.days.map((d, idx) => `
      <span class="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-900">
        <span>Day: ${h(d.label && d.label !== d.date ? `${d.label} (${d.date})` : (d.date || d))}</span>
        <button type="button" data-admin-action="edit-day" data-day-index="${idx}" class="text-emerald-700 hover:underline">Edit</button>
        <button type="button" data-admin-action="remove-day" data-date="${h(d.date || d)}" class="text-red-600 hover:text-red-800" aria-label="Remove day">✕</button>
      </span>
    `).join('')}
  ` : '<p class="text-xs text-slate-400">No stages or festival days added yet.</p>';
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
    <tr class="hover:bg-slate-50">
      <td class="px-3 py-2.5 font-mono-num font-bold text-slate-900">${h(s.chestNo || '—')}</td>
      <td class="px-3 py-2.5 font-semibold text-slate-900">${h(s.name)}</td>
      <td class="px-3 py-2.5">${h(teamName(s.team))}</td>
      <td class="px-3 py-2.5">${h(categoryName(s.category))}</td>
      <td class="px-3 py-2.5">${h(s.gender || 'Boys')}</td>
      <td class="px-3 py-2.5 text-right space-x-1.5 whitespace-nowrap">
        <button type="button" data-admin-action="edit-student" data-id="${h(s.id)}" class="rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50">Edit</button>
        <button type="button" data-admin-action="delete-student" data-id="${h(s.id)}" class="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100">Delete</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400">No students match this filter.</td></tr>';
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
    <tr class="hover:bg-slate-50">
      <td class="px-3 py-2.5 font-semibold text-slate-900">${h(e.name)}${e.status && e.status !== 'active' ? ` <span class="text-[10px] font-bold uppercase text-amber-700">(${h(e.status)})</span>` : ''}</td>
      <td class="px-3 py-2.5">${h(categoryName(e.category || 'General'))}</td>
      <td class="px-3 py-2.5">${h(e.gender || 'Both')}</td>
      <td class="px-3 py-2.5 font-mono-num">${h(e.type || 'Single')} (${e.limit || 1}×${e.groupSize || 1})</td>
      <td class="px-3 py-2.5">${h(e.stage || 'On-Stage')}</td>
      <td class="px-3 py-2.5 text-right space-x-1.5 whitespace-nowrap">
        <button type="button" data-admin-action="edit-event" data-id="${h(e.id)}" class="rounded border border-slate-200 px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50">Edit</button>
        <button type="button" data-admin-action="delete-event" data-id="${h(e.id)}" class="rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100">Delete</button>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400">No events match this filter.</td></tr>';
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
      <article class="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div class="flex items-start justify-between gap-2">
          <div>
            <h3 class="font-display text-sm font-bold text-slate-900">${h(ev.name)}</h3>
            <p class="text-[11px] text-slate-500">${h(categoryName(ev.category || ''))} • ${h(ev.gender || 'Both')} • ${h(ev.type || 'Single')}</p>
          </div>
          <button type="button" data-admin-action="open-admin-reg" data-event-id="${h(ev.id)}" class="rounded-lg bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 whitespace-nowrap">+ Add Entry</button>
        </div>
        <div class="space-y-1.5 text-xs">
          ${evRegs.length ? evRegs.map((r) => {
            const names = (r.studentIds || []).map((sid) => state.students.find((s) => s.id === sid)?.name || sid);
            return `
              <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5">
                <span class="truncate"><strong>${h(teamName(r.team))}</strong> #${r.slotIndex || 1}: ${h(names.join(', ') || 'Empty')}</span>
                <div class="flex items-center gap-2 shrink-0">
                  <button type="button" data-admin-action="edit-reg" data-id="${h(r.id)}" class="text-blue-700 font-semibold hover:underline">Edit</button>
                  <button type="button" data-admin-action="delete-reg" data-id="${h(r.id)}" class="text-red-600 font-semibold hover:underline">Remove</button>
                </div>
              </div>
            `;
          }).join('') : '<p class="text-slate-400">No teams registered yet.</p>'}
        </div>
      </article>
    `;
  }).join('') : '<p class="col-span-full text-center text-xs text-slate-400">No events found.</p>';

  const pending = state.registrationRequests.filter((r) => r.status === 'pending');
  byId('admin-requests-list').innerHTML = pending.length ? pending.map((r) => {
    const evNames = (r.eventIds || []).map((id) => state.events.find((e) => e.id === id)?.name || id);
    return `
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-2">
        <div class="flex items-center justify-between">
          <strong>${h(r.name)} (${h(teamName(r.team))})</strong>
          <span class="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">PENDING</span>
        </div>
        <p class="text-slate-600">${h(evNames.join(', '))}</p>
        <div class="flex justify-end gap-2">
          <button type="button" data-admin-action="reject-req" data-id="${h(r.id)}" class="rounded border border-red-200 bg-white px-2.5 py-1 font-semibold text-red-700 hover:bg-red-50">Reject</button>
          <button type="button" data-admin-action="approve-req" data-id="${h(r.id)}" class="rounded bg-blue-700 px-2.5 py-1 font-semibold text-white hover:bg-blue-800">Approve</button>
        </div>
      </div>
    `;
  }).join('') : '<p class="text-xs text-slate-400">No pending student self-registration requests.</p>';
}

function renderSchedule() {
  const stageOpts = (selected) => `<option value="">Select Stage</option>` + [...new Set(['Main Stage', ...state.stages])].map((s) => `<option value="${h(s)}" ${selected === s ? 'selected' : ''}>${h(s)}</option>`).join('');
  byId('schedule-builder-body').innerHTML = state.events.filter((e) => !['draft', 'archived'].includes(e.status)).map((e) => `
    <tr data-sched-row="${h(e.id)}" class="hover:bg-slate-50">
      <td class="px-3 py-2 font-semibold text-slate-900">${h(e.name)}<br><span class="text-[11px] font-normal text-slate-500">${h(categoryName(e.category || ''))} • ${h(e.gender || '')}</span></td>
      <td class="px-3 py-2"><input data-sched-date="${h(e.id)}" type="date" value="${h(e.scheduleDate || '')}" class="rounded border border-slate-200 px-2 py-1 text-xs"></td>
      <td class="px-3 py-2"><select data-sched-stage="${h(e.id)}" class="rounded border border-slate-200 bg-white px-2 py-1 text-xs">${stageOpts(e.scheduleStage || e.stage || '')}</select></td>
      <td class="px-3 py-2"><input data-sched-time="${h(e.id)}" type="time" value="${h(e.time || '')}" class="rounded border border-slate-200 px-2 py-1 text-xs"></td>
      <td class="px-3 py-2"><input data-sched-dur="${h(e.id)}" type="number" min="5" max="300" value="${Number(e.scheduleDuration || e.duration || 30)}" class="w-16 rounded border border-slate-200 px-2 py-1 font-mono-num text-xs"></td>
      <td class="px-3 py-2 text-right"><button type="button" data-admin-action="save-schedule-row" data-id="${h(e.id)}" class="rounded bg-blue-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-800">Save</button></td>
    </tr>
  `).join('');

  byId('breaks-list').innerHTML = state.scheduleBreaks.length ? state.scheduleBreaks.map((b) => `
    <div class="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <span><strong>${h(b.title)}</strong> • ${h(b.date)} (${h(b.startTime)} – ${h(b.endTime)})</span>
      <div class="flex items-center gap-2 shrink-0">
        <button type="button" data-admin-action="edit-break" data-id="${h(b.id)}" class="text-blue-700 font-semibold hover:underline">Edit</button>
        <button type="button" data-admin-action="delete-break" data-id="${h(b.id)}" class="text-red-600 font-semibold hover:underline">Remove</button>
      </div>
    </div>
  `).join('') : '<p class="text-slate-400">No schedule breaks configured.</p>';
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
      <div class="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-2">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="truncate font-bold text-slate-900">${h(u.displayName || u.username)}</p>
            <p class="text-[11px] text-slate-600">${h(u.role)} ${u.team ? `• ${h(teamName(u.team))} (${h(u.genderScope || 'Both')})` : ''}</p>
            <p class="truncate text-[11px] text-slate-400">${h(u.email || u.username || '')}</p>
          </div>
          <span class="rounded px-2 py-0.5 text-[10px] font-bold uppercase ${active ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}">${active ? 'Active' : 'Inactive'}</span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button type="button" data-admin-action="edit-access" data-id="${h(docId)}" class="rounded border border-slate-200 bg-white px-2.5 py-1 font-semibold text-blue-700 hover:bg-blue-50">Edit</button>
          <button type="button" data-admin-action="toggle-access" data-id="${h(docId)}" class="rounded border border-slate-200 bg-white px-2.5 py-1 font-semibold text-slate-700 hover:bg-slate-100">${active ? 'Deactivate' : 'Activate'}</button>
          <button type="button" data-admin-action="delete-access" data-id="${h(docId)}" class="rounded border border-red-200 bg-white px-2.5 py-1 font-semibold text-red-700 hover:bg-red-50">Delete</button>
        </div>
      </div>
    `;
  }).join('') : '<p class="text-xs text-slate-400">No staff accounts created yet.</p>';
}

function renderAll() {
  renderOverview();
  renderSetupLists();
  renderStudents();
  renderEvents();
  renderRegistrations();
  renderSchedule();
  renderAccessList();
  resultsController?.renderAll();
  excelController?.renderAllWorkspaces();
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

function resetStaffForm() {
  byId('access-edit-uid').value = '';
  byId('access-uid').value = '';
  byId('access-identifier').disabled = false;
  byId('access-identifier').classList.remove('bg-slate-100', 'text-slate-500');
  byId('access-password').disabled = false;
  byId('access-password').classList.remove('bg-slate-100', 'text-slate-500');
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
  byId('access-identifier').disabled = true;
  byId('access-identifier').classList.add('bg-slate-100', 'text-slate-500');
  byId('access-password').value = '';
  byId('access-password').disabled = true;
  byId('access-password').classList.add('bg-slate-100', 'text-slate-500');
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
    <label class="block text-xs font-semibold text-slate-700">Team
      <select id="admin-reg-team" ${isEditing ? 'disabled' : ''} class="mt-1 w-full rounded-lg border border-slate-200 ${isEditing ? 'bg-slate-100 text-slate-600' : 'bg-white'} px-3 py-2 text-xs">
        ${state.teams.map((t) => `<option value="${h(t)}">${h(teamName(t))}</option>`).join('')}
      </select>
    </label>
    <div id="admin-reg-students" class="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2 text-xs"></div>
    <div class="flex justify-end gap-2">
      <button id="btn-cancel-admin-reg" type="button" class="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
      <button id="btn-save-admin-reg" type="button" class="rounded-lg bg-blue-700 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-800">${isEditing ? 'Update Entry' : 'Save Entry'}</button>
    </div>
  `;

  if (existingReg?.team) byId('admin-reg-team').value = existingReg.team;
  const preselectedIds = new Set(existingReg?.studentIds || []);

  const renderChecklist = () => {
    const team = byId('admin-reg-team').value;
    const list = state.students.filter((s) => s.team === team && (!ev.category || ev.category === 'All' || ev.category === 'General' || s.category === ev.category) && (!ev.gender || ev.gender === 'Both' || s.gender === ev.gender));
    byId('admin-reg-students').innerHTML = list.length ? list.map((s) => `
      <label class="flex items-center justify-between rounded px-2 py-1.5 hover:bg-slate-50 cursor-pointer">
        <span class="flex items-center gap-2"><input type="checkbox" name="admin-reg-pick" value="${h(s.id)}" ${preselectedIds.has(s.id) ? 'checked' : ''}><strong>${h(s.name)}</strong></span>
        <span class="font-mono-num text-slate-500">${h(s.chestNo || '')}</span>
      </label>
    `).join('') : '<p class="p-3 text-center text-slate-400">No eligible students in this team.</p>';
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
    invalidateCache('general');
    populateSelectOptions();
    renderAll();
    showToast(msg);
  };

  byId('btn-add-team')?.addEventListener('click', async () => {
    const key = byId('inp-new-team').value.trim();
    const label = byId('inp-new-team-label').value.trim() || key;
    const color = byId('inp-new-team-color').value || '#1D4ED8';
    if (!key) return showToast('Enter a Team Key', 'error');
    if (state.teams.some((t) => t.toLowerCase() === key.toLowerCase())) {
      return showToast('Team Key already exists. Use Edit to change its Display Name.', 'error');
    }
    state.teams.push(key);
    state.teamColors[key] = color;
    state.teamDisplayNames[key] = label;
    byId('inp-new-team').value = '';
    byId('inp-new-team-label').value = '';
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
    const key = byId('inp-new-category').value.trim();
    const label = byId('inp-new-category-label')?.value.trim() || key;
    if (!key) return showToast('Enter a Category Key', 'error');
    if (state.categories.some((c) => c.toLowerCase() === key.toLowerCase())) {
      return showToast('Category Key already exists. Use Edit to change its Display Name.', 'error');
    }
    state.categories.push(key);
    state.categoryDisplayNames[key] = label;
    byId('inp-new-category').value = '';
    if (byId('inp-new-category-label')) byId('inp-new-category-label').value = '';
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

  byId('btn-save-scoring')?.addEventListener('click', async () => {
    const next = normalizeScoringRules(state.scoringRules);
    next.configs.Single.points[0].value = Number(byId('pts-single-1').value || 0);
    next.configs.Single.points[1].value = Number(byId('pts-single-2').value || 0);
    next.configs.Single.points[2].value = Number(byId('pts-single-3').value || 0);
    next.configs.Group.points[0].value = Number(byId('pts-group-1').value || 0);
    next.configs.Group.points[1].value = Number(byId('pts-group-2').value || 0);
    next.configs.Group.points[2].value = Number(byId('pts-group-3').value || 0);
    next.enabled.grades = byId('score-enable-grades').checked;
    next.policies.multipleJudgeMethod = byId('policy-multi-judge').value;
    await setDoc(doc(db, 'settings', 'scoring_rules'), { ...next, updatedAt: Date.now() }, { merge: false });
    state.scoringRules = next;
    invalidateCache('scoring_rules');
    showToast('Scoring rules saved');
  });

  // Students
  byId('btn-gen-chest')?.addEventListener('click', () => {
    const nums = state.students.map((s) => Number(String(s.chestNo || '').replace(/\D/g, ''))).filter(Number.isFinite);
    byId('inp-std-chest').value = String((nums.length ? Math.max(...nums) : 100) + 1);
  });

  byId('form-student')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = byId('inp-std-name').value.trim();
    const chestNo = byId('inp-std-chest').value.trim();
    const team = byId('inp-std-team').value;
    const category = byId('inp-std-cat').value;
    const gender = byId('inp-std-gender').value;
    const photoData = byId('inp-std-photo-data').value.trim();

    if (state.students.some((s) => String(s.chestNo || '').toLowerCase() === chestNo.toLowerCase())) {
      return showToast('Duplicate chest number', 'error');
    }
    const payload = { name, chestNo, team, category, gender, photoData, updatedAt: Date.now() };
    const docRef = await addDoc(collection(db, 'students'), payload);
    state.students.push({ id: docRef.id, ...payload });
    e.target.reset();
    byId('inp-std-photo-data').value = '';
    window.refreshImageUploadPreviews?.();
    renderStudents();
    renderOverview();
    await resultsController?.syncPublicSummary(state.results);
    showToast(`Added student: ${name}`);
  });

  ['filter-std-search', 'filter-std-team', 'filter-std-cat'].forEach((id) => byId(id)?.addEventListener('input', renderStudents));

  byId('edit-student-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = byId('edit-std-id').value;
    const name = byId('edit-std-name').value.trim();
    const chestNo = byId('edit-std-chest').value.trim();
    if (state.students.some((s) => s.id !== id && String(s.chestNo || '').toLowerCase() === chestNo.toLowerCase())) {
      return showToast('Duplicate chest number', 'error');
    }
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
    window.lucide?.createIcons?.();
  }
});
