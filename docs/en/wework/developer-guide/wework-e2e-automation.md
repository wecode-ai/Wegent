---
sidebar_position: 34
---

# E2E Automation

Wework provides a dedicated Playwright E2E entrypoint and a test-only frontend automation bridge for operating the Wework Vite/React frontend in CI. The default entrypoint runs in browser mode, which covers most frontend interactions; the desktop task-flow E2E below covers native-window and task-execution behavior.

## Running Tests

Install the Playwright browser before the first run:

```bash
pnpm --filter wework exec playwright install chromium
```

Run Wework E2E:

```bash
pnpm --filter wework e2e
```

Run the real desktop task-flow E2E:

```bash
pnpm --filter wework e2e:desktop
```

Run only the cloud-project desktop E2E:

```bash
pnpm --filter wework e2e:desktop:cloud
```

Run only the plugin marketplace, install, chat-use, and uninstall flow:

```bash
pnpm --filter wework e2e:desktop:plugins
```

Run only the embedded-browser Agent operation regression:

```bash
pnpm --filter wework e2e:desktop:embedded-browser
```

Run the desktop memory regression on macOS, including streaming growth and the whole-process check with 10 concurrent tasks:

```bash
pnpm --filter wework e2e:desktop:memory
```

Run only the regression that keeps “Thinking” below already-visible streaming assistant text and removes it after completion:

```bash
pnpm --filter wework e2e:desktop:streaming-text
```

The command starts a test-only Vite server through `wework/playwright.config.ts`:

```bash
pnpm exec vite --host 127.0.0.1 --port 4174 --mode e2e
```

It also starts Responses API, Sites upstream, and Connector upstream mocks:

```bash
node e2e/utils/mock-response-api-server.mjs
node e2e/utils/mock-sites-upstream-server.mjs
node e2e/utils/mock-connector-upstream-server.mjs
```

Default configuration:

- `VITE_WEWORK_E2E=true`
- `VITE_WEWORK_RUNTIME_MODE=backend`
- `VITE_LOGIN_MODE=password`
- `WEWORK_RESPONSE_API_MOCK_URL`: `http://127.0.0.1:9998`
- `WEWORK_SITES_UPSTREAM_MOCK_URL`: `http://127.0.0.1:9997`
- `WEWORK_CONNECTOR_UPSTREAM_MOCK_URL`: `http://127.0.0.1:9996`

All three mock ports can be overridden with matching `*_PORT` environment variables: `WEWORK_RESPONSE_API_MOCK_PORT`, `WEWORK_SITES_UPSTREAM_MOCK_PORT`, and `WEWORK_CONNECTOR_UPSTREAM_MOCK_PORT`. If a port is overridden, tests can also receive the full matching URL environment variable directly.

Tests do not mock backend APIs. When Backend is not running, the login-page smoke test only verifies that the frontend renders the login entrypoint. Business flows after login must start a real Backend and required services in CI.

## Desktop Task-Flow E2E

`wework/e2e/desktop/task-flow.e2e.mjs` covers the real task lifecycle in a local workspace and lets product distributions inject an optional desktop scenario:

1. Builds and starts the real Electron Wework application, opening an isolated workspace with `--open-workspace`.
2. Starts the real `wegent-executor` sidecar, which starts a real `codex app-server`.
3. Fills in a task and clicks send in the native WebView, then waits for the real conversation to render.
4. Verifies the request issued by Codex to the model service, the workspace file written by a real Codex tool call, and the final UI response.
5. Sends a follow-up in the same conversation and verifies its request and rendered response.
6. Starts a streaming response, cancels it through the desktop UI, verifies the stopped task state and rendered stop notice, then verifies the composer accepts a subsequent message.
7. Forces one model failure, clicks retry in the rendered error card, and verifies the retried request and final response.
8. Creates a short two-turn conversation, switches to a new conversation, reopens the original conversation, verifies that both user messages, both assistant messages, and all four unified virtual rows remain mounted, and confirms that the first message stays near the top of the viewport instead of losing content or leaving a large virtual-list gap.
9. Dynamically loads a product scenario when `WEWORK_E2E_DESKTOP_SCENARIO_MODULE` is set. The public runner supplies only HTTP, WebSocket, control, and diagnostic lifecycles; it contains no concrete product protocol or assertions.

