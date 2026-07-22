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

仅运行云端项目桌面 E2E：

```bash
pnpm --filter wework e2e:desktop:cloud
```

仅运行插件市场、安装、对话使用和卸载链路：

```bash
pnpm --filter wework e2e:desktop:plugins
```

该命令会通过 `wework/playwright.config.ts` 启动测试专用 Vite 服务：

```bash
pnpm exec vite --host 127.0.0.1 --port 4174 --mode e2e
```

同时会启动 Responses API、Sites upstream 和 Connector upstream mock：

```bash
node e2e/utils/mock-response-api-server.mjs
node e2e/utils/mock-sites-upstream-server.mjs
node e2e/utils/mock-connector-upstream-server.mjs
```

配置默认设置：

- `VITE_WEWORK_E2E=true`
- `VITE_WEWORK_RUNTIME_MODE=backend`
- `VITE_LOGIN_MODE=password`
- `WEWORK_RESPONSE_API_MOCK_URL`: `http://127.0.0.1:9998`
- `WEWORK_SITES_UPSTREAM_MOCK_URL`: `http://127.0.0.1:9997`
- `WEWORK_CONNECTOR_UPSTREAM_MOCK_URL`: `http://127.0.0.1:9996`

三个 mock 的端口都可以通过同名 `*_PORT` 环境变量覆盖：`WEWORK_RESPONSE_API_MOCK_PORT`、`WEWORK_SITES_UPSTREAM_MOCK_PORT` 和 `WEWORK_CONNECTOR_UPSTREAM_MOCK_PORT`。如果覆盖端口，也可以直接传入完整 URL 环境变量给测试进程。

测试不 mock 后端 API。没有启动 Backend 时，登录页 smoke 测试只验证前端能渲染登录入口；需要登录后的业务流程时，CI 必须先启动真实 Backend 和依赖服务。

## 桌面端任务全链路 E2E

`wework/e2e/desktop/task-flow.e2e.mjs` 覆盖本机工作区中的真实任务生命周期，并允许产品发行版注入可选桌面场景：

1. 构建并启动真实 Tauri Wework 应用，使用 `--open-workspace` 打开隔离工作区。
2. 启动真实 `wegent-executor` sidecar，并由它启动真实 `codex app-server`。
3. 在原生 WebView 中填入任务、点击发送，并等待真实会话渲染完成。
4. 校验 Codex 向模型服务发出的请求、Codex 实际工具调用写入的工作区文件，以及页面中的最终回复。
5. 在同一会话中发送连续追问，并校验对应请求和页面回复。
6. 启动流式回复后通过桌面端 UI 取消，校验任务已停止、停止提示已渲染，并在发送后续消息时恢复输入。
7. 让模型首次请求确定性失败，点击错误卡中的重试，并校验重试请求和最终回复。
8. 如果设置了 `WEWORK_E2E_DESKTOP_SCENARIO_MODULE`，动态加载产品场景；公共 runner 只提供 HTTP、WebSocket、控制和诊断生命周期，不包含具体产品协议或断言。

测试不模拟 Wework、Executor 或 Codex。为了让回归结果确定且不需要真实账号，测试只在 loopback 地址启动模型服务，分别实现 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages。每种接口都会执行“发送 → `apply_patch` → 工具结果回传 → 追问”，工具调用仍由真实 Codex 在隔离工作区内执行。

mock 会按 cc-switch 的转换边界严格校验模型侧收到的请求，包括鉴权、模型 ID、stream 参数、消息历史、tool choice、shell 工具，以及 `apply_patch` 的 Lark grammar 或 function wrapper。任何字段错误都会返回非 2xx 并使测试失败。桌面测试同时保存三种接口的追问截图和完整 `model-requests.json`；GitHub Actions 无论成功或失败都会上传桌面诊断产物。

运行环境需要 Rust、Tauri 构建依赖和真实 Codex 二进制。默认从 `PATH` 查找 `codex`；也可以显式指定已安装或由 `prepare:codex` 准备的真实二进制：

```bash
CODEX_BIN=/absolute/path/to/codex pnpm --filter wework e2e:desktop
```

可选的 `WEWORK_E2E_EXECUTOR_BIN` 和 `WEWORK_E2E_APP_BIN` 分别允许复用已经构建的真实 Executor 和真实 Tauri 应用。传入的应用必须使用桌面 E2E 的 Vite 环境变量构建。各生命周期场景复用一次应用启动以控制 CI 时长；测试过程、捕获的模型请求和失败诊断会保存在 `wework/test-results/desktop-e2e/`。

云端项目场景会启动真实 Backend、Redis 和一个注册为远端设备的真实 Executor，通过真实鉴权、设备 RPC、任务持久化和项目删除接口完成创建项目、执行任务、恢复会话、连续追问与删除项目验证。测试只模拟 Codex 使用的模型 Responses API；不得模拟 Backend HTTP 或 WebSocket 接口。运行该场景需要 Python 3.11、`uv` 和 `redis-server`。

