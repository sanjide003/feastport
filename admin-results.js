import { db, auth } from './firebase-config.js';
import { invalidateCache } from './data-cache.js';
import { escapeHtml, resolveDisplayName } from './admin-utils.js';
import {
  judgeScoreToResult,
  calculateEventOutcome,
  resolveWinnerDetails,
  buildTeamScoreLedger,
  createResultRevision,
  createScoringSnapshot,
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
  const teamLabel = (key) => resolveDisplayName(state().teamDisplayNames, key, key);
  const catLabel = (key) => resolveDisplayName(state().categoryDisplayNames, key, key || 'General');

  function activeJudges() {
    const { accessUsers = [] } = state();
    return accessUsers.filter((u) => u.role === 'judge' && u.active !== false);
  }

  function judgeCanonicalId(judge) {
    return judge?.authUid || judge?.uid || judge?.docId || judge?.id || '';
  }

  function eventLabel(ev) {
    return `${ev.name || 'Event'} (${catLabel(ev.category || 'General')} • ${ev.gender || 'Both'} • ${ev.type || 'Single'})`;
  }

  function gradeMapFromAwards(gradeAwards = []) {
    const map = new Map();
    (gradeAwards || []).forEach((g) => {
      const info = {
        key: String(g.key || ''),
        label: String(g.label || ''),
        value: Number(g.value || 0)
      };
      (g.winners || []).forEach((w) => {
        const wid = typeof w === 'string' ? w : w?.id;
        if (wid && !map.has(wid)) map.set(wid, info);
      });
    });
    return map;
  }

  function participantOptionsForEvent(ev) {
    const { registrations = [], students = [] } = state();
    const evRegs = registrations.filter((r) => r.eventId === ev.id);
    if (ev.type === 'Group') {
      return evRegs.map((r) => {
        const names = (r.studentIds || []).map((sid) => students.find((s) => s.id === sid)?.name).filter(Boolean);
        return {
          id: r.id,
          label: `${teamLabel(r.team)} — Entry #${r.slotIndex || 1}${names.length ? ` (${names.slice(0, 3).join(', ')})` : ''}`,
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
            label: `${st.chestNo ? `[${st.chestNo}] ` : ''}${st.name} (${teamLabel(st.team)})`,
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
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/60">
        <td class="px-4 py-2.5 font-semibold text-slate-900 dark:text-slate-100">${h(a.eventName || a.eventId)}<br><span class="text-[11px] font-normal text-slate-500 dark:text-slate-400">${h(catLabel(a.category || ''))} • ${h(a.gender || '')}</span></td>
        <td class="px-4 py-2.5 text-slate-700 dark:text-slate-300">${h(a.judgeName || a.judgeId)}</td>
        <td class="px-4 py-2.5 font-mono-num text-xs text-slate-500 dark:text-slate-400">${h(a.date || 'TBA')} ${h(a.time || '')}</td>
        <td class="px-4 py-2.5 text-right space-x-1.5 whitespace-nowrap">
          <button type="button" data-results-action="edit-assignment" data-id="${h(a.id)}" class="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50">Edit</button>
          <button type="button" data-results-action="remove-assignment" data-id="${h(a.id)}" class="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-2.5 py-1 text-[11px] font-semibold text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-950/70">Remove</button>
        </td>
      </tr>
    `).join('') : '<tr><td colspan="4" class="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">No active judge assignments yet.</td></tr>';
  }

  function renderSubmittedSheets() {
    const { judgeScores = [], events = [], scoringRules = {}, students = [], registrations = [], results = [] } = state();
    const submitted = judgeScores.filter((s) => s.status === 'submitted');
    const awaitingCount = judgeScores.filter((s) => s.status === 'submitted' && s.publishStatus !== 'published').length;
    const subBadge = byId('badge-subtab-sheets');
    if (subBadge) {
      if (awaitingCount > 0) {
        subBadge.textContent = String(awaitingCount);
        subBadge.classList.remove('hidden');
      } else {
        subBadge.classList.add('hidden');
      }
    }
    const container = byId('submitted-sheets-list');
    if (!container) return;

    if (!submitted.length) {
      container.innerHTML = '<div class="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 text-center text-xs text-slate-500 dark:text-slate-400">No submitted judge sheets awaiting review.</div>';
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
      const gMap = gradeMapFromAwards(outcome.gradeAwards);
      const placedIds = new Set((outcome.places || []).flatMap((p) => p.winners || []));
      const extraGrades = (outcome.gradeAwards || [])
        .map((g) => ({
          ...g,
          extraWinners: (g.winners || []).filter((wid) => !placedIds.has(wid))
        }))
        .filter((g) => g.extraWinners.length > 0);
      const existingResult = results.find((r) => (r.eventId || r.id) === eventId);
      const isPublished = existingResult && existingResult.status === 'published';

      return `
        <article class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 class="font-display text-sm font-bold text-slate-900 dark:text-slate-100">${h(ev.name)}</h4>
              <p class="text-[11px] text-slate-500 dark:text-slate-400">${h(catLabel(ev.category || ''))} • ${h(ev.gender || '')} • ${sheets.length} judge sheet${sheets.length === 1 ? '' : 's'} submitted</p>
            </div>
            <span class="rounded px-2 py-0.5 text-[10px] font-bold uppercase ${isPublished ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200/70 dark:border-emerald-800/60' : 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200/70 dark:border-amber-800/60'}">${isPublished ? 'Published' : 'Ready to Publish'}</span>
          </div>

          <div class="space-y-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/60 p-3 text-xs">
            ${outcome.places.length ? outcome.places.map((p) => {
              const posPts = Number(p.earnedValue ?? p.value ?? 0);
              const winnerStr = (p.winners || []).map((wid) => {
                const nm = details[wid]?.name || wid;
                const g = gMap.get(wid);
                if (g) return `${nm} · ${g.label} (${posPts + g.value} pts: ${posPts}+${g.value})`;
                return `${nm} (${posPts} pts)`;
              }).join(', ');
              return `
                <div class="flex items-center justify-between gap-2">
                  <span class="font-bold text-slate-800 dark:text-slate-200">${h(p.label)}:</span>
                  <span class="truncate text-slate-700 dark:text-slate-300">${h(winnerStr)}</span>
                </div>
              `;
            }).join('') : '<p class="text-slate-500 dark:text-slate-400">No position winners qualified under current scoring rules.</p>'}
            ${extraGrades.length ? `<div class="pt-1.5 mt-1.5 border-t border-slate-200/80 dark:border-slate-700/80 text-[11px] text-slate-600 dark:text-slate-400">${extraGrades.map((g) => `<span class="font-semibold text-slate-700 dark:text-slate-300">${h(g.label)} (+${Number(g.value || 0)} pts):</span> ${h(g.extraWinners.map((wid) => details[wid]?.name || wid).join(', '))}`).join(' • ')}</div>` : ''}
          </div>

          <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div class="flex flex-wrap gap-1.5">
              ${sheets.map((s) => `
                <button type="button" data-results-action="reopen-sheet" data-id="${h(s.id)}" class="rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 px-2.5 py-1.5 text-[11px] font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/70">
                  Reopen (${h(s.judgeName || 'Judge')})
                </button>
              `).join('')}
            </div>
            <button type="button" data-results-action="publish-from-sheets" data-event-id="${h(eventId)}" class="rounded-lg bg-blue-700 dark:bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 dark:hover:bg-blue-500">
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

  function directEventContext(eventId) {
    const ev = state().events.find((e) => e.id === eventId);
    const rules = normalizeScoringRules(state().scoringRules);
    const typeKey = ev?.type === 'Group' ? 'Group' : 'Single';
    const pointConfig = rules.configs[typeKey]?.points || [];
    const gradeOptions = rules.configs[typeKey]?.grades || [];
    const gradesEnabled = rules.enabled?.grades === true;
    const participants = ev ? participantOptionsForEvent(ev) : [];
    return { ev, rules, typeKey, pointConfig, gradeOptions, gradesEnabled, participants };
  }

  function directExtraGradeRowHtml(participants, gradeOptions, selectedWinner = '', selectedGradeKey = '') {
    const partOpts = `<option value="">— Select Participant —</option>` + participants
      .map((o) => `<option value="${h(o.id)}" ${o.id === selectedWinner ? 'selected' : ''}>${h(o.label)}</option>`)
      .join('');
    const gradeOpts = `<option value="">— Select Grade —</option>` + gradeOptions
      .map((g) => `<option value="${h(g.key)}" ${g.key === selectedGradeKey ? 'selected' : ''}>${h(g.label)} (+${Number(g.value || 0)} pts)</option>`)
      .join('');
    return `
      <div data-direct-extra-row class="grid gap-2 sm:grid-cols-[1fr_180px_32px] items-center">
        <select data-direct-extra-winner class="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">${partOpts}</select>
        <select data-direct-extra-grade class="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">${gradeOpts}</select>
        <button type="button" data-remove-direct-extra-grade title="Remove grade award" class="flex h-8 w-8 items-center justify-center rounded-md border border-red-200 bg-red-50 text-xs font-bold text-red-600 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/70">✕</button>
      </div>
    `;
  }

  function updateDirectPointPreviews() {
    const eventId = byId('direct-result-event')?.value || '';
    const { ev, pointConfig, gradeOptions, gradesEnabled } = directEventContext(eventId);
    const gradeByKey = new Map(gradeOptions.map((g) => [g.key, g]));
    [
      { idx: 0, winnerSel: 'direct-first', gradeSel: 'direct-first-grade', previewId: 'direct-first-pts' },
      { idx: 1, winnerSel: 'direct-second', gradeSel: 'direct-second-grade', previewId: 'direct-second-pts' },
      { idx: 2, winnerSel: 'direct-third', gradeSel: 'direct-third-grade', previewId: 'direct-third-pts' }
    ].forEach(({ idx, winnerSel, gradeSel, previewId }) => {
      const previewEl = byId(previewId);
      if (!previewEl) return;
      if (!ev) {
        previewEl.textContent = '';
        return;
      }
      const posPts = Number(pointConfig[idx]?.value ?? [5, 3, 1][idx] ?? 0);
      const hasWinner = Boolean(byId(winnerSel)?.value);
      const gradeKey = gradesEnabled ? (byId(gradeSel)?.value || '') : '';
      const gradeObj = gradeKey ? gradeByKey.get(gradeKey) : null;
      const gradePts = gradeObj ? Number(gradeObj.value || 0) : 0;
      if (hasWinner && gradeObj) {
        previewEl.textContent = `${posPts + gradePts} pts (${posPts}+${gradePts})`;
      } else {
        previewEl.textContent = `${posPts} pts`;
      }
    });
  }

  function populateDirectWinnerSelects(eventId) {
    const { ev, gradeOptions, gradesEnabled, participants } = directEventContext(eventId);
    const optHtml = `<option value="">— None —</option>` + participants.map((o) => `<option value="${h(o.id)}">${h(o.label)}</option>`).join('');
    ['direct-first', 'direct-second', 'direct-third'].forEach((id) => {
      const el = byId(id);
      if (el) el.innerHTML = optHtml;
    });

    const showGradesUI = Boolean(ev && gradesEnabled && gradeOptions.length);
    document.querySelectorAll('[data-direct-grade-wrap]').forEach((el) => el.classList.toggle('hidden', !showGradesUI));
    byId('direct-extra-grades-wrap')?.classList.toggle('hidden', !showGradesUI);

    const gradeOptHtml = `<option value="">— No Grade —</option>` + gradeOptions
      .map((g) => `<option value="${h(g.key)}">${h(g.label)} (+${Number(g.value || 0)} pts)</option>`)
      .join('');
    ['direct-first-grade', 'direct-second-grade', 'direct-third-grade'].forEach((id) => {
      const el = byId(id);
      if (el) {
        el.innerHTML = gradeOptHtml;
        el.value = '';
      }
    });

    const extraList = byId('direct-extra-grades-list');
    if (extraList) extraList.innerHTML = '';

    const existing = state().results.find((r) => (r.eventId || r.id) === eventId);
    const isPublished = existing && existing.status === 'published';
    if (existing) {
      const findPlaceWinner = (rank) => {
        const match = (existing.places || []).find((p) => Number(p.rank) === rank) || existing.places?.[rank - 1];
        return match?.winners?.[0] || '';
      };
      const w1 = findPlaceWinner(1);
      const w2 = findPlaceWinner(2);
      const w3 = findPlaceWinner(3);
      if (byId('direct-first')) byId('direct-first').value = w1;
      if (byId('direct-second')) byId('direct-second').value = w2;
      if (byId('direct-third')) byId('direct-third').value = w3;

      const gMap = gradeMapFromAwards(existing.gradeAwards || []);
      const matchGradeKey = (wid) => {
        if (!wid || !gMap.has(wid)) return '';
        const info = gMap.get(wid);
        const byKey = gradeOptions.find((g) => g.key === info.key);
        if (byKey) return byKey.key;
        const byLabel = gradeOptions.find((g) => g.label.toLowerCase() === info.label.toLowerCase());
        return byLabel?.key || '';
      };
      if (byId('direct-first-grade')) byId('direct-first-grade').value = matchGradeKey(w1);
      if (byId('direct-second-grade')) byId('direct-second-grade').value = matchGradeKey(w2);
      if (byId('direct-third-grade')) byId('direct-third-grade').value = matchGradeKey(w3);

      const topIds = new Set([w1, w2, w3].filter(Boolean));
      if (showGradesUI && extraList) {
        const seenExtra = new Set();
        (existing.gradeAwards || []).forEach((g) => {
          const matchedOpt = gradeOptions.find((opt) => opt.key === g.key || opt.label.toLowerCase() === String(g.label || '').toLowerCase());
          const gKey = matchedOpt?.key || '';
          (g.winners || []).forEach((w) => {
            const wid = typeof w === 'string' ? w : w?.id;
            if (!wid || topIds.has(wid) || seenExtra.has(wid)) return;
            seenExtra.add(wid);
            extraList.insertAdjacentHTML('beforeend', directExtraGradeRowHtml(participants, gradeOptions, wid, gKey));
          });
        });
      }
      editingResultId = eventId;
    } else {
      editingResultId = '';
    }
    byId('direct-edit-banner')?.classList.toggle('hidden', !isPublished);
    byId('btn-cancel-direct-edit')?.classList.toggle('hidden', !editingResultId);
    updateDirectPointPreviews();
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
      const gMap = gradeMapFromAwards(r.gradeAwards || []);
      const placedIds = new Set((r.places || []).flatMap((p) => p.winners || []));
      const placeParts = (r.places || []).map((p) => {
        const posPts = Number(p.earnedValue ?? p.value ?? 0);
        const names = (p.winners || []).map((wid) => {
          const name = r.winnerDetails?.[wid]?.name || wid;
          const g = gMap.get(wid);
          if (g) return `${name} [${g.label} · ${posPts + g.value} pts: ${posPts}+${g.value}]`;
          return posPts > 0 ? `${name} (${posPts} pts)` : name;
        }).join(', ');
        return `${p.label}: ${names}`;
      });
      const extraGradeParts = (r.gradeAwards || [])
        .map((g) => {
          const extra = (g.winners || []).filter((w) => {
            const wid = typeof w === 'string' ? w : w?.id;
            return wid && !placedIds.has(wid);
          });
          if (!extra.length) return '';
          const names = extra.map((w) => {
            const wid = typeof w === 'string' ? w : w?.id;
            return r.winnerDetails?.[wid]?.name || wid;
          }).join(', ');
          return `${g.label} (+${Number(g.value || 0)} pts): ${names}`;
        })
        .filter(Boolean);
      const winnersSummary = [...placeParts, ...extraGradeParts].join(' • ');
      return `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/60">
          <td class="px-4 py-3 font-semibold text-slate-900 dark:text-slate-100">${h(ev.name || r.eventName || id)}<br><span class="text-[11px] font-normal text-slate-500 dark:text-slate-400">${h(catLabel(r.category || ev.category || ''))} • ${h(r.gender || ev.gender || '')}</span></td>
          <td class="px-4 py-3 text-xs text-slate-700 dark:text-slate-300">${h(winnersSummary || 'No positions')}</td>
          <td class="px-4 py-3"><span class="rounded px-2 py-0.5 text-[10px] font-bold uppercase ${status === 'published' ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200/70 dark:border-emerald-800/60' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700'}">${h(status)}</span></td>
          <td class="px-4 py-3 text-right space-x-1.5 whitespace-nowrap">
            <button type="button" data-results-action="edit-result" data-event-id="${h(id)}" class="rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50">Edit</button>
            <button type="button" data-results-action="toggle-archive-result" data-event-id="${h(id)}" class="rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">${status === 'published' ? 'Archive' : 'Publish'}</button>
            <button type="button" data-results-action="delete-result" data-event-id="${h(id)}" class="rounded border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-2.5 py-1 text-[11px] font-semibold text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-950/70">Delete</button>
          </td>
        </tr>
      `;
    }).join('') : '<tr><td colspan="4" class="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">No results published yet.</td></tr>';
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

  function openEditAssignmentModal(id) {
    const a = state().judgeAssignments.find((x) => x.id === id);
    if (!a) return;
    const judgeSelect = byId('edit-assign-judge');
    const judges = activeJudges();
    if (judgeSelect) {
      judgeSelect.innerHTML = judges
        .map((j) => `<option value="${h(judgeCanonicalId(j))}">${h(j.displayName || j.username || j.email)}</option>`)
        .join('');
      judgeSelect.value = a.judgeId || '';
    }
    byId('edit-assign-id').value = a.id;
    byId('edit-assign-event-name').value = `${a.eventName || a.eventId} (${catLabel(a.category || '')})`;
    byId('edit-assign-date').value = a.date || '';
    byId('edit-assign-time').value = a.time || '';
    byId('edit-assignment-modal').classList.remove('hidden');
    byId('edit-assignment-modal').classList.add('flex');
  }

  async function saveAssignmentUpdate() {
    const id = byId('edit-assign-id')?.value;
    const judgeId = byId('edit-assign-judge')?.value;
    const date = byId('edit-assign-date')?.value || '';
    const time = byId('edit-assign-time')?.value || '';
    const a = state().judgeAssignments.find((x) => x.id === id);
    const judge = activeJudges().find((j) => judgeCanonicalId(j) === judgeId);
    if (!a || !judge) return actions.toast('Selected assignment or judge is unavailable', 'error');

    const patch = {
      judgeId,
      judgeAuthId: judge.authUid || '',
      judgeAccessDocId: judge.id || '',
      judgeName: judge.displayName || judge.username || 'Judge',
      date,
      time,
      updatedAt: Date.now()
    };
    await updateDoc(doc(db, 'judgeAssignments', id), patch);
    Object.assign(a, patch);
    byId('edit-assignment-modal').classList.add('hidden');
    byId('edit-assignment-modal').classList.remove('flex');
    renderJudgeAssignments();
    actions.toast('Judge assignment updated');
  }

  async function removeAssignment(id) {
    const a = state().judgeAssignments.find((x) => x.id === id);
    const ok = await actions.confirm(
      `Remove judge assignment for "${a?.eventName || 'this event'}" (${a?.judgeName || 'Judge'})?`,
      { title: 'Remove Judge Assignment', okLabel: 'Remove' }
    );
    if (!ok) return;
    await updateDoc(doc(db, 'judgeAssignments', id), { active: false, updatedAt: Date.now() });
    const next = state().judgeAssignments.map((item) => (item.id === id ? { ...item, active: false } : item));
    actions.updateState({ judgeAssignments: next });
    renderJudgeAssignments();
    actions.toast('Judge assignment removed');
  }

  async function reopenSheet(scoreId) {
    const score = state().judgeScores.find((s) => s.id === scoreId);
    if (!score) return;
    const reason = await actions.prompt({
      title: 'Reopen Judge Sheet',
      message: `Provide a reason for reopening "${score.eventName || 'this sheet'}" (${score.judgeName || 'Judge'}).`,
      defaultValue: 'Score review required',
      placeholder: 'Minimum 5 characters…',
      minLength: 5,
      okLabel: 'Reopen Sheet'
    });
    if (!reason) return;

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
    const { ev, rules, pointConfig, gradeOptions, gradesEnabled } = directEventContext(eventId);
    if (!ev) return;

    const picks = [
      byId('direct-first')?.value || '',
      byId('direct-second')?.value || '',
      byId('direct-third')?.value || ''
    ];
    const nonEmptyPicks = picks.filter(Boolean);
    if (new Set(nonEmptyPicks).size !== nonEmptyPicks.length) {
      return actions.toast('The same participant cannot be assigned to multiple positions.', 'error');
    }

    const gradePicks = [
      byId('direct-first-grade')?.value || '',
      byId('direct-second-grade')?.value || '',
      byId('direct-third-grade')?.value || ''
    ];

    const extraRows = [...document.querySelectorAll('#direct-extra-grades-list [data-direct-extra-row]')];
    const extraAssignments = [];
    const seenExtra = new Set();
    const topIds = new Set(nonEmptyPicks);

    if (gradesEnabled) {
      for (let i = 0; i < extraRows.length; i += 1) {
        const row = extraRows[i];
        const wid = row.querySelector('[data-direct-extra-winner]')?.value || '';
        const gKey = row.querySelector('[data-direct-extra-grade]')?.value || '';
        if (!wid && !gKey) continue;
        if (!wid || !gKey) {
          return actions.toast(`Other Grade row #${i + 1}: select both a participant and a grade.`, 'error');
        }
        if (topIds.has(wid)) {
          return actions.toast('A 1st–3rd place winner is also in Other Participant Grades. Choose their grade on their position card instead.', 'error');
        }
        if (seenExtra.has(wid)) {
          return actions.toast('Duplicate participant in Other Participant Grade Awards.', 'error');
        }
        seenExtra.add(wid);
        extraAssignments.push({ wid, gKey });
      }
    }

    if (!nonEmptyPicks.length && !extraAssignments.length) {
      return actions.toast('Select at least one winner or grade award', 'error');
    }

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

    let gradeAwards = [];
    if (gradesEnabled) {
      const byGradeKey = new Map();
      picks.forEach((wid, idx) => {
        const gKey = gradePicks[idx];
        if (!wid || !gKey) return;
        if (!byGradeKey.has(gKey)) byGradeKey.set(gKey, []);
        byGradeKey.get(gKey).push(wid);
      });
      extraAssignments.forEach(({ wid, gKey }) => {
        if (!byGradeKey.has(gKey)) byGradeKey.set(gKey, []);
        byGradeKey.get(gKey).push(wid);
      });
      gradeAwards = gradeOptions
        .map((g) => {
          const winners = byGradeKey.get(g.key) || [];
          if (!winners.length) return null;
          return {
            key: g.key,
            order: g.order,
            label: g.label,
            minimumPercentage: Number(g.minimumPercentage ?? 0),
            value: Number(g.value || 0),
            winners
          };
        })
        .filter(Boolean);
    }

    let reason = 'Direct Admin result entry';
    if (editingResultId === eventId && state().results.some((r) => (r.eventId || r.id) === eventId && r.status === 'published')) {
      const inputReason = await actions.prompt({
        title: 'Publish Result Revision',
        message: `Provide a revision reason for updating the published result of "${ev.name}".`,
        defaultValue: 'Verified position update',
        placeholder: 'Minimum 5 characters…',
        minLength: 5,
        okLabel: 'Save & Publish Revision'
      });
      if (!inputReason) return;
      reason = inputReason.trim();
    }

    const scoringSnapshot = createScoringSnapshot(rules, ev);
    await publishEventOutcome(eventId, places, gradeAwards, scoringSnapshot, { sourceType: 'direct', reason });
  }

  async function toggleArchiveResult(eventId) {
    const { results = [] } = state();
    const res = results.find((r) => (r.eventId || r.id) === eventId);
    if (!res) return;
    const nextStatus = res.status === 'published' ? 'archived' : 'published';
    const actionLabel = nextStatus === 'archived' ? 'Archive' : 'Republish';
    const ok = await actions.confirm(
      `${actionLabel} result for "${res.eventName || eventId}"?`,
      { title: `${actionLabel} Result`, okLabel: actionLabel, tone: nextStatus === 'archived' ? 'danger' : 'primary' }
    );
    if (!ok) return;
    await updateDoc(doc(db, 'results', eventId), { status: nextStatus, updatedAt: Date.now() });
    res.status = nextStatus;
    await syncPublicSummary(results);
    renderPublishedResultsTable();
    actions.toast(`Result ${nextStatus}`);
  }

  async function deleteResult(eventId) {
    const res = state().results.find((r) => (r.eventId || r.id) === eventId);
    const ok = await actions.confirm(
      `Permanently delete the published result and team score ledger for "${res?.eventName || eventId}"?`,
      { title: 'Delete Published Result', okLabel: 'Delete Result' }
    );
    if (!ok) return;
    await deleteDoc(doc(db, 'results', eventId));
    await deleteDoc(doc(db, 'teamScoreLedgers', eventId)).catch(() => {});
    const nextResults = state().results.filter((r) => (r.eventId || r.id) !== eventId);
    actions.updateState({ results: nextResults });
    await syncPublicSummary(nextResults);
    renderPublishedResultsTable();
    actions.toast('Result deleted');
  }

  function clearDirectEdit() {
    if (byId('direct-result-event')) byId('direct-result-event').value = '';
    populateDirectWinnerSelects('');
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
    ['direct-first', 'direct-second', 'direct-third', 'direct-first-grade', 'direct-second-grade', 'direct-third-grade'].forEach((id) => {
      byId(id)?.addEventListener('change', updateDirectPointPreviews);
    });
    byId('btn-add-direct-extra-grade')?.addEventListener('click', () => {
      const eventId = byId('direct-result-event')?.value || '';
      const { ev, participants, gradeOptions, gradesEnabled } = directEventContext(eventId);
      if (!ev) return actions.toast('Select an event first', 'error');
      if (!gradesEnabled || !gradeOptions.length) return actions.toast('Enable Grades in Festival Setup → Scoring Rules first.', 'error');
      const list = byId('direct-extra-grades-list');
      if (!list) return;
      list.insertAdjacentHTML('beforeend', directExtraGradeRowHtml(participants, gradeOptions));
    });
    byId('direct-extra-grades-list')?.addEventListener('click', (e) => {
      const rmBtn = e.target.closest('[data-remove-direct-extra-grade]');
      if (!rmBtn) return;
      rmBtn.closest('[data-direct-extra-row]')?.remove();
    });
    byId('btn-save-direct-result')?.addEventListener('click', saveDirectResult);
    byId('btn-cancel-direct-edit')?.addEventListener('click', clearDirectEdit);
    byId('edit-assignment-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      saveAssignmentUpdate();
    });
    const closeAssignModal = () => {
      byId('edit-assignment-modal')?.classList.add('hidden');
      byId('edit-assignment-modal')?.classList.remove('flex');
    };
    byId('btn-close-edit-assignment')?.addEventListener('click', closeAssignModal);
    byId('btn-cancel-edit-assignment')?.addEventListener('click', closeAssignModal);

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-results-action]');
      if (!btn) return;
      const action = btn.dataset.resultsAction;
      if (action === 'edit-assignment') openEditAssignmentModal(btn.dataset.id);
      if (action === 'remove-assignment') removeAssignment(btn.dataset.id);
      if (action === 'reopen-sheet') reopenSheet(btn.dataset.id);
      if (action === 'publish-from-sheets') publishFromSheets(btn.dataset.eventId);
      if (action === 'edit-result') {
        actions.setSubTab?.('results', 'direct');
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