The test does not simulate Wework, Executor, or Codex. To keep regression results deterministic and avoid requiring a real provider account, it starts only a loopback model service implementing OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages. Each interface runs a text response plus a send → `apply_patch` → tool result → completion lifecycle, while real Codex executes the tool in the isolated workspace.

The model protocol matrix defines 18 combinations across execution location, model source, and protocol:

- Local execution covers local custom models, built-in Codex models, and cloud Model CRDs across all three protocols, for 9 complete text and tool lifecycles.
- Cloud execution also covers local custom models, built-in Codex models, and cloud Model CRDs across all three protocols, for 9 complete text and tool lifecycles.
- The first local-custom-model-to-cloud-device combination verifies the synchronization confirmation, target Executor catalog write, and cloud Codex restart. All three local-model protocols must then complete their text and `apply_patch` tool lifecycles.

Matrix submissions use a 10-second timeout. If the composer already displays a submission error, the runner throws that exact error immediately. Otherwise, a stalled protocol stage reports its current stage and captured requests instead of waiting through the general UI timeout.

`e2e:desktop:streaming-text` runs an isolated streaming-message state regression through a scenario module. It uses the real Electron renderer, Executor, and Codex app-server while a loopback Responses SSE keeps a partial reply active. The scenario first streams one assistant item as `final_answer` and completes the same item as `commentary`. It verifies that Executor sends `response.block.created.replacesItemId`, allowing the frontend to atomically migrate the visible assistant text into a process block so the page contains one process copy and no final-answer copy. The scenario then verifies that streaming reasoning appears as “Thinking · summary” and that the reasoning summary and its placeholder are removed after completion. It starts a long-running command and confirms that the tool-row duration continues increasing after switching tasks while the tool-group header does not show a turn-wide aggregate duration. The scenario next builds a long multi-turn conversation beyond the virtualization threshold and verifies the “Thinking” position, user scroll anchor, streaming growth, and viewport stability after reopening the task. It uses `scrollFromBottomAsUser` to move a fixed distance upward from the bottom, then combines `startScrollStabilitySampling` and `getScrollStabilitySample` to record anchor geometry, DOM changes, and real `scroll` events while response chunks arrive. The gate requires no back-and-forth anchor movement and no programmatic scroll events after the user stops. It also verifies that the waiting state disappears after completion. The scenario retains screenshots for phase reclassification, reasoning, tool timing, ready, streaming, and completed stages; its scenario-specific Codex configuration disables plugin extensions to isolate direct message streaming.

`e2e:desktop:embedded-browser` runs the embedded-browser Agent operation regression through a scenario module. It uses the real Electron renderer, Executor, Codex app-server, and browser MCP server, opens a local fixture page, and verifies the Electron `WebContentsView` bridge control path. The scenario covers bridge identity lookup, authenticated bridge requests, page open, structured `inspect`, `fill`, `click`, `wait`, `scroll`, `screenshot`, `capabilities`, high-risk action approval, and combined MCP tools such as `open_and_inspect` and `wait_and_inspect`. It also starts a long `waitFor` and then verifies an independent `click` is not blocked, preventing bridge concurrency regressions. When local-file support changes, the scenario also opens a `file://` HTML fixture, Markdown and extensionless text fixtures, and a local folder fixture through the bridge, and verifies that an unpreviewable local file shows a toast instead of entering the download list. Results are written to `embedded-browser-agent-result.json`.

The `renderer-storage` checkpoint writes model, draft, and layout `localStorage`
fixtures in the real packaged Electron app, flushes the persistence queue, and
restarts Core DSH. It requires the page origin after restart to differ from the
original origin before checking that all three values were restored. This makes
the regression exercise desktop persistence across origins instead of an
ordinary read within the same renderer process.

The main desktop flow's short-conversation layout regression stores `short-conversation-00-ready.png`, `short-conversation-01-prompt-filled.png`, `short-conversation-02-completed-top-aligned.png`, and `short-conversation-layout-metrics.json`. The final screenshot and metrics are captured after switching away and reopening the conversation. The gate requires the first message to remain within `160px` of the message viewport's top edge. For focused local diagnosis, run `node wework/e2e/desktop/task-flow.e2e.mjs --short-conversation-only`; the same check remains part of the regular `e2e:desktop` flow rather than a separate CI entrypoint.

