---
sidebar_position: 39
---

# AI 自验证会话

Wework 支持启动隔离的开发验证会话，让 AI 在真实 Electron 应用中完成 UI 操作和断言。该机制复用桌面端 E2E 的 WebView 控制通道，不会操作外部 Chrome，也不会连接开发者日常使用的 Wework 窗口。

## 插件周期恢复 E2E

`plugin-periodic-reconcile` checkpoint 使用真实 Electron、Executor、Socket.IO、数据库和插件包存储，丢弃一次真实插件变更通知后，验证定时对账恢复状态、持久化 ACK、设备身份以及未受影响插件的内容。测试实例设置 `LOCAL_PLUGIN_RECONCILE_INTERVAL=90`、`LOCAL_PLUGIN_RECONCILE_JITTER=18`（单位为秒），并用已有的 `LOCAL_HEARTBEAT_INTERVAL=1` 保留至少 10 次心跳的活性断言。90 秒基础周期为注册后的插件准备流程保留时间，避免准备阶段消耗首个对账周期。

未设置配置时，生产对账周期仍为 600 秒加 0～119 秒的稳定 Runtime 偏移，心跳仍为 30 秒。无效或非正整数配置使用默认值；测试没有手动触发对账或替换真实计时器。

```bash
pnpm --filter wework e2e:desktop:cloud -- --segment plugin-periodic-reconcile
```

## 启动会话

构建时的 `prepare-codex-binary.mjs` 使用 Node 原生 HTTP/HTTPS 流下载锁定版本，处理重定向并删除失败的临时文件；归档通过完整性校验后才解包使用。下载流不依赖 Node 内置 Fetch 的 Undici 解析器，避免其异常终止构建进程。

```bash
pnpm --filter wework ai:verify start
```

命令会输出 session 文件路径和本地控制地址。它会创建独立的 Executor Home、项目目录、设备 ID、IPC socket、Electron app-data namespace 和诊断目录，并启动真实的 `dev-mac-app.sh`。任务、项目、应用数据和单实例锁不会与正式版或其他验证会话共享。所有日志位于 `wework/test-results/ai-verify/<run-id>/`。

## 共享桌面 E2E 运行时镜像

完整源码的浅克隆不设置 `filter: blob:none`：工作目录需要全部 blob，过滤会把下载推迟到 checkout 的第二次 promisor 请求。仅变更分类任务保留完整提交历史及 blob 过滤，避免拉取历史文件内容。共享运行时合约测试检查浅克隆任务不引入这种额外请求。

