// score-utils.js
// Scoring Rules, Multi-Judge Aggregation, Ranking, Team Ledger & Self-Contained Winner Snapshot

const POSITION_LABELS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];
const ordinal = (index) => POSITION_LABELS[index] || `${index + 1}${[11, 12, 13].includes((index + 1) % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[(index + 1) % 10] || 'th')}`;
const gradeName = (index) => (index < 26 ? `${String.fromCharCode(65 + index)} Grade` : `Grade ${index + 1}`);

export const defaultScoringRules = () => ({
  policyPack: 'custom',
  enabled: { points: true, grades: false },
  display: { showPointsPublicly: true, showGradesPublicly: true, showGradePointValuePublicly: false },
  tiePolicyDefault: 'full',
  roundingDecimals: 2,
  gradeThresholds: [
    { key: 'grade_A', label: 'A Grade', minimumPercentage: 80, value: 5 },
    { key: 'grade_B', label: 'B Grade', minimumPercentage: 70, value: 3 },
    { key: 'grade_C', label: 'C Grade', minimumPercentage: 60, value: 1 }
  ],
  policies: {
    minimumPositionPolicy: 'none',
    minimumPositionPercentage: null,
    jointPositionMethod: 'competition',
    multipleJudgeMethod: 'average',
    trimMinimumJudges: 5,
    directRankGradeMode: 'disabled',
    publishedCorrectionMode: 'revision_reversal'
  },
  configs: {
    Single: {
      points: [5, 3, 1].map((value, index) => ({ key: `position_${index + 1}`, rank: index + 1, label: ordinal(index), value, tiePolicy: 'full' })),
      grades: [5, 3, 1].map((value, index) => ({ key: `single_grade_${index + 1}`, order: index + 1, label: gradeName(index), minimumPercentage: [80, 70, 60][index], value }))
    },
    Group: {
      points: [10, 7, 5].map((value, index) => ({ key: `position_${index + 1}`, rank: index + 1, label: ordinal(index), value, tiePolicy: 'full' })),
      grades: [10, 7, 5].map((value, index) => ({ key: `group_grade_${index + 1}`, order: index + 1, label: gradeName(index), minimumPercentage: [80, 70, 60][index], value }))
    }
  }
});

export const placeKeyAt = (index) => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][index] || `place${index + 1}`;
const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

const normalizeRows = (rows, fallback, type = 'points', legacyThresholds = []) =>
  (Array.isArray(rows) && rows.length ? rows : fallback).map((row, index) =>
    type === 'points'
      ? { key: String(row?.key || `position_${index + 1}`), rank: index + 1, label: String(row?.label || ordinal(index)), value: finite(row?.value), tiePolicy: row?.tiePolicy === 'shared' ? 'shared' : 'full' }
      : {
          key: String(row?.key || legacyThresholds[index]?.key || fallback[index]?.key || `grade_${index + 1}`),
          order: index + 1,
          label: String(row?.label || legacyThresholds[index]?.label || gradeName(index)),
          minimumPercentage: finite(row?.minimumPercentage, legacyThresholds[index]?.minimumPercentage ?? fallback[index]?.minimumPercentage ?? [80, 70, 60][index] ?? 0),
          value: finite(row?.value)
        }
  );

