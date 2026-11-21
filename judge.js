import { db, auth } from './firebase-config.js';
import { escapeHtml } from './admin-utils.js';
import { studentGender } from './admin-students.js';
import { eventGender } from './admin-events.js';
import { createScoringSnapshot, normalizeScoringRules, scoringConfigForEvent, scoringEnabled as scoringFlags } from './score-utils.js';
import { judgingEnabled, normalizeFestSetup, incompleteCompetitionPolicies } from './fest-config.js';
import { normalizeBranding, brandingName, cacheBranding, clearBrandingCache, applyBase64Image } from './branding-config.js';
import { cachedGetDoc } from './data-cache.js';
import { initCollapsibleSidebar } from './sidebar-shell.js';
import { collection, onSnapshot, doc, getDoc, query, where, documentId, runTransaction } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';

await window.ensureAdminDependencies?.(['tailwind', 'lucide']);
const sidebarShell = initCollapsibleSidebar();

let assignments = [];
let scores = [];
let events = [];
let registrations = [];
let students = [];
let scoringRules = normalizeScoringRules();
let teamDisplayNames = {};
let categoryDisplayNames = {};
let currentJudge = null;
let activeJudgeTab = 'dashboard';
let activeAssignmentId = '';
let pendingSubmitId = '';
const judgeListFilters = {
  assignments: { search: '', category: '', gender: '', type: '' },
  drafts: { search: '', category: '', gender: '', type: '' },
  submitted: { search: '', category: '', gender: '', type: '' }
};
let dirty = false;
let saving = false;
let judgeAuthRedirecting = false;
let listenersStarted = false;
let openedParticipantSignature = '';
let openedScoreVersion = 0;
let scopeUnsubscribers = [];
let studentUnsubscribers = [];
let lastFocusedElement = null;

const loadState = { assignments: 'loading', scores: 'loading', events: 'loading', registrations: 'loading', students: 'loading' };
const requiredSources = Object.keys(loadState);
const html = escapeHtml;
const teamLabel = (value) => teamDisplayNames?.[value] || value || '';
const categoryLabel = (value) => categoryDisplayNames?.[value] || value || 'General';
const safeId = (value) => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '-');
const unique = (values) => [...new Set(values.filter(Boolean))];
const chunks = (values, size = 30) => {
  const result = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
};
const scoreFor = (id) => scores.find((score) => score.assignmentId === id);
const statusFor = (assignment) => scoreFor(assignment.id)?.status || 'pending';
const eventFor = (assignment) => events.find((event) => event.id === assignment.eventId) || { id: assignment.eventId, name: assignment.eventName, type: 'Single', gender: assignment.gender || 'Both' };
const timestamp = (value) => (value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', hour12: true }) : '—');
const displayDate = (value) => {
  if (!value) return 'Date TBD';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString([], { dateStyle: 'medium' });
};
const displayTime = (value) => {
  const text = String(value || '').trim();
  if (!text) return 'Time TBD';
  const match = text.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match) return text;
  let hour = Number(match[1]);
  if (match[3]) return `${hour}:${match[2]} ${match[3].toUpperCase()}`;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${match[2]} ${suffix}`;
};

function toast(message, error = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('bg-red-700', error);
  el.classList.toggle('bg-slate-900', !error);
  el.style.opacity = '1';
  setTimeout(() => (el.style.opacity = '0'), 3000);
}

function showPageState(message, error = false) {
  const el = document.getElementById('judge-page-state');
  if (!el) return;
  el.className = `mb-4 rounded-xl border p-4 text-xs font-semibold ${error ? 'border-red-200 bg-red-50 text-red-700' : 'border-blue-200 bg-blue-50 text-blue-800'}`;
  el.textContent = message;
  el.classList.remove('hidden');
}

function updatePageState() {
  const failed = requiredSources.filter((key) => loadState[key] === 'error');
  const loading = requiredSources.filter((key) => loadState[key] === 'loading');
  if (failed.length) return showPageState(`Unable to load required judge data: ${failed.join(', ')}.`, true);
  if (loading.length) return showPageState(`Loading judge workspace: ${loading.join(', ')}…`);
  document.getElementById('judge-page-state')?.classList.add('hidden');
}

const dataReady = () => requiredSources.every((key) => loadState[key] === 'ready');

async function redirectToLogin(message = 'Please sign in as a judge to continue.', includeNext = true) {
  if (judgeAuthRedirecting) return;
  judgeAuthRedirecting = true;
  sessionStorage.removeItem('judge_user');
  sessionStorage.removeItem('judge_access_uid');
  sessionStorage.setItem('admin_login_message', message);
  await signOut(auth).catch(() => {});
  location.replace(includeNext ? `login.html?next=${encodeURIComponent('judge.html')}` : 'login.html');
}

async function logoutJudge() {
  if (!canLeaveWorkspace()) return;
  await redirectToLogin('Judge signed out.', false);
}

function toggleMenu(open) {
  if (open) sidebarShell.openMobile();
  else sidebarShell.closeMobile();
}

function assignmentDate(assignment) {
  const date = assignment.date || '9999-12-31';
  const match = String(assignment.time || '').trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match) return new Date(`${date}T23:59`).getTime();
  let hour = Number(match[1]);
  if (match[3]) {
    hour %= 12;
    if (match[3].toUpperCase() === 'PM') hour += 12;
  }
  return new Date(`${date}T${String(hour).padStart(2, '0')}:${match[2]}`).getTime();
}

function isReopened(assignment) {
  const score = scoreFor(assignment.id);
  return statusFor(assignment) === 'draft' && Number(score?.reopenedAt || 0) >= Number(score?.submittedAt || 0);
}

const currentJudgeIds = () => unique([currentJudge?.id, currentJudge?.uid, currentJudge?.authUid, currentJudge?.accessDocId, currentJudge?.sourceAccessDocId]);

function mine() {
  const ids = currentJudgeIds();
  return currentJudge
    ? assignments
        .filter((a) => a.active !== false && ids.includes(a.judgeId))
        .sort((a, b) => Number(isReopened(b)) - Number(isReopened(a)) || assignmentDate(a) - assignmentDate(b) || String(a.eventName || '').localeCompare(String(b.eventName || '')))
    : [];
}

function badge(status) {
  return status === 'submitted'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : status === 'draft'
    ? 'border-amber-200 bg-amber-50 text-amber-700'
    : 'border-slate-200 bg-slate-50 text-slate-600';
}

function empty(message) {
  return `<div class="col-span-full rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">${html(message)}</div>`;
}

function participantData(event) {
  const regs = registrations.filter((reg) => reg.eventId === event.id);
  const seen = new Set();
  const duplicates = [];
  const rows =
    event.type === 'Group'
      ? regs
          .sort((a, b) => `${a.team}-${a.slotIndex}`.localeCompare(`${b.team}-${b.slotIndex}`, undefined, { numeric: true }))
          .map((reg, index) => ({
            id: reg.id || `${reg.team}-${reg.slotIndex || index + 1}`,
            label: `${teamLabel(reg.team) || 'Team'} · Entry #${reg.slotIndex || index + 1}`,
            sub: `${(reg.studentIds || []).length} members`,
            chestText: (reg.studentIds || []).map((id) => students.find((s) => s.id === id)?.chestNo || '-').join(', ') || '-',
            memberIds: unique(reg.studentIds || [])
          }))
      : regs
          .flatMap((reg) =>
            (reg.studentIds || [])
              .map((id) => {
                const student = students.find((item) => item.id === id);
                return student
                  ? {
                      id,
                      label: `Chest #${student.chestNo || '-'}`,
                      sub: `${teamLabel(student.team)} · ${categoryLabel(student.category)} · ${studentGender(student)}`,
                      chestText: student.chestNo || '-',
                      memberIds: [id]
                    }
                  : null;
              })
              .filter(Boolean)
          )
          .sort((a, b) => String(a.chestText).localeCompare(String(b.chestText), undefined, { numeric: true }));

  rows.forEach((row) => {
    if (seen.has(row.id)) duplicates.push(row.id);
    seen.add(row.id);
  });
  return { rows: rows.filter((row, index, array) => array.findIndex((item) => item.id === row.id) === index), duplicates: unique(duplicates) };
}

