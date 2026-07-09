---
sidebar_position: 34
---

# E2E 自动化

Wework 提供独立的 Playwright E2E 入口和测试专用前端自动化接口，用于在 CI 中稳定操作 Wework 的 Vite/React 前端。默认入口运行在浏览器模式，适合覆盖大多数前端交互；需要验证原生窗口能力时，再单独接入 Tauri/WebDriver 测试。

## 运行方式

首次运行需要安装 Playwright 浏览器：

```bash
pnpm --filter wework exec playwright install chromium
```

运行 Wework E2E：

```bash
pnpm --filter wework e2e
```

该命令会通过 `wework/playwright.config.ts` 启动测试专用 Vite 服务：

```bash
pnpm exec vite --host 127.0.0.1 --port 4174 --mode e2e
```

同时会启动 Responses API mock：

```bash
node e2e/utils/mock-response-api-server.mjs
```

配置默认设置：

- `VITE_WEWORK_E2E=true`
- `VITE_WEWORK_RUNTIME_MODE=backend`
- `VITE_LOGIN_MODE=password`
- `WEWORK_RESPONSE_API_MOCK_URL`: `http://127.0.0.1:9998`

测试不 mock 后端 API。没有启动 Backend 时，登录页 smoke 测试只验证前端能渲染登录入口；需要登录后的业务流程时，CI 必须先启动真实 Backend 和依赖服务。

## Responses API Mock

`wework/e2e/utils/mock-response-api-server.mjs` 提供真实 HTTP 服务，用于模拟 OpenAI Responses API：

- `POST /v1/responses`：返回非流式 Responses API JSON。
- `POST /v1/responses` 且 `stream: true`：返回 `text/event-stream`，事件包含 `response.created`、`response.output_text.delta` 和 `response.completed`。
- `GET /captured-requests`：读取已捕获请求。
- `POST /clear-requests`：清空捕获请求。
- `GET /health`：CI health check。

该 mock 开启 CORS，因此 Wework 页面可以直接从浏览器环境发起真实 `fetch`。测试模型配置时，base URL 使用：

```text
http://127.0.0.1:9998/v1
```

## 自动化接口

测试模式下，Wework 会在 `window.__WEWORK_E2E__` 暴露前端控制接口。该接口只在 `import.meta.env.MODE === "e2e"` 或 `VITE_WEWORK_E2E=true` 时安装，普通开发和生产运行不会默认启用。

可用方法：

- `isTauri()`：返回当前是否运行在 Tauri 环境。
- `getRuntimeConfig()`：读取当前运行配置。
- `getRoute()`：返回去掉 app base path 后的当前路由。
- `navigate(path)`：通过前端 history 切换路由，并派发导航事件。
- `waitForTestId(testId, options)`：等待指定 `data-testid` 出现。
- `queryTestIds(prefix)`：列出当前页面中的 `data-testid`，可按前缀过滤。
- `setAuthToken(token)`：写入真实认证 token。
- `clearAuthToken()`：清除认证 token。
- `clearStorage()`：清空本地认证和浏览器存储。

## 测试封装

`wework/e2e/fixtures/wework-app.ts` 提供 `WeworkApp` Playwright helper，用于把 `window.__WEWORK_E2E__` 封装成类型安全的测试操作：

```ts
const app = new WeworkApp(page)

await app.goto("/")
await app.waitForTestId("login-form")
await app.navigate("/apps")
const route = await app.route()
```

新增 E2E 用例应优先使用该 helper 和 `data-testid` 定位，不要依赖易变的 CSS 选择器或可见文案。

## CI 建议

CI 可以把 Wework E2E 作为独立 job：

```bash
pnpm install --frozen-lockfile
pnpm --filter wework exec playwright install chromium
pnpm --filter wework e2e
```

仓库内的基础 workflow 是 `.github/workflows/wework-e2e.yml`，会在 Wework、`packages/chat-core`、pnpm lockfile 或 workflow 自身变化时运行。

登录后流程应在测试前通过后端 API 创建测试用户和测试数据，再使用真实登录或真实 token 注入。不要在 Playwright 中 mock 后端 HTTP 响应。
