---
sidebar_position: 39
---

# Wework 云端模型代理网关

Wework 桌面端与 Wegent 后端可能运行在不同机器上。当桌面端使用配置了真实云端 provider 凭证的 Model CRD 时，必须避免把 provider `api_key` 明文下发到本地，同时保证 Codex 能够正常调用云端模型。

## 解决方案

Wework 使用已配置的云端地址和登录 token 直接构造代理模型配置，由 Wegent 代替 Wework 调用真实 provider。

### 核心组件

- `app/services/llm_proxy_service.py`：解析模型身份、校验权限并转发 provider 请求。
- `POST /api/runtime-work/llm-responses-proxy/responses`：使用用户登录 token 鉴权的代理端点。
- `/models/unified`：下发模型名称、类型、namespace 和资源 owner ID，供代理精确定位 Model CRD。

### 云端模型预设的默认位置

Model CRD 的 `spec.modelConfig.ui.defaultModel: true` 标记默认模型，
`sliderModelsConfig.defaultPreset` 指定默认滑条预设。选择该预设时，Wework
优先定位到拥有预设配置的模型，即使它位于 `presets[].models` 的第二项或更后面。
未填写 `reasoningEffort` 的预设项表示只选择模型，同样可以作为默认位置；
填写推理等级时，优先匹配该模型的默认推理等级。没有匹配项时才选择预设中的第一项。

### 请求流程

1. Wework 从 `/models/unified` 获取不含 provider 凭证的模型元数据。
2. Wework 直接构造代理配置：`base_url` 为所配置云端地址下的 `/api/runtime-work/llm-responses-proxy`，`api_key` 为当前云端登录 token。
3. executor 的 Codex compat proxy 使用登录 token 请求 backend，并携带模型类型、namespace 和资源 owner ID。
4. backend 验证登录 token 和模型访问权限，按 `user_id + namespace + name` 精确解析 Model CRD。
5. backend 取出真实 provider 配置，将请求中的模型名称改写为 provider `model_id`，再流式转发请求和响应。

### 协议与端点解析

代理网关支持 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages。Model CRD 的 `protocol`、`apiFormat` 和 `wire_api` 决定实际请求协议；配置互相冲突或无法确定协议时，backend 会直接返回配置错误，不会静默回退到其他协议。

provider `base_url` 可以是服务根地址、带版本前缀的 API base，或已经包含协议端点的完整地址。网关按路径段合并协议端点并去除重叠部分，例如：

- `https://api.anthropic.com` 和 Anthropic Messages 解析为 `/v1/messages`。
- `https://proxy.example.com/v1` 和 Anthropic Messages 仍解析为 `/v1/messages`，不会生成 `/v1/v1/messages`。
- 已包含 `/responses`、`/chat/completions` 或 `/v1/messages` 的地址不会重复追加端点。

#### Responses 思考配置与请求模式

Model CRD 的 `modelConfig.env.thinking_config.reasoning`（也接受 `thinkingConfig`）作为 Wework 的默认思考设置。模型目录只下发受支持的 `effort` 和 `summary`，不会下发完整 env 或 provider 凭证。选择器采用配置的默认强度；用户显式调整的字段覆盖默认值，同时保留其他默认字段，例如调整 effort 后仍保留 `summary: "detailed"`。

`modelConfig.codex_request_mode` 控制完整的 Codex Responses 请求策略：

