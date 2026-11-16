---
sidebar_position: 1
---

# W-0061 复现与实现证据

本次工作区基线：`a451b8183993b521276afe4f78135cc88f6e0087`。
Issue 附件描述的更早基线为 `907b5f05f5`；其中部分路径已经调整，
当前不存在 `backend/app/services/project_chat/stand_in_events.py`。

## 稳定复现

`backend/tests/services/test_human_assistant_dispatch.py` 的关闭开关用例
保留原有人工分配分支：即使负责人有默认助理声明，人工 assignment 保存成功，
也没有 `LoopItemExecution`。现有 `human_task_binding` 仅提供任务身份，
通知发送成功不能证明助理已经接单。

配置和授权原本仅保存在 Executor 的 personal stand-in 设置中；
后端没有可持久化的默认助理端点声明。云端任务的旧唤醒依赖收到分配通知，
无法仅凭通知记录判断离线、未授权或执行状态。

## 实现边界

- assignment event 保存派发身份和版本；幂等键包含项目、Issue、assignment 和版本。
- 复用 Device 声明、LoopItemExecution、个人 Task admission 和 stand-in scheduler。
- 设备注册和心跳仅上报默认助理的授权范围，服务端过滤其他账号；不上传私有提示词或连接配置。
- 未授权显式返回 `no_authorized_assistant`；已授权等待接单返回 `waiting_device`。
- 个人任务绑定原子接单；改派、清空、关闭和撤权取消旧执行，迟到结果检查当前 assignment。
- 完成只发布用户署名的摘要和 provenance，不自动推进 Issue 状态；个人会话只允许所有者读取。
- agent/team 继续使用现有派发路径。
- 已迁移到 Rust 的任务绑定 GET 保留精确 execution 引用，让所有者可以打开对应私有任务。

## 验证方式

在 `backend` 中使用 `uv run pytest` 运行 dispatcher、device declaration、
session privacy、现有 assignment/execution 和 permission contract 用例。
Executor 使用 `cargo test --lib stand_in` 验证现有和新增 stand-in 契约。
共享 UI、桌面投影运行针对性 Vitest、构建、类型和静态检查。

已取得的结果：

| 检查 | 结果 |
| --- | --- |
| 后端综合回归，包含权限契约、人工分配、execution、设备声明、会话和时间线 | 349 passed |
| 后端派发专项，随后补充已关闭 Issue 不生成派发的边界 | 15 passed；与综合回归合计覆盖 350 个不同用例 |
| Executor stand-in 与端点声明 | 63 + 2 passed；包含真实持久化私有 Task、幂等绑定、启动失败、离线恢复和设备归属保护 |
| 共享 UI 状态和时间线回归 | 25 passed |
| 补充时间线、Runtime 链接和 ActivityPanel 回归 | 42 passed；覆盖非所有者即使有匹配 execution，也不能打开私有执行 |
| 桌面投影、活动和 API 针对性回归 | 128 passed |
| 共享包构建、Wework TypeScript、相关 ESLint 和格式检查 | 通过 |
| Rust 任务绑定 GET 投影 | `cargo fmt --check` 通过；测试构建受环境缺少 `cmake` 阻塞 |

派发专项可以在 `backend` 目录中复查：

```text
uv run pytest tests/services/test_human_assistant_dispatch.py -q
```

Executor 的最终源码分别在 `executor` 目录执行：

```text
cargo test --lib stand_in -- --nocapture
cargo test --lib assistant_dispatch -- --nocapture
```

这些测试使用隔离的本地 Task 存储和 HTTP 契约 fixture，不启动真实模型执行。

Rust 投影使用 `cargo test --lib loop_tasks::handler`。本次构建在项目原有
`turbojpeg-sys` 依赖调用 `cmake` 时退出，尚未执行到项目测试；未安装系统软件、
更改依赖或跳过该依赖。

本次没有运行 E2E 或真实 Electron 验证，没有部署。CI 场景的新增断言
与本地单元契约分别保留，不能将单元测试通过视为线上验证。

## 开关和回滚

功能开关 `collab.humanAssignmentAssistantDispatch.v1` 对应后端环境配置
`HUMAN_ASSIGNMENT_ASSISTANT_DISPATCH_ENABLED`，默认关闭。
启用前需要后端和支持端点声明的 Executor 同时就绪。
关闭后停止新的自动接单，已存在记录保留用于审计。
