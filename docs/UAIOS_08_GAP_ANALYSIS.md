# UAIOS_08 Continuity Manager — Gap Analysis

Baseline upstream: `SunnyLeu/ChatGPT-Conversation-Handoff-Exporter`
Baseline upstream commit: `e012b5cf924008d917130d5dfe933284377ecfa6`
Fork: `popvarachat/chatgpt-continuity-manager`

## What upstream already solves well
- Reads the current ChatGPT conversation and validates the conversation ID.
- Re-fetches conversation JSON using XHR and a secondary fetch path.
- Performs response/integrity checks before accepting export data.
- Exports raw conversation JSON and compact handoff JSON.
- Supports ChatGPT Project conversation URLs.
- Includes textdocs/canvas data when available.
- Supports controlled batch export for general and Project chat lists.
- Has a single-request round-robin scheduler for batch work.
- Protects active batch sessions with `beforeunload`.
- Uses no userscript privileges (`@grant none`).

## Important limitations for our continuity goal
- No automatic Retry / Try again / Continue-generating recovery.
- No durable project checkpoint model.
- No canonical `PROJECT_STATE`, `NEXT_ACTION`, `DECISION_LOG`, or blocker state.
- Handoff is conversation-oriented, not task-state-oriented.
- No automatic context-pressure or session-rollover policy.
- No one-click bootstrap of a fresh chat from the latest checkpoint.
- No local durable state store beyond the current page/session workflow.
- No n8n/UAIOS event interface.
- No GitHub/n8n evidence reconciliation for factual current state.
- No explicit separation between semantic memory and transactional project state.
- No automated recovery when an old chat becomes too large to answer reliably.
- No automated summary compression into a bounded context capsule.

## Technical risks observed
- The implementation is a single userscript of roughly 299 KB, so future changes need modularization discipline.
- It depends on undocumented ChatGPT DOM structure and `/backend-api/...` behavior; both can change without notice.
- Current userscript metadata points update/download URLs to the upstream repository; a customized release must change those URLs deliberately.
- There is no package manifest or automated test suite in the upstream baseline.
- Browser automation must avoid accidental loops, repeated submissions, or silent network export.

## Recommended reuse boundary
Keep upstream conversation acquisition, integrity validation, handoff construction, Project-list discovery, batch scheduler, and ZIP/export logic largely intact.

Add continuity behavior as isolated modules with feature flags. The first modules should be UI recovery, local checkpoint state, context capsule generation, and fresh-chat bootstrap. External UAIOS/n8n synchronization should be an optional adapter and disabled by default.

## Source-of-truth rule
Conversation history and AI memory are context sources, not canonical operational truth. Branch/PR/SHA/check status comes from GitHub; workflow execution state comes from the relevant orchestrator; the continuity manager stores pointers and verified snapshots rather than inventing current state.