const participantSignature = (assignment) =>
  participantData(eventFor(assignment))
    .rows.map((person) => `${person.id}:${[...(person.memberIds || [])].sort().join(',')}`)
    .sort()
    .join('|');

function progressFor(assignment) {
  const score = scoreFor(assignment.id);
  const total = participantData(eventFor(assignment)).rows.length;
  const scored = (score?.marks || []).filter((mark) => (mark.evaluation && mark.evaluation !== 'pending') || mark.position || mark.grade).length;
  return { scored, total };
}

function publishLabel(status) {
  return ({ published: 'Published', ready: 'Ready', unpublished: 'Not published', archived: 'Archived' })[status] || 'Not published';
}

function statusLabel(assignment) {
  return isReopened(assignment) ? 'Reopened' : statusFor(assignment) === 'submitted' ? 'Submitted' : statusFor(assignment) === 'draft' ? 'Draft' : 'Pending';
}

function participantSummary(assignment) {
  const event = eventFor(assignment);
  const regs = registrations.filter((reg) => reg.eventId === event.id);
  let total = 0;
  if (event.type === 'Group') total = regs.length;
  else regs.forEach((reg) => (total += unique(reg.studentIds || []).length));
  return `${event.type === 'Group' ? 'Entries' : 'Participants'}: ${total}`;
}

function assignmentCard(assignment, mode = 'assignments') {
  const score = scoreFor(assignment.id);
  const status = statusFor(assignment);
  const progress = progressFor(assignment);
  const reopened = isReopened(assignment);
  const details =
    mode === 'drafts'
      ? `${progress.scored}/${progress.total} reviewed · Saved ${timestamp(score?.updatedAt)}`
      : mode === 'submitted'
      ? `Submitted ${timestamp(score?.submittedAt)} · ${publishLabel(score?.publishStatus)}`
      : `${displayDate(assignment.date)} · ${displayTime(assignment.time)}`;

  return `<article class="flex items-center justify-between gap-4 rounded-xl border ${reopened ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200 bg-white'} p-4">
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <h3 class="truncate font-display text-base font-bold text-slate-900">${html(assignment.eventName || eventFor(assignment).name)}</h3>
        <span class="shrink-0 rounded border px-2 py-0.5 text-[11px] font-semibold ${badge(status)}">${html(statusLabel(assignment))}</span>
      </div>
      <p class="mt-1 truncate text-xs text-slate-500">${html(details)} · ${html(participantSummary(assignment))}</p>
    </div>
    <button data-judge-action="open-assignment" data-assignment-id="${html(assignment.id)}" class="shrink-0 rounded-lg bg-blue-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 whitespace-nowrap">${status === 'submitted' ? 'View' : 'Score'}</button>
  </article>`;
}

