---
sidebar_position: 25
---

# 项目空间 Agent 能力

范围：Wework 中项目空间工具的安装、会话启用、Issue 上下文绑定、本地离线访问、云端路由和 Agent Harness 适配。

```mermaid
flowchart LR
    ISSUE[Issue / 项目会话] --> GRANT[Session ContextGrant<br/>session_id + space_id + item_id + scopes]
    GENERIC[普通任务] --> SESSION[Agent Session]
    GRANT --> SESSION
    SESSION --> DECLARATION[合法的固定 MCP transport 声明<br/>按会话切换 enabled / ContextGrant]
    DECLARATION --> ADAPTER{Harness Adapter}
    ADAPTER -->|Codex| PLUGIN[内置 wework-space Plugin]
    ADAPTER -->|其他 Harness| MCP_ADAPTER[同契约 MCP Adapter]
    PLUGIN --> GATEWAY[Wework Local Project-space Gateway]
    MCP_ADAPTER --> GATEWAY
    GATEWAY -->|本地项目| LOCAL[Local ProjectSpace Provider]
    GATEWAY -->|云项目且在线| REMOTE[Backend ProjectSpace Provider]
    REMOTE --> BACKEND[Wegent Backend]
    GATEWAY --> DELIVERY[Delivery 生命周期<br/>创建 / 上传 / 下载 / 提交 / 丢弃]
    DELIVERY -->|source TaskBinding| ISSUE_STAGE[当前 Issue workflow node]
    CLOUD[Wegent 云端 Agent] --> BACKEND_MCP[Backend wework_space MCP]
    BACKEND_MCP --> BACKEND
    CONTRACT[统一工具契约与契约测试] --> PLUGIN
    CONTRACT --> MCP_ADAPTER
    CONTRACT --> BACKEND_MCP
```

```mermaid
sequenceDiagram
    participant W as Wework
    participant G as Local Gateway
    participant H as Agent Harness
    participant P as Codex Plugin / MCP Adapter
    participant L as Local Provider
    participant B as Backend Provider

    W->>G: App 启动时准备本地 Project-space Provider
    W->>H: 创建 Agent Session
    alt 普通任务
        W->>H: 提供合法 transport 声明并设置 enabled=false
    else 项目或 Issue 会话
        W->>H: 提供相同 transport，注入短期 ContextGrant 并设置 enabled=true
        H->>P: 初始化 MCP 并完成工具清单协商
        P->>G: 启动 Wework 管理的会话 Adapter 并校验 ContextGrant
        G-->>P: 返回绑定的 capability scope
    end
    H->>P: get_current_context / read_item_attachment
    P->>G: 调用统一工具契约
    alt 本地项目
        G->>L: 读取本地 Issue、描述或附件
        L-->>G: 返回本地数据
    else 云项目且在线
        G->>B: 使用用户身份和 scope 访问 Backend
        B-->>G: 返回云端数据
    else 云项目离线且未缓存
        G-->>P: 返回明确的 offline/not-cached 错误
    end
    opt 当前会话绑定到 Issue TaskBinding
        H->>P: get_delivery_requirements
        P->>G: 从 ContextGrant 的 device_id + task_id 解析当前阶段
        H->>P: create_delivery / upload_delivery_asset
        P->>G: 创建绑定当前 TaskBinding 的 Delivery 草稿并写入附件
        H->>P: finalize_delivery
        P->>G: 固化快照并将 delivery_id 绑定到当前 workflow node
    end
    G-->>P: 返回经过 scope 校验的结果
    P-->>H: MCP tool result
```

