// admin-utils.js
// Shared formatting, winner resolution, and safe print helpers

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export const jsAttr = (value) => escapeHtml(JSON.stringify(String(value ?? '')));

export const resolveDisplayName = (map, key, fallback = '') => {
  const k = String(key ?? '').trim();
  if (!k) return fallback;
  return String(map?.[k] || k);
};

export const normalizeStageValue = (value) =>
  String(value || '').trim().replace(/^stage\s*/i, '').replace(/\s+/g, ' ').toLowerCase();

export const normalizeStageForSchedule = normalizeStageValue;

export function showToastAdapter(message, type = 'success') {
  if (window.showToast) {
    window.showToast(message, type);
    return true;
  }
  return false;
}

export function normalizeResultData(raw = {}, { events = [], students = [], registrations = [] } = {}) {
  const eventId = raw.eventId || raw.id || '';
  const event = events.find((e) => e.id === eventId);
  const eventName = raw.eventName || event?.name || '';
  const embedded = raw.winnerDetails && typeof raw.winnerDetails === 'object' ? raw.winnerDetails : {};

  const resolveWinner = (winner) => {
    if (!winner) return null;
    if (typeof winner === 'object') {
      const id = winner.id || winner.participantId || '';
      const cached = id ? embedded[id] : null;
      return {
        id,
        name: winner.name || cached?.name || 'Unknown',
        team: winner.team || cached?.team || '-',
        chestNo: winner.chestNo || cached?.chestNo || '',
        photoUrl: winner.photoUrl || cached?.photoUrl || ''
      };
    }
    const id = String(winner);
    if (embedded[id]) {
      return {
        id,
        name: embedded[id].name || 'Unknown',
        team: embedded[id].team || '-',
        chestNo: embedded[id].chestNo || '',
        photoUrl: embedded[id].photoUrl || ''
      };
    }
    const student = students.find((s) => s.id === id || String(s.chestNo) === id || s.name === id);
    if (student) {
      return {
        id: student.id || id,
        name: student.name,
        team: student.team || '-',
        chestNo: student.chestNo || '',
        photoUrl: student.showPhotoInResults === false ? '' : (student.photoData || '')
      };
    }
    const reg = registrations.find((r) => r.id === id || `${r.team}-${r.slotIndex}` === id);
    if (reg) {
      const memberNames = (reg.studentIds || [])
        .map((sid) => students.find((s) => s.id === sid)?.name)
        .filter(Boolean);
      return {
        id,
        name: memberNames.length ? `${reg.team} (${memberNames.slice(0, 3).join(', ')}${memberNames.length > 3 ? '…' : ''})` : `${reg.team || 'Team'} Entry #${reg.slotIndex || 1}`,
        team: reg.team || '-',
        chestNo: reg.slotIndex ? `Entry ${reg.slotIndex}` : '',
        photoUrl: ''
      };
    }
    return { id, name: id, team: '-', chestNo: id, photoUrl: '' };
  };

  const legacyPlaces = raw.winners
    ? ['first', 'second', 'third'].flatMap((place, idx) => {
        const winners = Array.isArray(raw.winners[place]) ? raw.winners[place] : [raw.winners[place]].filter(Boolean);
        const resolved = winners.map(resolveWinner).filter(Boolean);
        return resolved.length
          ? [{ key: place, rank: idx + 1, label: ['First', 'Second', 'Third'][idx], value: 0, earnedValue: 0, winners: resolved }]
          : [];
      })
    : [];

  const normalizeAward = (award = {}, index = 0) => ({
    ...award,
    key: award.key || `place${index + 1}`,
    rank: Number(award.rank || index + 1),
    label: award.label || `Place ${index + 1}`,
    value: Number(award.value || 0),
    earnedValue: Number(award.earnedValue ?? award.value ?? 0),
    winners: (Array.isArray(award.winners) ? award.winners : [award.winners]).map(resolveWinner).filter(Boolean)
  });

  const places = Array.isArray(raw.places) && raw.places.length
    ? raw.places.map(normalizeAward).filter((p) => p.winners.length)
    : legacyPlaces;

  const gradeAwards = Array.isArray(raw.gradeAwards)
    ? raw.gradeAwards.map((grade = {}) => ({
        ...grade,
        value: Number(grade.value || 0),
        winners: (Array.isArray(grade.winners) ? grade.winners : [grade.winners]).map(resolveWinner).filter(Boolean)
      })).filter((g) => g.winners.length)
    : [];

  return {
    ...raw,
    id: raw.id || eventId,
    eventId,
    eventName,
    category: raw.category || event?.category || 'General',
    stage: raw.stage || event?.stage || 'On-Stage',
    gender: raw.gender || event?.gender || 'Both',
    type: raw.type || event?.type || 'Single',
    places,
    gradeAwards,
    status: raw.status || 'published',
    publishedAt: raw.publishedAt || raw.createdAt || null,
    updatedAt: raw.updatedAt || raw.publishedAt || raw.createdAt || null,
    updatedBy: raw.updatedBy || 'admin-ui'
  };
}

export function printPage(mode = '') {
  const className = mode ? `print-mode-${mode}` : '';
  const cleanup = () => {
    if (className) document.body.classList.remove(className);
    window.removeEventListener('afterprint', cleanup);
  };
  if (className) document.body.classList.add(className);
  window.addEventListener('afterprint', cleanup, { once: true });
  window.print();
  setTimeout(cleanup, 1000);
}
