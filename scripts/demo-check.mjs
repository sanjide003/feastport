import assert from 'node:assert/strict';

const project = 'demo-feastport';
const authEndpoint = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo';
const documents = 'http://127.0.0.1:8080/v1/projects/' + project + '/databases/(default)/documents/';
const password = process.env.FEASTPORT_DEMO_PASSWORD;
assert.ok(password, 'Seed the local demo with FEASTPORT_DEMO_PASSWORD before running this check.');

for (const role of ['admin', 'teamleader', 'judge']) {
  const response = await fetch(authEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: role + '@example.test', password, returnSecureToken: true })
  });
  assert.equal(response.status, 200, role + ' sign-in');
  const user = await response.json();
  const headers = { Authorization: 'Bearer ' + user.idToken };
  const profile = await fetch(documents + 'accessUsers/' + user.localId, { headers });
  assert.equal(profile.status, 200, role + ' profile');
  assert.equal((await profile.json()).fields.active.booleanValue, true);
}
const published = await fetch(documents + 'results/demo-rhythm');
assert.equal(published.status, 200);
assert.equal((await published.json()).fields.eventName.stringValue, 'Solo Rhythm');
const search = await fetch('http://127.0.0.1:5001/' + project + '/us-central1/searchRegistrationCandidates', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ data: { participantType: 'student', team: 'Aurora', gender: 'Girls', query: 'River' } })
});
assert.equal(search.status, 200, 'candidate search');
assert.ok((await search.json()).result.candidates.some(student => student.id === 'demo-river'));
console.log('Three role sign-ins, scoped profile reads, the public result and registration search passed.');
