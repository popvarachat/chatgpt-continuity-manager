# Final Flow Alignment

**Date:** 2026-09-20  
**Decision:** KEEP_OPTIONAL / MERGE_STATE_CONTRACT

ChatGPT Continuity Manager remains useful as a local browser-side recovery utility.

## Keep here

- local checkpoint state;
- IndexedDB recovery history;
- bounded handoff capsule;
- safe fresh-chat rollover;
- explicit/manual backup and restore;
- conservative Retry/Continue watchdog;
- local bootstrap hydration without auto-send.

## Delegate to UAIOS

- canonical project/task authority;
- fresh GitHub evidence;
- n8n execution evidence;
- Cloudflare/runtime evidence;
- external routing/orchestration;
- human approval authority;
- credentials/secrets;
- company/private integration.

## Why

Browser-local recovery and cross-system control have different trust and failure boundaries.

Keeping them separate means a ChatGPT UI/browser failure can still be recovered locally, while the extension never needs broad enterprise credentials or authority.

The extension is therefore a **seatbelt**, not another steering wheel.