export function normalizeScoringRules(raw = {}) {
  const d = defaultScoringRules();
  const legacyThresholds = (Array.isArray(raw.gradeThresholds) && raw.gradeThresholds.length ? raw.gradeThresholds : d.gradeThresholds).map((row, index) => ({
    key: String(row?.key || `grade_${index + 1}`),
    label: String(row?.label || gradeName(index)),
    minimumPercentage: finite(row?.minimumPercentage, [80, 70, 60][index] ?? 0),
    value: finite(row?.value, row?.points)
  }));
  const configs = {
    Single: {
      points: normalizeRows(raw.configs?.Single?.points, d.configs.Single.points),
      grades: normalizeRows(raw.configs?.Single?.grades, d.configs.Single.grades, 'grades', legacyThresholds)
    },
    Group: {
      points: normalizeRows(raw.configs?.Group?.points, d.configs.Group.points),
      grades: normalizeRows(raw.configs?.Group?.grades, d.configs.Group.grades, 'grades', legacyThresholds)
    }
  };
  for (const type of ['Single', 'Group']) {
    configs[type].grades.sort((a, b) => b.minimumPercentage - a.minimumPercentage).forEach((grade, index) => {
      grade.order = index + 1;
    });
  }
  const gradeThresholds = configs.Single.grades.map((grade) => ({
    key: grade.key,
    label: grade.label,
    minimumPercentage: grade.minimumPercentage,
    value: grade.value
  }));
  return {
    policyPack: String(raw.policyPack || d.policyPack),
    enabled: { ...d.enabled, ...raw.enabled },
    display: { ...d.display, ...raw.display },
    tiePolicyDefault: raw.tiePolicyDefault === 'shared' ? 'shared' : 'full',
    roundingDecimals: Math.min(4, Math.max(0, Math.trunc(finite(raw.roundingDecimals, d.roundingDecimals)))),
    gradeThresholds,
    policies: { ...d.policies, ...raw.policies, gradeCalculationMaximumMark: Math.max(1, finite(raw.policies?.gradeCalculationMaximumMark, 100)) },
    configs
  };
}

export function resolveEventScoring(rules, event = {}) {
  const normalized = normalizeScoringRules(rules);
  const override = event.scoringOverride && typeof event.scoringOverride === 'object' ? event.scoringOverride : {};
  const type = event.type === 'Group' ? 'Group' : 'Single';
  const policies = { ...normalized.policies, ...override.policies };
  const enabled = { ...normalized.enabled, ...override.enabled };
  if ((event.resultMethod === 'direct' || event.resultMethod === 'direct_rank' || event.scoringPolicy === 'direct_rank') && policies.directRankGradeMode === 'disabled') {
    enabled.grades = false;
  }
  return {
    ...normalized,
    enabled,
    policies,
    config: { ...normalized.configs[type], ...(override.config || {}) },
    eventType: type,
    scoreContribution: event.scoreContribution || 'default',
    resultMethod: event.resultMethod || 'default'
  };
}

export const scoringConfigForEvent = (rules, event = {}) => resolveEventScoring(rules, event).config;
export const scoringEnabled = (rules) => normalizeScoringRules(rules).enabled;

export function createScoringSnapshot(rules, event = {}) {
  const resolved = resolveEventScoring(rules, event);
  return JSON.parse(JSON.stringify({
    enabled: resolved.enabled,
    display: resolved.display,
    tiePolicyDefault: resolved.tiePolicyDefault,
    roundingDecimals: resolved.roundingDecimals,
    gradeThresholds: resolved.gradeThresholds,
    policies: resolved.policies,
    eventType: resolved.eventType,
    resultMethod: resolved.resultMethod,
    scoreContribution: resolved.scoreContribution,
    config: resolved.config
  }));
}

const round = (value, decimals = 2) => Number(Number(value || 0).toFixed(decimals));

