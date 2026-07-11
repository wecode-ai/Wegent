---
sidebar_position: 39
---

# AI Verification Sessions

Wework can start an isolated development verification session so an AI can operate and assert against the real Tauri application. It reuses the desktop E2E WebView control channel, never drives an external Chrome window, and does not attach to a developer's everyday Wework window.

## Start a session

```bash
pnpm --filter wework ai:verify start
```

The command prints a session file path and a local control URL. It creates separate Executor and diagnostic directories, then starts the real `dev-mac-app.sh`. Logs are stored in `wework/test-results/ai-verify/<run-id>/`.

## Operate and assert

Pass the session path returned by `start` to every later command. Prefer stable `data-testid` selectors.

```bash
pnpm --filter wework ai:verify snapshot --session /path/to/session.json
pnpm --filter wework ai:verify fill --session /path/to/session.json \
  --selector '[data-testid="chat-message-input"]' --value 'verification text'
pnpm --filter wework ai:verify click --session /path/to/session.json \
  --selector '[data-testid="send-message-button"]'
pnpm --filter wework ai:verify wait-for --session /path/to/session.json \
  --selector '[data-testid="message-assistant"]' --text 'Complete'
pnpm --filter wework ai:verify stop --session /path/to/session.json
```

Supported operations are `snapshot`, `text`, `click`, `fill`, `press`, `wait-for`, `status`, and `stop`. Commands return structured JSON and exit non-zero when the WebView is unavailable, an element is missing, or an assertion times out.

## Security boundary

The controller listens only on `127.0.0.1` and creates a single-use Bearer token per session. The Vite environment enables the channel only for the development instance started by `ai:verify start`; normal development and production builds do not expose it. The session file contains the token, so treat it as short-lived local credential and never commit or share it.

## AI workflow

An AI should start with `snapshot` to confirm the route and available `data-testid` values, make the smallest required interaction, and use `wait-for` plus `snapshot` or `text` to verify the result. Always call `stop` when finished. On failure, keep the session directory and inspect `app.log`.
