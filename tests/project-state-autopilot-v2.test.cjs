const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'chatgpt-conversation-handoff-exporter.user.js'), 'utf8');

function extractFunction(name) {
  const marker = '  function ' + name;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'missing ' + name);
  const next = source.indexOf('\n  function ', start + marker.length);
  return source.slice(start, next >= 0 ? next : undefined).trim();
}

let harness = '';
harness += "function uaiosContinuityBoundString(value, maxChars = 12000) {\n";
harness += "  if (value == null) return '';\n";
harness += "  const text = String(value);\n";
harness += "  return text.length <= maxChars ? text : text.slice(0, maxChars);\n";
harness += "}\n";
harness += "function uaiosContinuitySanitizeState(input = {}) { return { ...input }; }\n";
for (const name of [
  'uaiosContinuitySignalText',
  'uaiosContinuityUniqueSignals',
  'uaiosContinuityLastSignal',
  'uaiosContinuityResolutionBoundary',
  'uaiosContinuityNextActionFromAssistant',
  'uaiosContinuityIsBootstrapMessage',
  'uaiosContinuityDeriveProjectState'
]) {
  harness += extractFunction(name) + '\n';
}
harness += 'globalThis.derive = uaiosContinuityDeriveProjectState;\n';
harness += "function uaiosContinuityGetState() { return null; }\n";
harness += "function uaiosContinuityMergeProjectState(autoState) { return autoState; }\n";
harness += "function uaiosContinuityFormatProjectState(state) { return 'PROJECT STATE SNAPSHOT\\nSource: ' + (state.state_source || 'unknown'); }\n";
harness += extractFunction('uaiosContinuityUpgradeLegacyBootstrap') + '\n';
harness += 'globalThis.upgrade = uaiosContinuityUpgradeLegacyBootstrap;\n';

const context = { console };
vm.createContext(context);
vm.runInContext(harness, context);

const baseMessages = [
  { role: 'assistant', content: 'v1.5.8 FAIL: composer hydration still failing and blocker remains' },
  { role: 'assistant', content: 'Cross-chat Continuity Core PASS เต็มระบบ ✅ Bridge: OK' },
  { role: 'user', content: 'online ครับ' },
  {
    role: 'assistant',
    content: 'ตอนนี้อยู่ v1.7.0 | Bridge: OK | State: AUTO\nขั้นต่อไป: กด New Chat Handoff เพื่อทดสอบ Project State Autopilot ต่อ'
  }
];

const clean = context.derive(baseMessages, 'แนะนำระบบแก้หมดเวลา');
assert.equal(clean.state_source, 'autopilot-v2');
assert.equal(clean.blockers.length, 0, 'resolved FAIL must not survive the latest PASS boundary');
assert.match(clean.next_action, /New Chat Handoff/i);
assert.match(clean.phase, /v1\.7\.0/i);
assert.match(clean.notes, /latest resolved\/PASS boundary/i);

const activeBlocker = context.derive(
  [...baseMessages, { role: 'assistant', content: 'ยังติด bug composer hydration หลัง PASS ต้องแก้ต่อ' }],
  'แนะนำระบบแก้หมดเวลา'
);
assert.ok(activeBlocker.blockers.some((item) => /bug composer hydration/i.test(item)), 'new blocker after PASS must remain visible');

const nestedBootstrap = context.derive(
  [
    ...baseMessages,
    {
      role: 'user',
      content: 'UAIOS CONTINUITY BOOTSTRAP\nPROJECT STATE SNAPSHOT\nSource: autopilot-v1\nObjective: stale objective\nBOUNDED CONTINUITY PAYLOAD\n{}'
    },
    {
      role: 'assistant',
      content: 'ตอนนี้ v1.7.1 ผ่านแล้ว ✅\nขั้นต่อไป: ตรวจ acceptance ใหม่โดยไม่ดึง bootstrap เก่ามาเป็น objective'
    }
  ],
  'Conversation Continuity Protocol'
);
assert.doesNotMatch(nestedBootstrap.objective, /UAIOS CONTINUITY BOOTSTRAP/i, 'bootstrap handoff text must never become the project objective');
assert.doesNotMatch(nestedBootstrap.objective, /stale objective/i, 'nested stale objective must be ignored');
assert.match(nestedBootstrap.phase, /v1\.7\.1/i);
assert.match(nestedBootstrap.next_action, /acceptance/i);


const legacyPayload = {
  schema_version: 1,
  title: 'Legacy handoff',
  project_state: { state_source: 'autopilot-v1', objective: 'stale legacy objective' },
  recent_messages: [
    { role: 'user', content: 'Continue the actual project from the verified state.' },
    { role: 'assistant', content: 'Resolved and PASS. Next step: verify v1.7.2 acceptance.' }
  ]
};
const legacyBootstrap = 'UAIOS CONTINUITY BOOTSTRAP\nPROJECT STATE SNAPSHOT\nSource: autopilot-v1\n\nBOUNDED CONTINUITY PAYLOAD\n' + JSON.stringify(legacyPayload);
const upgradedBootstrap = context.upgrade(legacyBootstrap);
assert.notEqual(upgradedBootstrap, legacyBootstrap, 'legacy bootstrap must be rewritten before hydration');
const upgradedPayload = JSON.parse(upgradedBootstrap.split('\nBOUNDED CONTINUITY PAYLOAD\n')[1]);
assert.equal(upgradedPayload.project_state.state_source, 'autopilot-v2', 'legacy bootstrap must upgrade project state to autopilot-v2');
assert.doesNotMatch(upgradedPayload.project_state.objective || '', /stale legacy objective/i);
const currentBootstrap = 'UAIOS CONTINUITY BOOTSTRAP\nBOUNDED CONTINUITY PAYLOAD\n' + JSON.stringify({
  ...legacyPayload,
  project_state: { state_source: 'autopilot-v2', objective: 'current objective' }
});
assert.equal(context.upgrade(currentBootstrap), currentBootstrap, 'current autopilot-v2 bootstrap must remain unchanged');

console.log('project state autopilot v2 behavioral tests: PASS');