The main desktop runner also supports execution through ordered checkpoints.
The checkpoints are `remote-device-onboarding`, `workspace-tabs`,
`cloud-project-creation`, `cloud-space-mention`, `priority-filter`,
`telemetry-consent`, `automation-lifecycle`, `project-automation`,
`project-assignment-notification`, `offline-local-project-space`,
`core-dsh-plugin-management`, `plugin-auto-update`, `plugin-workspace-publication`,
`project-ai-settings`, `model-routing`, `permission-modes`, `core-task-flow`,
`task-attachments`, `cloud-git-worktree`, `cloud-worktree-capability`,
`cloud-worktree-create`, `cloud-worktree-queued-cancel`, `cloud-worktree-tools`,
`cloud-worktree-archive-restore`, `cloud-worktree-device-restart`,
`context-compaction`, `runtime-task-queue`, `runtime-terminal-convergence`,
`executor-stream-recovery`, `running-conversation-history`,
`codex-notification-isolation`, `split-workbench`, `native-window-startup`,
`native-window-chrome`, `renderer-storage`, `tray-lifecycle`, `window-lifecycle`,
`goal-lifecycle`, `supervisor-lifecycle`, `resilience`, `conversation-state`,
`temporary-chat`, `workspace-attachments`, `rendering-extensions`,
`change-request-status`, `claude-runtime`, `local-file-preview`, `local-harness`,
`harness-apps`, `browser-multi-tabs`, `embedded-browser`, and
`browser-toolbar-actions`.
`--segment <checkpoint>` performs common startup and project
initialization, then runs only the selected checkpoint.
`--from-segment <checkpoint>` starts there and continues through every later
checkpoint. When upstream checkpoints are skipped, each checkpoint establishes
its own minimal fixtures instead of depending on tasks or UI state created only
by the complete flow. PR CI builds the smallest segment matrix for the changed
feature paths. Shared desktop infrastructure, merge queue, scheduled runs, and
`ci:all` still run the complete desktop suites. Core uses seventeen fixed GitHub
Actions matrix jobs and Cloud uses fifteen. Every job runs its
checkpoints serially so multiple real Electron, WebView, and Executor stacks do not
contend for CPU and memory on the same GitHub runner and push normal asynchronous
state beyond the shared 10-second step timeout. The thirty-two matrix jobs still provide
suite-level parallelism across runners. Shards are balanced from observed CI
durations and capped to keep the complete suite inside its ten-minute critical-path
budget; a new or materially slower checkpoint requires rebalancing instead of
removing coverage or rerunning failures. The 2,200-delta Codex notification
isolation stress case and the long plugin auto-update checkpoint each have a
dedicated shard; the notification scenario uses a targeted 30-second render
budget without changing the shared 10-second UI timeout. CI first builds one Core Electron
application, Executor, and Codex artifact. Electron package preparation builds
the Harness runtime, Node execution runtime, and Executor concurrently; the
Harness preparation owns the single DSH application Vite build so the same
frontend is not compiled twice. Every Core and Cloud shard downloads and reuses
that artifact instead of rebuilding Vite, Electron, and Executor. Rust builds
reuse both the `main`-owned Cargo target cache and sccache compiler units: the
target cache bounds PR and first-run latency, while sccache reduces incremental
compilation after dependency or source changes. Archiving strips Linux debug symbols only from the copied
artifact binaries, leaving the original build outputs unchanged while reducing
upload and download time across the thirty-two shards. Desktop E2E and its cache
warmup explicitly set `WEWORK_EXECUTOR_PROFILE=debug` so test artifacts do not
spend time optimizing the Executor. Release packaging leaves the variable unset
and continues to build the `release` Executor by default. Desktop E2E builds
skip the duplicate TypeScript typecheck that the parallel Lint workflow runs in full,
while retaining the real Vite and Electron artifact build; test coverage and the
type gate remain unchanged. The macOS memory job keys its pnpm store from both
the workspace and Electron lockfiles, then installs offline so registry stalls
cannot consume the critical-path budget. Its large streaming Markdown response
uses a targeted 30-second completion budget while ordinary memory interactions
retain the shared 10-second timeout. The plugin suite requires an independent build
configuration and continues to run in parallel with the shared Core build.
Desktop shards use only the runtime tools already present in the immutable E2E
image; ZIP fixtures use Python's standard library, so the jobs do not restore
the full frontend dependency cache. Successful harness-app coverage keeps
milestone screenshots, and every run retains logs, state snapshots, and other
useful diagnostics. Before upload, CI removes only transient Chromium caches
that cannot help reproduce a failure. Uploads disable redundant compression for
PNG and other already-compressed evidence so artifact archiving does not extend
the pipeline tail. Merge queue validates
the final commit that enters `main`, so Tests, Lint, Platform E2E, and Wework E2E
do not repeat the same validation after the merge through a `push main` trigger. The
mapping lives in `.github/scripts/classify-wework-desktop-e2e.sh` and must be updated when new
feature coverage is registered. Segment commands are also useful for focused
local iteration:

