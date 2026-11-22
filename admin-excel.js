import './dependency-loader.js';
import { collection, doc, writeBatch } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { invalidateCache } from './data-cache.js';
import { escapeHtml, resolveDisplayName } from './admin-utils.js';
import {
  eventDuplicateKey,
  eventToFirestore,
  normalizeEventRow,
  normalizeGender,
  normalizeResultMethod,
  normalizeStage,
  parseCriteria,
  validateEvent
} from './event-utils.js';
import {
  DEFAULT_CLASS_LIST,
  buildStudentDetailsPatch,
  getStudentFieldVisibility,
  normalizeCategoryClassificationConfig,
  normalizeChestConfig,
  normalizeClassValue,
  resolveCategoryFromStudentInputs,
  resolveNextAutoChestNo,
  studentClassValue,
  studentDobValue,
  validateManualChestNo
} from './admin-students.js';

const h = escapeHtml;
const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const normKey = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_24_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const BATCH_LIMIT = 350;

const isAutoChestActive = (state) =>
  normalizeChestConfig(state?.chestNumberConfig || state?.generalConfig?.chestNumberConfig || {}).enabled;

const getClassificationConfig = (state) =>
  normalizeCategoryClassificationConfig(
    state?.categoryClassification || state?.generalConfig?.categoryClassification || {},
    state?.festSetup?.eligibleClasses
  );

const METHOD_OPTIONS = [
  { value: 'criteria', label: 'Criteria Scoring' },
  { value: 'direct_rank', label: 'Direct Rank' },
  { value: 'objective', label: 'Objective / Quiz' },
  { value: 'time', label: 'Time Based' },
  { value: 'count', label: 'Count Based' },
  { value: 'manual', label: 'Manual' }
];

const SCHEDULE_STATUS_OPTIONS = ['scheduled', 'unscheduled', 'completed', 'cancelled'];

const SCHEMAS = {
  students: {
    label: 'Students',
    sheetName: 'Students',
    filePrefix: 'students',
    commitLabel: 'Import Valid Students',
    fields: [
      { key: 'chestNo', label: 'Chest No', required: true, width: 'w-28', aliases: ['chestno', 'chest', 'chestnumber', 'rollno', 'regno', 'id', 'bib'] },
      { key: 'name', label: 'Full Name', required: true, width: 'w-48', aliases: ['fullname', 'name', 'studentname', 'participant', 'participantname', 'student'] },
      { key: 'team', label: 'Team', required: true, width: 'w-36', aliases: ['team', 'house', 'teamkey', 'teamname', 'housename', 'group'] },
      { key: 'category', label: 'Category', required: true, width: 'w-36', aliases: ['category', 'cat', 'categorykey', 'categoryname', 'wing', 'section'] },
      { key: 'gender', label: 'Gender', required: true, width: 'w-28', aliases: ['gender', 'sex'] }
    ]
  },
  events: {
    label: 'Events',
    sheetName: 'Events',
    filePrefix: 'events',
    commitLabel: 'Import Valid Events',
    fields: [
      { key: 'name', label: 'Event Name', required: true, width: 'w-48', aliases: ['eventname', 'name', 'event', 'item', 'itemname', 'program'] },
      { key: 'category', label: 'Category', required: true, width: 'w-36', aliases: ['category', 'cat', 'categorykey', 'categoryname', 'wing', 'section'] },
      { key: 'gender', label: 'Gender', required: false, width: 'w-28', aliases: ['gender', 'sex'] },
      { key: 'type', label: 'Type', required: false, width: 'w-28', aliases: ['type', 'eventtype', 'format'] },
      { key: 'stage', label: 'Stage Type', required: false, width: 'w-32', aliases: ['stagetype', 'stage', 'venuetype'] },
      { key: 'limit', label: 'Entries / Team', required: false, width: 'w-24', aliases: ['entriesperteam', 'limit', 'slots', 'maxentries', 'entries'] },
      { key: 'groupSize', label: 'Members / Entry', required: false, width: 'w-24', aliases: ['membersperentry', 'groupsize', 'members', 'participants'] },
      { key: 'resultMethod', label: 'Judging Method', required: false, width: 'w-36', aliases: ['judgingmethod', 'resultmethod', 'method', 'scoring', 'scoringmethod'] },
      { key: 'maximumMark', label: 'Max Mark', required: false, width: 'w-24', aliases: ['maximummark', 'maxmark', 'totalmarks', 'marks', 'max'] },
      { key: 'criteriaText', label: 'Criteria', required: false, width: 'w-48', aliases: ['criteria', 'criterialist', 'judgingcriteria', 'rubric'] },
      { key: 'rules', label: 'Rules / Notes', required: false, width: 'w-44', aliases: ['rulesnotes', 'rules', 'notes', 'description'] }
    ]
  },
  schedule: {
    label: 'Schedule',
    sheetName: 'Schedule',
    filePrefix: 'schedule',
    commitLabel: 'Apply Schedule Updates',
    fields: [
      { key: 'eventId', label: 'Event ID', required: false, width: 'w-36', aliases: ['eventid', 'id', 'docid'] },
      { key: 'eventName', label: 'Event Name', required: true, width: 'w-48', aliases: ['eventname', 'event', 'name', 'item', 'itemname'] },
      { key: 'category', label: 'Category', required: false, width: 'w-32', aliases: ['category', 'cat', 'wing'] },
      { key: 'scheduleDate', label: 'Date (YYYY-MM-DD)', required: true, width: 'w-36', aliases: ['dateyyyymmdd', 'date', 'scheduledate', 'day'] },
      { key: 'scheduleStage', label: 'Stage', required: true, width: 'w-36', aliases: ['stage', 'schedulestage', 'venue', 'hall'] },
      { key: 'time', label: 'Start Time (HH:MM)', required: true, width: 'w-32', aliases: ['starttimehhmm', 'starttime', 'time', 'start'] },
      { key: 'scheduleDuration', label: 'Duration (min)', required: false, width: 'w-28', aliases: ['durationmin', 'durationm', 'duration', 'minutes', 'mins'] },
      { key: 'scheduleStatus', label: 'Status', required: false, width: 'w-32', aliases: ['schedulestatus', 'status'] }
    ]
  }
};

const STUDENT_OPTIONAL_FIELDS = {
  class: { key: 'class', label: 'Class', required: false, width: 'w-28', aliases: ['class', 'std', 'standard', 'gradelevel', 'classname'] },
  dob: { key: 'dob', label: 'Date of Birth (YYYY-MM-DD)', required: false, width: 'w-36', aliases: ['dob', 'dateofbirth', 'birthdate', 'birthday'] }
};

function getAllMappableFields(scope) {
  if (scope !== 'students') return SCHEMAS[scope].fields;
  const base = SCHEMAS.students.fields;
  return [base[0], base[1], base[2], STUDENT_OPTIONAL_FIELDS.class, STUDENT_OPTIONAL_FIELDS.dob, base[3], base[4]];
}

function getScopeFields(scope, state, { rows = [], columnMap = {}, includeExistingStudentMeta = false } = {}) {
  const base = SCHEMAS[scope].fields;
  if (scope !== 'students') return base;
  const clsCfg = getClassificationConfig(state);
  const vis = getStudentFieldVisibility(clsCfg);
  const hasClassData = Boolean(columnMap?.class)
    || rows.some((r) => clean(r?.data?.class))
    || (includeExistingStudentMeta && (state?.students || []).some((s) => Boolean(studentClassValue(s))));
  const hasDobData = Boolean(columnMap?.dob)
    || rows.some((r) => clean(r?.data?.dob))
    || (includeExistingStudentMeta && (state?.students || []).some((s) => Boolean(studentDobValue(s))));
  const fields = [base[0], base[1], base[2]];
  if (vis.showClass || hasClassData) fields.push(STUDENT_OPTIONAL_FIELDS.class);
  if (vis.showDob || hasDobData) fields.push(STUDENT_OPTIONAL_FIELDS.dob);
  fields.push(base[3], base[4]);
  return fields;
}

async function ensureXlsx() {
  if (window.XLSX) return window.XLSX;
  if (window.ensureAdminDependencies) {
    await window.ensureAdminDependencies(['xlsx']);
  }
  if (!window.XLSX) {
    throw new Error('Excel engine could not be loaded. Check your internet connection and retry.');
  }
  return window.XLSX;
}

function makeBlankRow(scope, state) {
  if (scope === 'students') {
    const clsCfg = getClassificationConfig(state);
    return {
      chestNo: '',
      name: '',
      team: state.teams?.[0] || '',
      class: '',
      dob: '',
      category: clsCfg.mode === 'manual' ? (state.categories?.[0] || '') : '',
      gender: 'Boys'
    };
  }
  if (scope === 'events') {
    return {
      name: '',
      category: state.categories?.[0] || '',
      gender: 'Both',
      type: 'Single',
      stage: 'On-Stage',
      limit: '1',
      groupSize: '1',
      resultMethod: 'criteria',
      maximumMark: '100',
      criteriaText: '',
      rules: ''
    };
  }
  return {
    eventId: '',
    eventName: '',
    category: '',
    scheduleDate: state.days?.[0]?.date || state.days?.[0] || '',
    scheduleStage: state.stages?.[0] || 'Main Stage',
    time: '09:30',
    scheduleDuration: '30',
    scheduleStatus: 'scheduled'
  };
}

function resolveConfiguredOption(raw, keys = [], displayNames = {}, extras = []) {
  const val = clean(raw);
  if (!val) return { matched: false, value: '' };
  const target = val.toLowerCase();
  const candidates = [...new Set([...(keys || []), ...(extras || [])])];
  for (const k of candidates) {
    if (String(k).toLowerCase() === target) return { matched: true, value: k };
  }
  for (const k of keys || []) {
    const label = clean(displayNames?.[k]);
    if (label && label.toLowerCase() === target) return { matched: true, value: k };
  }
  return { matched: false, value: val };
}

function normalizeStudentGenderStrict(raw) {
  const k = normKey(raw);
  if (['boy', 'boys', 'male', 'm', 'b'].includes(k)) return { valid: true, value: 'Boys' };
  if (['girl', 'girls', 'female', 'f', 'g'].includes(k)) return { valid: true, value: 'Girls' };
  return { valid: false, value: clean(raw) };
}

function parseExcelDateCell(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 80000) {
    const utcMs = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(utcMs);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const str = clean(value);
  if (!str) return '';
  if (DATE_REGEX.test(str)) return str;
  const dmy = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    const mNum = Number(mm);
    const dNum = Number(dd);
    if (mNum >= 1 && mNum <= 12 && dNum >= 1 && dNum <= 31) {
      return `${yyyy}-${String(mNum).padStart(2, '0')}-${String(dNum).padStart(2, '0')}`;
    }
  }
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime()) && /\d{4}/.test(str)) {
    return parsed.toISOString().slice(0, 10);
  }
  return str;
}

