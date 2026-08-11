---
sidebar_position: 26
---

# Wework 遥测与产品分析

Wework 将产品使用分析、桌面错误诊断和服务端可观测性分开处理：

- PostHog 接收白名单产品事件。
- Sentry 接收 React WebView 异常和 Tauri/Rust panic。
- 服务端与 Executor 继续通过 OpenTelemetry Collector 上报 trace 和 metric。

## 隐私边界

Wework 首次启动时会明确询问用户是否允许共享匿名使用情况和错误诊断数据。在用户作出选择前，前端和原生端遥测均保持关闭。用户之后可以在“设置 > 通用 > 隐私”中修改选择；关闭后，Wework 会停止两个客户端 SDK、清空未发送事件并重置分析身份。

产品分析事件不得包含聊天、提示词、模型回复、代码、文件名、文件路径、仓库名、终端内容、凭据或认证信息。业务代码只能调用 `src/telemetry/client.ts`，不得直接调用 PostHog 或 Sentry SDK。新增事件必须先加入 `AnalyticsEventMap` 和运行时属性白名单。

PostHog 在发送前会再次按事件级白名单删除 SDK 自动附加的 URL、referrer、用户画像和其他非必要属性；SDK 自动生成且未登记的事件会被直接丢弃。WebView 与 Tauri 原生 Sentry 事件会删除请求、用户、面包屑、附加上下文、原始异常文本、源码片段、本机文件路径和局部变量。WebView 错误栈仅保留 Wework 自身可信应用资源的文件地址、函数、行列号和 Source Map Debug ID；URL 的 query、fragment 与凭证会被删除，用户文件、外部页面和其他不可信路径会显示为 `<redacted>`。桌面 E2E 使用本地接收器验证用户选择前没有请求、明确同意后才发送，并检查真实请求体不含测试工作区路径、认证令牌、模型 Key 或用户邮箱。

Wework 不向 PostHog 或 Sentry 发送账户用户 ID。Sentry 使用 localStorage 中保存的 `installation_id` 标签和每次会话的 `telemetry_session_id`；PostHog 使用 SDK 自生成的 `distinct_id` 和 `$session_id`。这些标识都是匿名的、与登录账户无关，并在用户关闭遥测时旋转，避免重新开启后继续关联关闭前的数据。

## 事件目录

事件只记录有产品决策价值的功能采用、漏斗结果和可靠性结果，不记录普通按钮点击。

| 领域             | 事件                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ |
| 应用、导航与认证 | `app_started`、`feature_opened`、`authentication_completed`                                |
| 项目与对话       | `project_opened`、`project_created`、`project_removed`、`conversation_created`             |
| 任务执行         | `task_started`、`first_response_completed`、`task_completed`、`task_interrupted`、`task_retried` |
| 项目空间与看板   | `board_view_opened`、`board_item_created`、`board_item_moved`、`feature_action_completed`  |
| 插件             | `plugin_center_opened`、`plugin_installed`、`plugin_enabled_changed`、`plugin_uninstalled` |
| 自动化           | `automation_action_completed`                                                              |
| 内置浏览器       | `browser_navigation_completed`、`browser_download_completed`                               |
| 云端、交付与更新 | `cloud_connection_changed`、`delivery_completed`、`app_update_install_started`             |
| 反馈与应用快照   | `feedback_submitted`、`appshot_received`                                                   |
| 工作区面板       | `workspace_panel_added`、`workspace_panel_removed`                                          |
| 设置             | `setting_changed`                                                                          |
| AI 分析          | `$ai_trace`、`$ai_generation`、`ai_output_action_completed`、`generation_regenerated`      |
| 隐私设置         | `telemetry_preference_changed`，仅在用户重新开启遥测后记录                                 |

跨领域的资源操作统一使用 `feature_action_completed`，其 `domain` 和 `action` 都是受控枚举，覆盖项目空间、任务卡片、任务关联、附件与工作区文件、AI 表格、插件、Skill、MCP、Hooks、Sites、模型、Git、云设备、快捷短语和归档会话。关键业务的已处理失败统一使用 `operation_failed` 和有限的操作类型，不上传异常消息。资源 ID、项目名、插件名、URL、文件路径和用户输入均不属于事件属性；唯一的例外是下文描述的 AI 关联 ID，它们是按运行生成的透明关联 token，而非原始 ID。功能代码应在 API 或本机操作确认成功后打点，失败回滚路径不得误报成功。

## AI 分析事件

Wework 针对 agent 任务 trace、LLM generation 和用户反馈上报 PostHog AI 分析事件。这些事件同样遵循隐私边界：只包含元数据和受控枚举值，绝不包含提示词、模型输出、用户文本、文件路径或凭据。

