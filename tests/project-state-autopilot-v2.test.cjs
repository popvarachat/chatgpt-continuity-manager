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
  'uaiosContinuityDeriveProjectState'
]) {
  harness += extractFunction(name) + '\n';
}
harness += 'globalThis.derive = uaiosContinuityDeriveProjectState;\n';

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

console.log('project state autopilot v2 behavioral tests: PASS');
