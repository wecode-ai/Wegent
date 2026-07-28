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

在 macOS 上运行桌面内存回归，包括流式输出增长和 10 个并发任务的整机内存检查：

```bash
pnpm --filter wework e2e:desktop:memory
```

仅验证助手已有流式文本时，其下方持续显示“正在思考”，并在响应完成后消失：

```bash
pnpm --filter wework e2e:desktop:streaming-text
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
8. 创建两轮短对话，切换到新对话后重新打开原对话，校验 2 条用户消息、2 条助手消息和 4 个统一虚拟行仍完整挂载，并确认首条消息靠近消息视口顶部，防止缓存恢复时丢失消息或留下大块顶部空白。
9. 如果设置了 `WEWORK_E2E_DESKTOP_SCENARIO_MODULE`，动态加载产品场景；公共 runner 只提供 HTTP、WebSocket、控制和诊断生命周期，不包含具体产品协议或断言。

测试不模拟 Wework、Executor 或 Codex。为了让回归结果确定且不需要真实 provider 账号，测试只在 loopback 地址启动模型服务，分别实现 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages。每种接口都会执行文本回复以及“发送 → `apply_patch` → 工具结果回传 → 完成回复”，工具调用仍由真实 Codex 在隔离工作区内执行。

模型协议矩阵按“执行位置 × 模型来源 × 协议”定义 18 个组合：

- 本机执行覆盖本机自定义模型、Codex 内置模型和云端 Model CRD，每种模型来源分别覆盖三种协议，共 9 个完整文本与工具链路。
- 云端执行覆盖 Codex 内置模型和云端 Model CRD 的三种协议，共 6 个完整文本与工具链路。
- 本机自定义模型不能用于云端执行；对应三种协议的 3 个组合断言模型不会出现在云端项目的选择器中。

矩阵提交等待上限为 10 秒。如果编辑器已经显示提交错误，runner 会立即抛出该错误；否则在协议阶段未按时推进时输出当前阶段和已捕获请求，避免失败后长时间无反馈。

`e2e:desktop:streaming-text` 通过场景模块运行独立的流式消息状态回归。它使用真实 Tauri WebView、Executor 和 Codex app-server，通过 loopback Responses SSE 保持部分回复处于运行状态。场景先验证“正在思考”位于可见回复下方，再在长回复持续追加时向上滚动，记录一个可见文本锚点，断言后续流式增量不会改变该锚点的视口位置；释放响应后还会验证“正在思考”消失。该场景会保存就绪、流式和完成阶段的截图；场景专用 Codex 配置会关闭插件扩展，以隔离验证消息直出链路。

主桌面流程的短对话布局回归会保存 `short-conversation-00-ready.png`、`short-conversation-01-prompt-filled.png`、`short-conversation-02-completed-top-aligned.png` 和 `short-conversation-layout-metrics.json`。最后一个截图和 metrics 均在切走并重新打开对话后生成；门禁要求首条消息距离消息视口顶部不超过 `160px`。本地排查该回归时可直接运行 `node wework/e2e/desktop/task-flow.e2e.mjs --short-conversation-only`，但该检查同时属于常规 `e2e:desktop` 主流程，不是独立 CI 入口。

主桌面 runner 也支持按有序 checkpoint 分段执行。当前 checkpoint 依次为
`core-task-flow`、`window-lifecycle`、`goal-lifecycle`、`resilience`、
`conversation-state`、`workspace-attachments` 和 `rendering-extensions`。
`--segment <checkpoint>` 在公共启动和项目初始化后只运行指定 checkpoint；
`--from-segment <checkpoint>` 从指定 checkpoint 开始并继续执行所有后续
checkpoint。跳过上游时，每个 checkpoint 会自行建立最小前置 fixture，不依赖只有
完整流程才创建的任务或 UI 状态。分段命令用于本地快速迭代，推送前仍需运行完整
`pnpm --filter wework e2e:desktop`：

```bash
pnpm --filter wework e2e:desktop -- --segment window-lifecycle
pnpm --filter wework e2e:desktop -- --from-segment window-lifecycle
pnpm --filter wework e2e:desktop -- --segment workspace-attachments
```

桌面 runner 的普通 UI 步骤默认在 10 秒后超时，避免单个失败步骤统一等待
120 秒。控制命令和等待 helper 都可以通过 `timeoutMs` 为确实较慢的特殊步骤设置
独立上限；启动、工作台恢复和模型协议矩阵等场景使用各自的专用超时。临时排查慢速
环境时，可通过 `WEWORK_E2E_STEP_TIMEOUT_MS` 调整普通步骤的全局默认值。

主桌面流程还覆盖从 Finder 粘贴或拖入普通文件和文件夹：输入框必须显示文件与文件夹路径标签，不得创建附件徽标；发送给 Codex 的请求必须包含对应绝对路径，且不得内联文件内容。顶部快捷发送窗口复用相同规则，只读取图片附件的字节。相关场景均使用普通小文件，本地聚焦排查可分别运行 `node wework/e2e/desktop/task-flow.e2e.mjs --pasted-workspace-paths-only` 和 `node wework/e2e/desktop/task-flow.e2e.mjs --dropped-workspace-paths-only`。

mock 会按 cc-switch 的转换边界严格校验模型侧收到的请求，包括鉴权、模型 ID、stream 参数、消息历史、tool choice、shell 工具，以及 `apply_patch` 的 Lark grammar 或 function wrapper。任何字段错误都会返回非 2xx 并使测试失败。桌面测试同时保存三种接口的追问截图和完整 `model-requests.json`；GitHub Actions 无论成功或失败都会上传桌面诊断产物。

运行环境需要 Rust、Tauri 构建依赖和真实 Codex 二进制。默认从 `PATH` 查找 `codex`；也可以显式指定已安装或由 `prepare:codex` 准备的真实二进制：

```bash
CODEX_BIN=/absolute/path/to/codex pnpm --filter wework e2e:desktop
```

可选的 `WEWORK_E2E_EXECUTOR_BIN` 和 `WEWORK_E2E_APP_BIN` 分别允许复用已经构建的真实 Executor 和真实 Tauri 应用。传入的应用必须使用桌面 E2E 的 Vite 环境变量构建。各生命周期场景复用一次应用启动以控制 CI 时长；测试过程、捕获的模型请求和失败诊断会保存在 `wework/test-results/desktop-e2e/`。

在 macOS 上，桌面 E2E 会通过临时 `.app` bundle 和 `open -g` 在后台启动。测试专用的 `WEWORK_E2E_BACKGROUND_WINDOW=1` 会让 Tauri 保持主窗口隐藏、禁止应用激活并隐藏 Dock 图标；隐藏 WebView 会关闭后台节流，因此 DOM 控制、计时器和截图仍正常工作。runner 在连接控制器后还会断言测试应用不是当前前台进程，防止窗口抢焦点行为回归。该环境变量只由桌面 E2E runner 注入，不改变正常开发或生产启动行为。

云端项目场景会启动真实 Backend、Redis 和一个注册为远端设备的真实 Executor，通过真实鉴权、设备 RPC、任务持久化和项目删除接口完成创建项目、执行任务、恢复会话、连续追问与删除项目验证。场景同时验证云端 Model CRD 经 backend 代理转发三种模型协议，以及同一云端账号下的 Codex/云端模型在本机 executor 中执行。测试只模拟 provider 模型端点；不得模拟 Backend HTTP 或 WebSocket 接口。清理项目之前必须等待任务的运行状态结束；助手文本已经渲染并不代表任务状态已经完成持久化。运行该场景需要 Python 3.11、`uv` 和 `redis-server`。

云端场景在验证连接账号下的本机执行模型之前，会通过当前“项目 → 本地项目”入口选择隔离目录，并在本地项目创建对话框中确认名称。桌面 E2E 应复用这个产品主流程，不得继续依赖已经移除的“已有项目”测试入口。

GitHub Actions 的 Executor E2E job 会在恢复 Python、Node.js 和 Playwright 缓存后加载预构建 Docker 镜像。该 job 必须先删除不使用的 hosted-runner SDK（.NET、Android、GHC 和 CodeQL）并记录磁盘用量，为镜像解压保留稳定空间；清理逻辑不得删除正在运行的 MySQL 或 Redis service 镜像。

插件场景会在测试结果目录动态创建隔离的本地 Codex marketplace 和带 Skill 的插件，然后通过真实 Tauri WebView、Executor 与 Codex app-server 验证市场展示、安装、在对话编辑器中插入插件引用及卸载。场景不访问个人 Codex home，也不 mock 插件 API；市场、插件缓存和安装状态都随测试结果目录清理。四个关键阶段会保留截图，失败时同时保留应用、Executor 和 UI 快照诊断。

内存场景仅支持 macOS。它会通过真实 Codex 工具调用执行一个开发任务，再向真实 Tauri WebView 流式发送包含 Markdown、表格和 TypeScript 代码的长回复。测试先等待 Web Content 内存基线稳定，再每 500 毫秒采集 Wework 关联的全部 WebKit Web Content 进程的聚合 physical footprint，并将采样、DOM 节点数和汇总指标写入 `memory-growth.json`；门禁不包含 Wework 主进程。默认门禁为峰值增长不超过 384 MiB、完成后的稳定态增长不超过 224 MiB、稳定窗口内最大波动范围不超过 16 MiB。DOM 门禁检查虚拟列表收敛后的稳定窗口，默认不得保留超过 900 个节点；流式渲染期间的瞬时峰值仍会记录在诊断中，但不会把收敛前的短暂渲染误判为泄漏。各阈值可分别通过 `WEWORK_E2E_MEMORY_MAX_PEAK_GROWTH_KIB`、`WEWORK_E2E_MEMORY_MAX_SETTLED_GROWTH_KIB` 和 `WEWORK_E2E_MEMORY_MAX_SETTLED_DOM_NODES` 调整。

并发内存场景同样仅支持 macOS。它会创建并同时保持 10 个 Responses 流，采集 Wework 主进程、WebKit Web Content/GPU/Networking、Executor 和 Codex app-server 的进程组 physical footprint，并将证据写入 `concurrent-memory.json`。门禁要求整个进程组峰值低于 800 MiB，可通过 `WEWORK_E2E_CONCURRENT_MEMORY_MAX_PHYSICAL_FOOTPRINT_KIB` 调整；场景还会在首尾任务之间切换，并等待各自的 prompt 内容重新出现。

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

隔离真实 Tauri 验证可通过 `ai:verify paste-paths` 或 `ai:verify drop-paths` 向输入框派发文件路径粘贴或拖放事件。`--value` 接收 JSON 数组，每项包含 `uri`、`name`，文件夹项还需设置 `isDirectory: true`：

```bash
pnpm --filter wework ai:verify paste-paths \
  --session /absolute/path/to/session.json \
  --selector '[data-testid="chat-message-input"]' \
  --value '[{"uri":"file:///tmp/context","name":"context","isDirectory":true}]'