function parseExcelTimeCell(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1.5) {
    const frac = value % 1;
    const totalMins = Math.round(frac * 24 * 60) % (24 * 60);
    const hh = Math.floor(totalMins / 60);
    const mm = totalMins % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  const str = clean(value);
  if (!str) return '';
  const ampm = str.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (ampm) {
    let hh = Number(ampm[1]);
    const mm = Number(ampm[2]);
    const mod = ampm[3].toUpperCase();
    if (hh >= 1 && hh <= 12 && mm >= 0 && mm <= 59) {
      if (mod === 'PM' && hh < 12) hh += 12;
      if (mod === 'AM' && hh === 12) hh = 0;
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
  }
  const h24 = str.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?$/);
  if (h24) {
    const hh = Number(h24[1]);
    const mm = Number(h24[2]);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
  }
  return str;
}

function timeToMinutes(hhmm) {
  const m = String(hhmm || '').match(TIME_24_REGEX);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function autoMapHeaders(headers, scope) {
  const fields = getAllMappableFields(scope);
  const mapping = {};
  const usedHeaders = new Set();
  for (const field of fields) {
    const exactMatch = headers.find((hdr) => !usedHeaders.has(hdr) && normKey(hdr) === normKey(field.label));
    if (exactMatch) {
      mapping[field.key] = exactMatch;
      usedHeaders.add(exactMatch);
      continue;
    }
    const aliasMatch = headers.find((hdr) => !usedHeaders.has(hdr) && field.aliases.includes(normKey(hdr)));
    if (aliasMatch) {
      mapping[field.key] = aliasMatch;
      usedHeaders.add(aliasMatch);
      continue;
    }
    const fuzzyMatch = headers.find((hdr) => !usedHeaders.has(hdr) && field.aliases.some((al) => normKey(hdr).includes(al)));
    mapping[field.key] = fuzzyMatch || '';
    if (fuzzyMatch) usedHeaders.add(fuzzyMatch);
  }
  return mapping;
}

export function validateScopeRows(scope, rows, state) {
  if (!rows.length) {
    return { total: 0, ready: 0, errors: 0, warnings: 0, skipped: 0 };
  }

  if (scope === 'students') {
    const chestCfg = normalizeChestConfig(state.chestNumberConfig || state.generalConfig?.chestNumberConfig || {});
    const clsCfg = getClassificationConfig(state);
    const existingByChest = new Map();
    (state.students || []).forEach((s) => {
      const k = clean(s.chestNo).toLowerCase();
      if (k) existingByChest.set(k, s);
    });
    const sheetChestFirstRow = new Map();

    // First pass: normalize Class & DOB, and resolve blank/auto Category from active classification rules
    rows.forEach((row) => {
      if (row.skip) return;
      const normClass = normalizeClassValue(row.data.class, clsCfg.classes);
      if (normClass) row.data.class = normClass;
      const parsedDob = parseExcelDateCell(row.data.dob);
      if (clean(row.data.dob)) row.data.dob = parsedDob;

      if (clsCfg.mode !== 'manual' && (!clean(row.data.category) || row._autoCat)) {
        const autoCat = resolveCategoryFromStudentInputs({
          config: clsCfg,
          categories: state.categories,
          classValue: normClass,
          dobValue: parsedDob
        });
        if (autoCat.matched && (!(state.categories || []).length || state.categories.includes(autoCat.category))) {
          row.data.category = autoCat.category;
          row._autoCat = true;
        } else if (row._autoCat) {
          row.data.category = '';
          row._autoCat = false;
        }
      }
    });

    // Reserve all explicit (non-blank) Chest Nos in the sheet first so blank auto-assigned rows never collide with them.
    const autoPool = [...(state.students || [])];
    rows.forEach((row) => {
      if (row.skip) return;
      const explicitChest = clean(row.data.chestNo);
      if (!explicitChest) return;
      const tRes = resolveConfiguredOption(row.data.team, state.teams, state.teamDisplayNames);
      const cRes = resolveConfiguredOption(row.data.category, state.categories, state.categoryDisplayNames);
      const gRes = normalizeStudentGenderStrict(row.data.gender);
      autoPool.push({
        chestNo: explicitChest,
        team: tRes.matched ? tRes.value : clean(row.data.team),
        category: cRes.matched ? cRes.value : clean(row.data.category),
        gender: gRes.valid ? gRes.value : 'Boys'
      });
    });

    rows.forEach((row, index) => {
      row.errors = {};
      row.warnings = {};
      row.normalized = {};
      if (row.skip) {
        row.status = 'skipped';
        return;
      }

      const chestNo = clean(row.data.chestNo);
      const name = clean(row.data.name);
      const classValue = normalizeClassValue(row.data.class, clsCfg.classes);
      const dobRaw = clean(row.data.dob);
      const dobParsed = parseExcelDateCell(dobRaw);
      const dobValid = !dobParsed || (DATE_REGEX.test(dobParsed) && !Number.isNaN(new Date(`${dobParsed}T00:00:00Z`).getTime()));
      const teamRes = resolveConfiguredOption(row.data.team, state.teams, state.teamDisplayNames);
      const catRes = resolveConfiguredOption(row.data.category, state.categories, state.categoryDisplayNames);
      const genderRes = normalizeStudentGenderStrict(row.data.gender);

      const details = buildStudentDetailsPatch({}, {
        classValue,
        dobValue: dobValid ? dobParsed : ''
      });

      row.normalized = {
        chestNo,
        name,
        team: teamRes.value,
        category: catRes.value,
        gender: genderRes.value,
        class: classValue,
        dob: dobValid ? dobParsed : '',
        details
      };
      if (teamRes.matched) row.data.team = teamRes.value;
      if (catRes.matched) row.data.category = catRes.value;
      if (genderRes.valid) row.data.gender = genderRes.value;

      if (!name) {
        row.errors.name = 'Full Name is required';
      } else if (name.length > 140) {
        row.errors.name = 'Full Name must be 140 characters or fewer';
      }

      if (dobParsed && !dobValid) {
        row.errors.dob = 'Invalid Date of Birth — use YYYY-MM-DD';
      }

      if (!clean(row.data.team)) {
        row.errors.team = 'Team is required';
      } else if ((state.teams || []).length && !teamRes.matched) {
        row.errors.team = `Unknown team "${row.data.team}"`;
      }

      if (!clean(row.data.category)) {
        row.errors.category = clsCfg.mode === 'class'
          ? 'Category required (select Class to auto-assign or choose Category)'
          : clsCfg.mode === 'dob'
            ? 'Category required (enter DOB to auto-assign or choose Category)'
            : 'Category is required';
      } else if ((state.categories || []).length && !catRes.matched) {
        row.errors.category = `Unknown category "${row.data.category}"`;
      }

      if (!clean(row.data.gender)) {
        row.errors.gender = 'Gender is required';
      } else if (!genderRes.valid) {
        row.errors.gender = 'Gender must be Boys or Girls';
      }

      if (chestNo) {
        const formatCheck = validateManualChestNo(chestNo, state.students);
        if (!formatCheck.ok) {
          row.errors.chestNo = formatCheck.error;
        } else {
          const lower = chestNo.toLowerCase();
          if (existingByChest.has(lower)) {
            const dbMatch = existingByChest.get(lower);
            row.errors.chestNo = `Duplicate Chest No (exists for ${dbMatch.name || 'another student'})`;
          } else if (sheetChestFirstRow.has(lower)) {
            row.errors.chestNo = `Duplicate Chest No in sheet (Row ${sheetChestFirstRow.get(lower) + 1})`;
          } else {
            sheetChestFirstRow.set(lower, index);
            row.normalized.chestNo = formatCheck.chestNo;
          }
        }
      } else if (chestCfg.enabled) {
        const hasValidMeta =
          !row.errors.team &&
          !row.errors.category &&
          !row.errors.gender &&
          teamRes.value &&
          catRes.value &&
          genderRes.valid;
        if (!hasValidMeta) {
          row.errors.chestNo = 'Select valid Team, Category & Gender to auto-assign Chest No';
        } else {
          const autoRes = resolveNextAutoChestNo({
            config: chestCfg,
            students: autoPool,
            team: teamRes.value,
            category: catRes.value,
            gender: genderRes.value
          });
          if (autoRes.ok) {
            row.normalized.chestNo = autoRes.chestNo;
            autoPool.push({
              chestNo: autoRes.chestNo,
              team: teamRes.value,
              category: catRes.value,
              gender: genderRes.value
            });
          } else {
            row.errors.chestNo = autoRes.reason;
          }
        }
      } else {
        row.errors.chestNo = 'Chest No is required';
      }

      row.status = Object.keys(row.errors).length ? 'error' : Object.keys(row.warnings).length ? 'warning' : 'ready';
    });
  } else if (scope === 'events') {
    const existingKeys = new Map();
    (state.events || []).forEach((ev) => {
      existingKeys.set(eventDuplicateKey(ev), ev);
    });
    const sheetEventKeys = new Map();

    rows.forEach((row, index) => {
      row.errors = {};
      row.warnings = {};
      row.normalized = {};
      if (row.skip) {
        row.status = 'skipped';
        return;
      }

      const rawCat = clean(row.data.category);
      const catRes = resolveConfiguredOption(rawCat, state.categories, state.categoryDisplayNames, ['General']);
      if (catRes.matched) row.data.category = catRes.value;

      const rawGender = clean(row.data.gender || 'Both');
      const rawType = clean(row.data.type || 'Single');
      const rawStage = clean(row.data.stage || 'On-Stage');
      const rawMethod = clean(row.data.resultMethod || 'criteria');
      const normGenderVal = normalizeGender(rawGender);
      const normTypeVal = /^group$|^team$/i.test(rawType) ? 'Group' : /^single$|^individual$|^solo$/i.test(rawType) ? 'Single' : rawType;
      const normStageVal = normalizeStage(rawStage);
      const normMethodVal = normalizeResultMethod(rawMethod, row.data.name);

      if (['Both', 'Boys', 'Girls', 'Mixed'].includes(normGenderVal)) row.data.gender = normGenderVal;
      if (['Single', 'Group'].includes(normTypeVal)) row.data.type = normTypeVal;
      if (['On-Stage', 'Off-Stage'].includes(normStageVal)) row.data.stage = normStageVal;
      row.data.resultMethod = normMethodVal;

      const parsedCriteria = parseCriteria(row.data.criteriaText || '');
      const limitNum = Number(row.data.limit === '' ? 1 : row.data.limit);
      const groupSizeNum = Number(row.data.groupSize === '' ? (normTypeVal === 'Group' ? 2 : 1) : row.data.groupSize);
      const maxMarkNum = Number(row.data.maximumMark === '' ? (parsedCriteria.total || 100) : row.data.maximumMark);

      const candidate = normalizeEventRow({
        name: row.data.name,
        category: catRes.matched ? catRes.value : rawCat,
        gender: normGenderVal,
        type: normTypeVal,
        stage: normStageVal,
        entriesPerTeam: limitNum,
        membersPerEntry: groupSizeNum,
        minimumMembers: normTypeVal === 'Group' ? groupSizeNum : 1,
        maximumMembers: normTypeVal === 'Group' ? groupSizeNum : 1,
        resultMethod: normMethodVal,
        maximumMark: maxMarkNum,
        criteriaText: row.data.criteriaText,
        criteria: parsedCriteria.criteria,
        rules: row.data.rules
      });

      const validation = validateEvent(candidate, { ...(state.festSetup || {}), categories: state.categories || [] }, []);

      if (!candidate.name) {
        row.errors.name = 'Event Name is required';
      } else if (candidate.name.length > 160) {
        row.errors.name = 'Event Name must be 160 characters or fewer';
      }
      if (!rawCat) {
        row.errors.category = 'Category is required';
      } else if ((state.categories || []).length && !catRes.matched) {
        row.errors.category = `Unknown category "${rawCat}"`;
      }
      if (!['On-Stage', 'Off-Stage'].includes(normStageVal)) {
        row.errors.stage = 'Stage Type must be On-Stage or Off-Stage';
      }
      if (!['Single', 'Group'].includes(normTypeVal)) {
        row.errors.type = 'Type must be Single or Group';
      }
      if (!Number.isFinite(limitNum) || limitNum < 1) {
        row.errors.limit = 'Entries / Team must be at least 1';
      }
      if (normTypeVal === 'Group' && (!Number.isFinite(groupSizeNum) || groupSizeNum < 2)) {
        row.errors.groupSize = 'Group events need at least 2 members';
      }
      if (!Number.isFinite(maxMarkNum) || maxMarkNum <= 0) {
        row.errors.maximumMark = 'Max Mark must be positive';
      }
      if (normMethodVal === 'criteria' && parsedCriteria.criteria.length > 0 && parsedCriteria.total !== maxMarkNum) {
        row.errors.criteriaText = `Criteria sum (${parsedCriteria.total}) must equal Max Mark (${maxMarkNum})`;
      }
      if (parsedCriteria.unparsed.length > 0) {
        row.warnings.criteriaText = `Check criteria format ("Name - Mark; ..."): ${parsedCriteria.unparsed.join(', ')}`;
      }
      if (validation.errors.length && !Object.keys(row.errors).length) {
        row.errors.name = validation.errors[0];
      }

      if (candidate.name && !row.errors.name && !row.errors.category) {
        const dupKey = eventDuplicateKey(candidate);
        const dbMatch = existingKeys.get(dupKey);
        if (dbMatch) {
          row.errors.name = `Duplicate event (already exists: ${dbMatch.name})`;
        } else if (sheetEventKeys.has(dupKey)) {
          row.errors.name = `Duplicate event in sheet (Row ${sheetEventKeys.get(dupKey) + 1})`;
        } else {
          sheetEventKeys.set(dupKey, index);
        }
      }

      row.normalized = { candidate, validation };
      row.status = Object.keys(row.errors).length ? 'error' : Object.keys(row.warnings).length ? 'warning' : 'ready';
    });
  } else if (scope === 'schedule') {
    const eventsById = new Map((state.events || []).map((e) => [e.id, e]));
    const allowedStages = [...new Set(['Main Stage', ...(state.stages || [])])];
    const configuredDays = new Set((state.days || []).map((d) => clean(d.date || d)).filter(Boolean));
    const seenEventIds = new Map();
    const occupiedSlots = [];

    rows.forEach((row, index) => {
      row.errors = {};
      row.warnings = {};
      row.normalized = {};
      row.matchedEventId = '';
      if (row.skip) {
        row.status = 'skipped';
        return;
      }

      const rawId = clean(row.data.eventId);
      const rawName = clean(row.data.eventName);
      const catRes = resolveConfiguredOption(row.data.category, state.categories, state.categoryDisplayNames, ['General']);
      const targetCat = catRes.matched ? catRes.value : clean(row.data.category);

      let matchedEvent = rawId ? eventsById.get(rawId) : null;
      if (!matchedEvent && rawName) {
        const byName = (state.events || []).filter((e) => clean(e.name).toLowerCase() === rawName.toLowerCase());
        if (byName.length === 1) {
          matchedEvent = byName[0];
        } else if (byName.length > 1) {
          const narrowed = targetCat
            ? byName.filter((e) => clean(e.category).toLowerCase() === targetCat.toLowerCase())
            : [];
          if (narrowed.length === 1) {
            matchedEvent = narrowed[0];
          } else {
            row.errors.eventName = `Multiple events match "${rawName}" — pick the exact event in Edit Mode`;
          }
        }
      }

      if (!matchedEvent && !row.errors.eventName) {
        row.errors.eventName = rawName || rawId
          ? `Event "${rawName || rawId}" not found in database`
          : 'Select an Event';
      }

      if (matchedEvent) {
        row.matchedEventId = matchedEvent.id;
        row.data.eventId = matchedEvent.id;
        row.data.eventName = matchedEvent.name;
        row.data.category = matchedEvent.category || '';
        if (seenEventIds.has(matchedEvent.id)) {
          row.errors.eventName = `Duplicate schedule row for "${matchedEvent.name}" (Row ${seenEventIds.get(matchedEvent.id) + 1})`;
        } else {
          seenEventIds.set(matchedEvent.id, index);
        }
      }

      const dateVal = parseExcelDateCell(row.data.scheduleDate);
      row.data.scheduleDate = dateVal;
      if (!dateVal) {
        row.errors.scheduleDate = 'Date (YYYY-MM-DD) is required';
      } else if (!DATE_REGEX.test(dateVal) || Number.isNaN(new Date(`${dateVal}T00:00:00Z`).getTime())) {
        row.errors.scheduleDate = 'Invalid date — use YYYY-MM-DD';
      } else if (configuredDays.size > 0 && !configuredDays.has(dateVal)) {
        row.warnings.scheduleDate = `Date ${dateVal} is outside configured Festival Days`;
      }

      const stageRes = resolveConfiguredOption(row.data.scheduleStage, allowedStages, {});
      if (stageRes.matched) row.data.scheduleStage = stageRes.value;
      if (!clean(row.data.scheduleStage)) {
        row.errors.scheduleStage = 'Stage is required';
      } else if (allowedStages.length && !stageRes.matched) {
        row.errors.scheduleStage = `Unknown stage "${row.data.scheduleStage}"`;
      }

      const timeVal = parseExcelTimeCell(row.data.time);
      row.data.time = timeVal;
      if (!timeVal) {
        row.errors.time = 'Start Time (HH:MM) is required';
      } else if (!TIME_24_REGEX.test(timeVal)) {
        row.errors.time = 'Invalid time — use HH:MM (24h)';
      }

      const durRaw = row.data.scheduleDuration === '' ? '30' : row.data.scheduleDuration;
      const durNum = Number(durRaw);
      if (!Number.isInteger(durNum) || durNum < 1 || durNum > 600) {
        row.errors.scheduleDuration = 'Duration must be 1–600 minutes';
      } else {
        row.data.scheduleDuration = String(durNum);
      }

      const rawStatus = clean(row.data.scheduleStatus).toLowerCase();
      const statusVal = SCHEDULE_STATUS_OPTIONS.includes(rawStatus)
        ? rawStatus
        : (dateVal && timeVal ? 'scheduled' : 'unscheduled');
      row.data.scheduleStatus = statusVal;

      const startMins = timeToMinutes(timeVal);
      if (dateVal && stageRes.matched && startMins !== null && Number.isInteger(durNum) && durNum > 0) {
        occupiedSlots.push({
          rowIndex: index,
          eventId: matchedEvent?.id || '',
          label: matchedEvent?.name || `Row ${index + 1}`,
          date: dateVal,
          stage: stageRes.value,
          start: startMins,
          end: startMins + durNum
        });
      }

      row.normalized = {
        eventId: matchedEvent?.id || '',
        patch: {
          scheduleDate: dateVal,
          scheduleStage: stageRes.matched ? stageRes.value : clean(row.data.scheduleStage),
          time: timeVal,
          scheduleDuration: Number.isFinite(durNum) ? durNum : 30,
          scheduleStatus: statusVal
        }
      };
      row.status = Object.keys(row.errors).length ? 'error' : Object.keys(row.warnings).length ? 'warning' : 'ready';
    });

    // Check stage + date + time overlaps across sheet rows, unscheduled DB events, and breaks
    const updatedEventIds = new Set(occupiedSlots.map((s) => s.eventId).filter(Boolean));
    const externalSlots = [];

    (state.events || []).forEach((ev) => {
      if (updatedEventIds.has(ev.id)) return;
      if (!ev.scheduleDate || !ev.scheduleStage || !ev.time) return;
      const sMins = timeToMinutes(ev.time);
      const dur = Number(ev.scheduleDuration || ev.duration || 30);
      if (sMins !== null && dur > 0) {
        externalSlots.push({
          label: ev.name,
          date: ev.scheduleDate,
          stage: ev.scheduleStage,
          start: sMins,
          end: sMins + dur
        });
      }
    });

    (state.scheduleBreaks || []).forEach((brk) => {
      if (!brk.date || !brk.startTime || !brk.endTime) return;
      const sMins = timeToMinutes(brk.startTime);
      const eMins = timeToMinutes(brk.endTime);
      if (sMins !== null && eMins !== null && eMins > sMins) {
        externalSlots.push({
          label: `Break: ${brk.title}`,
          date: brk.date,
          stage: brk.stage || 'All Stages',
          start: sMins,
          end: eMins
        });
      }
    });

    occupiedSlots.forEach((slot) => {
      const targetRow = rows[slot.rowIndex];
      if (!targetRow || targetRow.skip) return;
      const clashes = [];
      occupiedSlots.forEach((other) => {
        if (other.rowIndex === slot.rowIndex) return;
        if (other.date === slot.date && other.stage === slot.stage && slot.start < other.end && other.start < slot.end) {
          clashes.push(`${other.label} (Row ${other.rowIndex + 1})`);
        }
      });
      externalSlots.forEach((ext) => {
        const sameStage = ext.stage === 'All Stages' || ext.stage === slot.stage;
        if (ext.date === slot.date && sameStage && slot.start < ext.end && ext.start < slot.end) {
          clashes.push(ext.label);
        }
      });
      if (clashes.length) {
        targetRow.warnings.time = `Time overlap on ${slot.stage}: ${[...new Set(clashes)].slice(0, 2).join(', ')}`;
        if (targetRow.status === 'ready') targetRow.status = 'warning';
      }
    });
  }

  return summarizeRows(rows);
}

function summarizeRows(rows) {
  let ready = 0;
  let errors = 0;
  let warnings = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.skip) skipped++;
    else if (row.status === 'error') errors++;
    else if (row.status === 'warning') {
      warnings++;
      ready++;
    } else ready++;
  }
  return { total: rows.length, ready, errors, warnings, skipped };
}

