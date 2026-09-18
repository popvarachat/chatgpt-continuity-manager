# Repository Operating Contract

This repository is a public fork used as the browser-side foundation for UAIOS_08_CONTINUITY_MANAGER.

## Source of truth
- GitHub is canonical for branch, commit SHA, pull request, CI/checks, review threads, and merge state.
- Never infer current repository state from chat history.
- Before any change, read this file and the documents under `docs/` relevant to the task.

## Change workflow
- Start from current `main`.
- Create a feature/fix/chore branch.
- Open a pull request.
- Do not push directly to `main`.
- Do not force-push or bypass repository protections/checks.
- Prefer squash merge after applicable checks and human approval.

## Browser safety during development
- Never navigate an existing `chatgpt.com` tab, the user's active Chrome tab, or the first Chrome window returned by process enumeration to `chrome://extensions`.
- Never reload this unpacked extension by taking over the current address bar with UI automation.
- Use `scripts/reload-extension-safe.ps1`; it must create a dedicated helper Chrome window, operate only on that new window, and close only that helper window.
- If a dedicated helper window cannot be isolated, abort the reload instead of touching any pre-existing browser window.

## Safety and privacy
- Never commit secrets, credentials, cookies, session tokens, ChatGPT auth headers, webhook secrets, or private company data.
- This public fork must stay provider-agnostic and safe to publish.
- Any private UAIOS endpoint, credential, routing rule, or confidential state belongs in the private control-plane repository/configuration, not here.
- Network export of conversation content must be disabled by default and require explicit opt-in.
