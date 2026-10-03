const assert = require('node:assert/strict');
const fs = require('node:fs');

const collector = fs.readFileSync('chat-steward-collector.js', 'utf8');
const bridge = fs.readFileSync('chat-steward-dashboard-bridge.js', 'utf8');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));

assert.match(collector, /new URL\('\/backend-api\/conversations'/);
assert.match(collector, /LIST_LIMIT = 28/);
assert.match(collector, /FETCH_TIMEOUT_MS = 20000/);
assert.match(collector, /function observedConversationListUrl\(/);
assert.match(collector, /function buildConversationListPath\(/);
assert.match(collector, /new AbortController\(\)/);
assert.match(collector, /signal: controller\.signal/);
assert.match(collector, /searchParams\.set\('is_archived'/);
assert.match(collector, /\/backend-api\/gizmos\/snorlax\/sidebar/);
assert.match(collector, /\/backend-api\/gizmos\/\$\{encodeURIComponent\(project\.id\)\}\/conversations/);
assert.match(collector, /include_has_versions=true&num_turns=100/);
assert.match(collector, /\/backend-api\/conversation\/\$\{encoded\}/);
assert.match(collector, /status: 'backoff'/);
assert.match(collector, /DETAIL_DELAY_MS = 1800/);
assert.match(collector, /MAX_RECORDS = 10000/);
assert.match(collector, /autoFullInventory/);
assert.match(collector, /function buildPendingRecord\(/);
assert.match(collector, /async function seedInventoryRegistry\(/);
assert.match(collector, /analysis_state: existing\?\.analysis_state === 'ERROR' \? 'ERROR' : 'PENDING'/);
assert.match(collector, /const startingRegistry = await seedInventoryRegistry\(conversations\)/);
assert.match(collector, /Both detail endpoints rate-limited/);
assert.match(collector, /fetchJson\(path, headers, \{ maxAttempts: 1 \}\)/);
assert.match(bridge, /case 'startFullScan'/);
assert.equal(manifest.version, '1.9.4');
assert.ok(manifest.permissions.includes('unlimitedStorage'));

console.log('chat-steward full inventory static tests: PASS');
