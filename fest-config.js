// fest-config.js
// Institutional Arts Fest Configuration & Policy Normalization

export const DEFAULT_PUBLIC_VIEW = Object.freeze({
  landing: {
    sections: { hero: true, about: true, leaders: true, gallery: true, schedule: true, teamStandings: true, footer: true },
    customLinks: []
  },
  resultsPage: {
    defaultTab: 'result',
    tabs: { result: true, team: true },
    resultsTab: {
      showCategories: true,
      includeGeneral: true,
      scoreDisplay: 'total',
      cardFields: { category: true, gender: true, team: true, chestNo: true, position: true, grade: true, totalPoints: true }
    },
    teamsTab: {
      cardFields: { rank: true, total: true, medals: true, progress: true },
      breakdowns: { overall: true, category: true, gender: true, awards: true },
      showTimeline: true
    }
  }
});

const mergePublicView = (raw = {}) => {
  const v = raw || {};
  const l = v.landing || {};
  const r = v.resultsPage || {};
  const rt = r.resultsTab || {};
  const tt = r.teamsTab || {};
  return {
    landing: {
      sections: { ...DEFAULT_PUBLIC_VIEW.landing.sections, ...(l.sections || {}) },
      customLinks: Array.isArray(l.customLinks)
        ? l.customLinks
            .filter((item) => String(item?.label || '').trim() && String(item?.url || '').trim())
            .map((item) => ({ label: String(item.label || '').trim(), url: String(item.url || '').trim() }))
        : []
    },
    resultsPage: {
      defaultTab: r.defaultTab === 'team' ? 'team' : 'result',
      tabs: { ...DEFAULT_PUBLIC_VIEW.resultsPage.tabs, ...(r.tabs || {}) },
      resultsTab: {
        ...DEFAULT_PUBLIC_VIEW.resultsPage.resultsTab,
        ...rt,
        cardFields: { ...DEFAULT_PUBLIC_VIEW.resultsPage.resultsTab.cardFields, ...(rt.cardFields || {}) }
      },
      teamsTab: {
        ...DEFAULT_PUBLIC_VIEW.resultsPage.teamsTab,
        ...tt,
        cardFields: { ...DEFAULT_PUBLIC_VIEW.resultsPage.teamsTab.cardFields, ...(tt.cardFields || {}) },
        breakdowns: { ...DEFAULT_PUBLIC_VIEW.resultsPage.teamsTab.breakdowns, ...(tt.breakdowns || {}) }
      }
    }
  };
};

export const DEFAULT_FEST_SETUP = Object.freeze({
  setupVersion: 3,
  preset: 'institutional_arts_fest',
  organisationMode: 'team',
  participantTypes: ['student'],
  allowedGenders: ['Boys', 'Girls'],
  registrationChannels: ['admin', 'teamLeader', 'self'],
  scheduleMode: 'full',
  judgingMode: 'enabled',
  resultWorkflow: 'hybrid',
  teamScoringMode: 'enabled',
  eligibleClasses: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '+1', '+2'],
  registrationApprovalRequired: true,
  competitionPolicies: {
    groupPositionPoints: { first: 10, second: 7, third: 5 },
    directRankGradeMode: 'disabled',
    minimumPositionPolicy: 'none',
    minimumPositionPercentage: null,
    jointPositionMethod: 'competition',
    multipleJudgeMethod: 'average',
    trimMinimumJudges: 5,
    generalGenderMode: 'both',
    publishedCorrectionMode: 'revision_reversal'
  },
  studentFields: [
    { key: 'name', label: 'Student Name', type: 'text', enabled: true, required: true, system: true },
    { key: 'class', label: 'Class', type: 'select', options: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '+1', '+2'], enabled: true, required: true, system: true },
    { key: 'guardianName', label: 'Guardian Name', type: 'text', enabled: true, required: false, system: false },
    { key: 'phone', label: 'Phone Number', type: 'tel', enabled: true, required: false, system: false }
  ],
  publicModules: { home: true, results: true, about: true, leaders: true, gallery: true, schedule: true, registration: true, login: true, teamStandings: true, tv: true },
  publicView: DEFAULT_PUBLIC_VIEW
});

