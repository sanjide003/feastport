const CHEST_REGEX = /^[A-Za-z0-9_-]+$/;
const CHEST_SEED_REGEX = /^([A-Za-z0-9_-]*?)(\d+)$/;

export const studentGender = (student) => (student?.gender === 'Girls' ? 'Girls' : 'Boys');
export const chestKey = (team, category, gender) => `${team}-${category}-${gender}`;
export const legacyChestKey = (team, category) => `${team}-${category}`;

export function defaultChestConfig() {
  return {
    enabled: false,
    splitByCategory: false,
    splitByGender: false,
    series: {}
  };
}

export function normalizeChestConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const series = {};
  if (src.series && typeof src.series === 'object') {
    for (const [k, v] of Object.entries(src.series)) {
      const cleaned = String(v ?? '').trim();
      if (k && cleaned) series[k] = cleaned;
    }
  }
  return {
    enabled: Boolean(src.enabled),
    splitByCategory: Boolean(src.splitByCategory),
    splitByGender: Boolean(src.splitByGender),
    series
  };
}

export function chestSeriesKey({ team = '', category = '', gender = 'Boys', splitByCategory = false, splitByGender = false } = {}) {
  const parts = [String(team || '').trim()];
  if (splitByCategory) parts.push(String(category || '').trim());
  if (splitByGender) parts.push(gender === 'Girls' ? 'Girls' : 'Boys');
  return parts.join('::');
}

export function parseChestSeed(rawSeed) {
  const seed = String(rawSeed ?? '').trim();
  if (!seed || seed.length > 32 || !CHEST_REGEX.test(seed)) return null;
  const match = seed.match(CHEST_SEED_REGEX);
  if (!match) return null;
  const [, prefix, digits] = match;
  const startNum = Number(digits);
  if (!Number.isSafeInteger(startNum) || startNum < 0) return null;
  return {
    raw: seed,
    prefix,
    digits,
    padLength: digits.length,
    startNum
  };
}

export function formatChestCandidate(parsedSeed, num) {
  const padded = String(Math.max(0, num)).padStart(parsedSeed.padLength, '0');
  return `${parsedSeed.prefix}${padded}`;
}

export function getConfiguredChestSeed(config, { team = '', category = '', gender = 'Boys' } = {}) {
  const cfg = normalizeChestConfig(config);
  const key = chestSeriesKey({
    team,
    category,
    gender,
    splitByCategory: cfg.splitByCategory,
    splitByGender: cfg.splitByGender
  });
  return String(cfg.series[key] || '').trim();
}

export function resolveNextAutoChestNo({ config, students = [], team = '', category = '', gender = 'Boys' } = {}) {
  const cfg = normalizeChestConfig(config);
  if (!cfg.enabled) {
    return { ok: false, chestNo: '', reason: 'Automated chest numbering is disabled.' };
  }
  if (!team) {
    return { ok: false, chestNo: '', reason: 'Select a Team first.' };
  }
  if (cfg.splitByCategory && !category) {
    return { ok: false, chestNo: '', reason: 'Select a Category first.' };
  }
  if (cfg.splitByGender && !gender) {
    return { ok: false, chestNo: '', reason: 'Select a Gender first.' };
  }

  const seed = getConfiguredChestSeed(cfg, { team, category, gender });
  if (!seed) {
    return {
      ok: false,
      chestNo: '',
      reason: 'No starting chest number saved for this Team/Category/Gender in Festival Setup.'
    };
  }

  const parsed = parseChestSeed(seed);
  if (!parsed) {
    return {
      ok: false,
      chestNo: '',
      reason: `Invalid starting chest format "${seed}". End with digits (e.g., 101 or R101).`
    };
  }

  const takenLower = new Set();
  let maxMatchingNum = parsed.startNum - 1;
  const normalizedGender = gender === 'Girls' ? 'Girls' : 'Boys';
  const prefixLower = parsed.prefix.toLowerCase();

  for (const s of students) {
    const cRaw = String(s?.chestNo || '').trim();
    if (!cRaw) continue;
    takenLower.add(cRaw.toLowerCase());

    const sameTeam = s?.team === team;
    const sameCat = !cfg.splitByCategory || s?.category === category;
    const sameGender = !cfg.splitByGender || studentGender(s) === normalizedGender;
    if (!sameTeam || !sameCat || !sameGender) continue;

    const p = parseChestSeed(cRaw);
    if (!p || p.prefix.toLowerCase() !== prefixLower) continue;
    if (p.startNum > maxMatchingNum) {
      maxMatchingNum = p.startNum;
    }
  }

  let candidateNum = maxMatchingNum + 1;
  let guard = 0;
  let candidate = formatChestCandidate(parsed, candidateNum);
  while (takenLower.has(candidate.toLowerCase()) && guard < 100000) {
    candidateNum += 1;
    guard += 1;
    candidate = formatChestCandidate(parsed, candidateNum);
  }

  if (takenLower.has(candidate.toLowerCase())) {
    return { ok: false, chestNo: '', reason: 'Unable to find an unused chest number in this series.' };
  }

  return { ok: true, chestNo: candidate, reason: '', seed };
}

export function validateManualChestNo(rawChestNo, students = [], excludeStudentId = '') {
  const chestNo = String(rawChestNo ?? '').trim();
  if (!chestNo) return { ok: false, chestNo: '', error: 'Chest number is required.' };
  if (chestNo.length > 32) return { ok: false, chestNo, error: 'Chest number must be 32 characters or fewer.' };
  if (!CHEST_REGEX.test(chestNo)) {
    return { ok: false, chestNo, error: 'Chest number allows only letters, numbers, "-" or "_".' };
  }
  const lower = chestNo.toLowerCase();
  const conflict = students.find(
    (s) => s?.id !== excludeStudentId && String(s?.chestNo || '').trim().toLowerCase() === lower
  );
  if (conflict) {
    return {
      ok: false,
      chestNo,
      error: `Duplicate chest number "${chestNo}" is already assigned to ${conflict.name || 'another student'}.`
    };
  }
  return { ok: true, chestNo, error: '' };
}
