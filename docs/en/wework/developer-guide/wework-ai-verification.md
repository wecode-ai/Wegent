---
sidebar_position: 39
---

# AI Verification Sessions

Wework can start an isolated development verification session so an AI can operate and assert against the real Tauri application. It reuses the desktop E2E WebView control channel, never drives an external Chrome window, and does not attach to a developer's everyday Wework window.

## Start a session

```bash
pnpm --filter wework ai:verify start
```

The command prints a session file path and a local control URL. It creates a separate Executor Home, projects directory, device ID, IPC socket, Tauri identifier, and diagnostics directory, then starts the real `dev-mac-app.sh`. Tasks, projects, application data, and the single-instance lock are not shared with release or other verification sessions. Logs are stored in `wework/test-results/ai-verify/<run-id>/`.

### Startup completion criteria

`start` returns only after the real workbench is visible in the main window. The control client requires both `app-shell` and `desktop-workbench-content` to be visible while the local-runtime initializer, workbench loading state, and startup error screen are not visible. Creating the Tauri process, opening a window, or finishing HTML loading does not count as startup completion.

The local Executor and the workbench React tree start in parallel. The workbench can prepare its data behind the initialization screen, but it is revealed only after the local Executor is ready. Verification sessions inherit the environment already resolved by the launcher and skip a duplicate user login-shell invocation, preventing shell plugins or configuration from adding several seconds to verification startup.

### Cross-worktree build caches

On macOS, `ai:verify` reuses dependencies and build outputs from user cache directories. These caches do not belong to any worktree, so deleting a compiled worktree does not invalidate caches needed by a later worktree:

- pnpm virtual store: `$XDG_CACHE_HOME/wegent/wework-node-modules/v2`, or `~/.cache/wegent/wework-node-modules/v2` by default. Each worktree receives only a small local link view.
- Production frontend bundles: `$XDG_CACHE_HOME/wegent/dev-frontends`.
- Wework App and Executor development binaries: `$XDG_CACHE_HOME/wegent/dev-binaries`.
- Codex, DWS, Harness, and Node runtimes: `$XDG_CACHE_HOME/wegent/wework-runtime`.

Frontend and native-binary fingerprints read only Git-tracked or non-ignored source content. They exclude worktree paths, ports, branch names, and generated files. The local static server injects runtime worktree metadata and control addresses, so identical commits can reuse one build across worktrees; changing frontend source without changing dependencies rebuilds only the frontend. Frontend, App, and Executor caches each retain at most six versions by recent use to bound disk growth under parallel worktrees.

Each verification session still creates an isolated `executor-home` and logs. Always call `stop` and remove obsolete directories under `wework/test-results/ai-verify/` when appropriate. The Executor does not write complete `app/list/updated` notifications into runtime-task routing logs, and other unrouted raw previews are limited to 4 KiB so short sessions cannot create oversized rotated logs.

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

## AI workflow

An AI should start with `snapshot` to confirm the route and available `data-testid` values, make the smallest required interaction, and use `wait-for` plus `snapshot` or `text` to verify the result. Always call `stop` when finished. On failure, keep the session directory and inspect `app.log`.