function buildReferenceRows(state) {
  const rows = [['Type', 'Key (Use in Sheet)', 'Display Name / Note']];
  (state.teams || []).forEach((t) => {
    rows.push(['Team', t, resolveDisplayName(state.teamDisplayNames, t, t)]);
  });
  (state.categories || []).forEach((c) => {
    rows.push(['Category', c, resolveDisplayName(state.categoryDisplayNames, c, c)]);
  });
  rows.push(['Student Gender', 'Boys / Girls', 'Exact allowed values for Students']);
  const clsCfg = getClassificationConfig(state);
  const vis = getStudentFieldVisibility(clsCfg);
  if (vis.showClass) {
    rows.push(['Student Class', (clsCfg.classes || DEFAULT_CLASS_LIST).join(', '), clsCfg.mode === 'class' ? 'Auto-assigns Category when Category cell is left blank' : 'Optional student Class field']);
  }
  if (vis.showDob) {
    rows.push(['Student DOB', 'YYYY-MM-DD (e.g. 2012-05-14)', clsCfg.mode === 'dob' ? 'Auto-assigns Category from DOB range when Category cell is left blank' : 'Optional student Date of Birth']);
  }
  if (isAutoChestActive(state)) {
    rows.push(['Chest No (Auto)', 'Optional / Leave Blank', 'Automated chest numbering is ON — blank Chest No cells auto-assign sequentially']);
  }
  rows.push(['Event Gender', 'Both / Boys / Girls / Mixed', 'Allowed values for Events']);
  rows.push(['Event Type', 'Single / Group', 'Group requires Members >= 2']);
  rows.push(['Stage Type', 'On-Stage / Off-Stage', 'Allowed values for Events']);
  rows.push(['Judging Method', 'criteria / direct_rank / objective / time / count / manual', 'Use criteria when providing rubric criteria']);
  [...new Set(['Main Stage', ...(state.stages || [])])].forEach((s) => {
    rows.push(['Schedule Stage', s, 'Configured festival stage']);
  });
  (state.days || []).forEach((d) => {
    rows.push(['Festival Day', d.date || d, d.label || d.date || d]);
  });
  return rows;
}

