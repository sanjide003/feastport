import { db, auth } from './firebase-config.js';
import { invalidateCache } from './data-cache.js';
import { escapeHtml } from './admin-utils.js';
import {
  judgeScoreToResult,
  calculateEventOutcome,
  resolveWinnerDetails,
  buildTeamScoreLedger,
  createResultRevision,
  normalizeScoringRules
} from './score-utils.js';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  setDoc,
  updateDoc,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';

const h = escapeHtml;
const byId = (id) => document.getElementById(id);

export function createAdminResultsController(getState, actions) {
  let editingResultId = '';

  const state = () => getState();

  function activeJudges() {
    const { accessUsers = [] } = state();
    return accessUsers.filter((u) => u.role === 'judge' && u.active !== false);
  }

  function judgeCanonicalId(judge) {
    return judge?.authUid || judge?.uid || judge?.docId || judge?.id || '';
  }

  function eventLabel(ev) {
    return `${ev.name || 'Event'} (${ev.category || 'General'} • ${ev.gender || 'Both'} • ${ev.type || 'Single'})`;
  }

  function participantOptionsForEvent(ev) {
    const { registrations = [], students = [] } = state();
    const evRegs = registrations.filter((r) => r.eventId === ev.id);
    if (ev.type === 'Group') {
      return evRegs.map((r) => {
        const names = (r.studentIds || []).map((sid) => students.find((s) => s.id === sid)?.name).filter(Boolean);
        return {
          id: r.id,
          label: `${r.team} — Entry #${r.slotIndex || 1}${names.length ? ` (${names.slice(0, 3).join(', ')})` : ''}`,
          team: r.team
        };
      });
    }
    const items = [];
    evRegs.forEach((r) => {
      (r.studentIds || []).forEach((sid) => {
        const st = students.find((s) => s.id === sid);
        if (st && !items.some((i) => i.id === st.id)) {
          items.push({
            id: st.id,
            label: `${st.chestNo ? `[${st.chestNo}] ` : ''}${st.name} (${st.team})`,
            team: st.team
          });
        }
      });
    });
    return items.sort((a, b) => a.label.localeCompare(b.label));
  }

  async function syncPublicSummary(nextResults) {
    const { students = [], events = [], teams = [] } = state();
    const ledger = buildTeamScoreLedger(nextResults, () => '', events);
    const teamScores = {};
    teams.forEach((t) => { teamScores[t] = 0; });
    ledger.forEach((entry) => {
      teamScores[entry.team] = (teamScores[entry.team] || 0) + Number(entry.points || 0);
    });
    const publishedCount = nextResults.filter((r) => !r.status || r.status === 'published').length;
    await setDoc(doc(db, 'settings', 'public_summary'), {
      studentCount: students.length,
      publishedCount,
      teamScores,
      updatedAt: Date.now()
    }, { merge: true });
    invalidateCache('public_summary');
    invalidateCache('published_results');
  }

  function renderJudgeAssignments() {
    const { events = [], judgeAssignments = [] } = state();
    const judges = activeJudges();
    const eventSelect = byId('assign-event-select');
    const judgeSelect = byId('assign-judge-select');
    if (eventSelect) {
      const prev = eventSelect.value;
      eventSelect.innerHTML = `<option value="">Select Event…</option>` + events
        .filter((e) => !['draft', 'archived'].includes(e.status))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .map((e) => `<option value="${h(e.id)}">${h(eventLabel(e))}</option>`)
        .join('');
      if (prev) eventSelect.value = prev;
    }
    if (judgeSelect) {
      const prev = judgeSelect.value;
      judgeSelect.innerHTML = `<option value="">Select Judge…</option>` + judges
        .map((j) => `<option value="${h(judgeCanonicalId(j))}">${h(j.displayName || j.username || j.email)}</option>`)
        .join('');
      if (prev) judgeSelect.value = prev;
    }

    const active = judgeAssignments.filter((a) => a.active !== false);
    const listEl = byId('judge-assignment-table');
    if (!listEl) return;
    listEl.innerHTML = active.length ? active.map((a) => `
      <tr class="hover:bg-slate-50">
        <td class="px-4 py-2.5 font-semibold text-slate-900">${h(a.eventName || a.eventId)}<br><span class="text-[11px] font-normal text-slate-500">${h(a.category || '')} • ${h(a.gender || '')}</span></td>
        <td class="px-4 py-2.5 text-slate-700">${h(a.judgeName || a.judgeId)}</td>
        <td class="px-4 py-2.5 font-mono-num text-xs text-slate-500">${h(a.date || 'TBA')} ${h(a.time || '')}</td>
        <td class="px-4 py-2.5 text-right">
          <button type="button" data-results-action="remove-assignment" data-id="${h(a.id)}" class="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100">Remove</button>
        </td>
      </tr>
    `).join('') : '<tr><td colspan="4" class="px-4 py-6 text-center text-xs text-slate-400">No active judge assignments yet.</td></tr>';
  }

  function renderSubmittedSheets() {
    const { judgeScores = [], events = [], scoringRules = {}, students = [], registrations = [], results = [] } = state();
    const submitted = judgeScores.filter((s) => s.status === 'submitted');
    const container = byId('submitted-sheets-list');
    if (!container) return;

    if (!submitted.length) {
      container.innerHTML = '<div class="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-xs text-slate-500">No submitted judge sheets awaiting review.</div>';
      return;
    }

    // Group submitted sheets by eventId so multi-judge scoring aggregates automatically
    const byEvent = new Map();
    submitted.forEach((sheet) => {
      if (!byEvent.has(sheet.eventId)) byEvent.set(sheet.eventId, []);
      byEvent.get(sheet.eventId).push(sheet);
    });

    container.innerHTML = [...byEvent.entries()].map(([eventId, sheets]) => {
      const ev = events.find((e) => e.id === eventId) || { id: eventId, name: sheets[0].eventName || eventId };
      const outcome = sheets.length > 1
        ? calculateEventOutcome({ scoreSheets: sheets, event: ev, rules: scoringRules })
        : judgeScoreToResult(sheets[0], ev, scoringRules);
      const details = resolveWinnerDetails(outcome.places, outcome.gradeAwards, { students, registrations, event: ev });
      const existingResult = results.find((r) => (r.eventId || r.id) === eventId);
      const isPublished = existingResult && existingResult.status === 'published';

      return `
        <article class="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 class="font-display text-sm font-bold text-slate-900">${h(ev.name)}</h4>
              <p class="text-[11px] text-slate-500">${h(ev.category || '')} • ${h(ev.gender || '')} • ${sheets.length} judge sheet${sheets.length === 1 ? '' : 's'} submitted</p>
            </div>
            <span class="rounded px-2 py-0.5 text-[10px] font-bold uppercase ${isPublished ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}">${isPublished ? 'Published' : 'Ready to Publish'}</span>
          </div>

          <div class="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
            ${outcome.places.length ? outcome.places.map((p) => `
              <div class="flex items-center justify-between gap-2">
                <span class="font-bold text-slate-800">${h(p.label)}:</span>
                <span class="truncate text-slate-700">${h((p.winners || []).map((wid) => details[wid]?.name || wid).join(', '))}</span>
              </div>
            `).join('') : '<p class="text-slate-500">No position winners qualified under current scoring rules.</p>'}
          </div>

          <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div class="flex flex-wrap gap-1.5">
              ${sheets.map((s) => `
                <button type="button" data-results-action="reopen-sheet" data-id="${h(s.id)}" class="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100">
                  Reopen (${h(s.judgeName || 'Judge')})
                </button>
              `).join('')}
            </div>
            <button type="button" data-results-action="publish-from-sheets" data-event-id="${h(eventId)}" class="rounded-lg bg-blue-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-800">
              ${isPublished ? 'Republish Update' : 'Approve & Publish'}
            </button>
          </div>
        </article>
      `;
    }).join('');
  }

  function renderDirectEntryForm() {
    const { events = [] } = state();
    const select = byId('direct-result-event');
    if (!select) return;
    const prev = select.value;
    select.innerHTML = `<option value="">Select Event for Direct Entry…</option>` + events
      .filter((e) => !['draft', 'archived'].includes(e.status))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map((e) => `<option value="${h(e.id)}">${h(eventLabel(e))}</option>`)
      .join('');
    if (prev) select.value = prev;
    populateDirectWinnerSelects(select.value);
  }

  function populateDirectWinnerSelects(eventId) {
    const ev = state().events.find((e) => e.id === eventId);
    const options = ev ? participantOptionsForEvent(ev) : [];
    const optHtml = `<option value="">— None —</option>` + options.map((o) => `<option value="${h(o.id)}">${h(o.label)}</option>`).join('');
    ['direct-first', 'direct-second', 'direct-third'].forEach((id) => {
      const el = byId(id);
      if (el) el.innerHTML = optHtml;
    });
    const existing = state().results.find((r) => (r.eventId || r.id) === eventId);
    if (existing) {
      byId('direct-first').value = existing.places?.[0]?.winners?.[0] || '';
      byId('direct-second').value = existing.places?.[1]?.winners?.[0] || '';
      byId('direct-third').value = existing.places?.[2]?.winners?.[0] || '';
      editingResultId = eventId;
    } else {
      editingResultId = '';
    }
  }

  function renderPublishedResultsTable() {
    const { results = [], events = [] } = state();
    const tbody = byId('published-results-tbody');
    if (!tbody) return;

    const sorted = results.slice().sort((a, b) => Number(b.publishedAt || b.updatedAt || 0) - Number(a.publishedAt || a.updatedAt || 0));
    tbody.innerHTML = sorted.length ? sorted.map((r) => {
      const id = r.eventId || r.id;
      const ev = events.find((e) => e.id === id) || {};
      const status = r.status || 'published';
      const winnersSummary = (r.places || []).map((p) => {
        const names = (p.winners || []).map((wid) => r.winnerDetails?.[wid]?.name || wid).join(', ');
        return `${p.label}: ${names}`;
      }).join(' • ');
      return `
        <tr class="hover:bg-slate-50">
          <td class="px-4 py-3 font-semibold text-slate-900">${h(ev.name || r.eventName || id)}<br><span class="text-[11px] font-normal text-slate-500">${h(r.category || ev.category || '')} • ${h(r.gender || ev.gender || '')}</span></td>
          <td class="px-4 py-3 text-xs text-slate-700">${h(winnersSummary || 'No positions')}</td>
          <td class="px-4 py-3"><span class="rounded px-2 py-0.5 text-[10px] font-bold uppercase ${status === 'published' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}">${h(status)}</span></td>
          <td class="px-4 py-3 text-right space-x-1.5">
            <button type="button" data-results-action="edit-result" data-event-id="${h(id)}" class="rounded border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50">Edit</button>
            <button type="button" data-results-action="toggle-archive-result" data-event-id="${h(id)}" class="rounded border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100">${status === 'published' ? 'Archive' : 'Publish'}</button>
            <button type="button" data-results-action="delete-result" data-event-id="${h(id)}" class="rounded border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100">Delete</button>
          </td>
        </tr>
      `;
    }).join('') : '<tr><td colspan="4" class="px-4 py-6 text-center text-xs text-slate-400">No results published yet.</td></tr>';
  }

  async function publishEventOutcome(eventId, places, gradeAwards, scoringSnapshot, { sourceType = 'judgeScore', sheets = [], reason = '' } = {}) {
    const { events = [], students = [], registrations = [], results = [] } = state();
    const ev = events.find((e) => e.id === eventId);
    if (!ev) return actions.toast('Event not found', 'error');

    const now = Date.now();
    const winnerDetails = resolveWinnerDetails(places, gradeAwards, { students, registrations, event: ev });
    const previous = results.find((r) => (r.eventId || r.id) === eventId);
    let resultPayload = {
      eventId,
      eventName: ev.name || '',
      category: ev.category || 'General',
      stage: ev.stage || 'On-Stage',
      gender: ev.gender || 'Both',
      type: ev.type || 'Single',
      places,
      gradeAwards,
      winnerDetails,
      scoringSnapshot,
      sourceType,
      status: 'published',
      publishedAt: previous?.publishedAt || now,
      updatedAt: now,
      publishedByUid: auth.currentUser?.uid || ''
    };

    const batch = writeBatch(db);
    if (previous && previous.status === 'published') {
      const revisionReason = reason || 'Admin result update';
      resultPayload = createResultRevision(previous, resultPayload, {
        actorUid: auth.currentUser?.uid || '',
        reason: revisionReason.length >= 5 ? revisionReason : `${revisionReason} update`,
        timestamp: now
      });
      batch.set(doc(collection(db, 'resultRevisions')), {
        eventId,
        revision: resultPayload.revision,
        reason: resultPayload.revisionReason,
        previousPlaces: previous.places || [],
        nextPlaces: places,
        actorUid: auth.currentUser?.uid || '',
        timestamp: now
      });
    }

    batch.set(doc(db, 'results', eventId), resultPayload);
    sheets.forEach((s) => {
      batch.update(doc(db, 'judgeScores', s.id), {
        publishStatus: 'published',
        publishedResultId: eventId,
        publishedAt: now
      });
    });

    const ledgerEntries = buildTeamScoreLedger([resultPayload], () => '', events);
    batch.set(doc(db, 'teamScoreLedgers', eventId), {
      eventId,
      eventName: ev.name || '',
      entries: ledgerEntries,
      updatedAt: now
    });

    batch.set(doc(collection(db, 'auditLogs')), {
      action: previous ? 'result-revised' : 'result-published',
      eventId,
      eventName: ev.name || '',
      sourceType,
      timestamp: now,
      uid: auth.currentUser?.uid || ''
    });

    await batch.commit();

    const nextResults = [...results.filter((r) => (r.eventId || r.id) !== eventId), { id: eventId, ...resultPayload }];
    actions.updateState({ results: nextResults });
    sheets.forEach((s) => { s.publishStatus = 'published'; s.publishedResultId = eventId; });
    await syncPublicSummary(nextResults);
    renderAll();
    actions.toast(`Result published for ${ev.name}`);
  }

  async function assignJudge() {
    const eventId = byId('assign-event-select')?.value;
    const judgeId = byId('assign-judge-select')?.value;
    if (!eventId || !judgeId) return actions.toast('Choose both an event and a judge', 'error');

    const { events = [], judgeAssignments = [] } = state();
    const ev = events.find((e) => e.id === eventId);
    const judge = activeJudges().find((j) => judgeCanonicalId(j) === judgeId);
    if (!ev || !judge) return actions.toast('Selected event or judge is unavailable', 'error');

    const assignmentId = `${eventId}_${judgeId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const payload = {
      judgeId,
      judgeAuthId: judge.authUid || '',
      judgeAccessDocId: judge.id || '',
      judgeName: judge.displayName || judge.username || 'Judge',
      eventId: ev.id,
      eventName: ev.name || '',
      category: ev.category || 'General',
      gender: ev.gender || 'Both',
      date: ev.scheduleDate || '',
      time: ev.time || '',
      stage: ev.stage || 'On-Stage',
      active: true,
      updatedAt: Date.now(),
      createdAt: Date.now()
    };

    await setDoc(doc(db, 'judgeAssignments', assignmentId), payload, { merge: true });
    const next = [...judgeAssignments.filter((a) => a.id !== assignmentId), { id: assignmentId, ...payload }];
    actions.updateState({ judgeAssignments: next });
    renderJudgeAssignments();
    actions.toast(`Assigned ${payload.judgeName} to ${ev.name}`);
  }

  async function removeAssignment(id) {
    await updateDoc(doc(db, 'judgeAssignments', id), { active: false, updatedAt: Date.now() });
    const next = state().judgeAssignments.map((a) => (a.id === id ? { ...a, active: false } : a));
    actions.updateState({ judgeAssignments: next });
    renderJudgeAssignments();
    actions.toast('Judge assignment removed');
  }

  async function reopenSheet(scoreId) {
    const score = state().judgeScores.find((s) => s.id === scoreId);
    if (!score) return;
    const reason = window.prompt('Enter reason for reopening this judge sheet (minimum 5 characters):', 'Score review required');
    if (!reason || reason.trim().length < 5) return actions.toast('Reopen cancelled: reason must be at least 5 characters', 'error');

    const batch = writeBatch(db);
    batch.update(doc(db, 'judgeScores', scoreId), {
      status: 'draft',
      publishStatus: 'unpublished',
      reopenedAt: Date.now(),
      reopenReason: reason.trim(),
      reopenedByUid: auth.currentUser?.uid || '',
      reopenCount: Number(score.reopenCount || 0) + 1
    });
    batch.delete(doc(db, 'publicJudgingStatuses', score.assignmentId || scoreId));
    await batch.commit();

    score.status = 'draft';
    score.publishStatus = 'unpublished';
    renderSubmittedSheets();
    actions.toast('Judge sheet reopened for editing');
  }

  async function publishFromSheets(eventId) {
    const { judgeScores = [], events = [], scoringRules = {} } = state();
    const sheets = judgeScores.filter((s) => s.eventId === eventId && s.status === 'submitted');
    const ev = events.find((e) => e.id === eventId);
    if (!ev || !sheets.length) return actions.toast('No submitted sheets found for this event', 'error');

    const outcome = sheets.length > 1
      ? calculateEventOutcome({ scoreSheets: sheets, event: ev, rules: scoringRules })
      : judgeScoreToResult(sheets[0], ev, scoringRules);
    await publishEventOutcome(eventId, outcome.places, outcome.gradeAwards, outcome.scoringSnapshot, {
      sourceType: 'judgeScore',
      sheets
    });
  }

  async function saveDirectResult() {
    const eventId = byId('direct-result-event')?.value;
    if (!eventId) return actions.toast('Select an event first', 'error');
    const ev = state().events.find((e) => e.id === eventId);
    if (!ev) return;

    const rules = normalizeScoringRules(state().scoringRules);
    const pointConfig = rules.configs[ev.type === 'Group' ? 'Group' : 'Single']?.points || [];
    const picks = [
      byId('direct-first')?.value || '',
      byId('direct-second')?.value || '',
      byId('direct-third')?.value || ''
    ];
    if (!picks.some(Boolean)) return actions.toast('Select at least one winner', 'error');

    const places = picks.map((winnerId, idx) => {
      if (!winnerId) return null;
      const cfg = pointConfig[idx] || { key: `position_${idx + 1}`, rank: idx + 1, label: ['First', 'Second', 'Third'][idx], value: [5, 3, 1][idx] || 0 };
      return {
        key: cfg.key,
        rank: idx + 1,
        label: cfg.label,
        value: Number(cfg.value || 0),
        earnedValue: Number(cfg.value || 0),
        winners: [winnerId]
      };
    }).filter(Boolean);

    let reason = 'Direct Admin result entry';
    if (editingResultId === eventId && state().results.some((r) => (r.eventId || r.id) === eventId && r.status === 'published')) {
      const inputReason = window.prompt('Revision reason for updating this published result:', 'Verified position update');
      if (!inputReason || inputReason.trim().length < 5) return actions.toast('Revision cancelled: enter at least 5 characters', 'error');
      reason = inputReason.trim();
    }

    await publishEventOutcome(eventId, places, [], null, { sourceType: 'direct', reason });
  }

  async function toggleArchiveResult(eventId) {
    const { results = [] } = state();
    const res = results.find((r) => (r.eventId || r.id) === eventId);
    if (!res) return;
    const nextStatus = res.status === 'published' ? 'archived' : 'published';
    await updateDoc(doc(db, 'results', eventId), { status: nextStatus, updatedAt: Date.now() });
    res.status = nextStatus;
    await syncPublicSummary(results);
    renderPublishedResultsTable();
    actions.toast(`Result ${nextStatus}`);
  }

  async function deleteResult(eventId) {
    if (!await actions.confirm(`Delete published result for this event?`)) return;
    await deleteDoc(doc(db, 'results', eventId));
    await deleteDoc(doc(db, 'teamScoreLedgers', eventId)).catch(() => {});
    const nextResults = state().results.filter((r) => (r.eventId || r.id) !== eventId);
    actions.updateState({ results: nextResults });
    await syncPublicSummary(nextResults);
    renderPublishedResultsTable();
    actions.toast('Result deleted');
  }

  function renderAll() {
    renderJudgeAssignments();
    renderSubmittedSheets();
    renderDirectEntryForm();
    renderPublishedResultsTable();
  }

  function bindEvents() {
    byId('btn-assign-judge')?.addEventListener('click', assignJudge);
    byId('direct-result-event')?.addEventListener('change', (e) => populateDirectWinnerSelects(e.target.value));
    byId('btn-save-direct-result')?.addEventListener('click', saveDirectResult);

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-results-action]');
      if (!btn) return;
      const action = btn.dataset.resultsAction;
      if (action === 'remove-assignment') removeAssignment(btn.dataset.id);
      if (action === 'reopen-sheet') reopenSheet(btn.dataset.id);
      if (action === 'publish-from-sheets') publishFromSheets(btn.dataset.eventId);
      if (action === 'edit-result') {
        byId('direct-result-event').value = btn.dataset.eventId;
        populateDirectWinnerSelects(btn.dataset.eventId);
        byId('direct-result-event')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (action === 'toggle-archive-result') toggleArchiveResult(btn.dataset.eventId);
      if (action === 'delete-result') deleteResult(btn.dataset.eventId);
    });
  }

  bindEvents();
  return { renderAll, syncPublicSummary };
}
