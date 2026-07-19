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

The command starts a test-only Vite server through `wework/playwright.config.ts`:

```bash
pnpm exec vite --host 127.0.0.1 --port 4174 --mode e2e
```

It also starts a Responses API mock:

```bash
node e2e/utils/mock-response-api-server.mjs
```

Default configuration:

- `VITE_WEWORK_E2E=true`
- `VITE_WEWORK_RUNTIME_MODE=backend`
- `VITE_LOGIN_MODE=password`
- `WEWORK_RESPONSE_API_MOCK_URL`: `http://127.0.0.1:9998`

Tests do not mock backend APIs. When Backend is not running, the login-page smoke test only verifies that the frontend renders the login entrypoint. Business flows after login must start a real Backend and required services in CI.

## Desktop Task-Flow E2E

`wework/e2e/desktop/task-flow.e2e.mjs` covers the real task lifecycle in a local workspace:

1. Builds and starts the real Tauri Wework application, opening an isolated workspace with `--open-workspace`.
2. Starts the real `wegent-executor` sidecar, which starts a real `codex app-server`.
3. Fills in a task and clicks send in the native WebView, then waits for the real conversation to render.
4. Verifies the request issued by Codex to the model service, the workspace file written by a real Codex tool call, and the final UI response.
5. Sends a follow-up in the same conversation and verifies its request and rendered response.
6. Starts a streaming response, cancels it through the desktop UI, verifies the stopped task state and rendered stop notice, then verifies the composer accepts a subsequent message.
7. Forces one model failure, clicks retry in the rendered error card, and verifies the retried request and final response.

The test does not simulate Wework, Executor, or Codex. To keep regression results deterministic and avoid requiring a real account, it starts only a loopback model service implementing OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages. Each interface runs a send → `apply_patch` → tool result → follow-up lifecycle, while real Codex executes the tool in the isolated workspace.

Following the cc-switch conversion boundary, the mock strictly validates what reaches the model side: authentication, model ID, stream settings, message history, tool choice, shell tools, and either the `apply_patch` Lark grammar or its function wrapper. Any incorrect field returns a non-2xx response and fails the test. The desktop test stores a follow-up screenshot for each interface plus the complete `model-requests.json`; GitHub Actions uploads desktop diagnostics on both success and failure.

The environment needs Rust, Tauri build dependencies, and a real Codex binary. The runner finds `codex` on `PATH` by default; an installed or `prepare:codex`-prepared real binary can also be selected explicitly:

```bash
CODEX_BIN=/absolute/path/to/codex pnpm --filter wework e2e:desktop
```

Optional `WEWORK_E2E_EXECUTOR_BIN` and `WEWORK_E2E_APP_BIN` reuse already-built real Executor and Tauri application binaries. A supplied application must be built with the desktop E2E Vite environment variables. The lifecycle scenarios share one application launch to control CI duration. Test artifacts, captured model requests, and failure diagnostics are stored in `wework/test-results/desktop-e2e/`.

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
xvfb-run -a pnpm --filter wework e2e:desktop
```

The repository includes a basic workflow at `.github/workflows/wework-e2e.yml`. It runs when Wework, `packages/chat-core`, the pnpm lockfile, or the workflow itself changes.

Authenticated flows should create users and data through backend APIs before the test, then use real login or a real token injection. Do not mock backend HTTP responses in Playwright.