export function aggregateJudgeScores(scoreSheets = [], policy = 'average', options = {}) {
  const submitted = scoreSheets.filter((score) => score?.status === 'submitted' || options.includeDrafts);
  const ids = [...new Set(submitted.flatMap((score) => (score.marks || []).map((mark) => mark.participantId)).filter(Boolean))];
  const minimum = finite(options.trimMinimumJudges, 5);
  return ids.map((participantId) => {
    const source = submitted
      .map((score) => {
        const mark = (score.marks || []).find((item) => item.participantId === participantId);
        return mark ? { judgeId: score.judgeId, value: finite(mark.rawMark, mark.mark), weight: finite(score.judgeWeight, 1), mark } : null;
      })
      .filter(Boolean);
    const values = source.map((item) => item.value);
    let used = [...source];
    let value = 0;
    if (policy === 'trim_extremes' && source.length >= minimum) {
      used = [...source].sort((a, b) => a.value - b.value).slice(1, -1);
      value = used.reduce((sum, item) => sum + item.value, 0) / used.length;
    } else if (policy === 'weighted') {
      const weight = source.reduce((sum, item) => sum + item.weight, 0);
      value = weight ? source.reduce((sum, item) => sum + item.value * item.weight, 0) / weight : 0;
    } else if (policy === 'admin_manual') {
      value = finite(options.manualMarks?.[participantId], values[0] || 0);
    } else {
      value = values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : 0;
    }
    return {
      participantId,
      mark: round(value, options.roundingDecimals ?? 2),
      judgeCount: source.length,
      usedJudgeIds: used.map((item) => item.judgeId),
      sourceMarks: values,
      evaluation: source.some((item) => item.mark.evaluation === 'disqualified')
        ? 'disqualified'
        : source.some((item) => item.mark.evaluation === 'absent')
        ? 'absent'
        : 'awarded'
    };
  });
}

export function gradeForMark(mark, maximumMark, rules, event = {}) {
  const resolved = resolveEventScoring(rules, event);
  if (!resolved.enabled.grades || !maximumMark) {
    return { key: '', label: '', value: 0, percentage: maximumMark ? round((finite(mark) / maximumMark) * 100, resolved.roundingDecimals) : 0 };
  }
  const percentage = round((finite(mark) / finite(maximumMark, 100)) * 100, resolved.roundingDecimals);
  const grade = (resolved.config.grades || []).find((item) => percentage >= item.minimumPercentage);
  return grade ? { key: grade.key, label: grade.label, value: finite(grade.value), percentage } : { key: '', label: '', value: 0, percentage };
}

export function rankMarks(marks = [], rules, event = {}) {
  const resolved = resolveEventScoring(rules, event);
  const policy = resolved.policies;
  const minimum = policy.minimumPositionPolicy === 'percentage' ? finite(policy.minimumPositionPercentage) : null;
  const maximum = finite(event.maximumMark, 100);
  const lowerWins = event.resultMethod === 'elimination' || (event.resultMethod === 'time' && event.timeRule?.direction !== 'higher');
  const eligible = marks
    .filter((mark) => !['absent', 'disqualified', 'withheld'].includes(mark.evaluation) && finite(mark.mark) >= 0)
    .filter((mark) => minimum === null || lowerWins || (finite(mark.mark) / maximum) * 100 >= minimum)
    .sort((a, b) => (lowerWins ? finite(a.mark) - finite(b.mark) : finite(b.mark) - finite(a.mark)));
  let denseRank = 0;
  let previous = null;
  let competitionRank = 0;
  return eligible
    .map((mark, index) => {
      if (previous === null || finite(mark.mark) !== previous) {
        denseRank++;
        competitionRank = index + 1;
      }
      const rank = policy.jointPositionMethod === 'dense' ? denseRank : competitionRank;
      previous = finite(mark.mark);
      return { ...mark, rank, label: ordinal(rank - 1) };
    })
    .filter((mark) => mark.rank <= (resolved.config.points.length || 3));
}