const allowed = (value, choices, fallback) => (choices.includes(value) ? value : fallback);
const list = (value, choices, fallback) => {
  const clean = Array.isArray(value) ? [...new Set(value.filter((item) => choices.includes(item)))] : [];
  return clean.length ? clean : [...fallback];
};
const optionalChoice = (value, choices, fallback = '') => (choices.includes(value) ? value : fallback);
const optionalNumber = (value, fallback = null) =>
  value === '' || value === null || value === undefined || !Number.isFinite(Number(value)) ? fallback : Number(value);

export function normalizeCompetitionPolicies(value = {}) {
  const d = DEFAULT_FEST_SETUP.competitionPolicies;
  return {
    groupPositionPoints: {
      first: optionalNumber(value?.groupPositionPoints?.first, d.groupPositionPoints.first),
      second: optionalNumber(value?.groupPositionPoints?.second, d.groupPositionPoints.second),
      third: optionalNumber(value?.groupPositionPoints?.third, d.groupPositionPoints.third)
    },
    directRankGradeMode: optionalChoice(value.directRankGradeMode, ['disabled', 'manual', 'converted_score', 'per_event'], d.directRankGradeMode),
    minimumPositionPolicy: optionalChoice(value.minimumPositionPolicy, ['none', 'percentage', 'per_event'], d.minimumPositionPolicy),
    minimumPositionPercentage: optionalNumber(value.minimumPositionPercentage, d.minimumPositionPercentage),
    jointPositionMethod: optionalChoice(value.jointPositionMethod, ['competition', 'dense', 'shared_points', 'admin_manual', 'per_event'], d.jointPositionMethod),
    multipleJudgeMethod: optionalChoice(value.multipleJudgeMethod, ['average', 'trim_extremes', 'weighted', 'admin_manual', 'per_event'], d.multipleJudgeMethod),
    trimMinimumJudges: optionalNumber(value.trimMinimumJudges, d.trimMinimumJudges),
    generalGenderMode: optionalChoice(value.generalGenderMode, ['both', 'mixed', 'separate', 'admin_decision', 'per_event'], d.generalGenderMode),
    publishedCorrectionMode: optionalChoice(value.publishedCorrectionMode, ['revision_reversal', 'locked', 'admin_overwrite'], d.publishedCorrectionMode)
  };
}

export function incompleteCompetitionPolicies(value = {}) {
  const policy = normalizeCompetitionPolicies(value);
  const missing = [];
  if (['first', 'second', 'third'].some((k) => policy.groupPositionPoints[k] === null)) missing.push('Group position points');
  if (policy.minimumPositionPolicy === 'percentage' && (policy.minimumPositionPercentage === null || policy.minimumPositionPercentage < 0 || policy.minimumPositionPercentage > 100)) {
    missing.push('Minimum position percentage');
  }
  if (policy.multipleJudgeMethod === 'trim_extremes' && (!Number.isInteger(policy.trimMinimumJudges) || policy.trimMinimumJudges < 3)) {
    missing.push('Trim-method minimum judges');
  }
  return missing;
}

export function normalizeStudentFields(value) {
  const source = Array.isArray(value) && value.length ? value : DEFAULT_FEST_SETUP.studentFields;
  const clean = source
    .map((field, index) => {
      const key = String(field?.key || field?.label || `field_${index + 1}`)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
      const type = key === 'class' ? 'select' : allowed(field?.type, ['text', 'tel', 'email', 'number', 'date', 'select'], 'text');
      const options = type === 'select' && Array.isArray(field?.options)
        ? [...new Set(field.options.map((item) => String(item).trim()).filter(Boolean))].slice(0, 100)
        : [];
      return {
        key,
        label: String(field?.label || key).trim().slice(0, 60),
        type,
        options,
        enabled: field?.enabled !== false,
        required: !!field?.required,
        system: ['name', 'class', 'guardianName', 'phone'].includes(key) || !!field?.system
      };
    })
    .filter((field) => field.key && field.label);
  const unique = [...new Map(clean.map((field) => [field.key, field])).values()];
  const name = unique.find((field) => field.key === 'name') || { key: 'name', label: 'Student Name', type: 'text', enabled: true, required: true, system: true };
  name.enabled = true;
  name.required = true;
  name.system = true;
  return [name, ...unique.filter((field) => field.key !== 'name')];
}

