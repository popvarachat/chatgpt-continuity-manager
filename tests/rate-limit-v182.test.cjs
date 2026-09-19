const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'chatgpt-conversation-handoff-exporter.user.js'), 'utf8');

assert.match(source, /UAIOS_RATE_LIMIT_BASE_BACKOFF_MS = 3 \* 60 \* 1000/);
assert.match(source, /UAIOS_RATE_LIMIT_MAX_BACKOFF_MS = 10 \* 60 \* 1000/);
assert.match(source, /UAIOS_RATE_LIMIT_WINDOW_MS = 30 \* 60 \* 1000/);
assert.match(source, /function uaiosRateLimitFindModal\(\)/);
assert.match(source, /\[role="dialog"\], \[aria-modal="true"\]/);
assert.match(source, /UAIOS_RATE_LIMIT_DISMISS_LABELS\.includes\(uaiosRateLimitButtonLabel\(candidate\)\)/);
assert.match(source, /UAIOS_RATE_LIMIT_BLOCKED_MARKERS/);
assert.match(source, /data-uaios-rate-limit-handled/);
assert.match(source, /rate_limit_auto_dismiss/);
assert.match(source, /rateLimitEl\.textContent = `Cool /);
assert.match(source, /if \(uaiosRateLimitScanAndDismiss\(\)\) return true;/);
assert.match(source, /if \(uaiosRateLimitIsCooling\(\)\) return false;/);
assert.match(source, /checkpoint\.disabled = .*rateLimitCooling/);
assert.match(source, /exportRaw\.disabled = .*rateLimitCooling/);

const labelsBlock = source.match(/const UAIOS_RATE_LIMIT_DISMISS_LABELS = \[([\s\S]*?)\];/);
assert.ok(labelsBlock);
assert.doesNotMatch(labelsBlock[1], /['"]ok['"]/i, 'generic OK must never be an auto-dismiss label');

const modalStart = source.indexOf('function uaiosRateLimitFindModal');
const modalEnd = source.indexOf('function uaiosRateLimitScanAndDismiss', modalStart);
const modalBody = source.slice(modalStart, modalEnd);
assert.match(modalBody, /dialog\.querySelectorAll\('button, \[role="button"\]'\)/);
assert.doesNotMatch(modalBody, /document\.querySelectorAll\('button/);
console.log('v1.8.2 rate-limit smart backoff tests: PASS');