独立 MinIO 的 API 端口由共享分配器分配，并排除固定版本的控制台默认端口 `13333`。该版本即使设置 `MINIO_BROWSER=off` 仍会检查端口相等并退出，详见固定源码的 [默认值](https://github.com/minio/minio/blob/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/cmd/globals.go#L215)及[启动检查](https://github.com/minio/minio/blob/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/cmd/common-main.go#L502)。端口回归直接从 `13333` 开始分配，验证排除后的端口可真实绑定；不靠重启 MinIO 掩盖冲突。

非草稿 PR 只触发 Wework 桌面 E2E 时，也必须启动 `e2e-tests.yml` 中的 Backend Rust 运行时生产任务，不能只以平台 E2E 是否运行作为条件。生产任务先检查内容寻址镜像是否存在，缓存命中时复用既有镜像；缓存未命中时构建并发布，供桌面构建消费。`ruby .github/scripts/test-backend-rs-e2e-runtime.rb` 覆盖平台、桌面和草稿 PR 的生产条件。

Linux 桌面 E2E 构建和缓存预热使用 `e2e-tests.yml` 生产的 Rust Backend OCI 镜像。消费者必须与生产方的 `SOURCE_DIGEST` 表达式保持一致，包括示例程序源码；只哈希主程序会生成无人发布的镜像标签，最终以 `manifest unknown` 超时失败。修改运行时镜像输入时，运行 `bash .github/scripts/test-wework-core-e2e-runtimes.sh`，检查桌面验证和缓存预热两个消费者与生产方的摘要契约。

## 操作与断言

Linux 隔离桌面使用 `Xvfb -noreset`，使显示服务在整个 checkpoint 内持续可连接。默认的“最后一个客户端断开即 reset”会在短连接 `xprop` 探测与 Openbox 连接之间关闭监听，详见 [Debian 的生命周期分析](https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=1095028#43)。Xvfb 错误通过 `/dev/stderr` 进入 runner 日志；不通过重启窗口管理器或延长等待隐藏启动失败。

后续命令都传入启动命令返回的 session 路径。优先使用稳定的 `data-testid` 选择器。

创建 Issue 后，API 列表中已存在该记录不代表详情界面已完成渲染。共享的 `createAndAssignCloudIssue` 流程使用 `clickWhenEnabled` 等待详情负责人控件出现并启用后再点击，沿用默认步骤时限；不能用 API 落库状态代替控件就绪，也不能用延时或重跑掩盖竞争。

```bash
pnpm --filter wework ai:verify snapshot --session /path/to/session.json
pnpm --filter wework ai:verify fill --session /path/to/session.json \
  --selector '[data-testid="chat-message-input"]' --value '验证内容'
pnpm --filter wework ai:verify click --session /path/to/session.json \
  --selector '[data-testid="send-message-button"]'
pnpm --filter wework ai:verify wait-for --session /path/to/session.json \
  --selector '[data-testid="message-assistant"]' --text '完成'
pnpm --filter wework ai:verify stop --session /path/to/session.json
```

可用操作包括 `snapshot`、`text`、`click`、`fill`、`press`、`wait-for`、`status` 和 `stop`。命令返回结构化 JSON；WebView 不可用、元素不存在或断言超时时，命令以非零状态退出。

## 安全边界

控制器只监听 `127.0.0.1`，并为每个会话生成一次性 Bearer token。该通道只有在 `ai:verify start` 启动的开发实例中通过 Vite 环境变量启用；普通开发与生产构建不会暴露控制接口。session 文件包含 token，应视为短期本地凭据，不应提交或共享。

## 控制协议

WebView 启动后先调用 `/ready`，随后用短轮询请求 `/commands`。控制器在队列为空时立即返回 `204`；WebView 通过 `/control-tick` 做短暂节流，再发起下一次轮询。收到命令后，WebView 依次调用 `/started` 和 `/results`，分别确认命令已开始执行并提交最终结果。

`ai:verify` 和桌面端 E2E 共用这套协议，修改任一端时必须保持端点和轮询语义一致。不要把 `/commands` 改成长轮询：这会与 WebView 的控制循环冲突，使后续命令留在队列中并表现为连续超时。控制器还必须在命令超时后将其从队列移除，避免过期命令在下一次轮询中被执行。

## 原生应用菜单刷新

“查看 → 刷新”重新加载当前 Wework 窗口，快捷键为 macOS 的 `⌘R` 或 Windows/Linux 的 `Ctrl+R`。该菜单项在任务和设置页面均可用，直接调用当前窗口的 `webContents.reload()`。

`application-menu` 桌面 CI 检查点覆盖菜单项存在、设置页可见，以及刷新后控制通道重新连接、页面恢复和工作区导航可用。定向单测覆盖三种平台的快捷键、窗口重载及中英文标签。

测试控制命令 `refreshFromApplicationMenu` 先等待 `/results` 确认，再激活真实的原生菜单项，避免 renderer 卸载时丢失命令回执。控制协议单测通过延迟回执验证该顺序。

设置页保留后台的当前工作区标签。“工作 → 任务 / 项目空间”在设置页应重新选择目标标签并恢复其内容路由，即使该标签已经是当前标签；在正常工作区中则继续避免重复选择。

设置路由不写入工作区标签的类型或内容路由。在设置页重新加载时，标签管理器初始化正常工作区标签，设置页继续由应用路由显示，避免返回工作区时再次打开设置。

读取持久化标签时，校验会排除指向设置页的无效条目，并保留其他合法工作区标签。

## 原生右键菜单

Electron 不会为 WebContents 自动创建网页右键菜单。Wework 由 Electron 主进程统一监听 `context-menu`，并为主窗口、工作区窗口和辅助窗口构建原生菜单。

- 图片菜单保留复制图片、打开图片和本机文件操作。
- 可编辑区域必须读取 `params.isEditable` 和 `params.editFlags`，使用 Electron 的 `undo`、`redo`、`cut`、`copy`、`paste`、`delete`、`selectAll` 原生 role，并把 `params.frame` 传给 `menu.popup`。
- 非编辑区域的选中文本使用原生 `copy` role；没有可执行操作时不弹出空菜单，以免干扰 React 组件自己的业务右键菜单。

修改该链路时，先运行 `wework/electron/src/host/image-context-menu.test.ts`，再在隔离 Electron 会话的真实输入框中验证菜单弹出、菜单项可用状态和粘贴行为。WebView 的 DOM 快照不会包含 macOS 原生 `NSMenu`，不能用合成的 `contextmenu` 事件或仅浏览器截图代替真实桌面验证。

## 固定标签窗口恢复

固定标签分配到独立窗口后，Electron 会从本机偏好设置恢复其窗口标识和内容路由。恢复地址必须通过共享的 `resolveDshAppRoute` 添加 `/wework/app/` 前缀，并保留任务或项目查询参数、`workspaceTab`、`workspaceTabTitle` 和片段。直接加载未加前缀的内容路由会绕过 Wework 应用的深链接入口，导致恢复窗口无法正常显示。

桌面 CI 的 `workspace-tabs` 检查点覆盖固定标签拆出及应用重启，断言恢复窗口的路由、标签身份、固定状态，以及编辑区可见且能继续输入。针对性验证使用 `pnpm --filter wework e2e:desktop --segment workspace-tabs`。

## AI 验证流程

AI 应先执行 `snapshot` 确认路由和可用的 `data-testid`，再进行最小必要操作，并以 `wait-for` 加 `snapshot` 或 `text` 验证结果。结束时必须执行 `stop`；若失败，保留该会话目录中的 `app.log` 以便诊断。