```bash
pnpm --filter wework e2e:desktop -- --segment automation-lifecycle
pnpm --filter wework e2e:desktop -- --segment local-harness
pnpm --filter wework e2e:desktop -- --segment model-routing
pnpm --filter wework e2e:desktop -- --segment window-lifecycle
pnpm --filter wework e2e:desktop -- --from-segment window-lifecycle
pnpm --filter wework e2e:desktop -- --segment temporary-chat
pnpm --filter wework e2e:desktop -- --segment workspace-attachments
pnpm --filter wework e2e:desktop -- --segment claude-runtime
```

`automation-lifecycle` independently covers automation creation, immediate
execution, pinning and continuing an existing task, and scheduled continuation.
`model-routing` independently covers all six local protocol-switch directions,
cross-provider retry, the vision sidecar, and the local model protocol matrix.
Both checkpoints establish their own minimal fixtures, so they no longer extend
the critical path for task creation, follow-up, and background plans in
`core-task-flow`. An unsegmented complete desktop run still executes these
scenarios, so splitting them does not reduce coverage.

`temporary-chat` creates an independent local project and real Codex ephemeral
thread, holds a follow-up response open, verifies that the user message appears
above the Thinking indicator, and confirms that the temporary-chat content is
restored from the runtime conversation cache after switching the main
conversation away and back.

`claude-runtime` uses the real Electron Wework application, Backend, local
executor, and remote executor to verify Claude Code creation, follow-up, and
cancellation on both local and remote devices. It also confirms that remote
execution uses the target device's own Claude Code binary and checks visible
DOM state so the sidebar and composer stop showing running after completion;
the hidden sidebar preview retained by the layout is excluded from visible
state assertions.

`local-harness` uses the real OpenCode, Claude Code, and Kimi Code CLIs pinned
by `.github/claude-code-cli/package-lock.json`; argument-recording shell
fixtures are not valid substitutes. The scenario must assert real requests
from every CLI through the Wework local model proxy. Kimi Code starts as an
interactive TUI, so its first prompt is injected only after PTY output contains
the readiness marker. Writing during terminal capability negotiation loses the
input.

The plugin desktop suite reuses the same segment options while keeping its
separate Codex Home initialization environment. Its ordered segments are
`plugin-lifecycle`, `skill-mention-rendering`, and
`sites-plugin-auto-install`. Each segment establishes the minimal plugin
fixture it needs, so it can run alone or continue through the later plugin
features. `plugin-lifecycle` also covers: the composer plugin picker no longer
listing a plugin after uninstall, and unmatched assistant `need_login` /
`connector_auth_required` resume text not opening a local auth card.

```bash
pnpm --filter wework e2e:desktop:plugins -- --segment skill-mention-rendering
pnpm --filter wework e2e:desktop:plugins -- --from-segment skill-mention-rendering
```

Ordinary desktop-runner UI steps time out after 10 seconds by default, so one
failed step does not always wait for the former 120-second limit. Control
commands and wait helpers accept `timeoutMs` for genuinely slower special
steps; startup, workbench recovery, and the model protocol matrix keep their
dedicated limits. Set `WEWORK_E2E_STEP_TIMEOUT_MS` to temporarily adjust the
global default for ordinary steps in a slower diagnostic environment.

The main desktop flow also covers pasting or dropping ordinary files and folders from Finder. The composer must render file and folder path chips without creating an attachment badge. The request sent to Codex must contain the matching absolute paths without inlining file contents. This decision depends on whether the native desktop transfer resolves a file path; the composer must not switch to attachment upload early only because its current workspace is marked as remote. The top quick-send window uses the same rule and reads bytes only for image attachments. Both scenarios use ordinary small files. For focused local diagnosis, run `node wework/e2e/desktop/task-flow.e2e.mjs --pasted-workspace-paths-only` or `node wework/e2e/desktop/task-flow.e2e.mjs --dropped-workspace-paths-only`.

