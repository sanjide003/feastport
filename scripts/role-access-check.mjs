import { readFileSync } from 'node:fs';

const source = (file) => readFileSync(file, 'utf8');
const login = source('login.js');
const adminAuth = source('admin-auth.js');
const admin = source('admin-main.js');
const adminResults = source('admin-results.js');
const team = source('team.html');
const judge = source('judge.js');
const tv = source('tv.html');
const tvControl = source('tv-control.html');
const rules = source('firestore.rules');

const contracts = {
  'role redirects without publisher': [
    "admin: 'admin.html'",
    "superAdmin: 'admin.html'",
    "teamLeader: 'team.html'",
    "judge: 'judge.html'"
  ].every((value) => login.includes(value)) && !login.includes('publish.html'),
  'admin profile gate': adminAuth.includes("doc(db, 'adminUsers', user.uid)")
    && adminAuth.includes('ADMIN_ROLES.has(profile.role)'),
  'tv control admin gate': tvControl.includes("doc(db, 'adminUsers', user.uid)")
    && tvControl.includes("['admin', 'superAdmin'].includes(profile.role)"),
  'access creation uses Firebase Auth': admin.includes('createUserWithEmailAndPassword')
    && admin.includes("setDoc(doc(db, 'accessUsers'")
    && admin.includes("setDoc(doc(db, 'adminUsers'"),
  'team profile and strict team scope': team.includes("profile.role !== 'teamLeader'")
    && team.includes("where('team', '==', currentTeam)")
    && team.includes("where('team', 'in', ['All', currentTeam])")
    && rules.includes("hasAccessRole('teamLeader')"),
  'team registration CRUD and lock': team.includes("addDoc(collection(db, 'registrations')")
    && team.includes("updateDoc(doc(db, 'registrations'")
    && team.includes("deleteDoc(doc(db, 'registrations'")
    && rules.includes('registrationsOpen()'),
  'judge profile and scoped assignments': judge.includes("access.role !== 'judge'")
    && judge.includes("where('judgeId', 'in', ids.slice(0, 30))")
    && judge.includes('currentJudgeIds')
    && rules.includes('judgeOwnsAssignment'),
  'judge draft submit transaction': judge.includes("persistScores(id, 'draft')")
    && judge.includes('runTransaction')
    && judge.includes("status === 'submitted'")
    && rules.includes("resource.data.status == 'draft'")
    && rules.includes('judgeOwnsAssignment(scoreId'),
  'admin direct publishing and revisions': adminResults.includes("batch.set(doc(db, 'results', eventId)")
    && adminResults.includes("batch.update(doc(db, 'judgeScores'")
    && adminResults.includes("batch.set(doc(collection(db, 'auditLogs'))")
    && adminResults.includes("doc(db, 'settings', 'public_summary')")
    && rules.includes('allow create, update, delete: if isAdmin();'),
  'public results published only': rules.includes("resource.data.status == 'published'")
    && source('index.html').includes("where('status', '==', 'published')")
    && source('results.html').includes("where('status', '==', 'published')")
    && source('team.html').includes("where('status', '==', 'published')")
    && tv.includes("where('status', '==', 'published')"),
  'default deny': rules.includes('match /{document=**}')
    && rules.includes('allow read, write: if false;')
};

let failed = false;
for (const [name, passed] of Object.entries(contracts)) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  failed ||= !passed;
}
if (failed) throw new Error('Role access contract check failed');
console.log('Role access contracts passed');
