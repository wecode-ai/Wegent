---
sidebar_position: 12
---

# Wework API Client

通过 HTTP 操作 Wework 独立对话。与手机版共用设备 Runtime 的会话、消息和状态，不新增数据库表，不复制会话数据。

## 鉴权与地址

在 Wegent 中创建**个人 API Key**，请求携带：

```http
Authorization: Bearer wg-...
```

API 前缀为 `/api/v1`，与线上 Wegent Responses 共用入口。反向代理需要将这个前缀转发到 backend，并关闭 SSE 响应缓冲。API Key 过期、撤销或所属用户停用后，后续请求返回 401；不接受登录 JWT 或服务密钥。

## 与线上 Wegent API 的关系

已有 Wegent 请求保持不变：`model: "namespace#team_name"`，不传 `execution` 即走原有智能体链路，原有工具、鉴权和数字 response ID 行为保持不变。新建 Wework 会话显式传 `execution: {"type": "wework", "device_id": "..."}`，此时 `model` 使用 Wework 模型目录返回的 ID。

Wework 支持 `X-API-Key` 和 `Authorization: Bearer`，都要求个人 API Key。会话及模型发现接口目前提供 Wework 数据，支持 `execution=wework`；其他值会被拒绝。会话列表支持 `device_id` 筛选。原有 `/api/tasks`、`/api/models` 等接口保持不变。`DELETE /responses/{id}` 保留线上行为，Wework 暂不提供删除操作。

OpenAI SDK 的 `base_url` 设置为 `https://example.com/api/v1`，通过 `extra_body={"execution": {"type": "wework", "device_id": "..."}}` 传执行目标。标准 `model`、`input`、`stream`、`background` 参数正常传入。仅支持 Responses 的文本子集，不接受智能体专用工具、附件或生成参数，非法组合返回 422。

## 接口

| 方法与路径（省略前缀） | 用途 |
| --- | --- |
| `GET /devices` | 当前用户的设备列表（含离线设备） |
| `GET /conversations?limit=20&after=...` | 当前在线设备上的独立会话列表 |
| `GET /conversations/{id}?limit=20&before=...` | 分页消息历史及 `latest_response` |
| `POST /responses` | 创建新对话或继续已有对话 |
| `GET /responses/{id}` | 从 Runtime 查询指定轮次的状态与输出 |
| `GET /responses/{id}?stream=true` | 订阅该轮次的新输出 |
| `POST /responses/{id}/cancel` | 请求停止该轮次 |
| `GET /models` | 当前用户可用于创建 Codex 对话的模型 |

每次用户提问是一轮 response。response ID 包含 Runtime 地址和原生用户消息身份，不依赖 backend 的映射表；它不是授权凭证。每次查询、续写、停止都会重新校验用户可访问的设备和会话。

PC、手机版创建的会话也可查询。会话详情中的 `latest_response.id` 可直接用于查询、订阅和停止。`is_latest` 表示是否为当前会话最后一轮；`status` 表示该轮执行状态。

## 创建任务

先调用 `/devices` 选择设备，再调用 `/models` 获取模型 `id`。设备列表使用相同的个人 API Key，返回格式如下：

```json
{
  "object": "list",
  "data": [
    {
      "device_id": "your-device-id",
      "name": "My Wework",
      "status": "online",
      "device_type": "local",
      "is_default": true
    }
  ]
}
```

`status` 为 `online`、`offline` 或 `busy`；无设备时 `data` 为空数组。新建会话将选中的 `device_id` 放入 `execution.device_id`。`is_default` 仅供参考，不会自动选择设备。设备在线不代表一定能接受任务，执行时仍会校验远程控制权限和 Runtime 能力。

```bash
curl -N 'https://example.com/api/v1/responses' \
  -H "Authorization: Bearer $WEGENT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "public:default:0:my-model",
    "input": "检查工作区并介绍当前项目",
    "stream": true,
    "execution": {
      "type": "wework",
      "device_id": "your-device-id",
      "title": "API 独立对话"
    }
  }'
```

- `stream: true`：返回 Responses SSE 事件，包含 `response.created`、`response.output_text.delta` 和终态事件。
- `background: true, stream: false`：等待 Runtime 接受任务后立即返回 response ID，使用 GET 查询结果。
- 两者均为 false：等待该轮结束后返回 response 对象。
- `input` 支持字符串或 `role: "user"` 的文本消息数组；内容块类型为 `input_text`。
- 创建和续写目前使用 Codex Runtime。工具执行由 Runtime 自身配置；本接口不接受客户端 function tool 定义或 tool output 回传，不支持客户端注入 assistant 历史。
- `execution.model_type` 可消除模型来源歧义；推荐直接使用 `/models` 返回的完整 ID。`model_options` 传递现有 Runtime 的模型选项，资源身份始终由服务端模型目录决定。

云模型的上游协议由 backend 的 Model 配置决定，不由 `model_options` 覆盖。Runtime 按该配置转换 OpenAI Responses、Chat Completions 或 Anthropic Messages 请求及流式响应；对外仍统一使用 Responses 协议。模型服务的 API Key 只保留在 backend。

继续对话时传 `conversation`，不再传设备和标题：

```json
{
  "model": "public:default:0:my-model",
  "conversation": "conv_...",
  "input": "继续检查测试覆盖率",
  "background": true
}
```

也可用 `previous_response_id` 代替 `conversation`。它必须是会话最近一个已结束的轮次；不支持从历史轮次创建分支。正在运行的会话返回 409，由调用方等待或先停止。

## 状态、实时输出与停止

状态包括 `queued`、`in_progress`、`completed`、`failed`、`cancelled` 和 `incomplete`。GET 从原生消息历史构造当前快照；模型信息来自 Runtime 当前的会话配置。

重新订阅正在运行的 response 时，SSE 从订阅时刻的新事件开始，`response.created.output` 为空；已有内容通过普通 GET 查询。已完成 response 的流式查询会返回结果快照及终态事件。`sequence_number` 只在当前连接内有效，不支持 `starting_after` 或历史事件重放。

断开 SSE 不会取消任务。停止请求返回 `cancellation_requested: true` 表示 Runtime 已接受停止请求，最终状态继续通过 GET 查询。已结束的旧轮次不会停止会话中的新任务；无法安全定位原生轮次时返回 409。

设备必须在线且允许远程控制。设备离线时，API 无法读取或执行其会话。RPC 提交超时不代表任务未执行：错误响应中的 `response_id` 和 `conversation_id` 可用于检查结果，避免盲目重复提交。

## 实现结构

```mermaid
flowchart LR
    Client[API Client] --> Auth[个人 API Key 鉴权]
    Auth --> Devices[Device list / existing device service]
    Auth --> Routing[Execution / resource ID routing]
    Routing --> Wegent[Existing Wegent execution]
    Routing --> Adapter[Responses 协议适配]
    Adapter --> RPC[现有 Runtime RPC]
    RPC --> Runtime[设备 Runtime 会话与消息]
    Runtime --> Relay[设备事件入口]
    Relay --> PubSub[临时 Redis Pub/Sub]
    PubSub --> SSE[SSE 订阅]
    SSE --> Client
```

Redis 仅转发在线订阅事件，不写入键、事件日志或 response 状态；异步任务由 Runtime 执行，backend 不启动独立任务执行器。

设备定向操作在 RPC 前校验归属和在线路由：离线返回 HTTP 503，`detail.code` 为 `device_offline`；无权访问或设备不存在返回 404。查询单个会话或 response 只请求目标设备。断网尚未被心跳检测到时，RPC 仍可能等待超时。
