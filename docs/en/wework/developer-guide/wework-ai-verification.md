---
sidebar_position: 39
---

# AI Verification Sessions

Wework can start an isolated development verification session so an AI can operate and assert against the real Electron application. It reuses the desktop E2E WebView control channel, never drives an external Chrome window, and does not attach to a developer's everyday Wework window.

## Periodic plugin recovery E2E

The `plugin-periodic-reconcile` checkpoint uses real Electron, Executor, Socket.IO, database, and plugin package storage. It discards one real plugin change notification, then verifies timer-driven recovery, persisted acknowledgements, device identity, and unchanged unrelated plugin content. Its isolated instances set `LOCAL_PLUGIN_RECONCILE_INTERVAL=90` and `LOCAL_PLUGIN_RECONCILE_JITTER=18` (seconds), with the existing `LOCAL_HEARTBEAT_INTERVAL=1` configuration preserving the assertion of at least 10 heartbeats. The 90-second base period leaves room for plugin setup after registration before the first reconciliation.

Without overrides, production retains a 600-second base period plus a stable per-Runtime offset of 0–119 seconds and 30-second heartbeats. Invalid or non-positive integer values use the defaults. The test neither invokes reconciliation manually nor replaces the real timer.

```bash
pnpm --filter wework e2e:desktop:cloud -- --segment plugin-periodic-reconcile
```

## Start a session

During builds, `prepare-codex-binary.mjs` downloads the locked version through native Node HTTP/HTTPS streams, follows redirects, and removes failed temporary files. Archives are extracted for use only after integrity verification. The download stream does not depend on the Undici parser used by Node's built-in Fetch, avoiding parser crashes that terminate the build process.

```bash
pnpm --filter wework ai:verify start
```

The command prints a session file path and a local control URL. It creates a separate Executor Home, projects directory, device ID, IPC socket, Electron app-data namespace, and diagnostics directory, then starts the real `dev-mac-app.sh`. Tasks, projects, application data, and the single-instance lock are not shared with release or other verification sessions. Logs are stored in `wework/test-results/ai-verify/<run-id>/`.

## Shared desktop E2E runtime images

Shallow clones that check out the complete source tree omit `filter: blob:none`: the working tree needs every blob, so filtering only defers their download to a second promisor request during checkout. Only change classification retains full commit history with blob filtering to avoid downloading historical file contents. The shared runtime contract test checks that shallow checkout jobs do not introduce this extra request.

Standalone MinIO uses the shared API port allocator and excludes the pinned version's default console port, `13333`. Even with `MINIO_BROWSER=off`, that version checks port equality and exits; see its pinned [default](https://github.com/minio/minio/blob/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/cmd/globals.go#L215) and [startup check](https://github.com/minio/minio/blob/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/cmd/common-main.go#L502). The port regression starts allocation at `13333` and verifies that the resulting non-conflicting port can actually bind, rather than masking the conflict by restarting MinIO.

Non-draft PRs that trigger only Wework desktop E2E must also start the Backend Rust runtime producer in `e2e-tests.yml`; platform E2E eligibility alone is insufficient. The producer checks the content-addressed image first, reuses it on a cache hit, and builds and publishes it on a cache miss for the desktop build to consume. `ruby .github/scripts/test-backend-rs-e2e-runtime.rb` covers producer eligibility for platform, desktop, and draft PRs.

Linux desktop E2E builds and cache warmup consume the Rust Backend OCI image produced by `e2e-tests.yml`. Consumers must use the producer's exact `SOURCE_DIGEST` expression, including example sources. Hashing only the main program generates an unpublished image tag and eventually times out with `manifest unknown`. When changing runtime image inputs, run `bash .github/scripts/test-wework-core-e2e-runtimes.sh` to verify that both the desktop and warmup consumers match the producer.

## Operate and assert

Linux isolated desktops use `Xvfb -noreset` so the display remains connectable throughout the checkpoint. The default reset after the last client disconnects can close the listener between a short-lived `xprop` probe and Openbox connecting; see [Debian's lifecycle analysis](https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=1095028#43). Xvfb errors go through `/dev/stderr` into runner logs. Window-manager restarts or longer waits must not hide startup failures.

Pass the session path returned by `start` to every later command. Prefer stable `data-testid` selectors.

After Issue creation, finding the record in the API list does not prove that its detail UI has rendered. The shared `createAndAssignCloudIssue` flow uses `clickWhenEnabled` to wait for the detail assignee control to appear and become enabled before clicking, within the default step timeout. API persistence cannot substitute for control readiness; delays and reruns must not hide the race.

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

## Native application menu refresh

**View → Refresh** reloads the current Wework window with `⌘R` on macOS or `Ctrl+R` on Windows/Linux. The item remains available on task and settings surfaces and calls the current window's `webContents.reload()` directly.

The `application-menu` desktop CI checkpoint covers item presence, visibility in settings, control-channel reconnection after refresh, route restoration, and working workspace navigation. Focused unit tests cover shortcuts on all three platforms, window reload, and English and Chinese labels.

The `refreshFromApplicationMenu` test control command waits for `/results` acknowledgement before activating the real native menu item, so renderer unload cannot lose the command result. A control-protocol unit test delays acknowledgement to verify this ordering.

Settings preserves the active workspace tab in the background. **Work → Tasks / Project spaces** must reselect the target tab and restore its content route from settings, even when that tab is already active; ordinary workspace navigation still avoids redundant selection.

Settings routes never overwrite a workspace tab's kind or content route. Reloading settings initializes ordinary workspace tabs while the application route continues to display settings, so returning to a workspace cannot reopen settings.

Persisted-tab validation excludes invalid settings entries while retaining valid workspace tabs.

## Native context menus

Electron does not create a WebContents context menu automatically. The Wework Electron main process listens for `context-menu` centrally and builds native menus for the main window, workspace windows, and auxiliary windows.

- Image menus retain copy-image, open-image, and local-file actions.
- Editable contexts must read `params.isEditable` and `params.editFlags`, use Electron's native `undo`, `redo`, `cut`, `copy`, `paste`, `delete`, and `selectAll` roles, and pass `params.frame` to `menu.popup`.
- Selected text outside an editor uses the native `copy` role. When no meaningful action exists, do not show an empty menu, so React components can keep their own business context menus.

When changing this path, run `wework/electron/src/host/image-context-menu.test.ts`, then verify menu presentation, enabled states, and paste behavior in a real input inside an isolated Electron session. WebView DOM snapshots do not include a native macOS `NSMenu`; a synthetic `contextmenu` event or browser-only screenshot is not a substitute for real desktop verification.

## Fixed tab window restoration

When a fixed tab is assigned to a separate window, Electron restores its window identity and content route from local preferences. The restored URL must use the shared `resolveDshAppRoute` helper to add the `/wework/app/` prefix while preserving task or project query parameters, `workspaceTab`, `workspaceTabTitle`, and the fragment. Loading an unprefixed content route bypasses the Wework application deep-link entry point and prevents the restored window from displaying correctly.

The desktop CI `workspace-tabs` checkpoint covers detaching a fixed tab and restarting the application. It asserts the restored window route, tab identity, fixed state, and a visible composer that accepts input. Run focused verification with `pnpm --filter wework e2e:desktop --segment workspace-tabs`.

## AI workflow

An AI should start with `snapshot` to confirm the route and available `data-testid` values, make the smallest required interaction, and use `wait-for` plus `snapshot` or `text` to verify the result. Always call `stop` when finished. On failure, keep the session directory and inspect `app.log`.