export function calculateEventOutcome({ scoreSheets = [], event = {}, rules = {}, manualMarks = {} } = {}) {
  const resolved = resolveEventScoring(rules, event);
  const aggregated = aggregateJudgeScores(scoreSheets, resolved.policies.multipleJudgeMethod, {
    trimMinimumJudges: resolved.policies.trimMinimumJudges,
    roundingDecimals: resolved.roundingDecimals,
    manualMarks
  });
  const ranked = rankMarks(aggregated, rules, event);
  const marks = aggregated.map((mark) => ({ ...mark, ...gradeForMark(mark.mark, event.maximumMark || 100, rules, event) }));
  const places = [];
  for (const rankedMark of ranked) {
    const rule = resolved.config.points[rankedMark.rank - 1];
    if (!rule) continue;
    let place = places.find((item) => item.rank === rankedMark.rank);
    if (!place) {
      place = {
        key: rule.key || placeKeyAt(rankedMark.rank - 1),
        rank: rankedMark.rank,
        label: rule.label || ordinal(rankedMark.rank - 1),
        value: finite(rule.value),
        tiePolicy: rule.tiePolicy || resolved.tiePolicyDefault,
        winners: []
      };
      places.push(place);
    }
    place.winners.push(rankedMark.participantId);
  }
  places.forEach((place) => {
    place.earnedValue = place.tiePolicy === 'shared' ? round(place.value / place.winners.length, resolved.roundingDecimals) : place.value;
  });
  const gradeAwards = resolved.enabled.grades
    ? (resolved.config.grades || [])
        .map((grade) => {
          const winners = marks.filter((mark) => mark.key === grade.key);
          return {
            key: grade.key,
            label: grade.label,
            minimumPercentage: grade.minimumPercentage,
            value: grade.value,
            winners: winners.map((mark) => mark.participantId)
          };
        })
        .filter((item) => item.winners.length)
    : [];
  return { marks, places, gradeAwards, scoringSnapshot: createScoringSnapshot(rules, event) };
}

export function judgeScoreToResult(score = {}, event = {}, rules = {}, options = {}) {
  if (options.scoreSheets?.length) {
    return calculateEventOutcome({ scoreSheets: options.scoreSheets, event, rules, manualMarks: options.manualMarks });
  }
  const snapshot = score.scoringSnapshot || createScoringSnapshot(rules, event);
  const resolved = resolveEventScoring({ ...rules, ...snapshot }, event);
  const marks = Array.isArray(score.marks) ? score.marks : [];
  const hasExplicitAwards = marks.some((mark) => mark.position || mark.grade);
  const hasRaw = marks.some((mark) => mark.rawMark !== undefined || (!mark.position && !mark.grade && mark.mark !== undefined));
  if (hasRaw && !hasExplicitAwards) {
    return calculateEventOutcome({ scoreSheets: [{ ...score, status: 'submitted' }], event, rules });
  }
  const places = (resolved.config.points || [])
    .map((point, index) => {
      const winners = marks.filter((mark) => mark.position === point.label).map((mark) => mark.participantId).filter(Boolean);
      return winners.length
        ? {
            key: point.key || placeKeyAt(index),
            rank: index + 1,
            label: point.label,
            value: finite(point.value),
            tiePolicy: point.tiePolicy || resolved.tiePolicyDefault,
            earnedValue: (point.tiePolicy || resolved.tiePolicyDefault) === 'shared' ? round(finite(point.value) / winners.length, resolved.roundingDecimals) : finite(point.value),
            winners
          }
        : null;
    })
    .filter(Boolean);
  const gradeAwards = resolved.enabled.grades
    ? (resolved.config.grades || [])
        .map((grade, index) => ({
          key: grade.key || `grade_${index + 1}`,
          label: grade.label,
          minimumPercentage: grade.minimumPercentage ?? null,
          value: finite(grade.value),
          winners: marks.filter((mark) => mark.grade === grade.label).map((mark) => mark.participantId).filter(Boolean)
        }))
        .filter((item) => item.winners.length)
    : [];
  return { places, gradeAwards, scoringSnapshot: snapshot };
}

