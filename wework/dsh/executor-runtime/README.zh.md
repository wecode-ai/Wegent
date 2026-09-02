# Wework DSH Executor Runtime

该插件是 Wework 产品 DSH App 的统一执行面。浏览器侧只访问版本化同源接口，
不会接触 Electron IPC、executor stdio 或 bearer token。

当前物理 transport 接入迁移期的 Electron loopback relay；逻辑 client、结构化
错误、事件序号、有限 ring buffer 和断线续传接口已经固定。后续替换成本地
Unix Domain Socket / Windows Named Pipe 和云 runtime relay 时，不改变产品 App
接口。

## 与 Agent 的关系

该插件提供 Executor 执行能力和 DSH Session 投影，但不注册第二个全局
`AgentFactory`。DSH 基础 bundle 的 `agent-loop` 已占用唯一 factory 槽位；重复
注册会让默认工作台无法启动。

Executor 是独立进程，可在同一 Wework 进程中同时连接本地与远程执行目标。
Codex、Claude Code 等是 Executor 调起的运行时，不包含在该插件中。Wegent
智能体（Team）在创建任务时物化为现有 Executor `executionRequest`，后续轮次
沿用任务绑定，因此不会改变旧版 Executor 的线协议。