| 值              | 行为                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` 或未配置 | 保持现有按协议适配行为；Responses 的原生工具能力仍可用已有开关单独设置。                                                                                            |
| `standard`      | 使用标准 function 工具格式，转换 `tool_search`、namespace 和 custom tools，并恢复返回给 Codex 的工具身份。适用于不支持 Codex 原生工具类型的 Kimi Responses 等服务。 |
| `passthrough`   | 仅替换路由所需的模型 ID 和鉴权信息；其余请求业务字段原样保留，响应流也不做协议改写。仅适用于 OpenAI Responses 上游。                                                |

透传模式保留思考、历史、原始调用 ID、加密内容、`previous_response_id`、`include`、`store` 和扩展字段。它也跳过图片预算裁剪、视觉副模型替换、历史增强、fork/模型切换清理及输出上限注入；配置的 `max_output_tokens` 不会由代理添加到请求中。上游需要直接支持这些 Codex 请求内容。

例如，Kimi Responses 可配置为：

```json
{
  "modelConfig": {
    "codex_request_mode": "standard",
    "env": {
      "model": "openai",
      "model_id": "moonshot-kimi-k3",
      "thinking_config": {
        "reasoning": { "summary": "detailed" }
      }
    }
  }
}
```

完整兼容 Codex 请求的 Responses 服务可将该字段改为 `"passthrough"`。模式配置优先于 `native_tool_search`、`native_namespace_tools` 等单项工具设置；不合法的模式或非 Responses 透传配置会在执行前报错。

模型目录遇到不合法的 `codex_request_mode` 时会忽略该字段，保留模型的其他有效信息，避免一个错误配置导致整个模型列表不可用。目录读取不会修改存储的 Model CRD；实际调用仍校验原始配置，本机和云端执行都会在请求发送至模型服务前返回 HTTP 400。

透传响应保留上游正常数据块的原始字节。若发生读取错误或流在 Responses 终态之前结束，仅追加 `response.failed`；已有 `response.completed`、`response.failed` 或 `response.incomplete` 后不会重复追加。独立的 `[DONE]` 不能代替 Responses 终态。

`standard` 模式只向上游提供客户端可执行的 function tools，不提供 `web_search`、`image_generation` 等服务端内置工具。若请求通过 `tool_choice` 强制选择服务端工具，代理返回 HTTP 400；`auto` 和 `passthrough` 继续保留这些工具。

#### Kimi K3 Chat Completions 兼容

云端 Model CRD 配置为 OpenAI Chat Completions，且 provider 模型名称包含不区分大小写的 `kimi-k3`（例如 `moonshot-kimi-k3`）时，如果 Model CRD 未配置 `codex_catalog_model_id` 或 `codexCatalogModelId`，Wework 会自动选择上下文窗口为 1,048,576 tokens 的 `wework-kimi-k3` Codex 模型目录。显式配置的模型目录始终优先于 Kimi K3 自动选择。Codex 内部仍使用 Responses 协议，executor 在边界将请求转换为 Chat Completions，并为 Kimi K3 进行以下兼容处理：

- 使用 Kimi 支持的 `thinking` 字段，而不是通用的 `reasoning_effort`。
- 在多轮消息和工具调用中保留 `reasoning_content`。
- 可逆地保留 namespace tool 的身份，确保同名工具仍能路由到正确的执行器。
- 保留 function parameters 顶层的 `type: "object"`，将顶层 `anyOf` 约束等价地下沉到 `allOf`，并为 `anyOf` 对象分支补齐类型，满足 Kimi 的工具 schema 校验。

显式配置的 Anthropic Messages 不会被自动改写。运维人员必须在 Model CRD 中通过 `protocol` 或 `apiFormat` 明确选择 OpenAI Chat Completions；如果只保留 `env.model=claude` 且没有协议元数据，请求仍会按 Anthropic Messages 路由到 `/v1/messages`。

云端或远端设备执行任务时，模型选择器同时展示当前桌面端配置的本地模型。首次使用或配置变化后，Wework 会要求用户确认，将自定义 Codex 模型目录同步到目标 Executor，并在设备空闲时重启其 Codex app-server、校验模型已加载，然后再发送任务。Codex 内置模型和云端 Model CRD 仍可直接用于本机或云端执行。

通用云端模型使用 `wework-gpt-6.1-sol` 共享兼容目录作为能力基线，沿用原来 `wework-gpt-5.6-sol` 的目录获取与云端模型调用链路，无需登录官方账号。共享目录保留原有的协议能力，不强制添加推理档位，不启用官方专用的 code mode 或 Responses Lite。云端模型元数据可以覆盖上下文窗口；兼容目录的 `max_context_window` 保持为空，不固定限制云端模型的有效窗口。Codex 官方模型仍保留各自的能力和窗口限制。

### 模型限流重试

executor 的 Codex compat proxy 在上游尚未开始返回响应流、且模型服务返回 HTTP `429 Too Many Requests` 时，会自动重发同一模型请求。默认最多重试 5 次，退避等待依次为 1 秒、5 秒、10 秒、30 秒和 60 秒。

如果上游返回标准 `Retry-After` 响应头，proxy 会优先采用该等待时间，并将单次等待限制在 60 秒以内。非 429 响应不会触发这项策略；重试耗尽后，proxy 会把最后一次 429 状态和错误正文返回给 Codex。已经开始输出的流不会通过这项机制重放，避免重复生成或重复执行工具。

### 重试状态展示

收到 Codex 或模型代理的重试事件后，会话顶部立即显示“正在自动重试…”，
不再只显示思考状态。限流等待保留“模型限流，等待自动重试…”提示。
恢复输出或任务结束后，重试状态自动清除。持续中断时仍会展示详细的重连提示，
ChatGPT 模型同时提供代理设置入口。

该状态以运行时事件为依据；Codex 内部未上报的请求层重试或被隐藏的首次
WebSocket 重试，暂时无法由界面识别。

### Codex 直连模型过载恢复

使用原生 Codex provider 直连模型时，请求不经过 compat proxy。Codex
app-server 报告结构化 `serverOverloaded` 错误后，executor 会等待该轮
`turn/completed` 确认失败轮次已经结束，再在同一 thread、同一模型下恢复。
最多恢复 5 次，等待时间依次为 5、10、20、40 和 60 秒。

恢复使用原生 `turn/start` 的空 `input`，继续已保存的会话历史，不重发原任务、
附件、用户消息 ID 或已合并的 additional context。已经完成的工具结果仍留在
历史中。等待期间任务保持运行并显示重连状态；在重试请求发出前，executor 会
发送恢复事件，让已打开的界面立即清除该轮次的终止错误状态，而不是继续显示
过期的失败卡片。用户取消会立即终止等待，恢复耗尽后才向用户返回最终失败。
额度不足、认证错误、上下文超限、子智能体失败，以及 Codex 自己正在重试的
错误不会触发这项恢复。

executor 持久化已进入恢复的失败轮次 ID。读取原生或缓存历史时，仅清除这些
轮次的终止错误状态，保留用户消息和工具输出，避免重新打开任务后出现已处理
的失败提示。最终耗尽恢复的轮次及其他错误不受影响。

诊断日志 `codex overloaded turn recovery` 记录 thread、重试序号、上限和等待
毫秒数。桌面检查点 `model-overload-recovery` 使用真实 Electron、Codex 和
executor 验证工具结果保留、无重复用户消息、自动恢复与取消。

### Anthropic 空输出恢复

部分 Anthropic Messages 兼容服务可能在 `message_delta` 中返回结束原因和大于零的 `output_tokens`，却没有发送任何文本、思考内容或工具调用。executor 的 Codex compat proxy 会把这种不完整响应转换为失败事件，而不是错误地发出成功完成事件。Codex 随后按流错误恢复机制重试当前模型请求，避免 Wework 在没有 assistant 回复时提前结束任务。

只有完全没有观察到模型输出时才会触发这项检查。已经收到文本、思考内容或工具调用的响应不会被重放；用于连接预热且 `output_tokens` 为零的合法空响应也不受影响。

### Claude Code 工具结果完整性

Claude Code 使用 Anthropic Messages 协议调用 Wework 模型路由。转换到 OpenAI Responses 或 Chat Completions 前，executor 会检查每个 assistant `tool_use` 是否在后续 user 消息中具有同 ID 的 `tool_result`。并行工具结果可以拆分到多个 user 消息并按完成顺序乱序到达；只要整个请求历史中存在匹配结果，代理就必须保留该结果且不得提前补充失败。只有工具进程在返回结果前异常结束、整个历史都缺少匹配结果时，代理才会补充一个明确的失败结果，使请求历史保持协议合法并允许模型继续处理失败；已有的正常工具结果不会被覆盖或重复。

Claude Code 的本地与远端任务、智能体固定模型都使用同一执行器协议桥，支持上述三种云端上游协议。Backend 保留云端模型的真实协议和完整资源身份，不要求上游必须为 Anthropic Messages，也不直接将 Claude 的请求转发给不兼容的接口；协议转换由执行器模型路由完成。

### Namespace 工具兼容

Codex 向 OpenAI Responses API 发送工具时，可以使用 `type: "namespace"` 把多个子工具组织在同一个 namespace 下。OpenAI Chat Completions 和 Anthropic Messages 没有对应的 namespace 字段，因此 executor 的 Codex compat proxy 会在协议转换边界执行可逆映射：

1. 请求转换时，将 namespace 内的子工具展开为 Chat/Anthropic 的普通 function tools。没有重名时保留子工具原名；存在重名时使用包含 namespace 的稳定别名。
2. 别名只使用 Chat function name 允许的字符，并限制在 64 字节内；过长名称使用稳定哈希截断。
3. 历史 tool call 和指定 `tool_choice` 使用同一份映射，避免多轮对话切换工具身份。
4. 上游返回平铺 tool call 后，proxy 恢复原始 `name` 和 `namespace`，再以 Responses 事件交给 Codex 路由。

这个映射属于单次模型请求的协议上下文，不写入模型配置，也不依赖根据工具名猜测 namespace。不同 namespace 中的同名工具仍能准确路由到各自的执行器。

### App 工具按需展开

Wework 不应在新会话的第一次模型请求中注入所有 App 和浏览器子工具的完整 schema。Codex 启动配置只启用 Remote Apps 和 `tool_search`，由模型先搜索需要的 namespace，再把搜索结果中的子工具加入后续模型请求：

- 原生支持 Codex `tool_search` 和 namespace tools 的 Responses 模型直接使用原协议，executor 不重复转换。
- OpenAI Chat Completions、Anthropic Messages 等不支持 namespace tools 的模型由 executor 在协议边界展开本次 `tool_search` 已命中的 namespace。未命中的 App 工具不能出现在请求中。
- executor 必须同时转换当前工具列表、历史 tool call、tool result 和显式 `tool_choice`，并在返回 Codex 前恢复原 namespace 身份。
- 普通消息只携带精简的 `tool_search` 入口；新增 App 或浏览器工具时，不得让首次请求大小随全部工具 schema 线性增长。

协议转换 E2E 必须覆盖 Responses、Chat Completions 和 Anthropic Messages，验证首次请求未展开 namespace、搜索后只出现命中的工具、工具调用与结果可以往返，并对首次工具 JSON 大小设置上限。

## 安全收益

- Wework 桌面端和本地 executor 永远不会拿到真实 provider `api_key`。
- 模型代理与其他 backend API 共用登录 token 的过期和鉴权策略。
- 真实 provider 凭证只留在 backend 内存和数据库中。

## 相关实现

- executor 的 Codex compat proxy 将登录 token 放入 backend 请求的 `Authorization: Bearer` 头。
- backend 使用完整资源身份解析模型，避免个人、公共和群组模型重名时串用配置。
- Wework 创建任务、继续对话和回滚时都直接使用同一代理配置，不再请求单独的模型配置解析接口。