export function resolveWinnerDetails(places = [], gradeAwards = [], { students = [], registrations = [], event = {} } = {}) {
  const details = {};
  const ids = new Set([
    ...(places || []).flatMap((p) => p.winners || []),
    ...(gradeAwards || []).flatMap((g) => g.winners || [])
  ]);
  for (const rawId of ids) {
    const id = typeof rawId === 'object' ? (rawId.id || rawId.participantId || '') : String(rawId || '');
    if (!id) continue;
    if (typeof rawId === 'object' && rawId.name) {
      details[id] = {
        name: rawId.name,
        team: rawId.team || '-',
        chestNo: rawId.chestNo || '',
        photoUrl: rawId.photoUrl || ''
      };
      continue;
    }
    const student = students.find((s) => s.id === id || String(s.chestNo) === id);
    if (student) {
      details[id] = {
        name: student.name || 'Student',
        team: student.team || '-',
        chestNo: student.chestNo || '',
        photoUrl: student.showPhotoInResults === false ? '' : (student.photoData || '')
      };
      continue;
    }
    const reg = registrations.find((r) => r.id === id || `${r.team}-${r.slotIndex}` === id);
    if (reg) {
      const members = (reg.studentIds || []).map((sid) => students.find((s) => s.id === sid)?.name).filter(Boolean);
      details[id] = {
        name: members.length ? `${reg.team} (${members.slice(0, 3).join(', ')}${members.length > 3 ? '…' : ''})` : `${reg.team || 'Team'} Entry #${reg.slotIndex || 1}`,
        team: reg.team || '-',
        chestNo: reg.slotIndex ? `Entry ${reg.slotIndex}` : '',
        photoUrl: '',
        memberCount: (reg.studentIds || []).length
      };
      continue;
    }
    details[id] = {
      name: event.type === 'Group' ? `${id} Group` : id,
      team: '-',
      chestNo: '',
      photoUrl: ''
    };
  }
  return details;
}

export function buildTeamScoreLedger(results = [], lookupTeam = () => '', events = []) {
  const ledger = [];
  for (const result of results.filter((item) => !item.status || item.status === 'published')) {
    const event = events.find((item) => item.id === (result.eventId || result.id)) || result;
    if (event.scoreContribution === 'individual' || event.scoreContribution === 'display_only') continue;
    for (const place of result.places || []) {
      for (const winner of place.winners || []) {
        const team = result.winnerDetails?.[winner]?.team || lookupTeam(winner, event.type, result);
        if (team && team !== '-') {
          ledger.push({
            key: `${result.eventId}:position:${place.rank || place.key}:${team}`,
            eventId: result.eventId,
            team,
            kind: 'position',
            points: finite(place.earnedValue ?? place.value),
            winner
          });
        }
      }
    }
    for (const grade of result.gradeAwards || []) {
      for (const winner of grade.winners || []) {
        const team = result.winnerDetails?.[winner]?.team || lookupTeam(winner, event.type, result);
        if (team && team !== '-') {
          ledger.push({
            key: `${result.eventId}:grade:${grade.label}:${team}`,
            eventId: result.eventId,
            team,
            kind: 'grade',
            points: finite(grade.value),
            winner
          });
        }
      }
    }
  }
  const unique = new Map();
  for (const item of ledger) {
    const k = (events.find((event) => event.id === item.eventId)?.type === 'Group' || item.groupEntry)
      ? `${item.eventId}:${item.kind}:${item.team}:${item.key.split(':')[2]}`
      : item.key;
    if (!unique.has(k)) unique.set(k, item);
  }
  return [...unique.values()];
}

export function createResultRevision(previous, next, { actorUid = '', reason = '', timestamp = Date.now() } = {}) {
  if (!reason || reason.trim().length < 5) {
    throw new Error('A revision reason of at least 5 characters is required');
  }
  const revision = finite(previous?.revision, 0) + 1;
  return {
    ...next,
    revision,
    previousRevision: previous
      ? {
          revision: finite(previous.revision, 0),
          places: previous.places || [],
          gradeAwards: previous.gradeAwards || [],
          status: previous.status || 'published',
          publishedAt: previous.publishedAt || 0
        }
      : null,
    revisionReason: reason.trim(),
    revisedByUid: actorUid,
    revisedAt: timestamp
  };
}
