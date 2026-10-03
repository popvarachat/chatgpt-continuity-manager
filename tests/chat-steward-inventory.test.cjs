const assert = require('node:assert/strict');
const fs = require('node:fs');

const collector = fs.readFileSync('chat-steward-collector.js', 'utf8');
const bridge = fs.readFileSync('chat-steward-dashboard-bridge.js', 'utf8');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));

assert.match(collector, /\/backend-api\/conversations\?offset=/);
assert.match(collector, /is_archived=/);
assert.match(collector, /\/backend-api\/gizmos\/snorlax\/sidebar/);
assert.match(collector, /\/backend-api\/gizmos\/\$\{encodeURIComponent\(project\.id\)\}\/conversations/);
assert.match(collector, /include_has_versions=true&num_turns=100/);
assert.match(collector, /\/backend-api\/conversation\/\$\{encoded\}/);
assert.match(collector, /status: 'backoff'/);
assert.match(collector, /DETAIL_DELAY_MS = 500/);
assert.match(collector, /MAX_RECORDS = 10000/);
assert.match(collector, /autoFullInventory/);
assert.match(bridge, /case 'startFullScan'/);
assert.equal(manifest.version, '1.9.1');
assert.ok(manifest.permissions.includes('unlimitedStorage'));

console.log('chat-steward full inventory static tests: PASS');