| 边                                            | 代码归属                                                          |
| --------------------------------------------- | ----------------------------------------------------------------- |
| Wework 启动 → Local Provider 生命周期         | Wework Tauri local executor；Executor local ProjectSpace provider |
| Agent Session → ContextGrant                  | Wework Runtime 消息元数据；Executor session context registry      |
| Agent Session → 固定 MCP transport 与启用状态 | Executor Codex adapter；Harness-specific MCP adapter              |
| Codex → project-space capability              | Wework 内置 `wework-space` Codex Plugin；Executor Codex adapter   |
| 其他 Harness → project-space capability       | Harness-specific MCP adapter                                      |
| Gateway → Local Provider                      | Executor `task_runtime` 与本地 ProjectSpace provider              |
| Gateway → Backend Provider                    | Executor authenticated Backend ProjectSpace client                |
| MCP → Delivery 生命周期                       | Executor `task_runtime/mcp.rs`、Delivery API 与本地 ProjectSpace   |
| Delivery → 当前 workflow node                 | ContextGrant Runtime 地址、`LoopItemTaskBinding`、Delivery 服务    |
| 云端 Agent → Backend MCP                      | Backend `wework_space` MCP                                        |
| 统一工具契约 → 全部 Adapter                   | 共享 schema、工具名、权限语义与契约测试                           |

不变量：

- MCP 能力的安装和服务声明是稳定配置；`space_id`、`item_id` 与权限是会话数据。不得再通过修改任务的完整 MCP Server 列表来表达 Issue 上下文。
- Wework 不连接 Backend 时，本地项目的 Issue、描述和附件读取必须可用；Backend 是云项目 Provider，不是本地能力成立的前提。
- Plugin 只是 Codex Adapter。Gateway、ContextGrant 和工具契约不得依赖 Codex 专有类型。
- Plugin 的 MCP 声明是产品打包入口；Runtime 负责按会话提供 ContextGrant、启用状态和实际 Executor 路径，不能依赖插件市场页面曾被打开或异步安装时序。
- Harness 收到的禁用 MCP 配置仍必须包含可解析的固定 transport；`enabled=false` 只阻止服务启动，不能用缺少 `command`/`url` 的残缺条目表达禁用状态。
- ContextGrant 必须按 Agent session 隔离且不向模型暴露。其一小时有效期只限制新 MCP 会话的启动，启动后租约跟随该会话 Adapter 生命周期；长任务不会在执行中断权，Adapter 退出即撤销。模型参数、prompt 文本和全局“当前项目”均不是授权来源。
- 普通任务不启用项目空间工具；项目会话可只绑定 `space_id`，Issue 会话绑定 `space_id + item_id`。
- `get_current_context` 在无绑定时返回明确的未绑定结果；MCP 启动失败、无权限、云项目离线和未缓存必须是不同错误。
- Gateway 必须拒绝超出 ContextGrant scope 的显式 `space_id/item_id`，不能信任模型传入的标识。
- Delivery 写工具只在同时绑定 `space_id + item_id + device_id + task_id` 的 Issue 会话可用。`source_task` 与 `workflow_node_id` 必须由 ContextGrant 和当前有效 `TaskBinding` 推导，模型不得指定或覆盖。
- 本地与云端 Provider 必须提供同语义的 `get_delivery_requirements`、`create_delivery`、`upload_delivery_asset`、`list_deliveries`、`read_delivery`、`download_delivery_asset`、`finalize_delivery` 和 `discard_delivery_draft`。普通 Issue 附件工具不得代替 Delivery 工具。
- `create_delivery` 的聊天快照选择由服务端从当前 Issue 时间线解析，支持全部、最近 N 条和指定消息 ID；不得信任模型提交的伪造消息内容作为“选择结果”。
- Delivery 附件下载必须校验附件属于当前 Issue 下可见的 Delivery；上传和丢弃仅允许操作当前会话创建且仍为 draft 的 Delivery。`finalize_delivery` 必须复用既有不可变快照边界，并将交付绑定到来源 TaskBinding 的唯一 workflow node。
- Runtime 在首轮前只校验固定能力配置与 ContextGrant，不得用全局 MCP 工具清单阻塞模型。工具清单诊断异步执行；能力调用失败必须返回明确错误，并由会话 UI 保留用户消息和失败回复。
- 本地、远程和 Backend MCP 使用相同工具 schema 与契约测试；Provider 只决定数据来源，不改变工具语义。
- 迁移完成后必须删除 `ensure_space_mcp_server` 的逐任务服务注入路径，不能长期保留双主路径。