Following the cc-switch conversion boundary, the mock strictly validates what reaches the model side: authentication, model ID, stream settings, message history, tool choice, shell tools, and either the `apply_patch` Lark grammar or its function wrapper. Any incorrect field returns a non-2xx response and fails the test. The desktop test stores a follow-up screenshot for each interface plus the complete `model-requests.json`; GitHub Actions uploads desktop diagnostics on both success and failure.

The environment needs Rust, Electron build dependencies, and a real Codex binary. The runner finds `codex` on `PATH` by default; an installed or `prepare:codex`-prepared real binary can also be selected explicitly:

```bash
CODEX_BIN=/absolute/path/to/codex pnpm --filter wework e2e:desktop
```

Optional `WEWORK_E2E_EXECUTOR_BIN` and `WEWORK_E2E_APP_BIN` reuse already-built real Executor and Electron application binaries. A supplied application must be built with the desktop E2E Vite environment variables. The lifecycle scenarios share one application launch to control CI duration. Test artifacts, captured model requests, and failure diagnostics are stored in `wework/test-results/desktop-e2e/`.

`ai:verify:electron:build` shares immutable Harness Runtime archives across worktrees. The default archive cache is `~/Library/Caches/wegent/harness-runtime` on macOS, `${XDG_CACHE_HOME:-~/.cache}/wegent/harness-runtime` on Linux, and `%LOCALAPPDATA%\wegent/harness-runtime` on Windows. Materialized development runtimes remain under `wework/node_modules/.cache/harness-runtime-dev` in the current worktree so mutable state is not shared across source trees. Set `WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT` to override the archive cache. If a build only sets the legacy `WEWORK_HARNESS_RUNTIME_CACHE_ROOT`, that value is translated into an archive-only cache override and does not move the current worktree's materialized runtime.

Before launching Electron, desktop E2E removes inherited task, IPC, Node, and Harness runtime variables so a development Wework or Codex session cannot leak personal runtime paths into the test application. To select a Core DSH runtime explicitly for focused diagnosis, set `WEWORK_E2E_HARNESS_RUNTIME_ROOT`; the runner validates that directory and passes it to the test application as `WEWORK_HARNESS_RUNTIME_ROOT`. Do not pass `WEWORK_HARNESS_RUNTIME_ROOT` directly to the test command.

On macOS, desktop E2E injects the test-only `WEWORK_E2E_BACKGROUND_WINDOW=1` setting by default. It keeps the Electron main window hidden, prohibits application activation, and hides its Dock icon. Background throttling is disabled for the hidden WebView, so DOM control, timers, and snapshots continue to work. Set `WEWORK_E2E_BACKGROUND_WINDOW=0` explicitly when foreground window inspection is required. This setting affects desktop E2E only; normal development and production launches are unchanged.

The cloud-project scenario starts a real Backend, Redis, and a real Executor registered as a remote device. It exercises real authentication, device RPC, task persistence, and project deletion while covering project creation, task execution, conversation restoration, follow-up, and project removal. The scenario also verifies all three model protocols through the Backend proxy for cloud Model CRDs, plus local-executor use of Codex and cloud models under the same connected account. Only provider model endpoints are simulated; Backend HTTP and WebSocket APIs must not be mocked. To shorten cold startup, the Executor build runs in parallel with Backend, Redis, and database preparation, while remote Executor registration runs in parallel with the Electron application build. Application startup still waits for both prerequisite groups to finish. Project cleanup must wait until the task is no longer running; rendered assistant text does not mean the final task state has been persisted. Python 3.11, `uv`, and `redis-server` are required to run this scenario.

Before validating local-executor models for a connected account, the cloud scenario selects its isolated directory through the current Projects → Local project entrypoint and confirms the name in the local-project creation dialog. Desktop E2E coverage must follow this primary product flow instead of relying on the removed existing-project test entrypoint.

The GitHub Actions Executor E2E job loads a prebuilt Docker image after restoring Python, Node.js, and Playwright caches. It must first remove unused hosted-runner SDKs (.NET, Android, GHC, and CodeQL) and print disk usage so image extraction has stable headroom. The cleanup must not remove the running MySQL or Redis service images.