| 事件              | 用途                                                                 | 关键属性                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `$ai_trace`       | 一次任务运行，在运行开始和结束时各上报一次。                         | `$ai_trace_id`（运行开始时生成的透明 per-run id）、`$ai_trace_phase`（`start` 或 `end`）、`execution_target`、`duration_ms`（仅 end）、`result`（`success`、`failure` 或 `cancelled`；仅 end）、`failure_reason`（有限的失败分类；仅 result 为 `failure` 时）。                                 |
| `$ai_generation`  | 每一次由 LLM 驱动的助手回复，从助手开始生成到生成结束进行测量。      | `$ai_generation_id`、`$ai_trace_id`（该运行所属的透明 trace id；这是 PostHog 要求并用来把 generation 归入同一 trace 的属性）、`$ai_parent_id`（同一 per-run id，保留用于树状嵌套）、`$ai_model`（运行时目录枚举）、`$ai_provider`（已知提供方的有界枚举）、`$ai_input_tokens`、`$ai_output_tokens`、`$ai_total_tokens`、`$ai_latency`（秒）、`$ai_cost`（识别到模型时的最佳 effort 美元估算）、`result`。                                           |

任务是一个可被重复运行的稳定资源，因此 trace 关联必须限定在**单次运行**内，而不是绑定任务 ID。运行开始时，客户端生成一个透明的 `t-<base36>` trace id，本次运行期间发出的每条 `$ai_trace` 和 `$ai_generation` 都共享它；运行结束时该 id 被丢弃，下一次运行会重新生成。如果所有运行都复用同一任务 ID 派生的 trace id，不同运行会被合并进同一条 PostHog trace，导致按运行统计的时长、token、成本全部失真。每条 `$ai_generation` 在助手开始时捕获当前运行的 trace id，因此即使运行与 generation 并发结束，关联也不会丢失。若窗口在运行进行中关闭，会补发一条 `$ai_trace` `end`（`result=cancelled`），避免留下永不闭合的 trace。运行时白名单会强制 `$ai_trace_id`、`$ai_parent_id` 符合哈希后的 `t-<base36>` 格式、`$ai_generation_id` 符合 UUID 格式，因此未经哈希的原始任务 ID 永远不会作为关联属性被上报。

generation 的 token 数（`$ai_input_tokens`、`$ai_output_tokens`、`$ai_total_tokens`）取自该次运行在结束事件中携带的自身 context usage，保证计数归属于它所描述的 generation，而不会串到同一任务的并发运行上；当运行没有上报某轮的 usage 时，这些 token 属性会被省略。

`$ai_trace` `end`、`task_completed` 与 `first_response_completed` 的 `result` 在运行时上报了本轮（generation）结果时，会以该运行最后一次助手回合的实际结果为准：若运行内唯一的 generation 失败或被取消，这些事件会如实上报 `failure` 或 `cancelled`，而不是默认报 `success`；当运行时没有上报任何 generation 结果时，才回退到任务记录的状态。

`$ai_model` 是**动态有界**的枚举，取值来自当前 Wework 模型目录——该目录只由三个模型渠道（Codex 模型、自配提供方 profile、云端模型）提供，因此应用暴露出的任何模型 ID 都是合法枚举值，其余一律归入 `other`；用户自定义的模型显示名绝不发送。`$ai_provider` 是已知提供方的有界枚举，按以下优先级推导：先按模型 ID 前缀识别厂商（如 `moonshot-kimi-*`、`kimi-*` 归 `moonshot`，`deepseek-*` 归 `deepseek`，`minimax-*` 归 `minimax`，`gpt-*` 归 `openai`）；未命中时，官方 Codex 目录模型统一归 `openai`（它们全部经 Wework 的 openai-responses 路由转发）；最后才回退到模型配置里的 provider 字符串。**注意**：provider 字符串是自由文本——云端模型与自配模型渠道都可能把 API 传输协议（如经 anthropic-messages 接入的 Kimi 会写成 `anthropic`）而非真实厂商写入该字段，因此当模型 ID 无法识别时，`$ai_provider` 可能是脏数据，按提供方聚合或核算成本时应以模型 ID 为准。`$ai_cost` 目前由客户端通过一张小型已知模型价格表进行最佳 effort 估算，因为后端暂未暴露每次调用的实际成本；它只是客户端侧的估算，PostHog 会根据模型、提供方和 token 数自行计算成本，因此 `$ai_cost` 不应作为成本口径的权威来源；后续应在后端提供真实成本后替换为后端值。

旧版本构建曾以不同的 schema 上报 AI 事件：trace id 为 `runtime-<id>` 且 generation 上不带 `$ai_trace_id`，provider 为 `claude` 等原始字符串，并存在 `$ai_trace_summary` 事件。当前白名单会丢弃上述 schema 之外的事件与属性，因此新构建只会上报本文档描述的格式；但旧版 emitter 产生的历史数据仍可能出现在项目里。

## 体验优化事件

除上述生命周期与 AI 分析事件外，客户端还会上报关于质量闭环与摩擦点的有界元数据，以便在不暴露内容的前提下支撑产品决策：

