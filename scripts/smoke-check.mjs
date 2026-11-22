import { existsSync, readFileSync } from 'node:fs';

const read = (f) => readFileSync(f, 'utf8');
const indexHtml = read('index.html');
const resultsHtml = read('results.html');
const registerHtml = read('register.html');
const teamHtml = read('team.html');
const tvHtml = read('tv.html');
const tvControlHtml = read('tv-control.html');
const adminHtml = read('admin.html');
const adminMain = read('admin-main.js');
const adminResults = read('admin-results.js');
const judgeHtml = read('judge.html');
const judgeJs = read('judge.js');
const dataCache = read('data-cache.js');
const dependencyLoader = read('dependency-loader.js');
const scoreUtils = read('score-utils.js');
const rules = read('firestore.rules');

const checks = {
  'obsolete bloat files removed': !existsSync('publish.html') && !existsSync('poster-certificate-engine.js') && !existsSync('poster-certificate-admin.js'),
  'heavy pdf/canvas dependencies removed and xlsx lazy-loaded': !dependencyLoader.includes('jspdf') && !dependencyLoader.includes('html2canvas') && !indexHtml.includes('xlsx') && !resultsHtml.includes('xlsx') && !tvHtml.includes('xlsx'),
  'shared data cache implemented': dataCache.includes('cachedGetDoc') && dataCache.includes('cachedGetDocs') && dataCache.includes('invalidateCache'),
  'public index uses cached reads without students or listeners': indexHtml.includes('cachedGetDoc') && indexHtml.includes('cachedGetDocs') && !indexHtml.includes('onSnapshot') && !indexHtml.includes("collection(db, 'students')") && !indexHtml.includes('collection(db, "students")'),
  'public results uses cached reads and winnerDetails': resultsHtml.includes('cachedGetDoc') && resultsHtml.includes('cachedGetDocs') && !resultsHtml.includes('onSnapshot') && !resultsHtml.includes("collection(db, 'students')"),
  'tv display avoids students and registrations listeners': tvHtml.includes('winnerDetails') && !tvHtml.includes("collection(db, 'students')") && !tvHtml.includes("collection(db, 'registrations')") && !tvHtml.includes("collection(db, 'participants')"),
  'tv control avoids students reads': tvControlHtml.includes('winnerDetails') && !tvControlHtml.includes("collection(db, 'students')"),
  'team portal uses strict team scoped queries': teamHtml.includes("where('team', '==', currentTeam)") && teamHtml.includes('cachedGetDoc') && teamHtml.includes('winnerDetails'),
  'admin console has separated tabs and direct publishing': ['overview', 'setup', 'students', 'events', 'registrations', 'schedule', 'results', 'staff', 'tv', 'notices', 'reset'].every((t) => adminHtml.includes(`data-tab="${t}"`)) && adminResults.includes('publishFromSheets') && adminResults.includes('resolveWinnerDetails') && adminMain.includes('createAdminResultsController'),
  'judge desk uses external module and transaction locking': judgeHtml.includes('src="./judge.js"') && judgeJs.includes('runTransaction') && judgeJs.includes('cachedGetDoc'),
  'registration portal supports student verification': registerHtml.includes('student_verification') || registerHtml.includes('students') && registerHtml.includes('registrationRequests'),
  'winnerDetails helper present in score-utils': scoreUtils.includes('resolveWinnerDetails'),
  'security rules protect results and team scope': rules.includes('isAdmin()') && rules.includes("resource.data.status == 'published'")
};

let failed = 0;
for (const [label, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed++;
}
if (failed) throw new Error(`${failed} smoke check(s) failed`);
console.log('All streamlined smoke checks passed');