The plugin scenario dynamically creates an isolated local Codex marketplace and a plugin with a Skill under the test-results directory. It then uses the real Electron renderer, Executor, and Codex app-server to verify marketplace discovery, installation, the install-time local authorization dialog, insertion of the plugin reference into the chat composer, unmatched resume auth text not opening a local auth card, composer filtering after uninstall, and uninstallation. It neither reads the user's Codex home nor mocks plugin APIs; marketplace data, plugin cache, and installation state remain inside the isolated test directory. Screenshots are retained for the critical stages, with application, Executor, and UI snapshot diagnostics retained on failure.

The memory scenario is macOS-only. It executes a development task through a real Codex tool call, then streams a long response containing Markdown, tables, and TypeScript code into the real Electron renderer. The test first waits for the renderer-process memory baseline to stabilize, then samples the aggregate physical footprint of associated Electron renderer processes every 500 milliseconds. It writes the samples, DOM node counts, and summary metrics to `memory-growth.json`; the gate does not include the main Wework process. The default gates limit peak growth to 384 MiB, settled growth after completion to 224 MiB, and the full physical-footprint range within the settled window to 16 MiB. The DOM gate checks the settled window after virtual-list convergence and allows at most 900 retained nodes by default. Transient peaks during streaming remain in the diagnostics but do not treat pre-convergence rendering as a leak. The limits can be adjusted with `WEWORK_E2E_MEMORY_MAX_PEAK_GROWTH_KIB`, `WEWORK_E2E_MEMORY_MAX_SETTLED_GROWTH_KIB`, and `WEWORK_E2E_MEMORY_MAX_SETTLED_DOM_NODES`.

The concurrent-memory scenario is also macOS-only. It creates and holds 10 Responses streams at the same time, samples the process-group physical footprint for the Wework main process, Electron renderer/GPU/network processes, Executor processes, and the Codex app-server, and writes the evidence to `concurrent-memory.json`. Relative to the stable baseline, both the peak and active settled plateau may grow by at most 320 MiB, while the settled sampling window may vary by at most 64 MiB. The limits can be adjusted with `WEWORK_E2E_CONCURRENT_MEMORY_MAX_PEAK_GROWTH_KIB`, `WEWORK_E2E_CONCURRENT_MEMORY_MAX_SETTLED_GROWTH_KIB`, and `WEWORK_E2E_CONCURRENT_MEMORY_MAX_SETTLED_SAMPLE_RANGE_KIB`. The scenario also switches between the first and last tasks and waits for each task's prompt content to reappear.

## Responses API Mock

`wework/e2e/utils/mock-response-api-server.mjs` provides a real HTTP service that validates local-model capability probes:

- `POST /v1/responses`: returns non-streaming Responses API JSON.
- `POST /v1/responses` capability probes: returns `text/event-stream` tool-call events such as `response.output_item.added` and `response.output_item.done`.
- `POST /v1/responses` with `stream: true`: returns `text/event-stream` events including `response.created`, `response.output_text.delta`, and `response.completed`.
- `POST /v1/chat/completions`: validates and returns a Chat Completions function tool call.
- `POST /v1/messages`: validates and returns an Anthropic Messages `tool_use` block.
- `GET /captured-requests`: reads captured requests.
- `POST /clear-requests`: clears captured requests.
- `GET /health`: CI health check.

The mock enables CORS, so the Wework page can call it with a real browser `fetch`. For model connection tests, use this base URL:

```text
http://127.0.0.1:9998/v1
```

## External Upstream Mocks

Wework E2E also starts two local loopback upstream mocks. They replace only services outside Wegent; they do not replace Wegent Backend, Executor, Codex, `/api/sites`, `/api/apps/installed`, or connector runtime APIs.

`wework/e2e/utils/mock-sites-upstream-server.mjs` simulates the Sites project API and returns Sites or Mini Programs according to `app_type`:

- `GET /api/v1/projects/search`: returns deterministic projects and supports `username`, `limit`, `sitename`, and `cursor`.
- `POST /api/v1/projects/deploy/network`: updates project network visibility.
- `POST /api/v1/projects/update`: updates project name.
- `POST /api/v1/projects/del`: deletes a project.
- `GET /captured-requests`, `POST /clear-requests`, `POST /reset`, `GET /health`: assertion and reset helpers.

To cover the Sites path through a real Backend, start Backend with the following environment variables. These variables must be passed to the Backend process; passing them to Vite or the Playwright page does not configure Backend.

```text
SITES_API_BASE_URL=http://127.0.0.1:9997
SITES_API_TOKEN=e2e-sites-token
```

Example:

