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

#### Kimi K3 Chat Completions 兼容

云端 Model CRD 配置为 OpenAI Chat Completions，且 provider 模型名称包含不区分大小写的 `kimi-k3`（例如 `moonshot-kimi-k3`）时，如果 Model CRD 未配置 `codex_catalog_model_id` 或 `codexCatalogModelId`，Wework 会自动选择上下文窗口为 1,048,576 tokens 的 `wework-kimi-k3` Codex 模型目录。显式配置的模型目录始终优先于 Kimi K3 自动选择。Codex 内部仍使用 Responses 协议，executor 在边界将请求转换为 Chat Completions，并为 Kimi K3 进行以下兼容处理：

- 使用 Kimi 支持的 `thinking` 字段，而不是通用的 `reasoning_effort`。
- 在多轮消息和工具调用中保留 `reasoning_content`。
- 可逆地保留 namespace tool 的身份，确保同名工具仍能路由到正确的执行器。
- 保留 function parameters 顶层的 `type: "object"`，将顶层 `anyOf` 约束等价地下沉到 `allOf`，并为 `anyOf` 对象分支补齐类型，满足 Kimi 的工具 schema 校验。

显式配置的 Anthropic Messages 不会被自动改写。运维人员必须在 Model CRD 中通过 `protocol` 或 `apiFormat` 明确选择 OpenAI Chat Completions；如果只保留 `env.model=claude` 且没有协议元数据，请求仍会按 Anthropic Messages 路由到 `/v1/messages`。

云端或远端设备执行任务时，模型选择器同时展示当前桌面端配置的本地模型。首次使用或配置变化后，Wework 会要求用户确认，将自定义 Codex 模型目录同步到目标 Executor，并在设备空闲时重启其 Codex app-server、校验模型已加载，然后再发送任务。Codex 内置模型和云端 Model CRD 仍可直接用于本机或云端执行。

### 模型限流重试

executor 的 Codex compat proxy 在上游尚未开始返回响应流、且模型服务返回 HTTP `429 Too Many Requests` 时，会自动重发同一模型请求。默认最多重试 5 次，退避等待依次为 1 秒、5 秒、10 秒、30 秒和 60 秒。

如果上游返回标准 `Retry-After` 响应头，proxy 会优先采用该等待时间，并将单次等待限制在 60 秒以内。非 429 响应不会触发这项策略；重试耗尽后，proxy 会把最后一次 429 状态和错误正文返回给 Codex。已经开始输出的流不会通过这项机制重放，避免重复生成或重复执行工具。

### Anthropic 空输出恢复

部分 Anthropic Messages 兼容服务可能在 `message_delta` 中返回结束原因和大于零的 `output_tokens`，却没有发送任何文本、思考内容或工具调用。executor 的 Codex compat proxy 会把这种不完整响应转换为失败事件，而不是错误地发出成功完成事件。Codex 随后按流错误恢复机制重试当前模型请求，避免 Wework 在没有 assistant 回复时提前结束任务。

只有完全没有观察到模型输出时才会触发这项检查。已经收到文本、思考内容或工具调用的响应不会被重放；用于连接预热且 `output_tokens` 为零的合法空响应也不受影响。

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