function pickSampleClassForCategory(categoryKey, index, clsCfg) {
  const classes = clsCfg?.classes?.length ? clsCfg.classes : DEFAULT_CLASS_LIST;
  if (clsCfg?.mode === 'class' && categoryKey) {
    const matched = clsCfg.classRules?.[categoryKey];
    if (Array.isArray(matched) && matched.length) {
      return matched[index % matched.length];
    }
  }
  return classes[index % classes.length] || '';
}

function pickSampleDobForCategory(categoryKey, index, clsCfg) {
  const fallbackDobs = ['2014-05-12', '2012-08-23', '2010-03-17', '2008-11-04'];
  if (clsCfg?.mode === 'dob' && categoryKey) {
    const rule = clsCfg.dobRules?.[categoryKey];
    if (rule && typeof rule === 'object') {
      if (rule.from && rule.to && rule.from <= rule.to) {
        const start = new Date(`${rule.from}T00:00:00Z`).getTime();
        const end = new Date(`${rule.to}T00:00:00Z`).getTime();
        if (Number.isFinite(start) && Number.isFinite(end)) {
          const mid = new Date(Math.round((start + end) / 2));
          if (!Number.isNaN(mid.getTime())) return mid.toISOString().slice(0, 10);
        }
      }
      if (rule.from) return rule.from;
      if (rule.to) return rule.to;
    }
  }
  return fallbackDobs[index % fallbackDobs.length];
}

function buildTemplateSampleRows(scope, state, fields) {
  if (scope === 'students') {
    const teams = (state?.teams || []).length ? state.teams : ['red_house', 'blue_house'];
    const categories = (state?.categories || []).length ? state.categories : ['junior', 'senior'];
    const clsCfg = getClassificationConfig(state);
    const autoChest = isAutoChestActive(state);
    const people = [
      { name: 'Aarav Nair', gender: 'Boys' },
      { name: 'Diya Menon', gender: 'Girls' },
      { name: 'Rohan Varma', gender: 'Boys' },
      { name: 'Ananya Krishnan', gender: 'Girls' }
    ];
    return people.map((person, idx) => {
      const targetCat = categories[idx % categories.length];
      const valueMap = {
        chestNo: autoChest ? '' : String(101 + idx),
        name: person.name,
        team: teams[idx % teams.length],
        class: pickSampleClassForCategory(targetCat, idx, clsCfg),
        dob: pickSampleDobForCategory(targetCat, idx, clsCfg),
        category: targetCat,
        gender: person.gender
      };
      return fields.map((f) => valueMap[f.key] ?? '');
    });
  }

  if (scope === 'events') {
    const categories = (state?.categories || []).length ? state.categories : ['junior', 'senior'];
    const samples = [
      {
        name: 'Classical Dance (Sample)',
        category: categories[0],
        gender: 'Girls',
        type: 'Single',
        stage: 'On-Stage',
        limit: 2,
        groupSize: 1,
        resultMethod: 'criteria',
        maximumMark: 100,
        criteriaText: 'Expression - 40; Rhythm - 30; Costume - 30',
        rules: 'Max duration 7 minutes; traditional costume required'
      },
      {
        name: 'Essay Writing - English (Sample)',
        category: categories[1 % categories.length],
        gender: 'Both',
        type: 'Single',
        stage: 'Off-Stage',
        limit: 3,
        groupSize: 1,
        resultMethod: 'direct_rank',
        maximumMark: 100,
        criteriaText: '',
        rules: 'Topic announced 10 minutes before start; 60 minutes duration'
      },
      {
        name: 'Group Song (Sample)',
        category: categories[2 % categories.length],
        gender: 'Mixed',
        type: 'Group',
        stage: 'On-Stage',
        limit: 2,
        groupSize: 7,
        resultMethod: 'criteria',
        maximumMark: 100,
        criteriaText: 'Vocal Harmony - 40; Rhythm & Pitch - 40; Presentation - 20',
        rules: '5 to 7 singers per team'
      },
      {
        name: 'General Quiz (Sample)',
        category: 'General',
        gender: 'Both',
        type: 'Group',
        stage: 'Off-Stage',
        limit: 1,
        groupSize: 3,
        resultMethod: 'objective',
        maximumMark: 50,
        criteriaText: '',
        rules: '3-member team; written prelims + buzzer finals'
      }
    ];
    return samples.map((sample) => fields.map((f) => sample[f.key] ?? ''));
  }

  return [];
}

