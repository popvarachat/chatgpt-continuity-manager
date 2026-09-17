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

## Safety and privacy
- Never commit secrets, credentials, cookies, session tokens, ChatGPT auth headers, webhook secrets, or private company data.
- This public fork must stay provider-agnostic and safe to publish.
- Any Practika/UAIOS private endpoint, credential, routing rule, or confidential state belongs in the private control-plane repository/configuration, not here.
- Network export of conversation content must be disabled by default and require explicit opt-in.
