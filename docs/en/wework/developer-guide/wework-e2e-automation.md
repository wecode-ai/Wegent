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

Run the desktop streaming-memory regression on macOS:

```bash
pnpm --filter wework e2e:desktop:memory
```

Run the whole-process memory regression with 10 concurrently executing tasks:

```bash
pnpm --filter wework e2e:desktop:concurrent-memory
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

1. Builds and starts the real Tauri Wework application, opening an isolated workspace with `--open-workspace`.
2. Starts the real `wegent-executor` sidecar, which starts a real `codex app-server`.
3. Fills in a task and clicks send in the native WebView, then waits for the real conversation to render.
4. Verifies the request issued by Codex to the model service, the workspace file written by a real Codex tool call, and the final UI response.
5. Sends a follow-up in the same conversation and verifies its request and rendered response.
6. Starts a streaming response, cancels it through the desktop UI, verifies the stopped task state and rendered stop notice, then verifies the composer accepts a subsequent message.
7. Forces one model failure, clicks retry in the rendered error card, and verifies the retried request and final response.
8. Dynamically loads a product scenario when `WEWORK_E2E_DESKTOP_SCENARIO_MODULE` is set. The public runner supplies only HTTP, WebSocket, control, and diagnostic lifecycles; it contains no concrete product protocol or assertions.

The test does not simulate Wework, Executor, or Codex. To keep regression results deterministic and avoid requiring a real account, it starts only a loopback model service implementing OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages. Each interface runs a send → `apply_patch` → tool result → follow-up lifecycle, while real Codex executes the tool in the isolated workspace.

Following the cc-switch conversion boundary, the mock strictly validates what reaches the model side: authentication, model ID, stream settings, message history, tool choice, shell tools, and either the `apply_patch` Lark grammar or its function wrapper. Any incorrect field returns a non-2xx response and fails the test. The desktop test stores a follow-up screenshot for each interface plus the complete `model-requests.json`; GitHub Actions uploads desktop diagnostics on both success and failure.

The environment needs Rust, Tauri build dependencies, and a real Codex binary. The runner finds `codex` on `PATH` by default; an installed or `prepare:codex`-prepared real binary can also be selected explicitly:

```bash
CODEX_BIN=/absolute/path/to/codex pnpm --filter wework e2e:desktop
```

Optional `WEWORK_E2E_EXECUTOR_BIN` and `WEWORK_E2E_APP_BIN` reuse already-built real Executor and Tauri application binaries. A supplied application must be built with the desktop E2E Vite environment variables. The lifecycle scenarios share one application launch to control CI duration. Test artifacts, captured model requests, and failure diagnostics are stored in `wework/test-results/desktop-e2e/`.

The cloud-project scenario starts a real Backend, Redis, and a real Executor registered as a remote device. It exercises real authentication, device RPC, task persistence, and project deletion while covering project creation, task execution, conversation restoration, follow-up, and project removal. Only the model Responses API used by Codex is simulated; Backend HTTP and WebSocket APIs must not be mocked. Python 3.11, `uv`, and `redis-server` are required to run this scenario.

The plugin scenario dynamically creates an isolated local Codex marketplace and a plugin with a Skill under the test-results directory. It then uses the real Tauri WebView, Executor, and Codex app-server to verify marketplace discovery, installation, insertion of the plugin reference into the chat composer, and uninstallation. It neither reads the user's Codex home nor mocks plugin APIs; marketplace data, plugin cache, and installation state remain inside the isolated test directory. Screenshots are retained for all four critical stages, with application, Executor, and UI snapshot diagnostics retained on failure.

The memory scenario is macOS-only. It executes a development task through a real Codex tool call, then streams a long response containing Markdown, tables, and TypeScript code into the real Tauri WebView. It first samples the baseline once per second until the latest three samples span no more than 8 MiB or 10 samples have been captured, using the median of the latest three as the baseline. During streaming it samples the aggregate physical footprint of all associated WebKit Web Content processes every 500 milliseconds. After completion it samples once per second until the same convergence condition is met or 20 samples have been captured, then uses the median of the latest three samples for settled growth. The screenshot is captured only after memory sampling so image capture cannot affect the gate. Samples, DOM node counts, and summary metrics are written to `memory-growth.json`; the gate does not include the main Wework process. The default gates limit peak growth to 256 MiB, settled growth after completion to 160 MiB, and continued growth during the settled window to 16 MiB. The first two limits can be adjusted with `WEWORK_E2E_MEMORY_MAX_PEAK_GROWTH_KIB` and `WEWORK_E2E_MEMORY_MAX_SETTLED_GROWTH_KIB`.

The concurrent-memory scenario is also macOS-only. It creates and holds 10 Responses streams at the same time, samples the process-group physical footprint for the Wework main process, WebKit Web Content/GPU/Networking processes, Executor processes, and the Codex app-server, and writes the evidence to `concurrent-memory.json`. The gate requires the whole process group to stay below an 800 MiB peak and can be adjusted with `WEWORK_E2E_CONCURRENT_MEMORY_MAX_PHYSICAL_FOOTPRINT_KIB`. The scenario also switches between the first and last tasks and waits for each task's prompt content to reappear.

## Responses API Mock

`wework/e2e/utils/mock-response-api-server.mjs` provides a real HTTP service that validates local-model capability probes:

- `POST /v1/responses`: returns non-streaming Responses API JSON.
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

`wework/e2e/utils/mock-sites-upstream-server.mjs` simulates the Sites project API:

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

Available methods:

- `isTauri()`: returns whether the app is running in Tauri.
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

On macOS, the desktop controller's `capture` command asks Tauri for a native WebKit `WKWebView` snapshot instead of cloning the DOM in the page. The native command is available only when `VITE_WEWORK_E2E=true` and times out after 10 seconds. Capturing `body` returns the full PNG directly; other selectors are cropped from that native snapshot using the element bounds. This keeps failure diagnostics faithful to fonts, native WebView rendering, and the real page state without depending on a hidden iframe load event.

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

The memory gate depends on macOS WebKit process association and physical-footprint sampling, so run it separately on a macOS runner:

```bash
pnpm --filter wework prepare:codex
pnpm --filter wework e2e:desktop:memory
```

The repository includes a basic workflow at `.github/workflows/wework-e2e.yml`. It runs when Wework, `packages/chat-core`, the pnpm lockfile, or the workflow itself changes.

Authenticated flows should create users and data through backend APIs before the test, then use real login or a real token injection. Do not mock backend HTTP responses in Playwright.
