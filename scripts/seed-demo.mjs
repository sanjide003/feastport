// Seed the fixed loopback emulator project with fictional festival records.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
initializeApp({ projectId: 'demo-feastport' });
const db = getFirestore();
const auth = getAuth();
const password = process.env.FEASTPORT_DEMO_PASSWORD || randomBytes(12).toString('hex');
const batch = db.batch();
const seed = (path, data) => batch.set(db.doc(path), data, { merge: true });
const roles = ['admin', 'teamLeader', 'judge'];
for (const role of roles) {
  const uid = 'demo-' + role;
  const email = role.toLowerCase() + '@example.test';
  const profile = { role, active: true, email, name: role === 'teamLeader' ? 'Aurora Team Lead' : 'Festival ' + role, authUid: uid };
  if (role === 'teamLeader') Object.assign(profile, { team: 'Aurora', genderScope: 'Both' });
  try {
    await auth.updateUser(uid, { email, password });
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    await auth.createUser({ uid, email, password });
  }
  seed('accessUsers/' + uid, profile);
  if (role === 'admin') seed('adminUsers/' + uid, profile);
}
seed('settings/home_config', { festName1: 'Aurora Arts Festival', setupCompleted: true, tagline: 'Music, movement and the spoken word.' });
seed('settings/general', { teams: ['Aurora', 'Solstice'], teamColors: { Aurora: '#653da9', Solstice: '#aa542b' } });
seed('students/demo-river', { name: 'River Lane', team: 'Aurora', category: 'General', gender: 'Girls', chestNo: 'A101' });
const date = new Date().toISOString().slice(0, 10);
const event = { category: 'General', gender: 'Both', type: 'Single', stage: 'On-Stage', limit: 3, scheduleDate: date, scheduleStage: 'Main Hall', status: 'active', maximumMark: 100 };
seed('events/demo-poetry', { ...event, name: 'Spoken Word', time: '15:30' });
seed('events/demo-rhythm', { ...event, name: 'Solo Rhythm', time: '16:00' });
seed('judgeAssignments/demo-poetry-judge', { eventId: 'demo-poetry', judgeId: 'demo-judge', active: true });
seed('results/demo-rhythm', { status: 'published', eventId: 'demo-rhythm', eventName: 'Solo Rhythm', category: 'General', publishedAt: Date.now(), places: [{ rank: 1, label: 'First', winners: [{ id: 'demo-river', name: 'River Lane', team: 'Aurora', chestNo: 'A101' }] }] });
await batch.commit();
console.log('Local demo ready. Sign in with admin@example.test, teamleader@example.test or judge@example.test.');
if (!process.env.FEASTPORT_DEMO_PASSWORD) console.log('Local demo password for this run:', password);