function buildExportAoA(scope, state, templateOnly = false) {
  const fields = getScopeFields(scope, state, { includeExistingStudentMeta: !templateOnly });
  const headers = fields.map((f) => f.label);
  const rows = [headers];

  if (scope === 'students') {
    if (templateOnly) {
      rows.push(...buildTemplateSampleRows('students', state, fields));
    } else {
      const sorted = [...(state.students || [])].sort((a, b) =>
        String(a.chestNo || '').localeCompare(String(b.chestNo || ''), undefined, { numeric: true })
      );
      sorted.forEach((s) => {
        const valueMap = {
          chestNo: s.chestNo || '',
          name: s.name || '',
          team: s.team || '',
          class: studentClassValue(s),
          dob: studentDobValue(s),
          category: s.category || '',
          gender: s.gender || 'Boys'
        };
        rows.push(fields.map((f) => valueMap[f.key] ?? ''));
      });
    }
  } else if (scope === 'events') {
    if (templateOnly) {
      rows.push(...buildTemplateSampleRows('events', state, fields));
    } else {
      const sorted = [...(state.events || [])].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      sorted.forEach((ev) => {
        const crit = Array.isArray(ev.criteria) && ev.criteria.length
          ? ev.criteria.map((c) => `${c.name} - ${c.maximumMark}`).join('; ')
          : '';
        rows.push([
          ev.name || '',
          ev.category || '',
          ev.gender || 'Both',
          ev.type || 'Single',
          ev.stage || 'On-Stage',
          ev.limit ?? 1,
          ev.groupSize ?? 1,
          ev.resultMethod || 'criteria',
          ev.maximumMark ?? 100,
          crit,
          ev.rules || ''
        ]);
      });
    }
  } else if (scope === 'schedule') {
    const active = (state.events || [])
      .filter((e) => !['draft', 'archived'].includes(e.status))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    active.forEach((ev) => {
      rows.push([
        ev.id,
        ev.name || '',
        ev.category || '',
        templateOnly ? '' : (ev.scheduleDate || ''),
        templateOnly ? (ev.scheduleStage || state.stages?.[0] || 'Main Stage') : (ev.scheduleStage || ev.stage || ''),
        templateOnly ? '' : (ev.time || ''),
        templateOnly ? 30 : Number(ev.scheduleDuration || ev.duration || 30),
        templateOnly ? 'scheduled' : (ev.scheduleStatus || (ev.scheduleDate && ev.time ? 'scheduled' : 'unscheduled'))
      ]);
    });
  }

  return rows;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createAdminExcelController(getState, handlers = {}) {
  const { db, toast = () => {}, confirm = async () => true, onCommitted = async () => {} } = handlers;

  const subTabs = { students: 'single', events: 'single', schedule: 'single' };
  const scopeState = {
    students: createInitialScopeState(),
    events: createInitialScopeState(),
    schedule: createInitialScopeState()
  };

  function createInitialScopeState() {
    return {
      fileName: '',
      workbook: null,
      sheetNames: [],
      activeSheet: '',
      rawHeaders: [],
      rawRecords: [],
      columnMap: {},
      showMapper: false,
      editMode: false,
      errorsOnly: false,
      rows: [],
      summary: { total: 0, ready: 0, errors: 0, warnings: 0, skipped: 0 },
      importing: false
    };
  }

  function containerOf(scope) {
    return document.getElementById(`excel-workspace-${scope}`);
  }

  function setSubTab(scope, mode) {
    if (!subTabs[scope]) return;
    subTabs[scope] = mode;
    document.querySelectorAll(`[data-subtab-group="${scope}"]`).forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.subtab === mode));
    });
    document.getElementById(`${scope}-subview-single`)?.classList.toggle('hidden', mode !== 'single');
    document.getElementById(`${scope}-subview-excel`)?.classList.toggle('hidden', mode !== 'excel');
    if (mode === 'excel') renderWorkspace(scope);
  }

  async function handleExport(scope, format = 'xlsx', templateOnly = false) {
    try {
      const state = getState();
      const schema = SCHEMAS[scope];
      const exportFields = getScopeFields(scope, state, { includeExistingStudentMeta: !templateOnly });
      const aoa = buildExportAoA(scope, state, templateOnly);
      const stamp = new Date().toISOString().slice(0, 10);
      const suffix = templateOnly ? 'template' : 'export';
      const filename = `${schema.filePrefix}-${suffix}-${stamp}.${format}`;

      if (format === 'csv') {
        const csv = aoa
          .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
          .join('\r\n');
        downloadBlob(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }), filename);
        toast(`Downloaded ${filename}`);
        return;
      }

      const XLSX = await ensureXlsx();
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = exportFields.map((f, colIdx) => {
        const maxLen = aoa.reduce((acc, r) => Math.max(acc, String(r[colIdx] ?? '').length), f.label.length);
        return { wch: Math.min(Math.max(maxLen + 3, 16), 42) };
      });
      XLSX.utils.book_append_sheet(wb, ws, schema.sheetName);

      const refSheet = XLSX.utils.aoa_to_sheet(buildReferenceRows(state));
      refSheet['!cols'] = [{ wch: 18 }, { wch: 30 }, { wch: 42 }];
      XLSX.utils.book_append_sheet(wb, refSheet, 'Reference Guide');

      XLSX.writeFile(wb, filename);
      toast(`Downloaded ${filename}`);
    } catch (err) {
      console.error(err);
      toast(err.message || 'Failed to generate Excel export', 'error');
    }
  }

  function applyMappingAndValidate(scope) {
    const sc = scopeState[scope];
    const allFields = getAllMappableFields(scope);
    const state = getState();
    sc.rows = sc.rawRecords.map((record, i) => {
      const data = {};
      allFields.forEach((f) => {
        const colName = sc.columnMap[f.key];
        const rawVal = colName ? record[colName] : '';
        if ((scope === 'schedule' && f.key === 'scheduleDate') || (scope === 'students' && f.key === 'dob')) {
          data[f.key] = parseExcelDateCell(rawVal);
        } else if (scope === 'schedule' && f.key === 'time') {
          data[f.key] = parseExcelTimeCell(rawVal);
        } else {
          data[f.key] = rawVal === undefined || rawVal === null ? '' : String(rawVal).trim();
        }
      });
      return {
        id: `${scope}-row-${Date.now()}-${i}`,
        data,
        skip: false,
        errors: {},
        warnings: {},
        normalized: {},
        matchedEventId: '',
        status: 'ready'
      };
    });
    sc.summary = validateScopeRows(scope, sc.rows, state);
  }

  function loadSheetFromWorkbook(scope, sheetName) {
    const sc = scopeState[scope];
    const XLSX = window.XLSX;
    if (!sc.workbook || !XLSX) return;
    const sheet = sc.workbook.Sheets[sheetName];
    if (!sheet) return;
    sc.activeSheet = sheetName;

    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    if (!matrix.length) {
      sc.rawHeaders = [];
      sc.rawRecords = [];
      sc.rows = [];
      sc.summary = summarizeRows([]);
      renderWorkspace(scope);
      return;
    }

    const rawHeaderRow = matrix[0].map((v, idx) => clean(v) || `Column ${idx + 1}`);
    const records = [];
    for (let r = 1; r < matrix.length; r++) {
      const rowArr = matrix[r] || [];
      if (!rowArr.some((cell) => clean(cell) !== '')) continue;
      const obj = {};
      rawHeaderRow.forEach((hdr, cIdx) => {
        obj[hdr] = rowArr[cIdx] ?? '';
      });
      records.push(obj);
    }

    sc.rawHeaders = rawHeaderRow;
    sc.rawRecords = records;
    const schema = SCHEMAS[scope];
    sc.columnMap = autoMapHeaders(rawHeaderRow, scope);
    const autoChest = scope === 'students' && isAutoChestActive(getState());
    const clsCfg = scope === 'students' ? getClassificationConfig(getState()) : null;
    const missingRequired = schema.fields.some((f) => {
      if (scope === 'students' && f.key === 'chestNo' && autoChest) return false;
      if (scope === 'students' && f.key === 'category' && clsCfg?.mode === 'class' && sc.columnMap.class) return false;
      if (scope === 'students' && f.key === 'category' && clsCfg?.mode === 'dob' && sc.columnMap.dob) return false;
      return f.required && !sc.columnMap[f.key];
    });
    sc.showMapper = false;
    if (missingRequired) sc.editMode = true;
    applyMappingAndValidate(scope);
    renderWorkspace(scope);
  }

  async function handleFileUpload(scope, file) {
    if (!file) return;
    try {
      const XLSX = await ensureXlsx();
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array', cellDates: false });
      const sc = scopeState[scope];
      sc.fileName = file.name;
      sc.workbook = wb;
      sc.sheetNames = wb.SheetNames || [];
      const defaultSheet = sc.sheetNames.find((n) => n.toLowerCase() !== 'reference guide') || sc.sheetNames[0] || '';
      if (!defaultSheet) {
        toast('Uploaded file has no readable worksheet', 'error');
        return;
      }
      loadSheetFromWorkbook(scope, defaultSheet);
      const { total, errors } = sc.summary;
      if (errors > 0) {
        toast(`Checked ${total} row(s): ${errors} row(s) have issues — turn ON Edit Mode above the table to fix`, 'error');
      } else {
        toast(`Checked ${total} row(s): all rows ready`);
      }
    } catch (err) {
      console.error(err);
      toast(err.message || 'Could not parse file. Ensure it is a valid .xlsx, .xls, or .csv file.', 'error');
    }
  }

  const CELL_ERROR_CLASSES = ['border-red-500', 'dark:border-red-500', 'bg-red-50', 'dark:bg-red-950/50', 'text-red-900', 'dark:text-red-200'];
  const CELL_WARN_CLASSES = ['border-amber-400', 'dark:border-amber-500', 'bg-amber-50', 'dark:bg-amber-950/40', 'text-amber-900', 'dark:text-amber-200'];
  const CELL_DEFAULT_CLASSES = ['border-slate-200', 'dark:border-slate-700', 'bg-white', 'dark:bg-slate-950', 'text-slate-900', 'dark:text-slate-100'];

  function renderSelectControl(scope, row, field, options, currentVal, allowCustomInvalid = true, errKey = field) {
    const val = String(currentVal ?? '');
    const errMsg = row.errors?.[errKey];
    const warnMsg = row.warnings?.[errKey];
    const hasCustom = allowCustomInvalid && val && !options.some((o) => o.value === val);
    const borderCls = (errMsg ? CELL_ERROR_CLASSES : warnMsg ? CELL_WARN_CLASSES : CELL_DEFAULT_CLASSES).join(' ');
    return `
      <select data-excel-input="1" data-excel-scope="${scope}" data-row-id="${h(row.id)}" data-field="${h(field)}" data-err-field="${h(errKey)}"
        class="w-full min-w-[120px] rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none ${borderCls}" title="${h(errMsg || warnMsg || '')}">
        ${allowCustomInvalid && !val ? '<option value="">Select…</option>' : ''}
        ${hasCustom ? `<option value="${h(val)}" selected>⚠ Invalid: ${h(val)}</option>` : ''}
        ${options.map((opt) => `<option value="${h(opt.value)}" ${opt.value === val ? 'selected' : ''}>${h(opt.label)}</option>`).join('')}
      </select>
    `;
  }

  function renderInputControl(scope, row, field, { type = 'text', min = '', max = '', list = '', placeholder = '' } = {}) {
    const val = String(row.data?.[field] ?? '');
    const errMsg = row.errors?.[field];
    const warnMsg = row.warnings?.[field];
    const borderCls = (errMsg ? CELL_ERROR_CLASSES : warnMsg ? CELL_WARN_CLASSES : CELL_DEFAULT_CLASSES).join(' ');
    return `
      <input type="${h(type)}" value="${h(val)}" ${min !== '' ? `min="${h(min)}"` : ''} ${max !== '' ? `max="${h(max)}"` : ''}
        ${list ? `list="${h(list)}"` : ''} ${placeholder ? `placeholder="${h(placeholder)}"` : ''}
        data-excel-input="1" data-excel-scope="${scope}" data-row-id="${h(row.id)}" data-field="${h(field)}"
        title="${h(errMsg || warnMsg || '')}"
        class="w-full rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none ${type === 'number' || field === 'chestNo' || field === 'scheduleDate' || field === 'time' ? 'font-mono-num' : ''} ${borderCls}">
    `;
  }

  function cellDiagnosticHtml(row, fieldKey, extraKeys = []) {
    if (row.skip) return '';
    const keys = [...new Set([fieldKey, ...extraKeys])];
    const errs = [];
    const warns = [];
    keys.forEach((k) => {
      const err = row.errors?.[k];
      const warn = row.warnings?.[k];
      if (err && !errs.includes(err)) errs.push(err);
      if (warn && !warns.includes(warn)) warns.push(warn);
    });
    if (!errs.length && !warns.length) return '';
    return [
      ...errs.map((m) => `<p class="mt-1 text-[11px] font-semibold leading-tight text-red-700 dark:text-red-400">${h(m)}</p>`),
      ...warns.map((m) => `<p class="mt-1 text-[11px] font-semibold leading-tight text-amber-700 dark:text-amber-400">${h(m)}</p>`)
    ].join('');
  }

  function updateSummaryDom(scope) {
    const sc = scopeState[scope];
    const s = sc.summary;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
    set(`excel-stat-total-${scope}`, s.total);
    set(`excel-stat-ready-${scope}`, s.ready);
    set(`excel-stat-errors-${scope}`, s.errors);
    set(`excel-stat-warnings-${scope}`, s.warnings);
    set(`excel-stat-skipped-${scope}`, s.skipped);

    const commitBtn = document.getElementById(`excel-commit-btn-${scope}`);
    if (commitBtn) {
      const canCommit = !sc.importing && s.ready > 0 && s.errors === 0;
      commitBtn.disabled = !canCommit;
      commitBtn.textContent = sc.importing
        ? 'Saving…'
        : s.errors > 0
          ? `Fix ${s.errors} Error(s) Before Import`
          : `${SCHEMAS[scope].commitLabel} (${s.ready})`;
    }
  }

  function patchLiveValidationDom(scope) {
    const sc = scopeState[scope];
    const root = containerOf(scope);
    if (!root) return;

    updateSummaryDom(scope);

    const visibleFields = scope === 'schedule'
      ? SCHEMAS[scope].fields.filter((f) => f.key !== 'eventId')
      : getScopeFields(scope, getState(), { rows: sc.rows, columnMap: sc.columnMap });
    const visibleKeySet = new Set(visibleFields.map((vf) => vf.key));

    sc.rows.forEach((row) => {
      const tr = root.querySelector(`tr[data-excel-row-id="${CSS.escape(row.id)}"]`);
      if (!tr) return;

      tr.classList.toggle('bg-red-50/30', !row.skip && row.status === 'error');
      tr.classList.toggle('dark:bg-red-950/25', !row.skip && row.status === 'error');
      tr.classList.toggle('bg-slate-50/80', row.skip);
      tr.classList.toggle('dark:bg-slate-800/50', row.skip);
      tr.classList.toggle('opacity-65', row.skip);

      const orphanKeys = [...new Set([
        ...Object.keys(row.errors || {}).filter((k) => !visibleKeySet.has(k)),
        ...Object.keys(row.warnings || {}).filter((k) => !visibleKeySet.has(k))
      ])];

      tr.querySelectorAll('[data-cell-msg]').forEach((msgBox) => {
        const fKey = msgBox.dataset.cellMsg;
        const extra = msgBox.hasAttribute('data-cell-msg-primary') ? orphanKeys : [];
        msgBox.innerHTML = cellDiagnosticHtml(row, fKey, extra);
      });

      tr.querySelectorAll('[data-excel-input]').forEach((input) => {
        const field = input.dataset.errField || input.dataset.field;
        const err = !row.skip && row.errors?.[field];
        const warn = !row.skip && row.warnings?.[field];
        input.classList.remove(...CELL_ERROR_CLASSES, ...CELL_WARN_CLASSES, ...CELL_DEFAULT_CLASSES);
        if (err) input.classList.add(...CELL_ERROR_CLASSES);
        else if (warn) input.classList.add(...CELL_WARN_CLASSES);
        else input.classList.add(...CELL_DEFAULT_CLASSES);
        input.title = err || warn || '';
        if (scope === 'students' && field === 'category' && input.value !== (row.data?.category || '')) {
          input.value = row.data?.category || '';
        }
        if (scope === 'students' && field === 'chestNo') {
          input.placeholder = row.normalized?.chestNo && !clean(row.data?.chestNo)
            ? `Auto: ${row.normalized.chestNo}`
            : isAutoChestActive(getState()) ? 'Auto if blank' : 'Chest No';
        }
      });
    });
  }

  function renderFieldCell(scope, row, fieldDef, state) {
    const field = fieldDef.key;
    const raw = row.data?.[field] ?? '';
    const autoChest = scope === 'students' && isAutoChestActive(state);
    if (!scopeState[scope].editMode) {
      const err = !row.skip && row.errors?.[field];
      const warn = !row.skip && row.warnings?.[field];
      if (scope === 'students' && field === 'chestNo' && !raw && row.normalized?.chestNo && !err) {
        return `<span class="inline-flex items-center gap-1 font-mono-num font-semibold text-blue-700 dark:text-blue-300"><span class="rounded bg-blue-50 dark:bg-blue-950/70 px-1 py-0.5 text-[10px] font-bold uppercase">Auto</span>${h(row.normalized.chestNo)}</span>`;
      }
      const cls = err
        ? 'rounded border border-red-300 dark:border-red-800/70 bg-red-50 dark:bg-red-950/50 px-1.5 py-0.5 text-red-800 dark:text-red-300 font-semibold'
        : warn
          ? 'rounded border border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 text-amber-800 dark:text-amber-300 font-semibold'
          : 'text-slate-700 dark:text-slate-200';
      let displayVal = raw || '—';
      if (field === 'team' && raw && state.teamDisplayNames?.[raw]) {
        displayVal = `${state.teamDisplayNames[raw]} (${raw})`;
      } else if (field === 'category' && raw && state.categoryDisplayNames?.[raw]) {
        displayVal = `${state.categoryDisplayNames[raw]} (${raw})`;
      }
      return `<span class="${cls} ${['chestNo', 'dob', 'limit', 'groupSize', 'maximumMark', 'scheduleDate', 'time', 'scheduleDuration'].includes(field) ? 'font-mono-num' : ''}">${h(displayVal)}</span>`;
    }

    const teamOpts = (state.teams || []).map((t) => ({ value: t, label: `${resolveDisplayName(state.teamDisplayNames, t, t)} (${t})` }));
    const catOpts = (state.categories || []).map((c) => ({ value: c, label: `${resolveDisplayName(state.categoryDisplayNames, c, c)} (${c})` }));

    if (scope === 'students') {
      if (field === 'team') return renderSelectControl(scope, row, field, teamOpts, raw);
      if (field === 'class') {
        const clsCfg = getClassificationConfig(state);
        const clsList = clsCfg.classes?.length ? clsCfg.classes : DEFAULT_CLASS_LIST;
        const opts = [...clsList];
        if (raw && !opts.some((c) => c.toLowerCase() === String(raw).toLowerCase())) opts.push(raw);
        const classErr = !row.skip && row.errors?.class;
        const classWarn = !row.skip && row.warnings?.class;
        const classBorder = (classErr ? CELL_ERROR_CLASSES : classWarn ? CELL_WARN_CLASSES : CELL_DEFAULT_CLASSES).join(' ');
        return `
          <select data-excel-input="1" data-excel-scope="${scope}" data-row-id="${h(row.id)}" data-field="class"
            class="w-full min-w-[96px] rounded border px-2 py-1 text-xs focus:border-blue-500 focus:outline-none ${classBorder}" title="${h(classErr || classWarn || '')}">
            <option value="">Optional…</option>
            ${opts.map((c) => `<option value="${h(c)}" ${c === raw ? 'selected' : ''}>${h(c)}</option>`).join('')}
          </select>
        `;
      }
      if (field === 'dob') return renderInputControl(scope, row, field, { type: 'date' });
      if (field === 'category') return renderSelectControl(scope, row, field, catOpts, raw);
      if (field === 'gender') return renderSelectControl(scope, row, field, [{ value: 'Boys', label: 'Boys' }, { value: 'Girls', label: 'Girls' }], raw);
      if (field === 'chestNo' && autoChest) {
        const autoPlaceholder = row.normalized?.chestNo && !raw ? `Auto: ${row.normalized.chestNo}` : 'Auto if blank';
        return renderInputControl(scope, row, field, { placeholder: autoPlaceholder });
      }
      return renderInputControl(scope, row, field, { placeholder: fieldDef.label });
    }

    if (scope === 'events') {
      if (field === 'category') return renderSelectControl(scope, row, field, [{ value: 'General', label: 'General' }, ...catOpts], raw);
      if (field === 'gender') return renderSelectControl(scope, row, field, ['Both', 'Boys', 'Girls', 'Mixed'].map((v) => ({ value: v, label: v })), raw);
      if (field === 'type') return renderSelectControl(scope, row, field, [{ value: 'Single', label: 'Single' }, { value: 'Group', label: 'Group' }], raw);
      if (field === 'stage') return renderSelectControl(scope, row, field, [{ value: 'On-Stage', label: 'On-Stage' }, { value: 'Off-Stage', label: 'Off-Stage' }], raw);
      if (field === 'resultMethod') return renderSelectControl(scope, row, field, METHOD_OPTIONS, raw);
      if (['limit', 'groupSize', 'maximumMark'].includes(field)) return renderInputControl(scope, row, field, { type: 'number', min: 1 });
      return renderInputControl(scope, row, field, { placeholder: fieldDef.label });
    }

    if (scope === 'schedule') {
      if (field === 'eventName') {
        const eventOpts = (state.events || [])
          .filter((e) => !['draft', 'archived'].includes(e.status))
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
          .map((e) => ({
            value: e.id,
            label: `${e.name} (${resolveDisplayName(state.categoryDisplayNames, e.category, e.category || 'General')} • ${e.gender || 'Both'})`
          }));
        return renderSelectControl(scope, row, 'eventId', eventOpts, row.matchedEventId || row.data.eventId || '', true, 'eventName');
      }
      if (field === 'category') {
        return `<span class="text-xs text-slate-600 dark:text-slate-300">${h(resolveDisplayName(state.categoryDisplayNames, raw, raw || '—'))}</span>`;
      }
      if (field === 'eventId') {
        return `<span class="font-mono-num text-[11px] text-slate-500 dark:text-slate-400">${h(row.matchedEventId || raw || 'Auto')}</span>`;
      }
      if (field === 'scheduleDate') return renderInputControl(scope, row, field, { type: 'date', list: `excel-days-list-${scope}` });
      if (field === 'scheduleStage') {
        const stageOpts = [...new Set(['Main Stage', ...(state.stages || [])])].map((s) => ({ value: s, label: s }));
        return renderSelectControl(scope, row, field, stageOpts, raw);
      }
      if (field === 'time') return renderInputControl(scope, row, field, { type: 'time' });
      if (field === 'scheduleDuration') return renderInputControl(scope, row, field, { type: 'number', min: 1, max: 600 });
      if (field === 'scheduleStatus') return renderSelectControl(scope, row, field, SCHEDULE_STATUS_OPTIONS.map((v) => ({ value: v, label: v })), raw, false);
    }

    return renderInputControl(scope, row, field);
  }

  function renderWorkspace(scope) {
    const root = containerOf(scope);
    if (!root) return;
    const sc = scopeState[scope];
    const schema = SCHEMAS[scope];
    const state = getState();
    sc.summary = validateScopeRows(scope, sc.rows, state);

    const visibleFields = scope === 'schedule'
      ? schema.fields.filter((f) => f.key !== 'eventId')
      : getScopeFields(scope, state, { rows: sc.rows, columnMap: sc.columnMap });
    const visibleKeySet = new Set(visibleFields.map((vf) => vf.key));
    const filteredRows = sc.errorsOnly ? sc.rows.filter((r) => !r.skip && (r.status === 'error' || r.status === 'warning')) : sc.rows;
    const hasRows = sc.rows.length > 0;
    const autoChest = scope === 'students' && isAutoChestActive(state);
    const clsCfg = scope === 'students' ? getClassificationConfig(state) : null;
    const dayDatalist = scope === 'schedule'
      ? `<datalist id="excel-days-list-${scope}">${(state.days || []).map((d) => `<option value="${h(d.date || d)}">${h(d.label || d.date || d)}</option>`).join('')}</datalist>`
      : '';

    root.innerHTML = `
      ${dayDatalist}
      <!-- Top Bar: Download & Upload Controls -->
      <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-4">
          <div>
            <h2 class="font-display text-base font-bold text-slate-900 dark:text-slate-100">${h(schema.label)} Excel Import & Export</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400">Download formatted templates or current records, upload .xlsx/.csv to validate, or start a blank sheet.</p>
          </div>
        </div>

        <!-- Download & Upload Controls -->
        <div class="grid gap-4 lg:grid-cols-2">
          <div class="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/50 p-4 space-y-3">
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">1. Download Excel / CSV</p>
              <span class="text-[11px] text-slate-500 dark:text-slate-400">Includes Reference Guide sheet</span>
            </div>
            <div class="flex flex-wrap gap-2">
              <button type="button" data-excel-action="export-template" data-excel-scope="${scope}"
                class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">
                Download Template (.xlsx)
              </button>
              <button type="button" data-excel-action="export-xlsx" data-excel-scope="${scope}"
                class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-900 dark:bg-slate-700 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 dark:hover:bg-slate-600">
                Export Current Data (.xlsx)
              </button>
              <button type="button" data-excel-action="export-csv" data-excel-scope="${scope}"
                class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">
                Export CSV (.csv)
              </button>
              ${scope === 'schedule' ? `
                <button type="button" data-excel-action="load-current-schedule" data-excel-scope="${scope}"
                  class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-blue-200 dark:border-blue-800/70 bg-blue-50 dark:bg-blue-950/50 px-3 py-2 text-xs font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-950/80">
                  Load Active Events into Editor
                </button>
              ` : ''}
            </div>
          </div>

          <div class="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/50 p-4 space-y-2.5 transition-colors" data-excel-dropzone="${scope}">
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">2. Upload Filled Excel / CSV</p>
              ${sc.fileName ? `<span class="truncate max-w-[200px] text-[11px] font-semibold text-blue-700 dark:text-blue-400">${h(sc.fileName)}</span>` : ''}
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <label class="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg bg-blue-700 dark:bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-800 dark:hover:bg-blue-500">
                <span>Choose .xlsx / .csv File</span>
                <input type="file" accept=".xlsx,.xls,.csv" data-excel-file="${scope}" class="sr-only">
              </label>
              <button type="button" data-excel-action="start-blank-sheet" data-excel-scope="${scope}"
                class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">
                Start Blank Sheet
              </button>
              ${sc.sheetNames.length > 1 ? `
                <select data-excel-sheet="${scope}" class="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
                  ${sc.sheetNames.map((n) => `<option value="${h(n)}" ${n === sc.activeSheet ? 'selected' : ''}>Sheet: ${h(n)}</option>`).join('')}
                </select>
              ` : ''}
              ${(hasRows || sc.editMode) ? `
                <button type="button" data-excel-action="clear-staging" data-excel-scope="${scope}"
                  class="whitespace-nowrap rounded-lg border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50">
                  Clear Sheet
                </button>
              ` : ''}
            </div>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">Every row is validated immediately against active Teams, Categories, Stages, and duplicates.${autoChest ? ' <strong class="text-blue-700 dark:text-blue-300">Automated Chest Numbering is ON:</strong> leave Chest No blank to auto-assign sequentially, or enter a unique Chest No manually.' : ''}</p>
          </div>
        </div>
      </div>

      ${(hasRows || sc.editMode) ? `
        <!-- Validation Summary & Sheet Editor Container -->
        <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 font-semibold text-slate-700 dark:text-slate-200">Total: <strong id="excel-stat-total-${scope}" class="font-mono-num">${sc.summary.total}</strong></span>
              <span class="rounded-lg border border-emerald-200 dark:border-emerald-800/70 bg-emerald-50 dark:bg-emerald-950/50 px-2.5 py-1.5 font-semibold text-emerald-800 dark:text-emerald-300">Ready: <strong id="excel-stat-ready-${scope}" class="font-mono-num">${sc.summary.ready}</strong></span>
              <span class="rounded-lg border border-red-200 dark:border-red-800/70 bg-red-50 dark:bg-red-950/50 px-2.5 py-1.5 font-semibold text-red-800 dark:text-red-300">Errors: <strong id="excel-stat-errors-${scope}" class="font-mono-num">${sc.summary.errors}</strong></span>
              <span class="rounded-lg border border-amber-200 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/50 px-2.5 py-1.5 font-semibold text-amber-800 dark:text-amber-300">Warnings: <strong id="excel-stat-warnings-${scope}" class="font-mono-num">${sc.summary.warnings}</strong></span>
              <span class="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 font-semibold text-slate-500 dark:text-slate-400">Skipped: <strong id="excel-stat-skipped-${scope}" class="font-mono-num">${sc.summary.skipped}</strong></span>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <button type="button" role="switch" aria-checked="${sc.editMode ? 'true' : 'false'}"
                data-excel-action="toggle-edit" data-excel-scope="${scope}"
                class="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${
                  sc.editMode
                    ? 'border-blue-700 dark:border-blue-600 bg-blue-700 dark:bg-blue-600 text-white shadow-sm'
                    : 'border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
                }">
                <span class="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${sc.editMode ? 'bg-blue-400 dark:bg-blue-300' : 'bg-slate-300 dark:bg-slate-600'}">
                  <span class="inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${sc.editMode ? 'translate-x-3.5' : 'translate-x-0.5'}"></span>
                </span>
                <span>Edit Mode: ${sc.editMode ? 'ON' : 'OFF'}</span>
              </button>
              <label class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer">
                <input type="checkbox" data-excel-action="toggle-errors-only" data-excel-scope="${scope}" ${sc.errorsOnly ? 'checked' : ''} class="h-3.5 w-3.5 rounded border-slate-300 dark:border-slate-600 text-blue-700">
                <span>Errors / Warnings Only</span>
              </label>
              ${sc.summary.errors > 0 ? `
                <button type="button" data-excel-action="skip-all-errors" data-excel-scope="${scope}"
                  class="whitespace-nowrap rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">
                  Skip Error Rows
                </button>
              ` : ''}
              ${sc.summary.skipped > 0 ? `
                <button type="button" data-excel-action="include-all" data-excel-scope="${scope}"
                  class="whitespace-nowrap rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">
                  Restore Skipped
                </button>
              ` : ''}
              ${sc.editMode ? `
                <button type="button" data-excel-action="add-row" data-excel-scope="${scope}"
                  class="whitespace-nowrap rounded-lg border border-blue-200 dark:border-blue-800/70 bg-blue-50 dark:bg-blue-950/50 px-3 py-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-950/80">
                  + Add Row
                </button>
              ` : ''}
              <button type="button" id="excel-commit-btn-${scope}" data-excel-action="commit-import" data-excel-scope="${scope}"
                ${sc.importing || sc.summary.ready === 0 || sc.summary.errors > 0 ? 'disabled' : ''}
                class="whitespace-nowrap rounded-lg bg-emerald-700 dark:bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 dark:hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-800 disabled:text-slate-600 dark:disabled:text-slate-500">
                ${sc.importing ? 'Saving…' : sc.summary.errors > 0 ? `Fix ${sc.summary.errors} Error(s) Before Import` : `${schema.commitLabel} (${sc.summary.ready})`}
              </button>
            </div>
          </div>

          ${sc.summary.errors > 0 ? `
            <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-xs text-red-900 dark:text-red-200">
              <div>
                <strong>${sc.summary.errors} row(s) contain validation or duplicate errors.</strong>
                <span>${sc.editMode ? 'Fix highlighted cells or adjust column mapping dropdowns in the table headers below, or check Skip on problem rows.' : 'Turn ON Edit Mode above the table to edit cells, remap column headers, or skip problem rows.'}</span>
              </div>
              ${!sc.editMode ? `
                <button type="button" data-excel-action="toggle-edit" data-excel-scope="${scope}"
                  class="whitespace-nowrap rounded-lg bg-red-700 dark:bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-800 dark:hover:bg-red-500">
                  Open Edit Mode
                </button>
              ` : ''}
            </div>
          ` : ''}

          <div class="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <table class="w-full text-left text-xs">
              <thead class="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <tr>
                  <th class="px-2.5 py-2.5 align-top w-10">#</th>
                  <th class="px-2.5 py-2.5 align-top w-14 text-center">Skip</th>
                  ${visibleFields.map((f) => {
                    const isReq = scope === 'students' && f.key === 'chestNo'
                      ? !autoChest
                      : (scope === 'students' && f.key === 'category' && clsCfg && clsCfg.mode !== 'manual')
                        ? false
                        : f.required;
                    const missingMap = sc.editMode && sc.rawHeaders.length > 0 && isReq && !sc.columnMap[f.key];
                    return `
                      <th class="px-2.5 py-2.5 align-top ${f.width || ''}">
                        <div class="space-y-1.5">
                          <div class="whitespace-nowrap">${h(f.label)}${isReq ? ' <span class="text-red-500">*</span>' : ''}</div>
                          ${sc.editMode && sc.rawHeaders.length > 0 ? `
                            <select data-excel-map="${scope}" data-map-field="${h(f.key)}" aria-label="Map ${h(f.label)} column"
                              class="w-full min-w-[115px] rounded border px-1.5 py-1 text-[11px] font-medium normal-case tracking-normal focus:border-blue-500 focus:outline-none ${
                                missingMap
                                  ? 'border-red-400 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950/60 dark:text-red-200'
                                  : 'border-slate-300 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
                              }">
                              <option value="">— Not Mapped —</option>
                              ${sc.rawHeaders.map((hdr) => `<option value="${h(hdr)}" ${sc.columnMap[f.key] === hdr ? 'selected' : ''}>${h(hdr)}</option>`).join('')}
                            </select>
                          ` : ''}
                        </div>
                      </th>
                    `;
                  }).join('')}
                  ${sc.editMode ? '<th class="px-2.5 py-2.5 align-top text-right w-16">Row</th>' : ''}
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                ${filteredRows.length ? filteredRows.map((row) => {
                  const rowNum = sc.rows.indexOf(row) + 1;
                  const orphanKeys = [...new Set([
                    ...Object.keys(row.errors || {}).filter((k) => !visibleKeySet.has(k)),
                    ...Object.keys(row.warnings || {}).filter((k) => !visibleKeySet.has(k))
                  ])];
                  return `
                    <tr data-excel-row-id="${h(row.id)}" class="${row.skip ? 'bg-slate-50/80 dark:bg-slate-800/50 opacity-65' : row.status === 'error' ? 'bg-red-50/30 dark:bg-red-950/25' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}">
                      <td class="px-2.5 py-2 align-top font-mono-num font-bold text-slate-500 dark:text-slate-400">${rowNum}</td>
                      <td class="px-2.5 py-2 align-top text-center">
                        <input type="checkbox" data-excel-action="toggle-skip" data-excel-scope="${scope}" data-row-id="${h(row.id)}" ${row.skip ? 'checked' : ''}
                          class="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-slate-700 cursor-pointer" title="Skip this row during import">
                      </td>
                      ${visibleFields.map((f, colIdx) => {
                        const extraKeys = colIdx === 0 ? orphanKeys : [];
                        return `<td class="px-2 py-2 align-top">${renderFieldCell(scope, row, f, state)}<div data-cell-msg="${h(f.key)}"${colIdx === 0 ? ' data-cell-msg-primary="1"' : ''}>${cellDiagnosticHtml(row, f.key, extraKeys)}</div></td>`;
                      }).join('')}
                      ${sc.editMode ? `
                        <td class="px-2.5 py-2 text-right align-top">
                          <button type="button" data-excel-action="delete-row" data-excel-scope="${scope}" data-row-id="${h(row.id)}"
                            class="rounded border border-red-200 dark:border-red-900/60 bg-white dark:bg-slate-800 px-2 py-1 text-[11px] font-semibold text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50" title="Remove row from staging">✕</button>
                        </td>
                      ` : ''}
                    </tr>
                  `;
                }).join('') : `
                  <tr>
                    <td colspan="${visibleFields.length + (sc.editMode ? 3 : 2)}" class="px-4 py-8 text-center text-slate-400 dark:text-slate-500">
                      ${sc.errorsOnly ? 'No error or warning rows remaining.' : 'No rows loaded yet. Click "+ Add Row" or upload a spreadsheet above.'}
                    </td>
                  </tr>
                `}
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}
    `;
  }

  async function commitScope(scope) {
    const sc = scopeState[scope];
    const state = getState();
    sc.summary = validateScopeRows(scope, sc.rows, state);
    if (sc.summary.errors > 0) {
      renderWorkspace(scope);
      return toast(`Resolve or skip ${sc.summary.errors} error row(s) before importing`, 'error');
    }
    const validRows = sc.rows.filter((r) => !r.skip);
    if (!validRows.length) return toast('No active rows to import', 'error');

    const warningNote = sc.summary.warnings > 0
      ? ` Note: ${sc.summary.warnings} row(s) carry warnings.`
      : '';
    const ok = await confirm(
      `${SCHEMAS[scope].commitLabel}: Save ${validRows.length} row(s) to Firestore?${sc.summary.skipped ? ` (${sc.summary.skipped} skipped row(s) will be ignored.)` : ''}${warningNote}`,
      { title: `Confirm ${SCHEMAS[scope].label} Import`, okLabel: 'Save to Database', tone: 'primary' }
    );
    if (!ok) return;

    sc.importing = true;
    updateSummaryDom(scope);
    const now = Date.now();

    try {
      if (scope === 'students') {
        const added = [];
        for (let i = 0; i < validRows.length; i += BATCH_LIMIT) {
          const chunk = validRows.slice(i, i + BATCH_LIMIT);
          const batch = writeBatch(db);
          chunk.forEach((row) => {
            const ref = doc(collection(db, 'students'));
            const details = row.normalized.details || {};
            const payload = {
              name: row.normalized.name,
              chestNo: row.normalized.chestNo,
              team: row.normalized.team,
              category: row.normalized.category,
              gender: row.normalized.gender,
              photoData: '',
              ...(Object.keys(details).length ? { details } : {}),
              importedAt: now,
              updatedAt: now
            };
            batch.set(ref, payload);
            added.push({ id: ref.id, ...payload });
          });
          await batch.commit();
        }
        state.students.push(...added);
        toast(`Imported ${added.length} student(s)`);
      } else if (scope === 'events') {
        const added = [];
        for (let i = 0; i < validRows.length; i += BATCH_LIMIT) {
          const chunk = validRows.slice(i, i + BATCH_LIMIT);
          const batch = writeBatch(db);
          chunk.forEach((row) => {
            const ref = doc(collection(db, 'events'));
            const payload = eventToFirestore(row.normalized.candidate, {
              setup: state.festSetup,
              validation: row.normalized.validation
            });
            batch.set(ref, payload);
            added.push({ id: ref.id, ...payload });
          });
          await batch.commit();
        }
        state.events.push(...added);
        invalidateCache('events_all');
        toast(`Imported ${added.length} event(s)`);
      } else if (scope === 'schedule') {
        for (let i = 0; i < validRows.length; i += BATCH_LIMIT) {
          const chunk = validRows.slice(i, i + BATCH_LIMIT);
          const batch = writeBatch(db);
          chunk.forEach((row) => {
            const eventId = row.normalized.eventId;
            const patch = { ...row.normalized.patch, updatedAt: now };
            batch.update(doc(db, 'events', eventId), patch);
            const ev = state.events.find((e) => e.id === eventId);
            if (ev) Object.assign(ev, patch);
          });
          await batch.commit();
        }
        invalidateCache('events_all');
        toast(`Updated schedule for ${validRows.length} event(s)`);
      }

      sc.rows = [];
      sc.rawRecords = [];
      sc.rawHeaders = [];
      sc.fileName = '';
      sc.workbook = null;
      sc.sheetNames = [];
      sc.summary = summarizeRows([]);
      sc.importing = false;
      await onCommitted(scope);
      renderWorkspace(scope);
    } catch (err) {
      console.error(err);
      sc.importing = false;
      updateSummaryDom(scope);
      toast(err.message || 'Firestore batch import failed', 'error');
    }
  }

  function bind() {
    document.addEventListener('click', async (e) => {
      const subBtn = e.target.closest('[data-subtab-group]');
      if (subBtn) {
        setSubTab(subBtn.dataset.subtabGroup, subBtn.dataset.subtab);
        return;
      }

      const actBtn = e.target.closest('[data-excel-action]');
      if (!actBtn) return;
      const action = actBtn.dataset.excelAction;
      const scope = actBtn.dataset.excelScope;
      const sc = scopeState[scope];
      if (!sc) return;

      if (action === 'export-template') return handleExport(scope, 'xlsx', true);
      if (action === 'export-xlsx') return handleExport(scope, 'xlsx', false);
      if (action === 'export-csv') return handleExport(scope, 'csv', false);

      if (action === 'load-current-schedule' && scope === 'schedule') {
        const state = getState();
        sc.rows = (state.events || [])
          .filter((ev) => !['draft', 'archived'].includes(ev.status))
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
          .map((ev, idx) => ({
            id: `schedule-live-${Date.now()}-${idx}`,
            data: {
              eventId: ev.id,
              eventName: ev.name || '',
              category: ev.category || '',
              scheduleDate: ev.scheduleDate || '',
              scheduleStage: ev.scheduleStage || state.stages?.[0] || 'Main Stage',
              time: ev.time || '',
              scheduleDuration: String(ev.scheduleDuration || ev.duration || 30),
              scheduleStatus: ev.scheduleStatus || (ev.scheduleDate && ev.time ? 'scheduled' : 'unscheduled')
            },
            skip: false,
            errors: {},
            warnings: {},
            normalized: {},
            matchedEventId: ev.id,
            status: 'ready'
          }));
        sc.editMode = true;
        sc.fileName = 'Active Events Schedule (In-App Editor)';
        sc.summary = validateScopeRows(scope, sc.rows, state);
        renderWorkspace(scope);
        return;
      }

      if (action === 'start-blank-sheet') {
        if (sc.rows.length > 0 && sc.rawHeaders.length > 0) {
          const ok = await confirm('Replace the uploaded sheet with a blank editable sheet?', {
            title: 'Start Blank Sheet',
            okLabel: 'Replace'
          });
          if (!ok) return;
        }
        if (!sc.rows.length || sc.rawHeaders.length > 0) {
          sc.rows = [{
            id: `${scope}-row-${Date.now()}`,
            data: makeBlankRow(scope, getState()),
            skip: false,
            errors: {},
            warnings: {},
            normalized: {},
            matchedEventId: '',
            status: 'ready'
          }];
        }
        sc.rawHeaders = [];
        sc.rawRecords = [];
        sc.columnMap = {};
        sc.workbook = null;
        sc.sheetNames = [];
        sc.activeSheet = '';
        sc.showMapper = false;
        sc.fileName = 'Manual Entry Sheet';
        sc.editMode = true;
        sc.summary = validateScopeRows(scope, sc.rows, getState());
        renderWorkspace(scope);
        return;
      }

      if (action === 'toggle-edit') {
        sc.editMode = !sc.editMode;
        if (sc.editMode && !sc.rows.length) {
          sc.rows = [{
            id: `${scope}-row-${Date.now()}`,
            data: makeBlankRow(scope, getState()),
            skip: false,
            errors: {},
            warnings: {},
            normalized: {},
            matchedEventId: '',
            status: 'ready'
          }];
        }
        renderWorkspace(scope);
        return;
      }

      if (action === 'clear-staging') {
        if (sc.rows.length > 0) {
          const ok = await confirm('Clear uploaded rows from staging? Saved database records are not affected.', {
            title: 'Clear Staging Sheet',
            okLabel: 'Clear'
          });
          if (!ok) return;
        }
        Object.assign(sc, createInitialScopeState());
        renderWorkspace(scope);
        return;
      }

      if (action === 'add-row') {
        sc.rows.push({
          id: `${scope}-row-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
          data: makeBlankRow(scope, getState()),
          skip: false,
          errors: {},
          warnings: {},
          normalized: {},
          matchedEventId: '',
          status: 'ready'
        });
        renderWorkspace(scope);
        return;
      }

      if (action === 'delete-row') {
        const rowId = actBtn.dataset.rowId;
        sc.rows = sc.rows.filter((r) => r.id !== rowId);
        renderWorkspace(scope);
        return;
      }

      if (action === 'skip-all-errors') {
        sc.rows.forEach((r) => {
          if (r.status === 'error') r.skip = true;
        });
        renderWorkspace(scope);
        return;
      }

      if (action === 'include-all') {
        sc.rows.forEach((r) => {
          r.skip = false;
        });
        renderWorkspace(scope);
        return;
      }

      if (action === 'commit-import') {
        await commitScope(scope);
      }
    });

    document.addEventListener('change', (e) => {
      const fileInp = e.target.closest('input[data-excel-file]');
      if (fileInp && fileInp.files?.[0]) {
        const scope = fileInp.dataset.excelFile;
        handleFileUpload(scope, fileInp.files[0]);
        fileInp.value = '';
        return;
      }

      const sheetSel = e.target.closest('select[data-excel-sheet]');
      if (sheetSel) {
        loadSheetFromWorkbook(sheetSel.dataset.excelSheet, sheetSel.value);
        return;
      }

      const mapSel = e.target.closest('select[data-excel-map]');
      if (mapSel) {
        const scope = mapSel.dataset.excelMap;
        const fieldKey = mapSel.dataset.mapField;
        const sc = scopeState[scope];
        if (!sc) return;
        sc.columnMap[fieldKey] = mapSel.value;
        applyMappingAndValidate(scope);
        renderWorkspace(scope);
        return;
      }

      const errToggle = e.target.closest('input[data-excel-action="toggle-errors-only"]');
      if (errToggle) {
        const scope = errToggle.dataset.excelScope;
        scopeState[scope].errorsOnly = errToggle.checked;
        renderWorkspace(scope);
        return;
      }

      const skipChk = e.target.closest('input[data-excel-action="toggle-skip"]');
      if (skipChk) {
        const scope = skipChk.dataset.excelScope;
        const row = scopeState[scope]?.rows.find((r) => r.id === skipChk.dataset.rowId);
        if (!row) return;
        row.skip = skipChk.checked;
        scopeState[scope].summary = validateScopeRows(scope, scopeState[scope].rows, getState());
        if (scopeState[scope].editMode) {
          patchLiveValidationDom(scope);
        } else {
          renderWorkspace(scope);
        }
        return;
      }

      const sel = e.target.closest('select[data-excel-input]');
      if (sel) {
        const { excelScope: scope, rowId, field } = sel.dataset;
        const sc = scopeState[scope];
        const row = sc?.rows.find((r) => r.id === rowId);
        if (!row) return;
        row.data[field] = sel.value;
        if (scope === 'students' && field === 'category') {
          row._autoCat = false;
        }
        if (scope === 'schedule' && field === 'eventId') {
          const ev = (getState().events || []).find((x) => x.id === sel.value);
          row.data.eventName = ev?.name || '';
          row.data.category = ev?.category || '';
          sc.summary = validateScopeRows(scope, sc.rows, getState());
          renderWorkspace(scope);
          return;
        }
        sc.summary = validateScopeRows(scope, sc.rows, getState());
        patchLiveValidationDom(scope);
      }
    });

    document.addEventListener('input', (e) => {
      const inp = e.target.closest('input[data-excel-input]');
      if (!inp) return;
      const { excelScope: scope, rowId, field } = inp.dataset;
      const sc = scopeState[scope];
      const row = sc?.rows.find((r) => r.id === rowId);
      if (!row) return;
      row.data[field] = inp.value;
      if (scope === 'students' && field === 'dob') {
        if (getClassificationConfig(getState()).mode === 'dob' && !row._autoCat && !clean(row.data.category)) {
          row._autoCat = true;
        }
      }
      sc.summary = validateScopeRows(scope, sc.rows, getState());
      patchLiveValidationDom(scope);
    });

    document.addEventListener('dragover', (e) => {
      const zone = e.target.closest('[data-excel-dropzone]');
      if (!zone) return;
      e.preventDefault();
      zone.classList.add('border-blue-600', 'dark:border-blue-500', 'bg-blue-50/40', 'dark:bg-blue-950/30');
    });

    document.addEventListener('dragleave', (e) => {
      const zone = e.target.closest('[data-excel-dropzone]');
      if (!zone) return;
      zone.classList.remove('border-blue-600', 'dark:border-blue-500', 'bg-blue-50/40', 'dark:bg-blue-950/30');
    });

    document.addEventListener('drop', (e) => {
      const zone = e.target.closest('[data-excel-dropzone]');
      if (!zone) return;
      e.preventDefault();
      zone.classList.remove('border-blue-600', 'dark:border-blue-500', 'bg-blue-50/40', 'dark:bg-blue-950/30');
      const scope = zone.dataset.excelDropzone;
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFileUpload(scope, file);
    });
  }

  bind();

  return {
    setSubTab,
    renderAllWorkspaces: () => {
      ['students', 'events', 'schedule'].forEach((scope) => {
        if (subTabs[scope] === 'excel') renderWorkspace(scope);
      });
    },
    refreshActiveWorkspace: (scope) => {
      if (subTabs[scope] === 'excel') renderWorkspace(scope);
    }
  };
}
