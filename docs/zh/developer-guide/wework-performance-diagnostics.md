---
sidebar_position: 33
---

# 性能诊断

Wework 内置一个默认关闭的前端性能诊断开关，用于定位 release 包中“运行一段时间后变卡”的问题。诊断代码只在显式开启后运行；关闭时不会安装 React Profiler，也不会采集定时样本。

## 多实例调试

使用 `pnpm --filter wework dev:mac` 启动 debug 应用时，每个 Wework 进程都会使用独立的本地 executor runtime 目录和 IPC 地址文件。可以同时启动多个调试窗口，不同窗口不会连接到同一个 executor 实例。

开发环境默认让这些实例复用同一个 Cargo target 目录，以便 executor 源码变化后继续使用增量编译产物。需要排查共享构建缓存问题时，可以设置 `WEGENT_DISABLE_SHARED_CARGO_TARGET=1`，让当前启动过程使用项目内的默认 target 目录。

## 开启方式

在 Wework 窗口中按隐藏快捷键：

```text
macOS: Cmd + Option + Shift + P
Windows/Linux: Ctrl + Alt + Shift + P
```

快捷键会打开 **Developer Commands** 菜单。选择 **Enable Performance Diagnostics** 会写入 `localStorage` 中的 `wework:perf-debug` 标记并自动刷新应用；再次打开菜单选择 **Disable Performance Diagnostics** 会关闭诊断并刷新。

开发环境也可以通过 URL 参数临时切换：

```text
?weworkPerf=1  # 开启
?weworkPerf=0  # 关闭
```

也可以设置构建/运行环境变量 `VITE_WEWORK_PERF_DEBUG=1`，用于本地复现时默认开启。

## Debug 面板

Developer Commands 菜单中的 **Debug Panel** 用于排查 Wework 当前运行任务的问题。面板会展示：

- 当前活跃 runtime task 的地址、任务是否可识别、`running` 原始值、任务状态和 pane 派生运行状态。
- 当前 pane 的发送阶段、消息数量、队列、transcript 加载状态、subagent 状态和 goal 状态。
- Transcript 加载消息与当前流式输出消息的字段和预期 UI 样式对比。
- 最近的 `console.debug` 日志。

Debug 面板可以展开、收起、刷新、复制快照和清空日志。收起后只保留右下角状态条，避免遮挡主界面。

### Runtime 内存快照

Debug 面板的快照会附带当前 runtime pane 的轻量内存摘要，用于定位 WebView 或 executor 内存异常：

- 消息数量、角色分布、状态分布和正文长度汇总。
- processing block 数量、类型分布和工具输出长度汇总。
- 队列消息、guidance 消息、代码评论上下文和 transcript 范围状态。
- 当前 runtime task 在 work list 中的 `running` 原始值，以及由 pane 推导出的运行状态。

快照只记录摘要，不会把完整命令输出、原始 Codex 事件或完整 transcript 内容复制到 Debug 面板。需要排查原始内容时应查看 executor 日志或 Web Inspector 采样，而不是通过前端快照搬运大文本。

## Runtime transcript 与列表载荷

为降低前端和 executor 的内存压力，runtime task 列表、runtime handle 摘要和 transcript 响应只保留 UI 必需字段。命令输出、streaming delta、cached message、原始请求/响应等大块原始载荷不会放进 runtime work list 发送给前端。

前端显示对话时仍以 transcript/message action 生成的 `WorkbenchMessage` 为准；任务列表和状态轮询只用于状态、标题、运行态和 workspace 信息。排查“列表很慢”或“切换任务内存上涨”时，应优先确认是否又把原始消息或命令输出加入了 runtime list/handle/transcript 元数据路径。

## 本地 Codex 流式日志

本地 executor 的 Codex 调试日志默认保留 delta 详情，便于定位流式输出顺序、阶段识别和最终内容覆盖问题。默认会记录 Codex 原始 delta 与运行态分类摘要。

Developer Commands 菜单中的 **Enable Stream Logs** / **Disable Stream Logs** 会同时切换前端本地 chat stream 日志和 Codex executor stream 日志。优先使用这个菜单项做现场排查；它会让前端 `console.debug` 中的 stream 订阅/事件日志与 executor 的 Codex stream 详情保持同一个开关状态。

为避免 debug 包在长回复或高频 token 输出时产生过多日志，runtime work 内部的 cache/emit mapping 日志默认关闭。这类日志会为同一个 delta 额外记录缓存和 UI 事件分发路径，只有排查本地 runtime work 路由时才需要打开。

可用环境变量：

```text
WEGENT_CODEX_STREAM_DEBUG=0          # 关闭 Codex 原始 delta / 分类详情
WEGENT_CODEX_STREAM_DEBUG=1          # 开启 Codex 原始 delta / 分类详情（默认）
WEGENT_CODEX_STREAM_MAPPING_DEBUG=1  # 开启 runtime work cache/emit mapping 详情
```

