---
sidebar_position: 1
---

# 架构约束逻辑

修改下表逻辑前，先更新对应连线图、时序图、代码归属和必要不变量，确认逻辑闭环后再改代码。每个主题独立维护；新增受约束逻辑时增加一个文件和一行索引。

| 逻辑                                 | 架构文件                                                                             | 修改范围                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 看板自动化与 Wegent 执行             | [board-automation.md](board-automation.md)                                           | 指派、执行真值、runtime 激活、续聊、取消、终态投影                    |
| 自定义 AI 调度员评论续聊             | [automation-manager-continuation.md](automation-manager-continuation.md)             | 评论身份、execution 绑定、runtime 会话续聊、任务状态隔离              |
| 内置浏览器导航与多标签               | [embedded-browser.md](embedded-browser.md)                                           | bridge 路由、pending open、WebView 生命周期、导航完成、多标签 E2E     |
| Issue、任务与工作流编排              | [issue-task-workflow.md](issue-task-workflow.md)                                     | Issue 聚合、任务绑定、工作空间继承、DAG 就绪判断、状态聚合            |
| Issue Runtime 状态、交付与界面投影   | [issue-runtime-delivery-projection.md](issue-runtime-delivery-projection.md)         | Runtime 终态写入、阶段聚合、Delivery 履约、事件失效、Issue 详情一致性 |
| 工作流阶段交付与依赖上下文           | [workflow-stage-deliverables.md](workflow-stage-deliverables.md)                     | 结构化交付要求、人工与自动阶段门禁、代码证据、后继上下文快照          |
| 工作流阶段执行路由                   | [workflow-stage-execution-routing.md](workflow-stage-execution-routing.md)           | 人工启动、云端派发、本地/云端设备路由、统一阶段执行契约               |
| 项目空间 Agent 能力                  | [project-space-agent-capability.md](project-space-agent-capability.md)               | 本地 Gateway、ContextGrant、Codex Plugin、离线 Provider、MCP 生命周期 |
| 项目执行状态与 Runtime 容量          | [project-execution-state.md](project-execution-state.md)                             | claim、事件顺序、取消、重试、lease、并发容量、UI 投影                 |
| Git Worktree 执行                    | [git-worktree-execution.md](git-worktree-execution.md)                               | 设备路由、能力、preflight、排队创建、生命周期、持久化、UI 投影        |
| 文本模型视觉委托                     | [model-vision-delegation.md](model-vision-delegation.md)                             | 显式模型引用、catalog 能力、sidecar 配置、图片替换、失败隔离          |
| Wework 宿主插件运行时                | [workbench-plugin-runtime.md](workbench-plugin-runtime.md)                           | profile 装配、服务与 UI slot、动态模块、sidecar、卸载与恢复           |
| Agent 插件 MCP 配置兼容              | [agent-plugin-mcp-compatibility.md](agent-plugin-mcp-compatibility.md)               | 插件导入、MCP 声明解析、远程配置归一化、Harness Adapter               |
| 智能应用（DeepSeek Harness Runtime） | [deepseek-harness-apps.md](deepseek-harness-apps.md)                                 | 应用类型导航、安装包校验、版本绑定、模型代理、独立实例、标签页与回收  |
| IM 私聊续聊本地 Runtime              | [im-runtime-streaming.md](im-runtime-streaming.md)                                   | callback key、`runtime:event` 信封、紧凑进度投影、终态、失败隔离      |
| Codex 通知流隔离                     | [codex-notification-routing.md](codex-notification-routing.md)                       | 共享 app-server、线程路由、突发隔离、进程退出、终态投影               |
| Runtime 任务生命周期对账             | [runtime-task-lifecycle-reconciliation.md](runtime-task-lifecycle-reconciliation.md) | 事件流、掉队检测、异常对账、终态投影、transcript 读取边界             |

详细产品说明继续放在原开发指南；本目录只保存可评审的架构真值。
