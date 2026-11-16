---
sidebar_position: 1
---

# W-0061 复现与实现证据

本次实现已适配主线 `5ccea8412`，并采用 Issue 版本 9 的接单回执契约。
保留主线的 Rust Socket.IO 主路径、拆分后的 Task 存储、稳定 Issue 会话、
admission reservation、失败启动恢复和项目配置入口。

## 可检验的触发条件

原有 stand-in notification 和桌面自动处理链路已经存在。服务端缺少统一的
接单回执，通知写入、已读时间和 `human_task_binding` 是否为空均不足以证明设备接单。
本次使用已有 assignment、binding、execution 和 delivery 形成回执，不把通知成功
当作执行完成，也不扫描历史事项回填。

以下边界均保留了稳定失败的回归及修复后的验证：

- 同一私人 Task 的两条 execution 曾因 device/task 去重而只发送一次取消。
  取消改用冻结的 executionId，旧取消不能终止新的 assignment。
- 工作区设备残留个人声明、以及事务中的旧 Device 授权快照曾被当作可用授权。
  接单和运行检查使用当前 owner、个人设备和实时项目权限。
- 同步问题与 MCP 请求同时等待时曾没有服务端等待事件。现在只发布当前冻结 turn
  的等待聚合状态；回答最后一个阻塞问题后恢复 running，问题和答案不进入共享流。
- 私人执行不产生共享 agent 文本，曾被公共输出探测误判为停滞。实际 SDK 行回归
  先得到 2 passed / 1 failed；排除该探测后 3 项通过，普通 agent/team 探测保持原契约。
- 自动执行完成后的 owner 私聊曾被终态回执拒绝；旧内部重试又可能被可变 Task origin
  改写为新的手动身份。现在 owner 续办单独验证账户、同一 Task/设备绑定与实时执行权限，
  已准备的自动请求在发送和入队时保留原身份，迟到请求仍被原生检查拒绝。
- 关闭开关后，已有回执曾继续显示。回滚回归验证新投影隐藏，assignment metadata、
  execution 和原有 human_task_binding 均保留，且不读取设备在线状态。

## 实现边界

- assignment metadata 保存派发身份和版本；幂等键包含项目、Issue、assignment 和版本。
- 对外返回 `DirectHumanAssignmentReceipt`，关联既有 humanAssignmentId、runtime task、
  execution 和当前 assignment 的真实 delivery；未交付时 deliveryId 为 null。
- 复用 Device、LoopItemExecution、个人 Task admission 和 stand-in scheduler，不新增表或 API。
- Rust 注册和心跳只持久化净化后的默认助理授权范围，不上传提示词、模型连接和私密配置。
- 未开启、未授权项目、自动策略禁用和 Tag 不匹配返回 blocked_policy 与具体 reasonCode；
  离线为 waiting_device，在线未受理为 queued，设备接受后为 running。
- 等待用户保留同一 execution；真实恢复后返回 running。静默等待退出不被解释为 completed。
- 重连只恢复已有意图；重复保存不新建 execution。运行中取消等待真实终止证据。
- 每个原生 turn 冻结 executionId；失败启动恢复保留已准备请求，公开的预检错误先脱敏。
- 私人执行只允许 owner 读取。共享时间线仅写摘要、证据引用、用户署名和 AI provenance。
- Runtime 完成不推进 Issue 状态；既有 agent/team、手动、mention 和本地私人流程保留。
- UI 只给 owner 展示精确绑定的私人会话入口，并使用 runtimeTaskId 打开已有 Task。

## 本地验证

- Rust Backend 全库：3692 passed，0 failed，43 项主线既有 ignored。
- Python 最终 7 文件：154 passed；包括回执、权限、幂等、取消、隐私及列表查询预算。
- Executor 最终默认助理回归：20 passed；默认工作区独立集成回归：1 passed。
- 共享 UI：37 passed；桌面相关 3 文件：73 passed；Web adapter：17 passed。
- 双语文档：7 passed；既有桌面 checkpoint 静态契约：8 passed。
- 共享包构建、Wework/frontend TypeScript、相关 ESLint、Python Black/isort、Rust 格式通过。

Executor 使用独立的 capabilities 和 Task 目录，不读取主机个人 manifest。
Rust Backend 使用临时 uv 工具环境提供 CMake，未安装系统软件或更改项目依赖。
首次推送还需完成仓库的完整 pre-push 检查；最终发布验证以 PR CI 为准。

本地未运行 E2E 或真实 Electron。既有 CI core-2 的 project-assignment-notification
场景新增真实在线接单、重复保存、完成但不推进 Issue、同一私人会话续办及共享摘要隔离。
该场景仅替代模型响应，复用真实 Backend、Electron、Executor 和数据库，不新增测试服务。
本次未部署。

## 开关和回滚

功能开关 `collab.humanAssignmentReceipts.v1` 对应后端环境配置
`HUMAN_ASSIGNMENT_RECEIPTS_ENABLED`，默认关闭。
启用前需要后端和支持端点声明的 Executor 同时就绪。
关闭后停止新自动接单并隐藏新回执，页面恢复原有 human_task_binding 投影；
通知、runtime binding、delivery 和 execution 历史均保留。