function canLeaveWorkspace() {
  return !dirty || window.confirm('You have unsaved score changes. Leave without saving?');
}

function setTab(tab) {
  if (activeJudgeTab === 'workspace' && !canLeaveWorkspace()) return;
  activeJudgeTab = tab;
  activeAssignmentId = '';
  dirty = false;
  toggleMenu(false);
  render();
}

function renderTabs() {
  document.querySelectorAll('[data-judge-tab]').forEach((button) => button.classList.toggle('active', button.dataset.judgeTab === activeJudgeTab));
  const panels = { assignments: 'assigned-events', drafts: 'judge-drafts', submitted: 'judge-submitted', workspace: 'judge-workspace' };
  Object.entries(panels).forEach(([tab, id]) => document.getElementById(id)?.classList.toggle('hidden', tab !== activeJudgeTab));
  document.getElementById('judge-summary')?.classList.toggle('hidden', activeJudgeTab !== 'dashboard');
}

function renderDashboard(list) {
  const pending = list.filter((a) => statusFor(a) === 'pending').length;
  const drafts = list.filter((a) => statusFor(a) === 'draft').length;
  const submitted = list.filter((a) => statusFor(a) === 'submitted').length;
  document.getElementById('judge-summary').innerHTML = [
    ['Assigned Events', list.length, 'text-slate-900'],
    ['Pending', pending, 'text-amber-700'],
    ['Drafts', drafts, 'text-blue-700'],
    ['Submitted', submitted, 'text-emerald-700']
  ]
    .map(
      ([label, value, cls]) =>
        `<div class="rounded-xl border border-slate-200 bg-white p-5"><p class="text-xs font-semibold uppercase tracking-wider text-slate-500">${label}</p><h3 class="mt-2 font-mono-num text-3xl font-bold ${cls}">${value}</h3></div>`
    )
    .join('');
}

const assignmentFilterMeta = (assignment) => {
  const event = eventFor(assignment);
  const category = event.category || assignment.category || 'General';
  return {
    category,
    gender: eventGender(event) || assignment.gender || 'Both',
    type: event.type || assignment.type || 'Single',
    text: [assignment.eventName, event.name, category, categoryLabel(category), event.stage, eventGender(event), event.type].join(' ').toLowerCase()
  };
};

const filterOptions = (rows, key) => [...new Set(rows.map((item) => assignmentFilterMeta(item)[key]).filter(Boolean))].sort();
const judgeFilterSelect = (tab, key, label, values, current, format = (v) => v) =>
  `<select data-judge-filter data-tab="${tab}" data-filter="${key}" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700"><option value="">All ${label}</option>${values
    .map((value) => `<option value="${html(value)}" ${current === value ? 'selected' : ''}>${html(format(value))}</option>`)
    .join('')}</select>`;

function renderList(tab, list) {
  const id = tab === 'assignments' ? 'assigned-events' : tab === 'drafts' ? 'judge-drafts' : 'judge-submitted';
  const box = document.getElementById(id);
  const base =
    tab === 'drafts'
      ? list.filter((a) => statusFor(a) === 'draft')
      : tab === 'submitted'
      ? list.filter((a) => statusFor(a) === 'submitted')
      : [...list].sort((a, b) => assignmentDate(a) - assignmentDate(b));
  const filters = judgeListFilters[tab] || judgeListFilters.assignments;
  const search = String(filters.search || '').trim().toLowerCase();
  const filtered = base.filter((item) => {
    const meta = assignmentFilterMeta(item);
    return (!search || meta.text.includes(search)) && (!filters.category || meta.category === filters.category) && (!filters.gender || meta.gender === filters.gender) && (!filters.type || meta.type === filters.type);
  });

  box.innerHTML = `<section class="rounded-xl border border-slate-200 bg-white p-3">
    <div class="grid gap-2 md:grid-cols-4">
      <input data-judge-filter data-tab="${tab}" data-filter="search" value="${html(filters.search || '')}" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800" placeholder="Search event, category…">
      ${judgeFilterSelect(tab, 'category', 'Categories', filterOptions(base, 'category'), filters.category, categoryLabel)}
      ${judgeFilterSelect(tab, 'gender', 'Genders', filterOptions(base, 'gender'), filters.gender)}
      ${judgeFilterSelect(tab, 'type', 'Types', filterOptions(base, 'type'), filters.type)}
    </div>
  </section>
  <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
    ${filtered.length ? filtered.map((item) => assignmentCard(item, tab)).join('') : empty(tab === 'assignments' ? 'No events assigned yet.' : tab === 'drafts' ? 'No draft score sheets.' : 'No submitted score sheets yet.')}
  </div>`;
}