```

把上例的 `paste-paths` 替换为 `drop-paths`，即可验证 Finder 拖放路径。

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

GitHub Actions 将 plugins、core 和 cloud 三个 Linux 桌面场景作为矩阵并行运行。
每个场景使用独立 runner、HOME、Executor Home、端口和诊断 artifact，保留原有
真实 Tauri、Executor 与 Codex 验证语义，同时避免三个场景在同一个 job 中串行等待。
矩阵关闭 fail-fast，使一个场景失败时其他场景仍能完成并上传各自诊断。

内存门禁依赖 macOS 的 WebKit 进程关联和 physical footprint 采样，必须在 macOS runner 上单独运行：

```bash
pnpm --filter wework prepare:codex
pnpm --filter wework e2e:desktop:memory
```

仓库内的基础 workflow 是 `.github/workflows/wework-e2e.yml`，会在 Wework、`packages/chat-core`、pnpm lockfile 或 workflow 自身变化时运行。
普通 Draft PR 不运行浏览器或 Linux 桌面 E2E。macOS 内存门禁默认只在 `main`、
定时任务和手动任务中运行；需要在 PR 中验证内存边界时，添加 `ci:memory` 标签。
添加该标签只触发内存门禁，不会重复运行浏览器或 Linux 桌面 E2E。workflow 每天
UTC 04:00 运行一次完整回归。添加 `ci:all` 标签则会运行浏览器、Linux 桌面和
macOS 内存 E2E，即使 PR 的改动路径通常不会触发 Wework E2E。

登录后流程应在测试前通过后端 API 创建测试用户和测试数据，再使用真实登录或真实 token 注入。不要在 Playwright 中 mock 后端 HTTP 响应。
