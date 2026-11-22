import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applicationDecision, capacityState, eventCapacity, normalizeRegistrationConfig, participantEligibleForEvent, participationLimitDecision, participationUsage, registrationPhase, registrationWindowOpen, selfRegistrationAllowed, studentEligibleForEvent } from '../registration-utils.js';
import { buildVerificationUrl, computeVerificationToken, formatChestNumber, renderParticipantIdCardHtml } from '../id-card-renderer.js';
import { encodeQrMatrix } from '../qr-svg.js';
import {
  DEFAULT_CLASS_LIST,
  buildStudentDetailsPatch,
  getStudentFieldVisibility,
  normalizeCategoryClassificationConfig,
  normalizeClassValue,
  resolveCategoryFromStudentInputs,
  studentClassValue,
  studentDobValue
} from '../admin-students.js';
const student={id:'s1',name:'Student',team:'Blue',category:'Junior',gender:'Girls',details:{class:'7'}};
const event={id:'e1',name:'Event',limit:3,type:'Single',category:'Junior',gender:'Girls',allowedParticipantTypes:['student'],allowedRegistrationChannels:['self'],eligibleClasses:['7']};
assert.equal(studentEligibleForEvent(student,event,{registrationChannels:['self']}),true);
assert.equal(studentEligibleForEvent({...student,team:''},event,{}),false);
assert.equal(studentEligibleForEvent(student,{...event,status:'needs_review'}, {registrationChannels:['self']}),true);
assert.equal(studentEligibleForEvent(student,{...event,status:'draft'}, {registrationChannels:['self']}),false);
assert.equal(participantEligibleForEvent({id:'p1',participantType:'alumni',gender:'Girls',category:'Open'},{...event,category:'General',allowedParticipantTypes:['alumni']},{registrationChannels:['self']}),true);
assert.equal(studentEligibleForEvent(student,{...event,id:'g1',category:'General'}, {registrationChannels:['self']}, {generalEventEligibleCategories:['Junior']}),true);
assert.equal(studentEligibleForEvent({...student,category:'Senior'},{...event,id:'g2',category:'General'}, {registrationChannels:['self']}, {generalEventEligibleCategories:['Junior']}),false);
assert.equal(studentEligibleForEvent({...student,category:'Senior'},{...event,id:'g3',category:'General'}, {registrationChannels:['self']}, {generalEventEligibleCategories:[]}),true);
assert.equal(normalizeRegistrationConfig({generalEventEligibleCategories:[]}).generalEventEligibleCategories,null);
assert.equal(eventCapacity(event),3);
assert.deepEqual(capacityState(event,5),{capacity:3,count:5,remaining:0,state:'overloaded',excess:2});
assert.equal(applicationDecision({}, {}, capacityState(event,3)).status,'waitlisted');
assert.equal(applicationDecision({unfilledEventsOnly:true}, {}, capacityState(event,3)).allowed,false);
assert.equal(applicationDecision({}, {mode:'closed'}, capacityState(event,0)).allowed,false);
assert.equal(registrationWindowOpen(normalizeRegistrationConfig({openAt:1,closeAt:10}),5),true);
assert.equal(registrationPhase({selectionDeadlineAt:4,finalizationLockAt:8},5),'selection_closed');
assert.equal(selfRegistrationAllowed({registrationChannels:['admin','self']}),true);
assert.equal(selfRegistrationAllowed({registrationChannels:['admin','teamLeader']}),false);
assert.equal(studentEligibleForEvent(student,{...event,id:'g4',type:'Group',allowedRegistrationChannels:[]}, {registrationChannels:['self']}),true);
assert.equal(studentEligibleForEvent(student,{...event,id:'g5',type:'Group',allowedRegistrationChannels:['admin','teamLeader']}, {registrationChannels:['self']}),false);
assert.deepEqual(normalizeRegistrationConfig({applicationFields:{description:'required',images:'invalid'}}).applicationFields,{description:'required',youtube:'optional',reference:'optional',images:'optional'});
assert.equal(normalizeRegistrationConfig({applicationImageMaxCount:99}).applicationImageMaxCount,1);
assert.equal(normalizeRegistrationConfig({applicationImageMaxSizeKb:999}).applicationImageMaxSizeKb,300);
const limitConfig={participationLimits:{group:{mode:'custom',limit:1},total:{mode:'custom',limit:2},excludeGeneralFromTotal:true}};
assert.deepEqual(participationUsage(['e1'],[{...event,type:'Group'}],limitConfig),{offStage:1,onStage:0,single:0,group:1,general:0,total:1});
assert.equal(participationLimitDecision(limitConfig,{...event,type:'Group'}, {group:1,total:1}).allowed,false);
assert.equal(participationLimitDecision({participationLimits:{group:{enabled:false,mode:'custom',limit:0}}},{...event,type:'Group'},{group:5}).allowed,true);