export function normalizeFestSetup(raw = {}) {
  const base = DEFAULT_FEST_SETUP;
  const setup = {
    ...base,
    ...raw,
    organisationMode: allowed(raw.organisationMode, ['team', 'open', 'hybrid'], base.organisationMode),
    participantTypes: ['student'],
    allowedGenders: list(raw.allowedGenders, ['Boys', 'Girls'], base.allowedGenders),
    registrationChannels: list(raw.registrationChannels, ['admin', 'teamLeader', 'self'], base.registrationChannels),
    scheduleMode: allowed(raw.scheduleMode, ['disabled', 'basic', 'full'], base.scheduleMode),
    judgingMode: allowed(raw.judgingMode, ['disabled', 'enabled', 'optional'], base.judgingMode),
    resultWorkflow: allowed(raw.resultWorkflow, ['direct', 'judged', 'hybrid'], base.resultWorkflow),
    teamScoringMode: allowed(raw.teamScoringMode, ['disabled', 'enabled', 'per_event'], base.teamScoringMode),
    eligibleClasses: Array.isArray(raw.eligibleClasses)
      ? [...new Set(raw.eligibleClasses.map((v) => String(v).trim()).filter(Boolean))]
      : [...base.eligibleClasses],
    publicModules: { ...base.publicModules, ...(raw.publicModules || {}) },
    publicView: mergePublicView(raw.publicView),
    studentFields: normalizeStudentFields(raw.studentFields),
    competitionPolicies: normalizeCompetitionPolicies(raw.competitionPolicies)
  };
  const classField = setup.studentFields.find((field) => field.key === 'class');
  if (classField) {
    if (!classField.options.length && setup.eligibleClasses.length) {
      classField.options = [...setup.eligibleClasses];
    }
    setup.eligibleClasses = [...classField.options];
  }
  if (setup.judgingMode === 'disabled' && setup.resultWorkflow === 'judged') setup.resultWorkflow = 'direct';
  if (setup.scheduleMode === 'disabled') setup.publicModules.schedule = false;
  if (setup.organisationMode === 'open') {
    setup.registrationChannels = setup.registrationChannels.filter((c) => c !== 'teamLeader');
  }
  return setup;
}

export const scheduleEnabled = (setup) => normalizeFestSetup(setup).scheduleMode !== 'disabled';
export const judgingEnabled = (setup) => normalizeFestSetup(setup).judgingMode !== 'disabled';
export const directPublishingEnabled = (setup) => ['direct', 'hybrid'].includes(normalizeFestSetup(setup).resultWorkflow);
export const teamModeEnabled = (setup) => normalizeFestSetup(setup).organisationMode !== 'open';
export const selfRegistrationEnabled = (setup) => normalizeFestSetup(setup).registrationChannels.includes('self');

export function eventContributesToTeamScore(event = {}, setup = DEFAULT_FEST_SETUP) {
  const mode = normalizeFestSetup(setup).teamScoringMode;
  const policy = event.scoreContribution || 'default';
  if (policy === 'display_only' || policy === 'individual') return false;
  if (policy === 'team') return true;
  return mode === 'enabled';
}

export function readableTextColor(color = '#1D4ED8') {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : '1D4ED8';
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 >= 150 ? '#0F172A' : '#FFFFFF';
}

export const teamColor = (name, colors = {}) => (/^#[0-9a-f]{6}$/i.test(colors?.[name] || '') ? colors[name] : '#1D4ED8');
