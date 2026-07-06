---
sidebar_position: 34
---

# E2E Automation

Wework provides a dedicated Playwright E2E entrypoint and a test-only frontend automation bridge for operating the Wework Vite/React frontend in CI. The default entrypoint runs in browser mode, which covers most frontend interactions; native window behavior should be covered separately with Tauri/WebDriver tests when needed.

## Running Tests

Install the Playwright browser before the first run:

```bash
pnpm --filter wework exec playwright install chromium
```

Run Wework E2E:

```bash
pnpm --filter wework e2e
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
- `WEWORK_RESPONSE_API_MOCK_URL=http://127.0.0.1:9998`

Tests do not mock backend APIs. When Backend is not running, the login-page smoke test only verifies that the frontend renders the login entrypoint. Business flows after login must start a real Backend and required services in CI.

## Responses API Mock

`wework/e2e/utils/mock-response-api-server.mjs` provides a real HTTP service that simulates the OpenAI Responses API:

- `POST /v1/responses`: returns non-streaming Responses API JSON.
- `POST /v1/responses` with `stream: true`: returns `text/event-stream` events including `response.created`, `response.output_text.delta`, and `response.completed`.
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

## Test Helper

`wework/e2e/fixtures/wework-app.ts` provides a `WeworkApp` Playwright helper that wraps `window.__WEWORK_E2E__` in typed test operations:

```ts
const app = new WeworkApp(page)

await app.goto("/")
await app.waitForTestId("login-form")
await app.navigate("/apps")
const route = await app.route()
```

New E2E tests should prefer this helper and `data-testid` locators instead of unstable CSS selectors or visible copy.

## CI Guidance

CI can run Wework E2E as a separate job:

```bash
pnpm install --frozen-lockfile
pnpm --filter wework exec playwright install chromium
pnpm --filter wework e2e
```

The repository includes a basic workflow at `.github/workflows/wework-e2e.yml`. It runs when Wework, `packages/chat-core`, the pnpm lockfile, or the workflow itself changes.

Authenticated flows should create users and data through backend APIs before the test, then use real login or a real token injection. Do not mock backend HTTP responses in Playwright.
