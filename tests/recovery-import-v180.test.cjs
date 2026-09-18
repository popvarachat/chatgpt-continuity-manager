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
  const asyncNext = source.indexOf('\n  async function ', start + marker.length);
  const candidates = [next, asyncNext].filter((value) => value >= 0);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end).trim();
}

const harness = [
  "const UAIOS_RECOVERY_SCHEMA_VERSION = 1;",
  "const UAIOS_RECOVERY_HISTORY_LIMIT = 20;",
  "function uaiosContinuityRecoveryClone(value) { return JSON.parse(JSON.stringify(value)); }",
  extractFunction('uaiosContinuityValidateRecoveryBundle'),
  'globalThis.validateRecovery = uaiosContinuityValidateRecoveryBundle;'
].join('\n');
const context = {};
vm.createContext(context);
vm.runInContext(harness, context);

const scope = '/g/g-p-0123456789abcdef0123456789abcdef';
const checkpoint = {
  scope,
  captured_at: '2026-09-18T06:00:00.000Z',
  source_conversation_id: 'conversation-1',
  project_state: { objective: 'Finish continuity recovery' }
};
const bundle = {
  schema_version: 1,
  continuity_version: '1.8.0',
  exported_at: '2026-09-18T06:10:00.000Z',
  scope,
  project_state: { objective: 'Finish continuity recovery' },
  latest_checkpoint: checkpoint,
  history: Array.from({ length: 25 }, (_, index) => ({
    ...checkpoint,
    captured_at: `2026-09-18T05:${String(index).padStart(2, '0')}:00.000Z`,
    source_conversation_id: `conversation-${index}`
  }))
};

const valid = context.validateRecovery(bundle, scope);
assert.equal(valid.scope, scope);
assert.equal(valid.history.length, 20, 'import must remain bounded to 20 history entries');
assert.equal(valid.latest_checkpoint.source_conversation_id, 'conversation-1');
assert.notStrictEqual(valid.latest_checkpoint, checkpoint, 'validated checkpoint must be cloned');

assert.throws(
  () => context.validateRecovery({ ...bundle, schema_version: 2 }, scope),
  /Unsupported recovery schema/
);
assert.throws(
  () => context.validateRecovery({ ...bundle, scope: '/g/g-p-other' }, scope),
  /Recovery scope mismatch/
);
assert.throws(
  () => context.validateRecovery({ ...bundle, latest_checkpoint: { ...checkpoint, scope: '/g/g-p-other' } }, scope),
  /latest_checkpoint scope does not match/
);
assert.throws(
  () => context.validateRecovery({ ...bundle, history: [{ ...checkpoint, scope: '/g/g-p-other' }] }, scope),
  /another scope/
);

console.log('recovery import v1.8.0 behavioral tests: PASS');
