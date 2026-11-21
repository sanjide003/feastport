import assert from 'node:assert/strict';
import { normalizeFestSetup } from '../fest-config.js';
import { eventDuplicateKey, eventToFirestore, normalizeEventRow, parseCriteria, validateEvent } from '../event-utils.js';

const setup = normalizeFestSetup();
assert.deepEqual(setup.participantTypes, ['student']);
assert.equal(setup.resultWorkflow, 'hybrid');

const criteria = parseCriteria('Language - 20\nContent: 40\nPresentation = 40');
assert.equal(criteria.total, 100);
assert.equal(criteria.unparsed.length, 0);

const event = normalizeEventRow({
  name: 'Speech',
  category: 'Junior',
  gender: 'boy',
  stage: 'ON STAGE',
  type: 'solo',
  entriesPerTeam: '3',
  resultMethod: 'criteria',
  criteriaText: 'Language - 20; Content - 40; Presentation - 40'
});
assert.equal(event.gender, 'Boys');
assert.equal(event.type, 'Single');
assert.equal(event.maximumMark, 100);

const groupEvent = normalizeEventRow({
  name: 'Team Dance',
  category: 'Junior',
  gender: 'Girls',
  stage: 'On-Stage',
  type: 'Group',
  entriesPerTeam: '2',
  membersPerEntry: '5',
  resultMethod: 'direct'
});
assert.equal(groupEvent.entriesPerTeam, 2);
assert.equal(groupEvent.membersPerEntry, 5);

const validation = validateEvent(event, { ...setup, categories: ['Junior'] }, []);
assert.equal(validation.status, 'ready');
assert.ok(validateEvent(event, { ...setup, categories: ['Junior'] }, [{ ...event, id: 'existing_1' }]).errors.some((err) => err.includes('Duplicate')));
assert.equal(eventDuplicateKey(event), eventDuplicateKey({ ...event, code: 'OTHER' }));

const stored = eventToFirestore(event, { setup, validation });
assert.equal(stored.status, 'validated');
assert.equal(stored.criteria.length, 3);
assert.deepEqual(stored.allowedParticipantTypes, ['student']);

console.log('Event engine runtime checks passed');
