const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'chatgpt-conversation-handoff-exporter.user.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

assert.strictEqual(manifest.version, '1.8.9');
assert.match(source, /@version\s+1\.8\.9/);
assert.match(source, /UAIOS_CONTINUITY_VERSION = '1\.8\.9'/);
assert.match(source, /UAIOS_AUTO_HANDOFF_MESSAGE_THRESHOLD = 110/);
assert.match(source, /UAIOS_AUTO_HANDOFF_CHAR_THRESHOLD = 150000/);
assert.match(source, /function uaiosContinuityAutoHandoffEligible\(/);
assert.match(source, /function uaiosContinuityQueueAutoHandoff\(/);
assert.match(source, /async function uaiosContinuityAutoHandoffTick\(/);
assert.match(source, /void uaiosContinuityAutoHandoffTick\(\)/);
assert.match(source, /Handoff QUEUED/);
assert.match(source, /Queue Handoff/);
assert.match(source, /Creating first checkpoint and preparing Handoff/);
assert.doesNotMatch(source, /No validated checkpoint yet\. Save Checkpoint once, then retry Handoff/);
assert.match(source, /if \(!stagedRecord\) \{[\s\S]*?uaiosContinuityPrepareRollover\(\)/);
assert.match(source, /function uaiosContinuityBuildDomFallbackHandoff\(/);
assert.match(source, /data-message-author-role="user"/);
assert.match(source, /data-message-author-role="assistant"/);
assert.match(source, /checkpointTransport = 'dom-continuity-fallback'/);
assert.match(source, /if \(!uaiosContinuityCanUseDomFallback\(error\)\) throw error/);
assert.match(source, /\[data-testid\^="conversation-turn-"\]/);
assert.match(source, /'article'/);
assert.match(source, /document\.querySelector\('main, \[role="main"\]'\)/);
assert.match(source, /UAIOS_DOM_FALLBACK_TURN_LIMIT = 8/);
assert.match(source, /UAIOS_DOM_FALLBACK_TURN_CHARS = 2500/);
assert.match(source, /UAIOS_DOM_FALLBACK_EXCERPT_CHARS = 2400/);
assert.match(source, /messages\.slice\(-UAIOS_DOM_FALLBACK_TURN_LIMIT\)/);
assert.match(source, /fallback_context_excerpt/);
assert.match(source, /autopilot-v2-dom-fallback/);
assert.doesNotMatch(source, /VISIBLE CONVERSATION SNAPSHOT \(Continuity fallback\)/);

const handoffDisabledLine = source.match(/handoff\.disabled = ([^;]+);/);
assert.ok(handoffDisabledLine, 'handoff disabled assignment must exist');
assert.doesNotMatch(handoffDisabledLine[1], /rateLimitCooling/);

assert.match(
  source,
  /uaiosContinuityQueueAutoHandoff\('manual-during-cooling'\)/
);

const autoStart = source.indexOf('async function uaiosContinuityAutoHandoffTick');
const autoEnd = source.indexOf('async function uaiosContinuityAutoCheckpointTick', autoStart);
assert.ok(autoStart >= 0 && autoEnd > autoStart);
const autoBody = source.slice(autoStart, autoEnd);
assert.match(autoBody, /uaiosContinuityPrepareRollover\(\)/);
assert.match(autoBody, /uaiosRateLimitIsCooling\(\)/);

console.log('v1.8.3 smart auto-handoff tests: PASS');