function methodInputs(event, old, locked) {
  const field = (key, label, value = 0, attrs = '') =>
    `<label class="text-xs font-semibold text-slate-600">${label}<input data-method-field="${key}" type="number" step="0.01" value="${Number(old.methodData?.[key] ?? value)}" ${attrs} class="method-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm font-bold text-slate-900" ${locked ? 'disabled' : ''}></label>`;

  if (event.resultMethod === 'criteria') {
    return `<div class="col-span-2 mt-2 grid gap-2 sm:grid-cols-2">${(event.criteria || [])
      .map(
        (criterion) =>
          `<label class="text-xs font-semibold text-slate-600">${html(criterion.name)} <span class="text-slate-400">(/ ${Number(criterion.maximumMark || 0)})</span><input data-criterion-key="${html(criterion.key)}" data-criterion-max="${Number(criterion.maximumMark || 0)}" type="number" min="0" max="${Number(criterion.maximumMark || 0)}" step="0.01" value="${Number(old.criteriaMarks?.[criterion.key] || 0)}" class="criterion-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono-num text-sm font-bold text-slate-900" ${locked ? 'disabled' : ''}></label>`
      )
      .join('')}</div>`;
  }
  if (event.resultMethod === 'objective') return `<div class="col-span-2 mt-2 grid grid-cols-3 gap-2">${field('correct', 'Correct', 0, 'min="0"')}${field('wrong', 'Wrong', 0, 'min="0"')}${field('unanswered', 'Blank', 0, 'min="0"')}</div>`;
  if (event.resultMethod === 'time') return `<div class="col-span-2 mt-2 grid grid-cols-2 gap-2">${field('timeSeconds', 'Time (sec)', 0, 'min="0"')}${field('penaltySeconds', 'Penalty (sec)', 0, 'min="0"')}</div>`;
  if (event.resultMethod === 'count') return `<div class="col-span-2 mt-2 grid grid-cols-3 gap-2">${field('correctCount', 'Correct', 0, 'min="0"')}${field('wrongCount', 'Wrong', 0, 'min="0"')}${field('completionTime', 'Time (sec)', 0, 'min="0"')}</div>`;
  if (event.resultMethod === 'elimination') return `<div class="col-span-2 mt-2">${field('eliminationOrder', 'Elimination Rank (1 = winner)', 0, 'min="1"')}</div>`;
  return '';
}

function scoreRows(assignment) {
  const event = eventFor(assignment);
  const existing = scoreFor(assignment.id);
  const marks = existing?.marks || [];
  const data = participantData(event);
  const rule = scoringConfigForEvent(scoringRules, event);
  const enabled = scoringFlags(scoringRules);
  const locked = existing?.status === 'submitted';

  if (data.duplicates.length) {
    return `<div class="col-span-full rounded-xl border border-red-200 bg-red-50 p-4 text-xs font-semibold text-red-700">Duplicate participant registrations were detected. Ask an administrator to correct them before scoring.</div>`;
  }

  return data.rows.length
    ? data.rows
        .map((person, index) => {
          const old = marks.find((mark) => mark.participantId === person.id) || {};
          const evaluation = old.evaluation || (old.position || old.grade ? 'awarded' : 'pending');
          const positions = [
            '<option value="" data-value="0">No Position</option>',
            ...(enabled.points ? (rule.points || []).map((position) => `<option value="${html(position.label)}" data-value="${Number(position.value || 0)}" ${old.position === position.label ? 'selected' : ''}>${html(position.label)} (${Number(position.value || 0)} pts)</option>`) : [])
          ].join('');
          const grades = [
            '<option value="" data-value="0">No Grade</option>',
            ...(enabled.grades ? (rule.grades || []).map((grade) => `<option value="${html(grade.label)}" data-value="${Number(grade.value || 0)}" ${old.grade === grade.label ? 'selected' : ''}>${html(grade.label)} (${Number(grade.value || 0)} pts)</option>`) : [])
          ].join('');
          const criteriaInputs = methodInputs(event, old, locked);

          return `<div data-score-row data-result-method="${html(event.resultMethod || 'manual')}" data-correct-mark="${Number(event.objectiveRule?.correctMark ?? 1)}" data-wrong-penalty="${Number(event.objectiveRule?.wrongPenalty ?? 0)}" data-count-penalty="${Number(event.countRule?.wrongPenalty ?? 0)}" class="rounded-xl border border-slate-200 bg-white p-4">
            <div class="mb-3 flex items-center justify-between border-b border-slate-100 pb-2.5">
              <div>
                <p class="font-display text-base font-bold text-slate-900">#${index + 1} · ${html(person.label)}</p>
                <p class="text-xs text-slate-500">${html(person.sub)}</p>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <label class="text-xs font-semibold text-slate-600">Status<select data-participant-id="${html(person.id)}" class="evaluation-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-800" ${locked ? 'disabled' : ''}>
                <option value="pending" ${evaluation === 'pending' ? 'selected' : ''}>Not Reviewed</option>
                <option value="awarded" ${evaluation === 'awarded' ? 'selected' : ''}>Awarded</option>
                <option value="no-award" ${evaluation === 'no-award' ? 'selected' : ''}>No Award</option>
                <option value="absent" ${evaluation === 'absent' ? 'selected' : ''}>Absent</option>
                <option value="disqualified" ${evaluation === 'disqualified' ? 'selected' : ''}>Disqualified</option>
              </select></label>
              <label class="text-xs font-semibold text-slate-600">Position<select data-participant-id="${html(person.id)}" class="position-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-800" ${locked || !enabled.points ? 'disabled' : ''}>${positions}</select></label>
              <label class="text-xs font-semibold text-slate-600">Grade<select data-participant-id="${html(person.id)}" class="grade-input mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-800" ${locked || !enabled.grades ? 'disabled' : ''}>${grades}</select></label>
              <label class="text-xs font-semibold text-slate-600">Total Score<input data-participant-id="${html(person.id)}" data-label="${html(person.label)}" type="number" min="0" max="${Number(event.maximumMark || 100)}" step="0.01" class="score-total mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-center font-mono-num text-sm font-bold text-blue-700" value="${Number(old.rawMark ?? old.mark ?? ((old.positionValue || 0) + (old.gradeValue || 0)))}" ${locked ? 'disabled' : ''}></label>
              ${criteriaInputs}
            </div>
            <textarea data-participant-id="${html(person.id)}" rows="2" class="notes-input mt-3 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs" placeholder="Adjudicator remarks (optional)" ${locked ? 'disabled' : ''}>${html(old.notes || '')}</textarea>
          </div>`;
        })
        .join('')
    : empty('No registered participants found for this event.');
}

