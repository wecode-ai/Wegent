---
sidebar_position: 33
---

# 性能诊断

Wework 内置一个默认关闭的前端性能诊断开关，用于定位 release 包中“运行一段时间后变卡”的问题。诊断代码只在显式开启后运行；关闭时不会安装 React Profiler，也不会采集定时样本。

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

## 本地 Codex 流式日志

本地 executor 的 Codex 调试日志默认保留 delta 详情，便于定位流式输出顺序、阶段识别和最终内容覆盖问题。默认会记录 Codex 原始 delta 与运行态分类摘要。

为避免 debug 包在长回复或高频 token 输出时产生过多日志，runtime work 内部的 cache/emit mapping 日志默认关闭。这类日志会为同一个 delta 额外记录缓存和 UI 事件分发路径，只有排查本地 runtime work 路由时才需要打开。

可用环境变量：

```text
WEGENT_CODEX_STREAM_DEBUG=0          # 关闭 Codex 原始 delta / 分类详情
WEGENT_CODEX_STREAM_DEBUG=1          # 开启 Codex 原始 delta / 分类详情（默认）
WEGENT_CODEX_STREAM_MAPPING_DEBUG=1  # 开启 runtime work cache/emit mapping 详情
```

## 采集内容

开启后，诊断模块会采集：

- 浏览器 Long Task。
- 事件循环延迟，超过 120ms 时记录。
- 每 5 秒一次的内存、DOM 节点数、resource 数量和可见性状态。
- React root commit 耗时，超过 24ms 时记录。
- 手动标记事件。

最近 300 条事件保存在内存中，并暴露在 `window.__WEWORK_PERF__` 上。诊断数据不会上传到服务端。

## 现场取证

如果 debug 包或 release 包能打开 Web Inspector，在卡顿后执行：

```js
window.__WEWORK_PERF__.snapshot();
```

返回值包含当前 URL、页面可见性、DOM 节点数、内存快照、导航时序、resource 数量和最近事件。需要持续观察时可以多次执行，重点比较：

- `memory.usedJSHeapSize` 是否持续上涨。
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