## 流式消息渲染

Wework 将 executor 高频到达的文本增量与 Markdown 展示节奏分离。消息状态仍实时接收并保持完整内容，`AssistantMarkdown` 使用轻量缓冲器在浏览器帧上逐步推进可见文本：积压较多时自适应加速，接近队尾时保留少量字符并缓慢释放，以平滑 executor 批量发送和短暂空档造成的视觉顿挫。流结束、内容被替换或发生非追加更新时会立即对齐完整文本，不会影响最终消息正确性。

流式消息不执行 Pretext 全文高度测量，而是使用稳定的离屏占位高度；消息完成后再精确测量并缓存。已完成消息优先按消息对象和宽度命中高度缓存，避免每次流式更新都重新计算历史消息全文 hash。Composer、Workspace 操作栏、右侧工作区和底部终端也使用稳定属性与 memo 边界，避免随每个文本增量重复渲染。

排查流式卡顿时应区分以下情况：

- 帧率稳定但输出一阵快、一阵慢：检查 stream `message` 事件间隔，通常是 executor 增量批量到达或存在网络/IPC 空档。
- 存在长帧、密集样式重算或 Markdown 解析：检查是否绕过了文本缓冲、破坏了 Streamdown 组件引用稳定性，或重新引入了逐字符 DOM 动画。
- GC 时间异常高：确认 Web Inspector 是否开启 **Heap Allocations**。该采集项会显著放大长时间录制中的 GC；只排查交互流畅度时应关闭它。

流式文本缓冲的单元测试位于 `wework/src/components/chat/useBufferedStreamingText.test.ts`。修改缓冲水位或推进速率时，应同时验证 Unicode 字符边界、非追加更新和流结束立即对齐行为。

## 采集内容

开启后，诊断模块会采集：

- 浏览器 Long Task。
- 事件循环延迟，超过 120ms 时记录。
- 每 5 秒一次的内存、DOM 节点数、resource 数量和可见性状态。
- React root commit 耗时，超过 24ms 时记录。
- 手动标记事件。

最近 300 条事件保存在内存中，并暴露在 `window.__WEWORK_PERF__` 上。诊断数据不会上传到服务端。

## 现场取证

普通 release 包默认不会编译 Tauri Web Inspector。需要排查 release 包时，先构建诊断包：

```bash
pnpm --filter wework build:mac:devtools
```

如果需要通过 macOS 发布脚本生成带更新元数据的诊断包，使用：

```bash
bash wework/scripts/release-mac-app.sh --target local --devtools
```

也可以设置 `WEWORK_RELEASE_DEVTOOLS=1`。启动诊断包后按隐藏快捷键打开 **Developer Commands**，选择 **Open Web Inspector**。如需启动时自动打开，可以用环境变量：

```bash
WEWORK_WEBVIEW_DEVTOOLS=1 /path/to/WeWork.app/Contents/MacOS/WeWork
```

Web Inspector 打开后，在卡顿后执行：

```js
window.__WEWORK_PERF__.snapshot();
```

返回值包含当前 URL、页面可见性、DOM 节点数、内存快照、导航时序、resource 数量、最近事件，以及 Wework 进程组快照。macOS 上 WebKit XPC 进程会被系统改挂到 PID 1；诊断会通过 LaunchServices 将当前 Wework 实例对应的 Web Content、GPU 和 Networking 进程重新关联进来。

进程组同时提供 `rss_kib` 和 `physical_footprint_kib`：RSS 包含共享映射和可回收驻留页，通常明显高于真实内存压力；判断泄漏或系统资源占用时应优先比较 `physical_footprint_kib`，RSS 只作为地址空间驻留的辅助指标。需要持续观察时可以多次执行，重点比较：

- `memory.usedJSHeapSize` 是否持续上涨。
- `processMemory.groups[].physical_footprint_kib` 是否在任务结束并冷却后仍持续上涨。
- 增长来自 `webkit-webcontent`、`codex-app-server`、`executor` 还是 `main`。
- `domNodeCount` 是否持续上涨。
- 是否存在密集 `longtask` 或 `event-loop-lag`。
- 是否存在重复的 `slow-react-commit`。

也可以手动打点：

```js
window.__WEWORK_PERF__.mark("before-open-task", { taskId: "..." });
```

## 关闭方式

再次按隐藏快捷键打开 Developer Commands 菜单，然后选择 **Disable Performance Diagnostics** 会关闭诊断并刷新应用。也可以在控制台执行：

```js
localStorage.removeItem("wework:perf-debug");
location.reload();
```

关闭后 `window.__WEWORK_PERF__` 不再安装，React Profiler 也不会包裹应用根节点。
