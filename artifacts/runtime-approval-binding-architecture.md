# Runtime 绑定与审批状态异常架构图

## 结论

Runtime 已绑定。异常来自“配置完整性”存在两套不一致的判断标准：

- 配置弹窗与执行入队：`execution_device_id + model + workspace_binding` 即为完整。
- 人工审批：额外强制要求 `runtime_profile_id`。

用户直接选择设备和模型时，`runtime_profile_id` 可以合法为空。因此任务在创建时配置完整，
但审批后被错误改成 `waiting_runtime`。

## 修复状态

已新增统一的后端判定 `runtime_configuration_complete`，以下入口共用同一规则：

- 项目机器人入队
- 工作流通用机器人入队
- 人工审批

统一条件为：

```text
execution_device_id
+ runtime_selection.model
+ workspace_binding（调用链声明需要时）
```

`runtime_profile_id` 不再参与“是否可执行”的判断。

## 当前调用链

```mermaid
flowchart TD
    A[用户选择机器人预设] --> B[补全运行配置弹窗]
    B --> C[选择执行机器]
    B --> D[选择模型]
    B --> E[选择工作目录]
    C --> F[WorkflowExecutionConfig]
    D --> F
    E --> F

    F --> G{workflowExecutionConfigComplete}
    G -->|设备或 Agent + 模型 + 工作目录| H[界面显示：运行配置已完整]

    H --> I[PATCH /v1/loop-items/:id]
    I --> J[保存 Issue execution_config]
    J --> K[refresh_agent_execution_configuration]
    K --> L[create_for_assignment]
    L --> M{入队完整性判断}
    M -->|设备 + 模型 + workspace_binding 均存在| N[pending_approval]

    N --> O[用户审批]
    O --> P{统一 Runtime 完整性判断}
    P -->|设备、模型、工作目录完整| R[queued]
    P -->|真正缺少运行字段| Q[waiting_runtime]
```

## 数据证据

2026-08-24 的 Wework 前端日志记录了完整选择：

```json
{
  "runtimeProfileId": null,
  "deviceId": "cloud-device-dev",
  "model": "wecode-moonshot-kimi-k2.7-code-highspeed(公网)",
  "modelType": "public",
  "workspaceBinding": {
    "type": "standalone"
  }
}
```

这证明设备、模型和工作目录均已绑定，仅 `runtime_profile_id` 为空。

## 冲突代码

配置完整性：

```text
(agent_id 或 execution_device_id) && model && workspace_binding
```

审批完整性：

```text
runtime_profile_id && execution_environment && execution_device_id
```

审批判断既遗漏了 `model`，又把本应可选的 `runtime_profile_id` 当成必填字段。

## 正确状态机

```mermaid
stateDiagram-v2
    [*] --> pending_approval: 设备、模型、工作目录完整
    pending_approval --> queued: 审批通过且运行配置完整
    pending_approval --> waiting_runtime: 审批通过但设备/模型/工作目录缺失
    queued --> claimed
    claimed --> running
    running --> succeeded
    running --> failed
```

## 修复原则

审批不能重新发明 Runtime 完整性规则。现已复用入队时的统一判定，并基于执行快照判断：

```text
execution_device_id + runtime_selection.model + 有效 workspace_binding
```

`runtime_profile_id` 只表示配置来源，不应作为 Runtime 是否可执行的必要条件。
