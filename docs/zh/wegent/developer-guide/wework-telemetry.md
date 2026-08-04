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

PostHog 在发送前会再次按事件级白名单删除 SDK 自动附加的 URL、referrer、用户画像和其他非必要属性；SDK 自动生成且未登记的事件会被直接丢弃。WebView 与 Tauri 原生 Sentry 事件会删除请求、用户、面包屑、附加上下文、源码片段、本机文件路径和局部变量，并对异常消息里的路径、邮箱和类 token 字符串进行脱敏。异常类型和受信任的 Wework 栈位置会被保留。WebView 错误栈仅保留 Wework 自身可信应用资源的文件地址、函数、行列号和 Source Map Debug ID；URL 的 query、fragment 与凭证会被删除，用户文件、外部页面和其他不可信路径会显示为 `<redacted>`。桌面 E2E 使用本地接收器验证用户选择前没有请求、明确同意后才发送，并检查真实请求体不含测试工作区路径、认证令牌、模型 Key 或用户邮箱。

Wework 不向 PostHog 或 Sentry 发送账户用户 ID。Sentry 使用 localStorage 中保存的 `installation_id` 标签和每次会话的 `telemetry_session_id`；PostHog 使用 SDK 自生成的 `distinct_id` 和 `$session_id`。这些标识都是匿名的、与登录账户无关，并在用户关闭遥测时旋转，避免重新开启后继续关联关闭前的数据。

## 事件目录

事件只记录有产品决策价值的功能采用、漏斗结果和可靠性结果，不记录普通按钮点击。

| 领域             | 事件                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ |
| 应用、导航与认证 | `app_started`、`feature_opened`、`authentication_completed`                                |
| 项目与对话       | `project_opened`、`project_created`、`project_removed`、`conversation_created`             |
| 任务执行         | `task_started`、`first_response_completed`、`task_completed`                               |
| 项目空间与看板   | `board_view_opened`、`board_item_created`、`board_item_moved`、`feature_action_completed`  |
| 插件             | `plugin_center_opened`、`plugin_installed`、`plugin_enabled_changed`、`plugin_uninstalled` |
| 自动化           | `automation_action_completed`                                                              |
| 内置浏览器       | `browser_navigation_completed`、`browser_download_completed`                               |
| 云端、交付与更新 | `cloud_connection_changed`、`delivery_completed`、`app_update_install_started`             |
| 反馈与应用快照   | `feedback_submitted`、`appshot_received`                                                   |
| 工作区面板       | `workspace_panel_added`                                                                    |
| AI 分析          | `$ai_trace`、`$ai_generation`、`$ai_feedback`                                              |
| 隐私设置         | `telemetry_preference_changed`，仅在用户重新开启遥测后记录                                 |

跨领域的资源操作统一使用 `feature_action_completed`，其 `domain` 和 `action` 都是受控枚举，覆盖项目空间、任务卡片、任务关联、附件与工作区文件、AI 表格、插件、Skill、MCP、Hooks、Sites、模型、Git、云设备、快捷短语和归档会话。关键业务的已处理失败统一使用 `operation_failed` 和有限的操作类型，不上传异常消息。资源 ID、项目名、插件名、URL、文件路径和用户输入均不属于事件属性。功能代码应在 API 或本机操作确认成功后打点，失败回滚路径不得误报成功。

## AI 分析事件

Wework 针对 agent 任务 trace、LLM generation 和用户反馈上报 PostHog AI 分析事件。这些事件同样遵循隐私边界：只包含元数据和受控枚举值，绝不包含提示词、模型输出、用户文本、文件路径或凭据。

| 事件              | 用途                                                                 | 关键属性                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `$ai_trace`       | 一次完整的 agent 任务 / 对话轮次，在任务开始和结束时各上报一次。     | `$ai_trace_id`（稳定的任务 ID）、`$ai_trace_phase`（`start` 或 `end`）、`execution_target`、`duration_ms`（仅 end）、`result`（`success`、`failure` 或 `cancelled`；仅 end）、`failure_reason`（有限的失败分类；仅 result 为 `failure` 时）。                                         |
| `$ai_generation`  | 每一次由 LLM 驱动的助手回复，从助手开始生成到生成结束进行测量。      | `$ai_generation_id`、`$ai_parent_id`（父任务 ID）、`$ai_model`、`$ai_provider`、`$ai_input_tokens`、`$ai_output_tokens`、`$ai_total_tokens`、`$ai_latency`、`$ai_latency_ms`、 `$ai_cost`（识别到模型时的最佳 effort 美元估算）、`result`。                                          |
| `$ai_feedback`    | 用户在任务反馈弹窗中对 AI 结果给出的“赞/踩”评分。                    | `$ai_trace_id`（有任务 ID 时带上）、`$ai_feedback_type`（`positive` 或 `negative`）、`source`（`task_dialog`）、`attachment_count`（分箱为 `0`、`1`、`2-5` 或 `6+`）、`has_comment`。                                                                                                |

`$ai_trace_id` 与 `$ai_parent_id` 复用已有的稳定 `taskId`，无需引入新的关联 ID 即可把 trace、generation 和 feedback 关联起来。`$ai_cost` 目前由客户端通过一张小型已知模型价格表进行最佳 effort 估算，因为后端暂未暴露每次调用的实际成本；后续应在后端提供真实成本后替换为后端值。

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
