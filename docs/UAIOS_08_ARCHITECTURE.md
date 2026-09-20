# UAIOS_08 Continuity Manager — Target Architecture

## Goal
Keep long-running ChatGPT Project work recoverable across response timeouts, overloaded conversations, browser refreshes, and deliberate chat rollover.

## Layers
1. `08A UI Watchdog`
   - Detect recoverable ChatGPT UI errors.
   - Retry only when an explicit Retry/Try again control is present.
   - Continue generation only when an explicit Continue control is present.
   - Rate-limit every automatic action and keep a local audit log.

2. `08B Session Checkpoint`
   - Store milestone, current task, last verified evidence, and next action.
   - Use browser-local durable storage first.
   - Never persist authentication material.

3. `08C Project State`
   - Maintain a bounded project-state document separate from raw conversation history.
   - Track phase, completed work, blockers, decisions, evidence pointers, and next action.

4. `08D Handoff Capsule`
   - Reuse upstream conversation acquisition and integrity checks.
   - Produce a compact task-state capsule rather than replaying the whole conversation.
   - Include provenance/evidence pointers and freshness timestamps.

5. `08E Session Rollover`
   - Detect when a conversation should be retired before it becomes unusable.
   - Generate/update the capsule before rollover.
   - Bootstrap a fresh chat with only bounded current-state context.
6. `08F Recovery`
   - Recover after an old chat is no longer useful.
   - Rehydrate from the latest local checkpoint plus canonical evidence.
   - Treat prior chat history as optional supporting context, not a dependency.

7. `08G UAIOS Boundary` (delegated)
   - This public browser extension does **not** become an external orchestrator, evidence authority, or second control plane.
   - Canonical GitHub/n8n/runtime verification belongs to the private UAIOS control plane.
   - A future integration may exchange a bounded checkpoint/handoff capsule through an explicit UAIOS-owned contract, but direct n8n/provider credentials and routing remain outside this repository.
   - Local continuity must continue to work with this boundary completely disabled.

## Suggested state object
```json
{
  "project_id": "string",
  "session_id": "string",
  "phase": "string",
  "current_task": "string",
  "completed": [],
  "blockers": [],
  "decisions": [],
  "evidence": [],
  "next_action": "string",
  "updated_at": "ISO-8601"
}
```

## Recovery principle
The browser extension should be able to answer only three operational questions without reading the full old conversation: What is done? What is verified? What is next?


## Final Flow role boundary

Under UAIOS-ARCH-003, this repository is classified as:

`KEEP_OPTIONAL / MERGE_STATE_CONTRACT`

Its canonical responsibility is **browser-local continuity**, specifically:

- local checkpoint capture;
- bounded Project State working snapshot;
- recovery history;
- safe chat rollover/handoff;
- bootstrap hydration without auto-send;
- local recovery from browser/session failure.

It is **not** authoritative for:

- current Git branch/PR/check state;
- n8n execution state;
- Cloudflare/runtime state;
- task policy/routing;
- approval authority;
- cross-domain orchestration;
- canonical enterprise Project State.

The local Project State is a recovery cache/working snapshot. When mutable external truth matters, ChatGPT/UAIOS re-verifies canonical sources.

### Final relationship

```text
ChatGPT browser
   |
   +--> Continuity Manager
   |      local checkpoint / recovery / handoff
   |
   +--> ChatGPT -> UAIOS
                 canonical policy / evidence / external verification
```

This keeps the unique browser-local value without creating another control plane.