// ID card layout & public QR verification checks
assert.equal(formatChestNumber('#104'), '104');
assert.equal(formatChestNumber('R101'), 'R101');
const cardStudent = { id: 'secret_doc_99123', name: 'Amina Rahman', team: 'red_house', category: 'Senior', gender: 'Girls', chestNo: '#R104', details: { class: '10' } };
const tokenA = computeVerificationToken(cardStudent);
const tokenB = computeVerificationToken({ ...cardStudent, chestNo: 'R104' });
assert.equal(tokenA.length, 8);
assert.equal(tokenA, tokenB);
assert.notEqual(tokenA, computeVerificationToken({ ...cardStudent, chestNo: 'R105' }));
const qrUrl = buildVerificationUrl(cardStudent, 'https://ais-dev-xh3uqfwhmc6aghg2dh63iu-700250552557.asia-northeast1.run.app');
assert.equal(qrUrl.startsWith('https://ais-dev-xh3uqfwhmc6aghg2dh63iu-700250552557.asia-northeast1.run.app/verify.html?c=R104&k='), true);
const qrMatrix = encodeQrMatrix(qrUrl);
assert.equal(qrMatrix.size >= 21 && qrMatrix.version <= 9, true);
const cardHtml = renderParticipantIdCardHtml({
  student: cardStudent,
  confirmedEvents: [{ id: 'e1', name: 'Mappila Pattu', stage: 'On-Stage', type: 'Single' }],
  branding: { festName1: 'Kalotsavam', festName2: 'Arts Fest' },
  teamDisplayNames: { red_house: 'Red House' },
  festYear: '2026',
  verificationUrl: qrUrl
});
assert.equal(cardHtml.includes('#R104'), false, 'Chest number must not include # prefix');
assert.equal(cardHtml.includes('ID:'), false, 'Student document ID must be omitted from verification badge');
assert.equal(cardHtml.includes('secret_doc_99123'), false, 'Raw Firestore ID must never appear in rendered card HTML');
assert.ok(cardHtml.indexOf('R104') < cardHtml.indexOf('PARTICIPANT'), 'PARTICIPANT badge must appear after Chest Number');
assert.ok(cardHtml.indexOf('PARTICIPANT') < cardHtml.indexOf('Kalotsavam Arts Fest'), 'Fest name must appear in the bottom footer below body content');
const verifyHtml = readFileSync('verify.html', 'utf8');
assert.equal(verifyHtml.includes('studentRegistrationSession'), false, 'verify.html must never access or create studentRegistrationSession');

// Category classification & optional student fields checks
assert.deepEqual(getStudentFieldVisibility({ mode: 'manual', showClassInManual: false, showDobInManual: false }), { mode: 'manual', showClass: false, showDob: false });
assert.deepEqual(getStudentFieldVisibility({ mode: 'manual', showClassInManual: true, showDobInManual: true }), { mode: 'manual', showClass: true, showDob: true });
assert.deepEqual(getStudentFieldVisibility({ mode: 'class' }), { mode: 'class', showClass: true, showDob: false });
assert.deepEqual(getStudentFieldVisibility({ mode: 'dob' }), { mode: 'dob', showClass: false, showDob: true });

assert.equal(normalizeClassValue('Class 7', DEFAULT_CLASS_LIST), '7');
assert.equal(normalizeClassValue('+2', ['1', '2', '+1', '+2']), '+2');
assert.equal(normalizeClassValue('Degree 1', ['Degree 1', 'Degree 2']), 'Degree 1');

const classRulesCfg = normalizeCategoryClassificationConfig({
  mode: 'class',
  classes: ['LKG', '1', '2', '8', '+1', '+2'],
  classRules: { sub_junior: ['LKG', '1', '2'], senior: ['+1', '+2'] }
});
assert.deepEqual(
  resolveCategoryFromStudentInputs({ config: classRulesCfg, categories: ['sub_junior', 'junior', 'senior'], classValue: 'Class 2' }),
  { matched: true, category: 'sub_junior', mode: 'class' }
);
assert.deepEqual(
  resolveCategoryFromStudentInputs({ config: classRulesCfg, categories: ['sub_junior', 'junior', 'senior'], classValue: '+2' }),
  { matched: true, category: 'senior', mode: 'class' }
);
assert.deepEqual(
  resolveCategoryFromStudentInputs({ config: classRulesCfg, categories: ['sub_junior', 'junior', 'senior'], classValue: '8' }),
  { matched: false, category: '', mode: 'class' }
);

const dobRulesCfg = normalizeCategoryClassificationConfig({
  mode: 'dob',
  dobRules: {
    sub_junior: { from: '2014-01-01', to: '2016-12-31' },
    senior: { from: '2008-01-01', to: '2010-12-31' }
  }
});
assert.deepEqual(
  resolveCategoryFromStudentInputs({ config: dobRulesCfg, categories: ['sub_junior', 'senior'], dobValue: '2014-01-01' }),
  { matched: true, category: 'sub_junior', mode: 'dob' }
);
assert.deepEqual(
  resolveCategoryFromStudentInputs({ config: dobRulesCfg, categories: ['sub_junior', 'senior'], dobValue: '2012-06-15' }),
  { matched: false, category: '', mode: 'dob' }
);

const mergedDetails = buildStudentDetailsPatch({ guardianName: 'Parent' }, { classValue: '10', dobValue: '2010-05-14' });
assert.deepEqual(mergedDetails, { guardianName: 'Parent', class: '10', dob: '2010-05-14' });
assert.equal(studentClassValue({ details: mergedDetails }), '10');
assert.equal(studentDobValue({ details: mergedDetails }), '2010-05-14');
assert.deepEqual(buildStudentDetailsPatch(mergedDetails, { classValue: '', dobValue: '' }), { guardianName: 'Parent' });

console.log('Advanced registration engine checks passed');
