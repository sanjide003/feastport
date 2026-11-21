// event-utils.js
// Clean Institutional Event Normalization & Validation

const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const key = (value) => clean(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export const EVENT_STATUSES = ['draft', 'needs_review', 'validated', 'registration_open', 'registration_closed', 'scheduled', 'judging', 'under_review', 'approved', 'published', 'archived'];
export const RESULT_METHODS = ['criteria', 'objective', 'direct_rank', 'elimination', 'time', 'count', 'manual', 'display_only'];

export function normalizeGender(value) {
  const v = key(value);
  if (['boy', 'boys', 'male'].includes(v)) return 'Boys';
  if (['girl', 'girls', 'female'].includes(v)) return 'Girls';
  if (v === 'mixed') return 'Mixed';
  return 'Both';
}

export function normalizeStage(value) {
  const v = key(value);
  if (['on', 'onstage', 'stage'].includes(v)) return 'On-Stage';
  if (['off', 'offstage', 'nonstage'].includes(v)) return 'Off-Stage';
  return clean(value) || 'On-Stage';
}

export function normalizeEventType(value) {
  const v = key(value);
  if (['group', 'team'].includes(v)) return 'Group';
  if (['single', 'individual', 'solo'].includes(v)) return 'Single';
  return 'Single';
}

export function normalizeResultMethod(value, name = '') {
  const v = key(value);
  const map = {
    criteria: 'criteria',
    criteriabased: 'criteria',
    objective: 'objective',
    test: 'objective',
    quiz: 'objective',
    direct: 'direct_rank',
    directrank: 'direct_rank',
    elimination: 'elimination',
    time: 'time',
    timebased: 'time',
    count: 'count',
    countbased: 'count',
    manual: 'manual',
    displayonly: 'display_only'
  };
  if (map[v]) return map[v];
  const n = key(name);
  if (n.includes('quiz') || n.includes('test')) return 'objective';
  if (n.includes('memory')) return 'count';
  return 'manual';
}

export function parseCriteria(value) {
  const lines = String(value ?? '').split(/\r?\n|;/).map((line) => line.trim()).filter(Boolean);
  const criteria = [];
  const unparsed = [];
  for (const line of lines) {
    const match = line.match(/^(.+?)\s*[-:=]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!match) {
      unparsed.push(line);
      continue;
    }
    criteria.push({
      key: `criterion_${criteria.length + 1}`,
      name: clean(match[1]),
      maximumMark: Number(match[2]),
      required: true,
      order: criteria.length + 1,
      tieBreakPriority: criteria.length + 1
    });
  }
  return {
    criteria,
    unparsed,
    total: criteria.reduce((sum, item) => sum + item.maximumMark, 0)
  };
}

export function normalizeEventRow(row = {}, context = {}) {
  const type = normalizeEventType(row.type);
  const parsed = parseCriteria(row.criteriaText);
  const maximum = Number(row.maximumMark || parsed.total || 100);
  const entriesPerTeam = Math.max(1, Number(row.entriesPerTeam || row.limit || 1));
  const membersPerEntry = type === 'Group' ? Math.max(2, Number(row.membersPerEntry || row.groupSize || 2)) : 1;

  return {
    ...row,
    name: clean(row.name),
    code: clean(row.code),
    section: clean(row.section) || 'General',
    category: clean(row.category) || context.category || '',
    gender: normalizeGender(row.gender || context.gender),
    stage: normalizeStage(row.stage || context.stage),
    type,
    entriesPerTeam,
    membersPerEntry,
    minimumMembers: Number(row.minimumMembers || membersPerEntry),
    maximumMembers: Number(row.maximumMembers || membersPerEntry),
    eligibleClasses: Array.isArray(row.eligibleClasses)
      ? row.eligibleClasses.map(clean).filter(Boolean)
      : clean(row.eligibleClasses).split(/[,;|]/).map(clean).filter(Boolean),
    participantTypes: ['student'],
    registrationChannels: Array.isArray(row.registrationChannels) && row.registrationChannels.length
      ? row.registrationChannels.map(clean).filter(Boolean)
      : clean(row.registrationChannels).split(/[,;|]/).map(clean).filter(Boolean),
    resultMethod: normalizeResultMethod(row.resultMethod, row.name),
    maximumMark: maximum,
    criteria: Array.isArray(row.criteria) && row.criteria.length ? row.criteria : parsed.criteria,
    criteriaUnparsed: parsed.unparsed,
    objectiveRule: row.objectiveRule || { correctMark: Number(row.correctMark || 1), wrongPenalty: Number(row.wrongPenalty || 0) },
    countRule: row.countRule || { wrongPenalty: Number(row.countPenalty || 0) },
    timeRule: row.timeRule || { direction: clean(row.timeDirection) === 'higher' ? 'higher' : 'lower' },
    multipleJudgeMethod: clean(row.multipleJudgeMethod) || 'default',
    tieBreakMethod: clean(row.tieBreakMethod) || 'default',
    gradeMode: clean(row.gradeMode) || 'default',
    scoreContribution: clean(row.scoreContribution) || 'default',
    duration: Number(row.duration || 0),
    preparationTime: Number(row.preparationTime || 0),
    rules: clean(row.rules || row.description || row.notes),
    resultWorkflow: clean(row.resultWorkflow) || 'judged',
    scheduleRequirement: clean(row.scheduleRequirement) || 'default',
    teamPolicy: clean(row.teamPolicy) || 'default',
    scoringPolicy: clean(row.scoringPolicy) || 'default',
    status: row.status || 'validated'
  };
}

export function eventDuplicateKey(event = {}) {
  return [key(event.name), key(event.category), key(event.gender), key(event.stage), key(event.type)].join('|');
}

export function validateEvent(event = {}, setup = {}, existing = []) {
  const errors = [];
  const warnings = [];
  if (!event.name) errors.push('Event Name is required');
  if (!event.category) errors.push('Category is required');
  if (setup.categories?.length && !['General', ...setup.categories].includes(event.category)) {
    errors.push('Unknown category');
  }
  if (!event.gender) errors.push('Gender is required');
  if (![...(setup.allowedGenders || ['Boys', 'Girls']), 'Both', 'Mixed'].includes(event.gender)) {
    errors.push('Unknown gender');
  }
  if (!['On-Stage', 'Off-Stage'].includes(event.stage)) errors.push('Stage Type must be On-Stage or Off-Stage');
  if (!['Single', 'Group'].includes(event.type)) errors.push('Event Type must be Single or Group');
  if (!RESULT_METHODS.includes(event.resultMethod || 'manual')) errors.push('Result Method is invalid');
  if (!Number.isFinite(Number(event.entriesPerTeam)) || Number(event.entriesPerTeam) < 1) {
    errors.push('Entries per Team must be at least 1');
  }
  if (event.type === 'Group' && Number(event.membersPerEntry) < 2) {
    errors.push('Group Members per Entry must be at least 2');
  }
  const minimum = Number(event.minimumMembers || 1);
  const maximum = Number(event.maximumMembers || event.membersPerEntry || 1);
  if (minimum < 1 || maximum < minimum) errors.push('Member limits are invalid');
  if (!Number.isFinite(Number(event.maximumMark)) || Number(event.maximumMark) <= 0) {
    errors.push('Maximum Mark must be positive');
  }
  if (event.resultMethod === 'criteria' && (event.criteria || []).length) {
    const total = (event.criteria || []).reduce((sum, item) => sum + Number(item.maximumMark || 0), 0);
    if (total !== Number(event.maximumMark)) {
      errors.push(`Criteria total ${total} must equal Maximum Mark ${event.maximumMark}`);
    }
  }
  if (event.criteriaUnparsed?.length) warnings.push('Some criteria lines need review');

  const duplicate = existing.find(
    (item) => item.id !== event.id && ((event.code && item.code === event.code) || eventDuplicateKey(item) === eventDuplicateKey(event))
  );
  if (duplicate) errors.push(`Duplicate event${duplicate.name ? `: ${duplicate.name}` : ''}`);

  return {
    errors,
    warnings,
    status: errors.length ? 'error' : warnings.length ? 'needs_review' : 'ready'
  };
}

export function eventToFirestore(event = {}, meta = {}) {
  const validation = meta.validation || { errors: [], warnings: [], status: 'ready' };
  const normalized = normalizeEventRow(event);
  return {
    code: normalized.code,
    name: normalized.name,
    section: normalized.section,
    category: normalized.category,
    gender: normalized.gender,
    type: normalized.type,
    stage: normalized.stage,
    limit: Number(normalized.entriesPerTeam || 1),
    groupSize: normalized.type === 'Group' ? Number(normalized.membersPerEntry || 2) : 1,
    minimumMembers: Number(normalized.minimumMembers || 1),
    maximumMembers: Number(normalized.maximumMembers || normalized.membersPerEntry || 1),
    eligibleClasses: normalized.eligibleClasses || [],
    allowedParticipantTypes: ['student'],
    allowedRegistrationChannels: normalized.registrationChannels?.length
      ? normalized.registrationChannels
      : (meta.setup?.registrationChannels || ['admin', 'teamLeader', 'self']),
    resultWorkflow: normalized.resultWorkflow || 'judged',
    resultMethod: normalized.resultMethod || 'manual',
    maximumMark: Number(normalized.maximumMark || 100),
    criteria: normalized.criteria || [],
    objectiveRule: normalized.objectiveRule || { correctMark: 1, wrongPenalty: 0 },
    countRule: normalized.countRule || { wrongPenalty: 0 },
    timeRule: normalized.timeRule || { direction: 'lower' },
    multipleJudgeMethod: normalized.multipleJudgeMethod || 'default',
    tieBreakMethod: normalized.tieBreakMethod || 'default',
    gradeMode: normalized.gradeMode || 'default',
    scoreContribution: normalized.scoreContribution || 'default',
    duration: Number(normalized.duration || 0),
    preparationTime: Number(normalized.preparationTime || 0),
    rules: normalized.rules || '',
    scheduleRequirement: normalized.scheduleRequirement || 'default',
    teamPolicy: normalized.teamPolicy || 'default',
    scoringPolicy: normalized.scoringPolicy || 'default',
    status: validation.status === 'ready' ? 'validated' : 'needs_review',
    validation: {
      errors: validation.errors,
      warnings: validation.warnings,
      validatedAt: validation.status === 'ready' ? Date.now() : 0
    },
    updatedAt: Date.now()
  };
}
