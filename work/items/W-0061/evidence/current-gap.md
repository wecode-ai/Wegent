---
sidebar_position: 1
---

# W-0061 复现与实现证据

本次实现已适配主线 `3926d36a8`。保留主线的 Rust Socket.IO 主路径、
拆分后的 Task 存储、稳定 Issue 会话、assignment receipt 和 admission reservation。

## 可检验的触发条件

关闭功能开关后，即使负责人配置了默认助理，人工 assignment 保存成功仍不创建
`LoopItemExecution`；通知和 `human_task_binding` 不能证明助理已接单。
派发专项保留此旧行为作为回滚契约，并验证开启开关后的执行记录与幂等性。

还先复现、再修复了两个执行身份边界：

- 同一私人 Task 被不同 assignment 复用时，旧取消请求曾按 device/task 去重。
  两条 execution 的取消测试稳定失败（预期两条 RPC，实际一条），修复后按
  executionId 区分，同时保留普通 agent/team 的取消契约。
- Device 转为工作区设备后，个人端点声明仍可能被 REST admission 使用。
  五个所有权用例先得到 3 failed / 2 passed；加入与 Rust 一致的所有权检查后，
  包含声明、接单和会话权限的 47 项回归全部通过。
- Rust 端点授权使用当前锁定的 Device 行，避免沿用事务早先读取的授权快照。
  SDK 行 fixture 的旧授权 / 新撤权回归先稳定失败，修复后整个声明模块 12 项通过。

## 实现边界

- assignment metadata 保存派发身份和版本；幂等键包含项目、Issue、assignment 和版本。
- 复用 Device、LoopItemExecution、个人 Task admission 和 stand-in scheduler，不新增表或 API。
- Rust 注册和心跳净化并持久化默认助理的授权范围；不上传提示词、模型连接或工作区私密配置。
- 未授权显式返回 `no_authorized_assistant`；已授权等待接单返回 `waiting_device`。
- 重连只恢复已有派发意图，不回填历史 Issue。现有完整列表接口恢复用例覆盖第 102 条候选。
- 个人任务绑定原子接单。原生执行启动前重新检查本地授权和当前 assignment。
- 每个 turn 冻结 executionId，执行事件和取消请求携带此身份，旧结果和旧取消不影响新派发。
- Rust 后台授权保留项目和 Issue 权限，个人端点检查当前 owner、assignment、设备和默认助理授权。
- 改派、清空、关闭和撤权取消旧执行。运行中取消等待真实终止证据，不提前声明清理完成。
- 私人执行只允许所有者读取。共享时间线仅写最终摘要、证据链接及用户署名和 AI provenance。
- Runtime 完成不自动推进 Issue 状态；agent/team 和手动或 mention 的既有流程继续使用原契约。
- 任务绑定 GET 保留精确 execution 引用；共享 UI 仅为 owner 提供私人会话入口。

## 本地验证

| 检查                                                                       | 结果                                     |
| -------------------------------------------------------------------------- | ---------------------------------------- |
| Python：17 文件，权限、assignment、execution、绑定、取消、时间线和列表投影 | 424 passed                               |
| Rust Backend 全库单元测试                                                  | 3678 passed，0 failed，39 项原有 ignored |
| Executor：默认助理、既有 stand-in、端点声明                                | 351 个独立用例通过（10 + 338 + 3）       |
| 共享 UI 状态、时间线、卡片和 Runtime 链接                                  | 86 passed                                |
| 桌面活动、API、编辑器和执行投影                                            | 152 passed                               |
| 补充 API 与协作平台兼容                                                    | 69 passed                                |
| 保留主线 comment 定位行为                                                  | 16 passed                                |
| 双语文档导航和 bundled 静态检查                                            | 7 passed                                 |
| 共享包构建、Wework TypeScript、相关 ESLint、Python 格式和 diff 检查        | 通过                                     |

Executor 测试使用独立的 capabilities 和 Task 存储目录，不读取主机个人 manifest。
Rust Backend 使用临时 uv 工具环境提供 CMake，未安装系统软件或修改项目依赖。
Rust 主路径测试与完整发布检查的最终结果以 PR CI 和交付记录为准。

本地没有运行 E2E 或真实 Electron 验证。已有 CI 覆盖的
project-assignment-notification 场景增加未授权和重复保存断言。
单元契约不替代线上验证，本次未部署。

## 开关和回滚

功能开关 `collab.humanAssignmentAssistantDispatch.v1` 对应后端环境配置
`HUMAN_ASSIGNMENT_ASSISTANT_DISPATCH_ENABLED`，默认关闭。
启用前需要后端和支持端点声明的 Executor 同时就绪。
关闭后停止新的自动接单，保留已有 execution 供审计。