插件场景会在测试结果目录动态创建隔离的本地 Codex marketplace 和带 Skill 的插件，然后通过真实 Tauri WebView、Executor 与 Codex app-server 验证市场展示、安装、在对话编辑器中插入插件引用及卸载。场景不访问个人 Codex home，也不 mock 插件 API；市场、插件缓存和安装状态都随测试结果目录清理。四个关键阶段会保留截图，失败时同时保留应用、Executor 和 UI 快照诊断。

## Responses API Mock

`wework/e2e/utils/mock-response-api-server.mjs` 提供真实 HTTP 服务，用于验证本地模型能力探针请求：

- `POST /v1/responses`：返回非流式 Responses API JSON。
- `POST /v1/responses` 且 `stream: true`：返回 `text/event-stream`，事件包含 `response.created`、`response.output_text.delta` 和 `response.completed`。
- `POST /v1/chat/completions`：校验并返回 Chat Completions function tool call。
- `POST /v1/messages`：校验并返回 Anthropic Messages `tool_use`。
- `GET /captured-requests`：读取已捕获请求。
- `POST /clear-requests`：清空捕获请求。
- `GET /health`：CI health check。

该 mock 开启 CORS，因此 Wework 页面可以直接从浏览器环境发起真实 `fetch`。测试模型配置时，base URL 使用：

```text
http://127.0.0.1:9998/v1
```

## 外部 Upstream Mock

Wework E2E 还会启动两个本机 loopback upstream mock。它们只替代 Wegent 之外的外部服务，不替代 Wegent Backend、Executor、Codex、`/api/sites`、`/api/apps/installed` 或 connector runtime API。

`wework/e2e/utils/mock-sites-upstream-server.mjs` 模拟 Sites project API：

- `GET /api/v1/projects/search`：返回确定性的项目列表，支持 `username`、`limit`、`sitename` 和 `cursor`。
- `POST /api/v1/projects/deploy/network`：更新项目内外网状态。
- `POST /api/v1/projects/update`：更新项目名称。
- `POST /api/v1/projects/del`：删除项目。
- `GET /captured-requests`、`POST /clear-requests`、`POST /reset`、`GET /health`：用于断言和重置。

需要通过真实 Backend 覆盖 Sites 链路时，让 Backend 使用下面的环境变量启动。注意这些变量必须传给 Backend 进程；传给 Vite 或 Playwright 页面不会配置 Backend。

```text
SITES_API_BASE_URL=http://127.0.0.1:9997
SITES_API_TOKEN=e2e-sites-token
```

示例：

```bash
cd backend
SITES_API_BASE_URL=http://127.0.0.1:9997 \
SITES_API_TOKEN=e2e-sites-token \
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

`wework/e2e/utils/mock-connector-upstream-server.mjs` 模拟 connector 可连接的外部服务：

- `GET /api/tickets/{id}`：作为 HTTP connector upstream。
- `POST /mcp`：提供最小 Streamable HTTP MCP JSON-RPC 行为，支持 `initialize`、`tools/list` 和 `tools/call`。
- `GET /captured-requests`、`POST /clear-requests`、`GET /health`：用于断言和重置。

配置 connector app 时可使用：

```text
HTTP connector base URL: http://127.0.0.1:9996/api
MCP URL: http://127.0.0.1:9996/mcp
```

HTTP connector fixture 可以使用：

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

MCP connector fixture 可以使用：

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

公共控制器在内置动作未处理命令时，通过 `@extensions/desktop-control` 委派给产品扩展。没有产品扩展时，未知动作会明确失败；公共自动化层不识别具体产品协议。

控制器使用短轮询：没有待执行指令时服务端返回 `204`，前端短暂等待后再次请求。这避免了 WebView 刷新、任务切换或流结束时遗留的长轮询连接吞掉后续指令。对 Lexical 编辑器执行 `fill` 时，控制器会使用编辑器暴露的 `value` setter，以便真实提交 React/Lexical 状态；不要用原始 DOM 插入来替代它。失败诊断中的 `scenario-state.json` 会记录已投递的 `commandHistory`，用于定位控制通道问题。

桌面控制器的 `capture` 指令在 macOS 上通过 Tauri 调用 WebKit 原生 `WKWebView` snapshot，而不是在页面内复制 DOM。原生层仅在 `VITE_WEWORK_E2E=true` 时开放该命令，并在 10 秒后超时；截取 `body` 时直接返回完整 PNG，截取其他选择器时由前端按照元素边界裁剪原生快照。这样失败诊断可以覆盖字体、原生 WebView 渲染和真实页面状态，也不会依赖隐藏 iframe 的加载事件。

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
xvfb-run -a pnpm --filter wework e2e:desktop:plugins
xvfb-run -a pnpm --filter wework e2e:desktop
xvfb-run -a pnpm --filter wework e2e:desktop:cloud
```

仓库内的基础 workflow 是 `.github/workflows/wework-e2e.yml`，会在 Wework、`packages/chat-core`、pnpm lockfile 或 workflow 自身变化时运行。

登录后流程应在测试前通过后端 API 创建测试用户和测试数据，再使用真实登录或真实 token 注入。不要在 Playwright 中 mock 后端 HTTP 响应。
