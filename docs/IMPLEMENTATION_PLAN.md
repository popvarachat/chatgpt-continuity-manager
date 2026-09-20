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

## Phase 4 — Canonical evidence integration — DELEGATED TO UAIOS
- Do not add independent GitHub/n8n/Cloudflare evidence clients to the browser extension.
- Keep provider-neutral evidence pointer fields in the local checkpoint schema only where useful.
- ChatGPT/UAIOS performs fresh verification against canonical sources when mutable state matters.

Acceptance: local continuity can carry evidence pointers without claiming external state is current.

## Phase 5 — UAIOS integration — HOLD / CONTRACT-ONLY
- Do not add direct n8n credentials, provider credentials, private routing, or orchestration authority to this public extension.
- If a future need is proven, define only a bounded UAIOS-owned checkpoint/handoff exchange contract with explicit opt-in.
- The real Practika integration remains in the private UAIOS control plane.

Acceptance: browser-side continuity remains fully functional offline/local; external integration cannot become a second control plane.

## Upstream sync policy
- Keep `upstream` remote pointed at `SunnyLeu/ChatGPT-Conversation-Handoff-Exporter`.
- Sync upstream only through a dedicated branch/PR.
- Re-run continuity tests after every upstream sync because DOM/API behavior is not a stable public contract.

## Implementation status
- Phase 0: merged on `main`.
- Phase 1: merged on `main` as opt-in local UI watchdog.
- Phase 2A: current implementation adds bounded local structured state, validated on-demand checkpoint capture, and bootstrap text generation/copy.
- Phase 2B remains: move larger/full snapshots to IndexedDB if needed and add import/export recovery tooling.
- Phase 3A: implemented in v1.3 with visible controls, active-tab auto-checkpoint, heuristic load indicator, and bootstrap resume without auto-send. v1.5.9 restricts hydration to the visible on-screen composer and excludes hidden/off-screen editable nodes; v1.5.8 requires stable composer hydration across multiple React render cycles before clearing pending state; v1.5.7 self-heals the shared DOM mailbox observer after ChatGPT DOM rebuilds; v1.5.6 verifies composer hydration before clearing pending state; v1.5.5 stages the last validated handoff locally before navigation, then opens the canonical Project route from the user gesture while asynchronously refreshing that staged record, with extension-owned pending persistence, shared-DOM bridge health, and bounded Home recovery; v1.3.1 also hardened same-Project navigation by preferring ChatGPT's own live Project link over a synthesized route.
- Phase 3A.1: v1.6.0 hardens the bootstrap contract so a fresh chat reconstructs provisional project state from bounded recent evidence when stored project state is missing or stale, avoids asking the user to repeat checkpoint context, and still requires canonical verification for mutable external state.
- Phase 3A.2: v1.6.1 derives a bounded structured Project State Snapshot at checkpoint time, merges manual overrides, surfaces State: AUTO/MANUAL+AUTO in the panel, and renders the snapshot before raw recent-message evidence.
- Phase 3A.3: v1.6.2 makes the Continuity control bar draggable with pointer input, persists its viewport position locally, clamps it on resize, and supports double-click reset from the drag handle.
- Phase 3A.4: v1.6.3 removes the legacy raw/handoff export buttons from the ChatGPT conversation header and keeps manual JSON export under the Continuity `⋯ → Advanced / Export` menu.
- Phase 3A.5: v1.6.4 makes drag-handle reset robust by detecting two stationary pointer releases within 450 ms and an 8 px proximity threshold, while preserving drag persistence, viewport clamping, and the compact export menu.
- Phase 3B.1: v1.7.0 adds local-only bounded recovery history in IndexedDB (20 checkpoints per continuity scope) and manual Recovery Snapshot export from the Continuity advanced menu. IndexedDB failures are non-fatal to the existing latest-checkpoint path.
- Phase 3B.4: v1.8.0 completes explicit Import / Manual Restore for Recovery Snapshots with schema validation, same-Project scope guard, confirmation preview, bounded IndexedDB history replacement, and no auto-send/open behavior.
- Phase 3B.5: v1.8.1 reduces visual clutter by collapsing Recovery into one top-level menu entry with a compact Backup / Restore submenu; no recovery logic changes.
- Phase 3B remains: tune heuristic thresholds from real usage only; the functional recovery loop is complete.

- Phase 3B.2: v1.7.1 upgrades Project State Autopilot to v2. It prefers the newest 12 messages, treats the latest assistant PASS/resolution as the blocker freshness boundary, and extracts the next action from the latest assistant response with English/Thai action cues. Goal: resolved historical failures do not reappear as current blockers after handoff.
- Phase 3B.3: v1.7.2 prevents bootstrap self-reference by excluding continuity bootstrap messages from state derivation and upgrading pending legacy bootstrap payloads to Autopilot v2 before hydration.


## Final Flow alignment — 2026-09-20

Following UAIOS consolidation, further feature work should prefer reliability and browser-local recovery over expansion into external orchestration.

Priority:
1. maintain compatibility with ChatGPT UI changes;
2. preserve safe checkpoint/recovery/handoff behavior;
3. improve bounded local state quality from real usage;
4. keep all external authority delegated to UAIOS.

Do not implement direct n8n/GitHub/Cloudflare control surfaces here merely because they are technically possible.