```bash
cd backend
SITES_API_BASE_URL=http://127.0.0.1:9997 \
SITES_API_TOKEN=e2e-sites-token \
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

`wework/e2e/utils/mock-connector-upstream-server.mjs` simulates external services that connector apps can target:

- `GET /api/tickets/{id}`: acts as an HTTP connector upstream.
- `POST /mcp`: provides minimal Streamable HTTP MCP JSON-RPC behavior for `initialize`, `tools/list`, and `tools/call`.
- `GET /captured-requests`, `POST /clear-requests`, `GET /health`: assertion and reset helpers.

Connector app test data can use:

```text
HTTP connector base URL: http://127.0.0.1:9996/api
MCP URL: http://127.0.0.1:9996/mcp
```

An HTTP connector fixture can use:

```json
{
  "slug": "ticket-http",
  "name": "Ticket HTTP API",
  "description": "E2E HTTP connector upstream",
  "enabled": true,
  "visibility": "all",
  "allowed_roles": [],
  "auth_type": "none",
  "transport": "http",
  "mcp_url": "http://127.0.0.1:9996/api",
  "oauth_scopes": [],
  "provider_headers": {},
  "tool_allowlist": ["get_ticket"],
  "http_tools": [
    {
      "name": "get_ticket",
      "description": "Get one mock ticket",
      "method": "GET",
      "path": "/tickets/{id}",
      "input_schema": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "expand": { "type": "boolean" }
        },
        "required": ["id"]
      },
      "argument_locations": {
        "id": "path",
        "expand": "query"
      }
    }
  ]
}
```

An MCP connector fixture can use:

```json
{
  "slug": "docs-mcp",
  "name": "Docs MCP",
  "description": "E2E Streamable HTTP MCP connector upstream",
  "enabled": true,
  "visibility": "all",
  "allowed_roles": [],
  "auth_type": "none",
  "transport": "streamable-http",
  "mcp_url": "http://127.0.0.1:9996/mcp",
  "oauth_scopes": [],
  "provider_headers": {},
  "tool_allowlist": ["search_docs"]
}
```

## Automation Bridge

In test mode, Wework exposes a frontend control bridge at `window.__WEWORK_E2E__`. The bridge is installed only when `import.meta.env.MODE === "e2e"` or `VITE_WEWORK_E2E=true`; normal development and production runs do not enable it by default.

Isolated real Electron verification can dispatch path paste or drop events to the composer with `ai:verify paste-paths` or `ai:verify drop-paths`. The `--value` argument accepts a JSON array whose entries contain `uri` and `name`; folder entries also set `isDirectory: true`:

```bash
pnpm --filter wework ai:verify paste-paths \
  --session /absolute/path/to/session.json \
  --selector '[data-testid="chat-message-input"]' \
  --value '[{"uri":"file:///tmp/context","name":"context","isDirectory":true}]'
```

Replace `paste-paths` with `drop-paths` in the example to verify Finder drag and drop.

Available methods:

- `isDesktop()`: returns whether the app is running in Electron.
- `getRuntimeConfig()`: reads the current runtime config.
- `getRoute()`: returns the current route with the app base path removed.
- `navigate(path)`: changes route through frontend history and dispatches navigation events.
- `waitForTestId(testId, options)`: waits for a `data-testid` to appear.
- `queryTestIds(prefix)`: lists current `data-testid` values, optionally filtered by prefix.
- `setAuthToken(token)`: stores a real auth token.
- `clearAuthToken()`: clears the auth token.
- `clearStorage()`: clears local auth state and browser storage.

The desktop E2E build additionally injects `VITE_WEWORK_DESKTOP_E2E_CONTROL_URL`. Only when E2E mode and this URL are both present does the frontend poll a local loopback controller for `click`, `fill`, and wait assertions; normal development and production builds have no controller endpoint. The controller drives real WebView DOM events and does not replace task, model-selection, Executor, or Codex implementations.

When a built-in action does not handle a command, the public controller delegates it through `@extensions/desktop-control` to a product extension. Without a product extension, unknown actions fail explicitly; public automation does not recognize concrete product protocols.

The controller uses short polling: the server returns `204` when no command is available, and the frontend waits briefly before polling again. This prevents a stale long-poll connection, left behind by a WebView reload, task switch, or stream completion, from consuming later commands. When `fill` targets a Lexical editor, the controller uses the editor's exposed `value` setter so the React/Lexical state is actually committed; do not replace it with raw DOM insertion. Failure diagnostics include delivered `commandHistory` in `scenario-state.json` to aid control-channel debugging.

The desktop controller uses Electron `webContents.capturePage()` for native renderer screenshots. The capability is available only when `VITE_WEWORK_E2E=true`; selector captures crop the native image by the element bounds, so diagnostics preserve the actual Electron rendering.

Switching models in the same conversation can cause Codex to issue an internal context-compaction request. The desktop task-flow E2E loopback Responses service identifies and responds to these requests through `client_metadata.x-codex-turn-metadata.request_kind === "compaction"`, so they are not mistaken for a user follow-up message.

## Test Helper

`wework/e2e/fixtures/wework-app.ts` provides a `WeworkApp` Playwright helper that wraps `window.__WEWORK_E2E__` in typed test operations:

```ts
const app = new WeworkApp(page);

