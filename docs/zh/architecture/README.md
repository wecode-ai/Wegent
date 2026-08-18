---
sidebar_position: 1
---

# 架构约束逻辑

修改下表逻辑前，先更新对应连线图、时序图、代码归属和必要不变量，确认逻辑闭环后再改代码。每个主题独立维护；新增受约束逻辑时增加一个文件和一行索引。

| 逻辑                        | 架构文件                                                 | 修改范围                                                          |
| --------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| 看板自动化与 Wegent 执行    | [board-automation.md](board-automation.md)               | 指派、执行真值、runtime 激活、续聊、取消、终态投影                |
| 自定义 AI 调度员评论续聊    | [automation-manager-continuation.md](automation-manager-continuation.md) | 评论身份、execution 绑定、runtime 会话续聊、任务状态隔离 |
| 内置浏览器导航与多标签      | [embedded-browser.md](embedded-browser.md)               | bridge 路由、pending open、WebView 生命周期、导航完成、多标签 E2E |
| 项目执行状态与 Runtime 容量 | [project-execution-state.md](project-execution-state.md) | claim、事件顺序、取消、重试、lease、并发容量、UI 投影             |
| Git Worktree 执行           | [git-worktree-execution.md](git-worktree-execution.md)   | 设备路由、能力、preflight、排队创建、生命周期、持久化、UI 投影    |

详细产品说明继续放在原开发指南；本目录只保存可评审的架构真值。
