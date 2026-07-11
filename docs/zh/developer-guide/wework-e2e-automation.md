---
sidebar_position: 34
---

# E2E 自动化

Wework 提供独立的 Playwright E2E 入口和测试专用前端自动化接口，用于在 CI 中稳定操作 Wework 的 Vite/React 前端。默认入口运行在浏览器模式，适合覆盖大多数前端交互；原生窗口与任务执行链路由下文的桌面端全链路 E2E 覆盖。

## 运行方式

首次运行需要安装 Playwright 浏览器：

```bash
pnpm --filter wework exec playwright install chromium
```

运行 Wework E2E：

```bash
pnpm --filter wework e2e
```

运行真实桌面端任务全链路 E2E：

```bash
pnpm --filter wework e2e:desktop
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

## 桌面端任务全链路 E2E

`wework/e2e/desktop/task-flow.e2e.mjs` 覆盖本机工作区中的真实任务生命周期：

1. 构建并启动真实 Tauri Wework 应用，使用 `--open-workspace` 打开隔离工作区。
2. 启动真实 `wegent-executor` sidecar，并由它启动真实 `codex app-server`。
3. 在原生 WebView 中填入任务、点击发送，并等待真实会话渲染完成。
4. 校验 Codex 向模型服务发出的请求、Codex 实际工具调用写入的工作区文件，以及页面中的最终回复。
5. 在同一会话中发送连续追问，并校验对应请求和页面回复。
6. 启动流式回复后通过桌面端 UI 取消，校验任务已停止、停止提示已渲染且输入框重新可用。
7. 让模型首次请求确定性失败，点击错误卡中的重试，并校验重试请求和最终回复。

测试不模拟 Wework、Executor 或 Codex。为了让回归结果确定且不需要真实账号，测试只在 loopback 地址启动一个 OpenAI Responses 兼容服务，作为 Codex 的自定义模型 provider。该服务会返回确定性的工具调用和最终文本；工具调用仍由真实 Codex 在隔离工作区内执行。

运行环境需要 Rust、Tauri 构建依赖和真实 Codex 二进制。默认从 `PATH` 查找 `codex`；也可以显式指定已安装或由 `prepare:codex` 准备的真实二进制：

```bash
CODEX_BIN=/absolute/path/to/codex pnpm --filter wework e2e:desktop
```

可选的 `WEWORK_E2E_EXECUTOR_BIN` 和 `WEWORK_E2E_APP_BIN` 分别允许复用已经构建的真实 Executor 和真实 Tauri 应用。传入的应用必须使用桌面 E2E 的 Vite 环境变量构建。各生命周期场景复用一次应用启动以控制 CI 时长；测试过程、捕获的模型请求和失败诊断会保存在 `wework/test-results/desktop-e2e/`。

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

桌面端 E2E 构建会额外注入 `VITE_WEWORK_DESKTOP_E2E_CONTROL_URL`。只有在 E2E 模式且该 URL 存在时，前端才会轮询本机 loopback 控制器来执行 `click`、`fill` 和等待断言；常规开发和生产构建不会包含控制端点。控制器只驱动真实 WebView DOM 事件，不替换任务、模型选择、Executor 或 Codex 的实现。

控制器使用短轮询：没有待执行指令时服务端返回 `204`，前端短暂等待后再次请求。这避免了 WebView 刷新、任务切换或流结束时遗留的长轮询连接吞掉后续指令。对 Lexical 编辑器执行 `fill` 时，控制器会使用编辑器暴露的 `value` setter，以便真实提交 React/Lexical 状态；不要用原始 DOM 插入来替代它。失败诊断中的 `scenario-state.json` 会记录已投递的 `commandHistory`，用于定位控制通道问题。

同一会话在模型切换后可能触发 Codex 的内部上下文压缩请求。桌面端任务流 E2E 的 loopback Responses 服务会通过 `client_metadata.x-codex-turn-metadata.request_kind === "compaction"` 识别并响应这类请求，使它不被误判为用户发送的后续消息。

## 测试封装

`wework/e2e/fixtures/wework-app.ts` 提供 `WeworkApp` Playwright helper，用于把 `window.__WEWORK_E2E__` 封装成类型安全的测试操作：

```ts
const app = new WeworkApp(page);

await app.goto("/");
await app.waitForTestId("login-form");
await app.navigate("/apps");
const route = await app.route();
```

新增 E2E 用例应优先使用该 helper 和 `data-testid` 定位，不要依赖易变的 CSS 选择器或可见文案。

## CI 建议

CI 可以把 Wework E2E 作为独立 job：

```bash
pnpm install --frozen-lockfile
pnpm --filter wework exec playwright install chromium
pnpm --filter wework e2e
```

桌面端全链路 E2E 需要在有图形会话的 Linux runner 上运行，例如：

```bash
pnpm --filter wework prepare:codex
xvfb-run -a pnpm --filter wework e2e:desktop
```

仓库内的基础 workflow 是 `.github/workflows/wework-e2e.yml`，会在 Wework、`packages/chat-core`、pnpm lockfile 或 workflow 自身变化时运行。

登录后流程应在测试前通过后端 API 创建测试用户和测试数据，再使用真实登录或真实 token 注入。不要在 Playwright 中 mock 后端 HTTP 响应。
