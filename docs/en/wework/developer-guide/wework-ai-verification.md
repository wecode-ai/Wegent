---
sidebar_position: 39
---

# AI Verification Sessions

Wework can start an isolated development verification session so an AI can operate and assert against the real Electron application. It reuses the desktop E2E WebView control channel, never drives an external Chrome window, and does not attach to a developer's everyday Wework window.

## Start a session

```bash
pnpm --filter wework ai:verify start
```

The command prints a session file path and a local control URL. It creates a separate Executor Home, projects directory, device ID, IPC socket, Electron app-data namespace, and diagnostics directory, then starts the real `dev-mac-app.sh`. Tasks, projects, application data, and the single-instance lock are not shared with release or other verification sessions. Logs are stored in `wework/test-results/ai-verify/<run-id>/`.

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

## Control protocol

After startup, the WebView calls `/ready` and then short-polls `/commands`. The controller immediately returns `204` when the queue is empty; the WebView briefly throttles through `/control-tick` before polling again. After receiving a command, the WebView calls `/started` and `/results` in order to acknowledge execution and submit the final result.

`ai:verify` and desktop E2E share this protocol, so endpoint and polling semantics must remain aligned when either side changes. Do not convert `/commands` to long polling: it conflicts with the WebView control loop, leaves later commands queued, and surfaces as repeated timeouts. The controller must also remove a timed-out command from the queue so a later poll cannot execute stale work.

## Native context menus

Electron does not create a WebContents context menu automatically. The Wework Electron main process listens for `context-menu` centrally and builds native menus for the main window, workspace windows, and auxiliary windows.

- Image menus retain copy-image, open-image, and local-file actions.
- Editable contexts must read `params.isEditable` and `params.editFlags`, use Electron's native `undo`, `redo`, `cut`, `copy`, `paste`, `delete`, and `selectAll` roles, and pass `params.frame` to `menu.popup`.
- Selected text outside an editor uses the native `copy` role. When no meaningful action exists, do not show an empty menu, so React components can keep their own business context menus.

When changing this path, run `wework/electron/src/host/image-context-menu.test.ts`, then verify menu presentation, enabled states, and paste behavior in a real input inside an isolated Electron session. WebView DOM snapshots do not include a native macOS `NSMenu`; a synthetic `contextmenu` event or browser-only screenshot is not a substitute for real desktop verification.

## AI workflow

An AI should start with `snapshot` to confirm the route and available `data-testid` values, make the smallest required interaction, and use `wait-for` plus `snapshot` or `text` to verify the result. Always call `stop` when finished. On failure, keep the session directory and inspect `app.log`.
