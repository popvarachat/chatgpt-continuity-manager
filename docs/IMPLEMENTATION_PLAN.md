# Implementation Plan

## Phase 0 — Baseline and governance
- Preserve fork relation to upstream.
- Record upstream baseline SHA.
- Add repository operating contract, gap analysis, and target architecture.
- Verify the upstream userscript parses with Node.js.

Acceptance: clean feature branch, no secrets, documentation PR opened.

## Phase 1 — UI continuity
- Port the local Retry/Continue watchdog into the userscript as an isolated module.
- Default to conservative detection: action control plus matching recoverable-state text.
- Add cooldown, retry budget, per-conversation counters, and local event log.
- Add an obvious enable/disable control; default can remain off until validation completes.

Acceptance: timeout/continue test fixtures do not trigger duplicate sends or infinite loops.

## Phase 2 — Durable local checkpoint
- Add IndexedDB-backed project/session checkpoint storage.
- Keep checkpoint schema small and versioned.
- Add manual `Save checkpoint` and `Copy handoff capsule` actions first.
- Add export/import for disaster recovery.

Acceptance: close/reopen browser and recover the same checkpoint without the old chat.

## Phase 3 — Rollover and bootstrap
- Add bounded capsule generation using task state plus selected conversation evidence.
- Detect rollover candidates using message/count/size heuristics, not hidden model token assumptions.
- Provide one-click creation/copy flow for a fresh chat bootstrap.
Acceptance: a fresh chat can resume from the capsule with no dependency on a response from the old chat.

## Phase 4 — Canonical evidence adapters
- Define provider-neutral evidence records.
- Resolve GitHub branch/PR/SHA/check state from GitHub rather than conversation text.
- Keep orchestrator-specific state behind adapters.

Acceptance: stale conversation claims cannot overwrite newer verified evidence.

## Phase 5 — UAIOS/n8n integration
- Add an explicit opt-in adapter contract for checkpoint and handoff events.
- Keep private URLs, credentials, routing, and company data outside this public fork.
- Implement the real Practika adapter in the private UAIOS control-plane repository.

Acceptance: browser-side module works fully local when the adapter is disabled, and emits only approved fields when enabled.

## Upstream sync policy
- Keep `upstream` remote pointed at `SunnyLeu/ChatGPT-Conversation-Handoff-Exporter`.
- Sync upstream only through a dedicated branch/PR.
- Re-run continuity tests after every upstream sync because DOM/API behavior is not a stable public contract.

## Implementation status
- Phase 0: merged on `main`.
- Phase 1: merged on `main` as opt-in local UI watchdog.
- Phase 2A: current implementation adds bounded local structured state, validated on-demand checkpoint capture, and bootstrap text generation/copy.
- Phase 2B remains: move larger/full snapshots to IndexedDB if needed and add import/export recovery tooling.
- Phase 3A: implemented in v1.3 with visible controls, active-tab auto-checkpoint, heuristic load indicator, and bootstrap resume without auto-send. v1.5.7 self-heals the shared DOM mailbox observer after ChatGPT DOM rebuilds; v1.5.6 verifies composer hydration before clearing pending state; v1.5.5 stages the last validated handoff locally before navigation, then opens the canonical Project route from the user gesture while asynchronously refreshing that staged record, with extension-owned pending persistence, shared-DOM bridge health, and bounded Home recovery; v1.3.1 also hardened same-Project navigation by preferring ChatGPT's own live Project link over a synthesized route.
- Phase 3B remains: tune heuristic thresholds from real usage and add optional IndexedDB history/export recovery.
