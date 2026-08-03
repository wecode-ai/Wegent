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

PostHog 在发送前会再次按事件级白名单删除 SDK 自动附加的 URL、referrer、用户画像和其他非必要属性；SDK 自动生成且未登记的事件会被直接丢弃。WebView 与 Tauri 原生 Sentry 事件会删除请求、用户、面包屑、附加上下文、异常原文、源码片段、本机文件路径和局部变量。WebView 错误栈仅保留 Wework 自身可信应用资源的文件地址、函数、行列号和 Source Map Debug ID；URL 的 query 与 fragment 会被删除，用户文件、外部页面和其他不可信路径会显示为 `<redacted>`。桌面 E2E 使用本地接收器验证用户选择前没有请求、明确同意后才发送，并检查真实请求体不含测试工作区路径、认证令牌、模型 Key 或用户邮箱。

Wework 不向 PostHog 或 Sentry 发送账户用户 ID。两个 SDK 仅使用独立的随机安装标识和会话标识；用户关闭遥测时会旋转这些标识，避免重新开启后继续关联关闭前的数据。

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
| 隐私设置         | `telemetry_preference_changed`，仅在用户重新开启遥测后记录                                 |

跨领域的资源操作统一使用 `feature_action_completed`，其 `domain` 和 `action` 都是受控枚举，覆盖项目空间、任务卡片、任务关联、附件与工作区文件、AI 表格、插件、Skill、MCP、Hooks、Sites、模型、Git、云设备、快捷短语和归档会话。关键业务的已处理失败统一使用 `operation_failed` 和有限的操作类型，不上传异常消息。资源 ID、项目名、插件名、URL、文件路径和用户输入均不属于事件属性。功能代码应在 API 或本机操作确认成功后打点，失败回滚路径不得误报成功。

## 配置

前端构建变量：

| 变量                                    | 用途                                       |
| --------------------------------------- | ------------------------------------------ |
| `VITE_WEWORK_POSTHOG_KEY`               | PostHog 项目 Key；为空时不启用产品事件上报 |
| `VITE_WEWORK_POSTHOG_HOST`              | PostHog 接收地址                           |
| `VITE_WEWORK_SENTRY_DSN`                | WebView Sentry DSN                         |
| `VITE_WEWORK_SENTRY_TRACES_SAMPLE_RATE` | WebView 性能采样率，默认 `0.05`            |
| `VITE_WEWORK_TELEMETRY_ENVIRONMENT`     | `development`、`staging` 或 `production`   |
| `VITE_WEWORK_RELEASE_CHANNEL`           | 发布渠道                                   |

Tauri 原生端读取 `WEWORK_SENTRY_DSN` 和 `WEWORK_TELEMETRY_ENVIRONMENT`。DSN 既可以在构建时嵌入，也可以在运行时提供。

## 指标基数

OpenTelemetry metric 只能使用平台、版本、结果、错误类别等有界枚举维度。`user_id`、`task_id`、`team_id`、路径和任意名称只能进入受控事件或 trace，不能作为 metric attributes。

Session Replay、autocapture、页面自动采集和外部依赖动态加载均保持关闭。