function renderWorkspace() {
  const assignment = mine().find((a) => a.id === activeAssignmentId);
  if (!assignment) {
    activeJudgeTab = 'assignments';
    render();
    return;
  }
  const event = eventFor(assignment);
  const score = scoreFor(assignment.id);
  const locked = score?.status === 'submitted';
  const reason = score?.reopenReason || score?.reopenedReason || '';
  openedParticipantSignature = participantSignature(assignment);
  openedScoreVersion = Math.max(Number(score?.updatedAt || 0), Number(score?.reopenedAt || 0));

  document.getElementById('judge-workspace').innerHTML = `<article id="assignment-${safeId(assignment.id)}" class="space-y-4">
    ${isReopened(assignment) ? `<div class="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs font-semibold text-amber-800"><b>Admin correction note:</b> ${html(reason || 'Review and update this score sheet.')}</div>` : ''}
    <div class="sticky top-20 z-20 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <h2 class="truncate font-display text-lg font-bold text-slate-900">${html(assignment.eventName)}</h2>
          <p class="text-xs text-slate-500">${html(categoryLabel(event.category || assignment.category))} · ${html(displayDate(assignment.date))} · ${html(displayTime(assignment.time))} · ${html(assignment.stage || 'Stage TBD')} · ${html(eventGender(event))} · ${html(participantSummary(assignment))}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2 shrink-0">
          <span id="judge-save-state" class="text-xs text-slate-400 mr-1">${score?.updatedAt ? `Saved ${timestamp(score.updatedAt)}` : 'Not saved'}</span>
          ${locked ? '<span class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">Submitted &amp; Locked</span>' : `<button data-judge-action="save-scores" data-assignment-id="${html(assignment.id)}" class="judge-save-button rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Save Draft</button><button data-judge-action="review-submit" data-assignment-id="${html(assignment.id)}" class="judge-submit-button rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-700">Review &amp; Submit</button>`}
        </div>
      </div>
    </div>
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2">${scoreRows(assignment)}</div>
  </article>`;
  dirty = false;
}

function render() {
  if (!currentJudge) return;
  renderTabs();
  updatePageState();
  if (!dataReady()) {
    window.lucide?.createIcons?.();
    return;
  }
  const list = mine();
  if (activeJudgeTab === 'dashboard') renderDashboard(list);
  else if (['assignments', 'drafts', 'submitted'].includes(activeJudgeTab)) renderList(activeJudgeTab, list);
  else if (activeJudgeTab === 'workspace' && !dirty) renderWorkspace();
  window.lucide?.createIcons?.();
}

function updateTotals(root) {
  root?.querySelectorAll('[data-score-row]').forEach((row) => {
    const position = row.querySelector('.position-input');
    const grade = row.querySelector('.grade-input');
    const evaluation = row.querySelector('.evaluation-input');
    const total = row.querySelector('.score-total');
    const criteria = [...row.querySelectorAll('.criterion-input')];
    const method = Object.fromEntries([...row.querySelectorAll('[data-method-field]')].map((input) => [input.dataset.methodField, Number(input.value || 0)]));
    const kind = row.dataset.resultMethod;
    const hasAward = !!(position?.value || grade?.value || criteria.some((input) => Number(input.value) > 0) || Object.values(method).some(Number));
    if (hasAward && evaluation?.value === 'pending') evaluation.value = 'awarded';
    if (total && criteria.length) total.value = criteria.reduce((sum, input) => sum + Number(input.value || 0), 0);
    else if (total && kind === 'objective') total.value = Number(method.correct || 0) * Number(row.dataset.correctMark || 1) - Number(method.wrong || 0) * Number(row.dataset.wrongPenalty || 0);
    else if (total && kind === 'time') total.value = Number(method.timeSeconds || 0) + Number(method.penaltySeconds || 0);
    else if (total && kind === 'count') total.value = Number(method.correctCount || 0) - Number(method.wrongCount || 0) * Number(row.dataset.countPenalty || 0);
    else if (total && kind === 'elimination') total.value = Number(method.eliminationOrder || 0);
    else if (total && (position?.value || grade?.value)) total.value = Number(position?.selectedOptions[0]?.dataset.value || 0) + Number(grade?.selectedOptions[0]?.dataset.value || 0);
  });
}

function collectMarks(id) {
  const root = document.getElementById(`assignment-${safeId(id)}`);
  updateTotals(root);
  return Array.from(root?.querySelectorAll('[data-score-row]') || []).map((row) => {
    const input = row.querySelector('.score-total');
    const participantId = input.dataset.participantId;
    const position = row.querySelector('.position-input');
    const grade = row.querySelector('.grade-input');
    const evaluation = row.querySelector('.evaluation-input');
    const notes = row.querySelector('.notes-input');
    const rawMark = Number(input.value || 0);
    const criteriaMarks = Object.fromEntries([...row.querySelectorAll('.criterion-input')].map((field) => [field.dataset.criterionKey, Number(field.value || 0)]));
    const methodData = Object.fromEntries([...row.querySelectorAll('[data-method-field]')].map((field) => [field.dataset.methodField, Number(field.value || 0)]));
    return {
      participantId,
      label: input.dataset.label,
      evaluation: evaluation?.value || 'pending',
      mark: rawMark,
      rawMark,
      criteriaMarks,
      methodData,
      notes: notes?.value || '',
      position: position?.value || '',
      positionValue: Number(position?.selectedOptions[0]?.dataset.value || 0),
      grade: grade?.value || '',
      gradeValue: Number(grade?.selectedOptions[0]?.dataset.value || 0)
    };
  });
}

function validateMarks(assignment, marks) {
  const event = eventFor(assignment);
  const participantInfo = participantData(event);
  if (participantInfo.duplicates.length) return 'Duplicate participant registrations must be corrected before scoring.';
  if (!marks.length) return 'No registered entries to score.';
  const unreviewed = marks.filter((mark) => !mark.evaluation || mark.evaluation === 'pending');
  if (unreviewed.length) return `Review every entry before submitting (${unreviewed.length} remaining).`;
  const maximum = Number(event.maximumMark || 100);
  const bounded = !['time', 'elimination', 'objective'].includes(event.resultMethod);
  const invalidRaw = marks.filter((mark) => mark.evaluation === 'awarded' && bounded && (mark.rawMark < 0 || mark.rawMark > maximum));
  if (invalidRaw.length) return `Raw marks must be between 0 and ${maximum}.`;
  if (event.resultMethod === 'criteria') {
    const invalidCriterion = marks.find((mark) => mark.evaluation === 'awarded' && (event.criteria || []).some((criterion) => Number(mark.criteriaMarks?.[criterion.key]) < 0 || Number(mark.criteriaMarks?.[criterion.key]) > Number(criterion.maximumMark)));
    if (invalidCriterion) return 'A criterion mark is outside its allowed range.';
  }
  const invalidAwards = marks.filter((mark) => mark.evaluation === 'awarded' && !mark.position && !mark.grade && mark.rawMark === 0);
  if (invalidAwards.length) return 'Every Awarded entry must have a mark, position, or grade.';
  const nonAwardedWithPoints = marks.filter((mark) => mark.evaluation !== 'awarded' && (mark.position || mark.grade || mark.rawMark));
  if (nonAwardedWithPoints.length) return 'Only Awarded entries can have marks, a position, or a grade.';
  const rule = scoringConfigForEvent(scoringRules, event);
  const duplicates = [...new Set(marks.map((m) => m.position).filter(Boolean).filter((value, index, array) => array.indexOf(value) !== index))];
  const invalid = duplicates.filter((label) => !(rule.points || []).some((point) => point.label === label && ['full', 'shared'].includes(point.tiePolicy || scoringRules.tiePolicyDefault)));
  if (invalid.length) return `Duplicate positions are not allowed: ${invalid.join(', ')}.`;
  return '';
}

function setSavingState(active, label = 'Saving…') {
  saving = active;
  document.querySelectorAll('.judge-save-button,.judge-submit-button').forEach((button) => {
    button.disabled = active;
    button.classList.toggle('opacity-60', active);
  });
  const state = document.getElementById('judge-save-state');
  if (active && state) state.textContent = label;
}

async function persistScores(id, status) {
  if (saving || !dataReady()) return false;
  const assignment = mine().find((a) => a.id === id);
  const event = assignment && eventFor(assignment);
  const existing = scoreFor(id);
  if (!assignment || existing?.status === 'submitted') {
    toast('Submitted sheet is locked', true);
    return false;
  }
  const marks = collectMarks(id);
  if (status === 'submitted') {
    const error = validateMarks(assignment, marks);
    if (error) {
      showSubmitError(error);
      toast(error, true);
      return false;
    }
  }
  if (participantSignature(assignment) !== openedParticipantSignature) {
    toast('Participants changed after this sheet was opened. Reopen the assignment before saving.', true);
    return false;
  }
  setSavingState(true, status === 'submitted' ? 'Submitting…' : 'Saving…');
  try {
    const now = Date.now();
    const scoreRef = doc(db, 'judgeScores', id);
    await runTransaction(db, async (transaction) => {
      const latest = await transaction.get(scoreRef);
      const latestData = latest.data() || {};
      const latestVersion = Math.max(Number(latestData.updatedAt || 0), Number(latestData.reopenedAt || 0));
      if (latest.exists() && latestData.status === 'submitted') throw new Error('SHEET_LOCKED');
      if (latestVersion > openedScoreVersion) throw new Error('STALE_SCORE');
      transaction.set(
        scoreRef,
        {
          assignmentId: id,
          judgeId: currentJudge.id,
          judgeName: currentJudge.name,
          eventId: assignment.eventId,
          eventName: assignment.eventName,
          marks,
          status,
          participantSignature: openedParticipantSignature,
          scoringSnapshot: createScoringSnapshot(scoringRules, event),
          publishStatus: existing?.publishStatus || 'unpublished',
          updatedAt: now,
          ...(status === 'submitted' ? { submittedAt: now } : {})
        },
        { merge: true }
      );
      if (status === 'submitted') {
        transaction.set(doc(db, 'publicJudgingStatuses', id), { assignmentId: id, eventId: assignment.eventId, status: 'submitted', submittedAt: now });
      }
    });
    openedScoreVersion = now;
    dirty = false;
    toast(status === 'submitted' ? 'Score sheet submitted and locked' : 'Draft saved');
    if (status === 'submitted') {
      activeJudgeTab = 'submitted';
      closeSubmit();
    }
    render();
    return true;
  } catch (error) {
    console.error('Unable to save judge score', error);
    const message =
      error.message === 'STALE_SCORE'
        ? 'This score sheet changed elsewhere. Reopen it before saving.'
        : error.message === 'SHEET_LOCKED'
        ? 'This score sheet has already been submitted and locked.'
        : error?.code === 'permission-denied'
        ? 'Save permission was denied.'
        : `Unable to save${error?.code ? ` (${error.code})` : ''}. Please try again.`;
    showSubmitError(message);
    toast(message, true);
    return false;
  } finally {
    setSavingState(false);
  }
}

function showSubmitError(message = '') {
  const el = document.getElementById('judge-submit-error');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

function reviewSubmit(id) {
  const assignment = mine().find((a) => a.id === id);
  const marks = collectMarks(id);
  const error = validateMarks(assignment, marks);
  if (error) return toast(error, true);
  pendingSubmitId = id;
  showSubmitError('');
  document.getElementById('judge-submit-summary').innerHTML = `<div class="flex justify-between"><b>Total entries</b><span>${marks.length}</span></div><div class="flex justify-between"><b>Awarded</b><span>${marks.filter((m) => m.evaluation === 'awarded').length}</span></div><div class="flex justify-between"><b>No Award / Absent / DQ</b><span>${marks.filter((m) => m.evaluation !== 'awarded').length}</span></div>`;
  openModal('judge-submit-modal');
}

function openModal(id) {
  lastFocusedElement = document.activeElement;
  const modal = document.getElementById(id);
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  lastFocusedElement?.focus?.();
  lastFocusedElement = null;
}

function closeSubmit() {
  if (saving) return;
  closeModal('judge-submit-modal');
  pendingSubmitId = '';
  showSubmitError('');
}

function openAssignment(id) {
  if (!dataReady()) return toast('Judge data is still loading. Please wait.', true);
  if (activeJudgeTab === 'workspace' && !canLeaveWorkspace()) return;
  activeAssignmentId = id;
  activeJudgeTab = 'workspace';
  render();
}

function openJudgeProfile() {
  if (!currentJudge) return;
  document.getElementById('judge-profile-name').textContent = currentJudge.name || 'Judge';
  document.getElementById('judge-profile-id').textContent = currentJudge.username || '—';
  document.getElementById('judge-profile-phone').textContent = currentJudge.phone || '—';
  const photo = document.getElementById('judge-profile-photo');
  if (photo) {
    if (currentJudge.photoUrl) {
      photo.onload = () => photo.classList.remove('opacity-0');
      photo.src = currentJudge.photoUrl;
    } else {
      photo.classList.add('opacity-0');
    }
  }
  toggleMenu(false);
  openModal('judge-profile-modal');
  window.lucide?.createIcons?.();
}

function closeJudgeProfile() {
  closeModal('judge-profile-modal');
}

async function confirmSubmission() {
  if (!pendingSubmitId || saving) return;
  await persistScores(pendingSubmitId, 'submitted');
}

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-judge-action]');
  if (action) {
    event.preventDefault();
    const type = action.dataset.judgeAction;
    const id = action.dataset.assignmentId;
    if (type === 'logout') logoutJudge();
    if (type === 'toggle-menu') toggleMenu(true);
    if (type === 'open-profile') openJudgeProfile();
    if (type === 'close-profile') closeJudgeProfile();
    if (type === 'open-assignment') openAssignment(id);
    if (type === 'save-scores') persistScores(id, 'draft');
    if (type === 'review-submit') reviewSubmit(id);
    if (type === 'cancel-submit') closeSubmit();
    if (type === 'confirm-submit') confirmSubmission();
  }
  const tab = event.target.closest('[data-judge-tab]');
  if (tab) setTab(tab.dataset.judgeTab);
});

document.addEventListener('input', (event) => {
  const filter = event.target.closest('[data-judge-filter]');
  if (filter) {
    judgeListFilters[filter.dataset.tab][filter.dataset.filter] = filter.value;
    render();
    return;
  }
  if (event.target.closest('#judge-workspace input,#judge-workspace select,#judge-workspace textarea')) {
    dirty = true;
    const state = document.getElementById('judge-save-state');
    if (state) {
      state.textContent = 'Unsaved changes';
      state.className = 'text-xs font-semibold text-amber-600 mr-1';
    }
    updateTotals(document.getElementById('judge-workspace'));
  }
});

document.addEventListener('change', (event) => {
  const filter = event.target.closest('[data-judge-filter]');
  if (filter) {
    judgeListFilters[filter.dataset.tab][filter.dataset.filter] = filter.value;
    render();
  }
});

document.getElementById('judge-overlay')?.addEventListener('click', () => toggleMenu(false));
window.addEventListener('beforeunload', (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});

async function loadJudgeProfile(user) {
  const accessSnap = await getDoc(doc(db, 'accessUsers', user.uid));
  if (!accessSnap.exists()) return null;
  const access = accessSnap.data();
  if (access.active !== true || access.role !== 'judge' || (access.authUid && access.authUid !== user.uid)) return null;
  return { ...access, id: user.uid, uid: user.uid, authUid: user.uid, name: access.displayName || access.name || 'Judge' };
}

function listenRequired(name, source, apply) {
  loadState[name] = 'loading';
  updatePageState();
  return onSnapshot(
    source,
    (snapshot) => {
      apply(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
      loadState[name] = 'ready';
      updatePageState();
      render();
    },
    (error) => {
      console.error(`Unable to load ${name}`, error);
      loadState[name] = 'error';
      updatePageState();
      render();
    }
  );
}

function clearListeners(list) {
  list.splice(0).forEach((unsubscribe) => unsubscribe());
}

function bindChunked(name, queryList, targetUnsubscribers, apply) {
  const maps = new Map();
  const statuses = queryList.map(() => 'loading');
  loadState[name] = queryList.length ? 'loading' : 'ready';
  queryList.forEach((source, index) =>
    targetUnsubscribers.push(
      onSnapshot(
        source,
        (snapshot) => {
          maps.set(index, snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
          statuses[index] = 'ready';
          loadState[name] = statuses.includes('error') ? 'error' : statuses.every((s) => s === 'ready') ? 'ready' : 'loading';
          apply([...maps.values()].flat(), loadState[name] === 'ready');
          updatePageState();
          render();
        },
        (error) => {
          console.error(`Unable to load ${name} scope`, error);
          statuses[index] = 'error';
          loadState[name] = 'error';
          updatePageState();
          render();
        }
      )
    )
  );
}

function bindStudents() {
  clearListeners(studentUnsubscribers);
  students = [];
  const ids = unique(registrations.flatMap((reg) => reg.studentIds || []));
  if (!ids.length) {
    loadState.students = 'ready';
    render();
    return;
  }
  bindChunked('students', chunks(ids).map((idsChunk) => query(collection(db, 'students'), where(documentId(), 'in', idsChunk))), studentUnsubscribers, (data) => {
    students = data;
  });
}

function bindAssignmentScope() {
  clearListeners(scopeUnsubscribers);
  clearListeners(studentUnsubscribers);
  events = [];
  registrations = [];
  students = [];
  const ids = currentJudgeIds();
  const eventIds = unique(assignments.filter((item) => item.active !== false && ids.includes(item.judgeId)).map((item) => item.eventId));
  if (!eventIds.length) {
    loadState.events = loadState.registrations = loadState.students = 'ready';
    render();
    return;
  }
  loadState.events = loadState.registrations = loadState.students = 'loading';
  const eventChunks = chunks(eventIds);
  bindChunked('events', eventChunks.map((idsChunk) => query(collection(db, 'events'), where(documentId(), 'in', idsChunk))), scopeUnsubscribers, (data) => {
    events = data;
  });
  bindChunked('registrations', eventChunks.map((idsChunk) => query(collection(db, 'registrations'), where('eventId', 'in', idsChunk))), scopeUnsubscribers, (data, complete) => {
    registrations = data;
    if (complete) bindStudents();
  });
}

async function startJudgeData() {
  if (listenersStarted) return;
  try {
    const [generalData, rulesData, homeData] = await Promise.all([
      cachedGetDoc(db, 'settings', 'general', { ttlMs: 300_000 }),
      cachedGetDoc(db, 'settings', 'scoring_rules', { ttlMs: 300_000 }),
      cachedGetDoc(db, 'settings', 'home_config', { ttlMs: 300_000 })
    ]);
    teamDisplayNames = generalData?.teamDisplayNames || {};
    categoryDisplayNames = generalData?.categoryDisplayNames || {};
    const setup = normalizeFestSetup(generalData?.festSetup || {});
    if (!judgingEnabled(setup)) {
      showPageState('Judgement is disabled. Results are entered directly by Admin.', true);
      return;
    }
    const missingPolicies = incompleteCompetitionPolicies(setup.competitionPolicies);
    if (missingPolicies.length) {
      showPageState(`Judgement is paused until Admin completes Scoring Policies: ${missingPolicies.join(', ')}.`, true);
      return;
    }
    scoringRules = normalizeScoringRules(rulesData || {});
    const config = homeData ? cacheBranding(homeData) : (clearBrandingCache(), normalizeBranding());
    const fest = brandingName(config);
    document.title = `${fest} — Judge Desk`;
    document.querySelectorAll('[data-judge-fest-name]').forEach((el) => (el.textContent = fest));
    document.getElementById('judge-profile-fest').textContent = fest;
    ['judge-fest-logo', 'judge-profile-logo'].forEach((id) => applyBase64Image(document.getElementById(id), config.logoUrl, id === 'judge-fest-logo' ? document.getElementById('judge-logo-fallback') : null));
  } catch (error) {
    console.error('Unable to load judge setup', error);
  }

  listenersStarted = true;
  requiredSources.forEach((key) => (loadState[key] = 'loading'));
  updatePageState();
  const ids = currentJudgeIds();
  const assignmentSource = ids.length === 1 ? query(collection(db, 'judgeAssignments'), where('judgeId', '==', ids[0])) : query(collection(db, 'judgeAssignments'), where('judgeId', 'in', ids.slice(0, 30)));
  const scoreSource = ids.length === 1 ? query(collection(db, 'judgeScores'), where('judgeId', '==', ids[0])) : query(collection(db, 'judgeScores'), where('judgeId', 'in', ids.slice(0, 30)));
  listenRequired('assignments', assignmentSource, (data) => {
    assignments = data;
    bindAssignmentScope();
  });
  listenRequired('scores', scoreSource, (data) => (scores = data));
  render();
}

onAuthStateChanged(auth, async (user) => {
  if (judgeAuthRedirecting) return;
  if (!user) return redirectToLogin();
  try {
    currentJudge = await loadJudgeProfile(user);
    if (!currentJudge) return redirectToLogin('Judge access not found or disabled.');
    sessionStorage.removeItem('judge_user');
    sessionStorage.setItem('judge_access_uid', user.uid);
    document.getElementById('judge-title').textContent = `${currentJudge.name} · Judge Desk`;
    await startJudgeData();
  } catch (error) {
    console.error('Judge access validation failed', error);
    showPageState('Unable to verify judge access. Please refresh or sign in again.', true);
  }
});
