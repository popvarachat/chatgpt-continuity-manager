# Chat Steward — Conversation Lifecycle Agent

## Purpose

Chat Steward is a local-only companion to Continuity Manager. It maintains a bounded registry of ChatGPT conversations that the user actually opens or explicitly imports, then recommends one lifecycle state:

- `CONTINUE` — unresolved/open loop; return to the conversation and finish the next safe action.
- `REFERENCE` — work is substantially complete but reusable knowledge, decisions, files, code, or structured evidence should be retained.
- `PROJECT` — conversation belongs to a larger body of work and should be grouped under a user-defined Project taxonomy.
- `DELETE_CANDIDATE` — low-value transactional conversation that appears complete and has no meaningful reusable evidence.

`DELETE_CANDIDATE` is never an automatic delete action. Human approval is mandatory and the extension does not call a ChatGPT delete endpoint.

## Privacy boundary

The registry is stored in `chrome.storage.local` under `uaios.chatSteward.registry.v1`.

The public GitHub Pages dashboard does **not** receive raw conversation text from a server. A tightly-scoped extension content script bridges the dashboard page to local extension storage. The stored registry contains derived summaries only: title, conversation URL/id, scores, suggested status, project suggestion, reasons, next action, timestamps, and human decisions. Raw message bodies are not retained by Chat Steward after classification.

No credentials, cookies, auth headers, session tokens, or private company data are committed to this repository.

## Data flow

```text
ChatGPT page opened by user
   |
   +--> chat-steward-collector.js
           reads visible user/assistant turns (bounded)
           |
           +--> chat-steward-engine.js
                   lifecycle classification
                   scores / project affinity / next action
           |
           +--> chrome.storage.local
                   derived registry only

GitHub Pages /chat-steward/
   |
   +--> chat-steward-dashboard-bridge.js (ISOLATED extension world)
           read registry / save human decision / import handoff JSON
```

## Human Gate

The AI suggestion and the human decision are separate fields.

The dashboard can:

1. accept the AI suggestion;
2. override lifecycle status;
3. assign/override Project;
4. add a local note;
5. open the original Chat for manual action;
6. remove a record from the local registry;
7. import ChatGPT handoff JSON or exported conversation JSON for backlog review;
8. export the derived registry as a local JSON backup.

The dashboard cannot silently delete a ChatGPT conversation or move it to a ChatGPT Project. Those actions remain inside ChatGPT and require explicit user action.

## Classification guardrails

A conversation is not proposed as `DELETE_CANDIDATE` when the classifier detects meaningful evidence such as:

- attachment/textdoc/file signals;
- code or implementation content;
- explicit decisions/approvals;
- deeper multi-turn work;
- unresolved/open-loop language.

Project matching is configurable from the dashboard and is stored locally. Public repository defaults are generic and contain no confidential project data.

## Coverage model

Automatic scanning covers conversations the user opens while the extension is enabled. This is deliberate: the extension does not enumerate the user's hidden ChatGPT history through undocumented bulk APIs.

For historical backlog review, use **Import JSON** on the dashboard with one or more Handoff JSON files from Continuity Manager, or a ChatGPT export JSON containing conversation objects. Imported conversations are classified locally one at a time and only derived registry records are retained.

## Storage keys

- `uaios.chatSteward.registry.v1`
- `uaios.chatSteward.config.v1`
- `uaios.chatSteward.meta.v1`

## Version 1.0 acceptance criteria

- Automatic local classification of an opened Chat.
- Four lifecycle recommendations with confidence and scores.
- Human override kept separately from the AI suggestion.
- Project taxonomy configurable locally.
- GitHub Pages control center can read/write local decisions through the extension bridge.
- Import/export registry works without network upload of conversation content.
- No automatic ChatGPT deletion or project movement.
- Static engine tests pass.
