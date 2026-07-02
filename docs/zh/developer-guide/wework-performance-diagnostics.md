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

快捷键会切换 `localStorage` 中的 `wework:perf-debug` 标记并自动刷新应用。再次按同一快捷键会关闭诊断并刷新。

开发环境也可以通过 URL 参数临时切换：

```text
?weworkPerf=1  # 开启
?weworkPerf=0  # 关闭
```

也可以设置构建/运行环境变量 `VITE_WEWORK_PERF_DEBUG=1`，用于本地复现时默认开启。

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
window.__WEWORK_PERF__.snapshot()
```

返回值包含当前 URL、页面可见性、DOM 节点数、内存快照、导航时序、resource 数量和最近事件。需要持续观察时可以多次执行，重点比较：

- `memory.usedJSHeapSize` 是否持续上涨。
- `domNodeCount` 是否持续上涨。
- 是否存在密集 `longtask` 或 `event-loop-lag`。
- 是否存在重复的 `slow-react-commit`。

也可以手动打点：

```js
window.__WEWORK_PERF__.mark('before-open-task', { taskId: '...' })
```

## 关闭方式

再次按隐藏快捷键会关闭诊断并刷新应用。也可以在控制台执行：

```js
localStorage.removeItem('wework:perf-debug')
location.reload()
```

关闭后 `window.__WEWORK_PERF__` 不再安装，React Profiler 也不会包裹应用根节点。