await app.goto("/");
await app.waitForTestId("login-form");
await app.navigate("/apps");
const route = await app.route();
```

New E2E tests should prefer this helper and `data-testid` locators instead of unstable CSS selectors or visible copy.

## CI Guidance

CI can run Wework E2E as a separate job:

```bash
pnpm install --frozen-lockfile
pnpm --filter wework exec playwright install chromium
pnpm --filter wework e2e
```

Desktop task-flow E2E requires a Linux runner with a graphical session, for example:

```bash
pnpm --filter wework prepare:codex
xvfb-run -a pnpm --filter wework e2e:desktop:plugins
xvfb-run -a pnpm --filter wework e2e:desktop
xvfb-run -a pnpm --filter wework e2e:desktop:cloud
```

GitHub Actions runs the plugins, core, and cloud Linux desktop scenarios as a
parallel matrix. Each scenario receives an isolated runner, HOME, Executor
Home, ports, and diagnostic artifact. This preserves the existing real Electron,
Executor, and Codex verification semantics while removing the serial wait
between the three scenarios. Matrix fail-fast is disabled so the remaining
scenarios can finish and upload diagnostics when one scenario fails.
The three scenarios reuse one prebuilt Electron artifact. Scenario-specific
values such as Codex Home initialization, cloud endpoints, and test credentials
are injected through the desktop E2E runtime config when Electron starts rather
than compiled into the application binary. Plugins, core, and cloud can therefore
share the application build while retaining isolated runtime directories and
process state.

The Linux desktop scenarios cache the downloaded `.deb` files for Electron system
dependencies in the runner user's home directory. Cache keys rotate weekly and
are scoped by operating system and CPU architecture. Every run still executes
`apt-get update`; an older cache is only a restore source, and missing or
updated packages are downloaded from the Ubuntu repositories. Installation
uses `--no-install-recommends` plus repository retries and timeouts to reduce
whole-job timeouts caused by transient hosted-runner mirror degradation.

The memory gate depends on macOS Electron process association and physical-footprint sampling, so run it separately on a macOS runner:

```bash
pnpm --filter wework prepare:codex
pnpm --filter wework e2e:desktop:memory
```

The repository includes a basic workflow at `.github/workflows/wework-e2e.yml`. It runs when Wework, `packages/chat-core`, the pnpm lockfile, or the workflow itself changes.
Linux and Windows Desktop Core E2E consume the same shard matrix produced by
the classifier; a complete classification runs all 17 Core shards on both
platforms. The Windows job builds native `WeWork.exe`,
`wegent-executor.exe`, and `codex.exe` artifacts on `windows-latest` before
running checkpoints. A cross-platform package or a single Windows smoke test is
not equivalent coverage.

Regular draft PRs do not run browser or desktop E2E. Merge queue runs the
complete browser plus Linux and Windows Desktop Core suites before a commit
enters `main`; `main` does not repeat checks that already passed for the merge
group. The macOS memory gate runs by default only on scheduled and manual runs.
Add the `ci:memory` label when a PR must validate the memory boundary. Applying that
label starts only the memory gate and does not repeat browser, Linux desktop, or
Windows desktop E2E. Applying `ci:all` runs browser, Linux desktop, Windows
desktop, and macOS memory E2E even when the PR's changed paths would not
normally select Wework E2E. The workflow also runs a complete regression every
day at 04:00 UTC.

Authenticated flows should create users and data through backend APIs before the test, then use real login or a real token injection. Do not mock backend HTTP responses in Playwright.
