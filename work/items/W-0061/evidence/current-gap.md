---
sidebar_position: 1
---

# W-0061 复现与实现证据

本次实现已适配主线 `cbacc633a`，并采用 Issue 版本 9 的接单回执契约。
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
- 完整推送门禁中的 Electron 准备会重建根依赖，而 lint/TypeScript 已并发启动，
  导致缺模块错误。既有门禁协议用例稳定复现该顺序问题；准备现在先同步完成，
  再启动只读静态检查，保留全部检查及失败传播。
- 真实 CI E2E 在首次人工分配创建时复现 HTTP 500：持久化的设备声明为字符串，
  Python 对其调用 `.get()`。六项格式异常回归先全部失败，边界修复后相关四文件
  58 项通过；异常声明不授予助理权限，人工 assignment 保留并显示明确原因。
  Rust 的设备声明及 assignment 回执两处 JSON_SET 写入显式使用 CAST(? AS JSON)。
  对象类型、回执撤销与重复心跳的真实 MySQL 验证扩展在既有 CI 心跳用例中，
  本地没有任务专用 MySQL，实际数据库验证以 PR CI 为准。
- 下一轮真实 CI 中，本地授权保存成功后仍未接单。日志确认后端注册设备身份与
  App 安装身份不同；真实 LocalTaskStore 与实际 heartbeat payload 的回归稳定复现
  授权角色丢失。App 声明现在精确读取安装身份，缺失时返回空声明，不借用注册身份；
  非 App 继续使用自己的设备身份。相关 21 项回归通过，读取不迁移或改写授权。
  本地保存不是服务端声明确认；声明仍通过现有注册和心跳发布。
- 同轮 Platform shard 1 的订阅执行全部停在 PENDING。日志确认前置故障注入撤销
  共享 Redis default 用户的 ZADD 后，Celery 在 QoS 写入时不可恢复退出。
  任务专用 Redis 的实际 Kombu 协议验证稳定复现了同一拒绝。
  最新主线已把消费者启动移至故障注入之后，本次采用该时序修复；
  原故障、恢复及业务断言均保留，没有增加 Redis 用户、服务或测试套件。

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

- 前一轮主线的 Rust Backend 全库：3692 passed，0 failed，43 项主线既有 ignored。
  最新主线合入后，设备授权、执行身份和 Runtime 投影三组回归：46 passed。
- 最新主线合入后的 Python 7 文件：160 passed；包括回执、权限、幂等、取消、隐私及列表查询预算。
- 最新主线合入后的 Executor 派发、MCP、计划任务及异步问题回归：68 passed。
  前序默认工作区独立集成回归：1 passed。
- 最新主线合入后的共享 UI：67 passed；桌面相关 5 文件：170 passed。
  前序 Web adapter 验证：17 passed。
- 最新双语文档契约：8 passed；前序桌面 checkpoint 静态契约：8 passed。
- 共享包构建、Wework/frontend TypeScript、相关 ESLint、Python Black/isort、Rust 格式通过。
- PR CI 发现的两处 Rust `cmp_owned` 已稳定复现并修复。显式字符串比较保留冻结身份；
  15 项设备授权及 4 项运行事件回归通过，数值 ID 和带前导零的 ID 均被拒绝。
  与 CI 相同的 `cargo clippy --locked --all-targets -- -D warnings` 通过。

Executor 使用独立的 capabilities 和 Task 目录，不读取主机个人 manifest。
Rust Backend 使用临时 uv 工具环境提供 CMake，未安装系统软件或更改项目依赖。
修复依赖准备顺序及 Clippy 初始化告警后，首次推送完整 pre-push 已全部通过：
Backend pytest、frontend、全部 Wework renderer/Electron/script 单测、Executor 全量测试
与 Clippy，以及格式、配置和迁移 head 检查。最终发布验证以 PR CI 为准。

本地未运行 E2E 或真实 Electron。既有 CI 桌面 project-assignment-notification
场景新增真实在线接单、重复保存、完成但不推进 Issue、同一私人会话续办及共享摘要隔离。
该场景仅替代模型响应，复用真实 Backend、Electron、Executor 和数据库，不新增测试服务。
本次未部署。

## 开关和回滚

功能开关 `collab.humanAssignmentReceipts.v1` 对应后端环境配置
`HUMAN_ASSIGNMENT_RECEIPTS_ENABLED`，默认关闭。
启用前需要后端和支持端点声明的 Executor 同时就绪。
关闭后停止新自动接单并隐藏新回执，页面恢复原有 human_task_binding 投影；
通知、runtime binding、delivery 和 execution 历史均保留。
