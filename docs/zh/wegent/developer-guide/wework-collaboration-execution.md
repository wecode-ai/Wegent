---
sidebar_position: 35
---

# Wework 协作执行与授权

项目智能体绑定、智能体资源所有者、任务指派人和执行设备所有者是不同身份。
共享空间中的智能体可以被项目成员使用；这不授予成员修改原始 Team、Bot 或模型凭据的权限。

```mermaid
flowchart LR
  Selection[已有资源或新建智能体] --> Binding[项目智能体绑定]
  Binding --> Access[项目所属空间的有效资源授权]
  Access --> Compile[按 Team 所有者解析 Bot、Ghost 和 Shell]
  Compile --> Queue[持久化执行队列]
  Queue --> Routing[重新检查环境授权、模型能力和 Issue 设备绑定]
  Routing --> Wake[向实际设备所有者发送唤醒]
  Wake --> Pull[设备领取任务]
  Poll[默认每 5 秒轮询] --> Pull
  Pull --> Accept[Runtime 确认接收]
  Accept --> Status[运行状态和结果]
```

## 资源和编辑权限

- 项目内使用空间共享 Team 必须匹配项目所属空间中的有效授权；移出空间后不再通过该授权解析。
- Team 的子资源使用 Team 所有者身份解析。执行所用模型仍按执行者能力检查，不能借共享 Team 读取他人的私有模型凭据。
- 服务端返回 `can_edit`。个人 Team 仅所有者可编辑；群组 Team 使用群组 Developer 权限；项目管理角色不代替资源编辑权限。
- 本地资源没有 Team ID。已有智能体选择器使用资源提供的 `project_binding_input`，保留本地执行配置，不能编造 Team 关联。
- 本地资源目录负责确保“当前设备智能体”存在；项目添加入口同时提供已有智能体选择和新建操作。

## 任务领取

设备领取仍由持久化队列、原子认领和 Runtime 接收确认控制。唤醒通知只提示有工作，不携带任务，也不证明任务已经启动。
路由任务向满足当前授权、模型和 Issue 绑定的设备发送通知，并使用设备所有者的连接身份。
`LOCAL_RUNTIME_WORK_POLL_INTERVAL` 可覆盖默认 5 秒间隔；连接恢复和通知仍触发立即领取。

## 验证场景

1. 项目 Maintainer 使用其他成员加入空间的智能体，能建立绑定；全局资源详情和编辑权限保持原有边界。
2. 撤销空间 Team 授权后，项目成员不能通过个人权限绕过项目资源授权。
3. 共享设备的所有者与指派人不同时，唤醒到达设备所有者；撤销环境授权后不再通知该设备。
4. 只修改 Bot 路由配置，不修改名称或 Shell，仍可保存且保持资源身份。
5. 本地项目可以从已有资源添加“当前设备智能体”，并且不会生成假的 Team ID。

针对性单元和 API 测试覆盖以上规则。桌面回归沿现有 `collaboration-local-agent-dispatch` 场景进入 CI；本地仅在明确要求时运行 E2E 或 `ai:verify`。