- `ai_output_action_completed`（`action`：`copy`、`open_file`、`run`、`apply`、`expand`、`accept` 或 `reject`；`source`：`chat`、`workbench` 或 `board`）——用户对 AI 产出执行操作（如复制代码块、打开 agent 动过的文件）时上报。只记录动作类型，绝不包含被复制文本或文件路径。
- `generation_regenerated` —— 任务在已有一次运行后再次运行时上报，表示用户重新提问/修改了请求。它与 `task_interrupted` 分开统计：重新提问只会排入新的一轮，不会把运行标记为停止。
- `task_interrupted` —— 仅在用户显式停止当前回复时上报（暂停按钮或"打断并立即发送"）；`after_first_response` 区分在首次回复前还是之后停止。普通的重新提问不会触发该事件。
- `task_retried` —— 同一任务在上次完成后 60 秒内再次运行时上报（含 `previous_result`），用于识别不耐烦或反复失败的场景。
- `setting_changed`（`setting`：`appearance_mode`、`accent_color` 或后续新增键；`value`）—— 用户修改关键设置时上报，当前已接入外观主题模式与强调色。
- `workspace_panel_removed` —— 关闭工作区面板时上报，与 `workspace_panel_added` 互补。

## 配置

前端构建变量：

| 变量                                    | 用途                                       |
| --------------------------------------- | ------------------------------------------ |
| `VITE_WEWORK_POSTHOG_KEY`               | PostHog 项目 Key；为空时不启用产品事件上报 |
| `VITE_WEWORK_POSTHOG_HOST`              | PostHog 接收地址；默认 `https://us.i.posthog.com`；欧盟托管项目使用 `https://eu.i.posthog.com` |
| `VITE_WEWORK_SENTRY_DSN`                | WebView Sentry DSN                         |
| `VITE_WEWORK_SENTRY_TRACES_SAMPLE_RATE` | WebView 性能采样率，默认 `0.05`            |
| `VITE_WEWORK_TELEMETRY_ENVIRONMENT`     | `development`、`staging` 或 `production`   |
| `VITE_WEWORK_RELEASE_CHANNEL`           | 发布渠道                                   |

WebView 层在构建时读取 `VITE_WEWORK_SENTRY_DSN`，原生 Tauri 层在运行时读取 `WEWORK_SENTRY_DSN`（或在构建时嵌入）。两者应指向同一个 Sentry 项目；部署和本地开发配置时请保持这两个变量一致。原生 Tauri 层还读取 `WEWORK_TELEMETRY_ENVIRONMENT`。

## 纵深防御部署设置

客户端脱敏是第一道防线，但项目级服务端设置也必须尽量减少持久化数据。

WebView 与 Tauri 原生层使用的 Sentry 项目应：

- 开启 `scrubIPAddresses`，避免 Sentry 保存客户端 IP。
- 开启 `dataScrubberDefaults` 与 `enhancedPrivacy`，对事件、面包屑和 trace 数据启用内置 PII 脱敏。
- 配置 `relayPiiConfig`，在数据落盘之前 redact 本地文件路径、邮箱地址、bearer token 以及类似 API key 的值。示例：

```json
{
  "rules": {
    "remove_ips": { "type": "ip", "redaction": { "method": "remove" } },
    "remove_emails": {
      "type": "pattern",
      "pattern": "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
      "redaction": { "method": "remove" }
    },
    "remove_paths": {
      "type": "pattern",
      "pattern": "([A-Za-z]:)?(/|\\\\)(Users|home|tmp|var|private)(/|\\\\)[^\\s\\\"]*",
      "redaction": { "method": "replace", "text": "<redacted>" }
    },
    "remove_tokens": {
      "type": "pattern",
      "pattern": "(token|key|bearer)\\s*[:=]\\s*[\"']?[^\\s\"']+[\"']?",
      "redaction": { "method": "replace", "text": "<redacted>" }
    }
  },
  "applications": {
    "freeform": ["remove_ips", "remove_emails", "remove_paths", "remove_tokens"],
    "username": ["remove_ips", "remove_emails"],
    "$string": ["remove_emails", "remove_paths", "remove_tokens"]
  }
}
```

PostHog 项目应：

- 正确设置 `VITE_WEWORK_POSTHOG_HOST`。默认值为 `https://us.i.posthog.com`；欧盟托管项目使用 `https://eu.i.posthog.com`；私有化部署使用对应接收地址。
- 在项目级别关闭 Session Replay 与 autocapture，作为客户端开关的兜底；Wework 不会发送回放数据或自动采集事件。
- 保持 person profiles 关闭；Wework 已设置 `person_profiles: 'never'` 与 `$process_person_profile: false`，PostHog 不会基于匿名事件构建用户画像。
- 将项目级 IP 匿名化或 `$_` 采集设置作为 `$geoip_disable: true` 的兜底，Wework 已在每个事件上发送该属性。

## 指标基数

OpenTelemetry metric 只能使用平台、版本、结果、错误类别等有界枚举维度。`user_id`、`task_id`、`team_id`、路径和任意名称只能进入受控事件或 trace，不能作为 metric attributes。

Session Replay、autocapture、页面自动采集和外部依赖动态加载均保持关闭。
