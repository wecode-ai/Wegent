---
sidebar_position: 1
---

# 智能工作台首版统计设计

## 背景

智能工作台可从市场安装，也可通过导入 ZIP 包安装。已安装的工作台可
从市场、我的工作台或其运行页面进入。首版统计需要回答三个产品问题：

1. 用户是否进入智能工作台的发现与管理入口？
2. 市场安装、ZIP 导入和市场更新是否真正完成？
3. 安装后，用户是否实际打开了一个已安装的智能工作台？

首版只覆盖可稳定定义业务成功条件的核心漏斗，不采集工作台内容、名称、
标识符或本地文件信息。

## 目标

- 建立“浏览 → 安装或更新 → 打开”的全局智能工作台漏斗。
- 区分市场首次安装、ZIP 导入安装和市场更新，避免把更新计入新增安装。
- 只在事实成立后记录成功；失败记录为独立、可聚合的失败操作。
- 复用现有 telemetry 客户端和事件契约，保留现有属性白名单与值约束。

## 非目标

- 不统计搜索、筛选、详情浏览或卡片点击。
- 不统计工作台创建、复制、关联目录、导出、删除、开发助手、添加插件。
- 不按具体工作台、市场条目或 ZIP 包比较使用量；这些需要标识符，超出
  客户端 telemetry 的隐私边界。
- 不统计“点击安装”“开始导入”等尚未完成的意图事件，也不为取消文件选择
  记录失败。

上述动作在第二阶段根据产品问题再设计，不能以首版事件做替代。

## 事件模型

### 入口打开

复用 `feature_opened`，不在页面组件中手动调用 `track()`。路由统一统计
逻辑根据 `pathname` 和 `search` 映射以下 feature：

| 用户可见入口 | 路由条件 | `feature_opened.feature` |
| --- | --- | --- |
| 智能工作台市场 | `/sites?app_type=smart_app`，且非“我的工作台”视图 | `smart_apps_marketplace` |
| 我的工作台 | `/sites?app_type=smart_app&view=owned` | `smart_apps_owned` |
| 已安装的具体工作台 | `/app/harness-*` | `smart_app` |

路由映射必须在通用 `/sites` 与 `/app/*` 映射之前判断。路径相同但查询参数
不同的前两类入口必须被区分；因此路由统计的 effect 依赖中也要包含 `search`。

进入具体工作台页面即代表“打开”入口已到达，不能再在启动、恢复或页面组件
中重复发送同一打开事件。该事件衡量入口打开，而非工作台内部功能是否完成。

### 成功事件

首次安装需要携带粗粒度来源，因此新增专属事件：

```ts
smart_app_installed: {
  install_source: 'marketplace' | 'zip_import'
}
```

市场更新不是一次新增安装，复用普通成功事件：

```ts
feature_action_completed: {
  domain: 'smart_app'
  action: 'update'
}
```

`smart_app_installed` 的 `install_source` 不得包含市场条目 ID、工作台名称、
包名、文件名或本地路径。`feature_action_completed.domain` 需扩展
`'smart_app'` 枚举；更新来源当前固定为市场，故不另加属性。若以后支持其他
更新通路，届时再用受限枚举扩展该事件，而不是传入工作台标识。

### 失败事件

复用 `operation_failed`，扩展 `operation` 枚举：

```ts
'smart_app_marketplace_download'
'smart_app_marketplace_install'
'smart_app_marketplace_update'
'smart_app_zip_import'
```

市场获取待安装版本失败使用 `smart_app_marketplace_download`。安装 API
失败根据当前安装意图区分首次安装与更新。ZIP 文件预览、校验或实际安装失败
统一使用 `smart_app_zip_import`；不上传错误正文、路径、文件名或包内容。

## 事实发生点

| 流程 | 成功记录时点 | 成功事件 | 失败记录时点 | 失败事件 |
| --- | --- | --- | --- |
| 市场首次安装 | `harnessAppsApi.install(...)` 已成功返回且本地安装状态确认完成后 | `smart_app_installed { install_source: 'marketplace' }` | 获取描述失败，或安装失败 | `smart_app_marketplace_download` / `smart_app_marketplace_install` |
| 市场更新 | 同一安装调用成功且本地状态确认完成后 | `feature_action_completed { domain: 'smart_app', action: 'update' }` | 获取描述失败，或更新安装失败 | `smart_app_marketplace_download` / `smart_app_marketplace_update` |
| ZIP 导入 | ZIP 预览、校验和 `harnessAppsApi.install(...)` 均成功，且本地状态确认完成后 | `smart_app_installed { install_source: 'zip_import' }` | 预览、校验或安装失败 | `smart_app_zip_import` |

市场安装流程须在创建待安装状态时保存显式意图
`'install' | 'update'`。不得依靠按钮文案或安装完成后的版本比较推断意图，
否则刷新列表或异步状态变化可能把更新错误计为首次安装。

同一用户手动重试一次已失败的操作，视为一次新的业务尝试：若最终失败，记录
一次对应失败事件；若成功，只记录一次对应成功事件。文件选择器取消不构成业务
失败，不发送事件。

## 事件契约与隐私

新增或扩展事件时，`wework/src/telemetry/events.ts` 的以下三处必须同步：

1. `AnalyticsEventMap`：事件及属性的 TypeScript 契约。
2. `ANALYTICS_EVENT_PROPERTY_KEYS`：允许发送的属性白名单。
3. `ANALYTICS_EVENT_VALUE_CONSTRAINTS`：枚举值约束。

任何事件均不得包含：智能工作台 ID、市场 ID、插件 ID、名称、ZIP 文件名或
路径、目录、原始错误、模型名称、用户输入或工作台内容。客户端只发送本设计
列出的固定枚举属性；更细粒度的应用表现应由服务端在适当的权限与隐私设计下
聚合，而不是向 PostHog 透传标识符。

## 可得到的指标

在不增加用户内容或工作台标识符的前提下，首版可按用户、会话和时间窗口得到：

- 智能工作台市场、我的工作台和已安装工作台的打开量。
- 市场安装量与 ZIP 导入安装量。
- 市场更新量，且不污染首次安装量。
- 市场下载、安装、更新及 ZIP 导入的失败量与失败率。
- 从安装成功到随后打开具体工作台的整体转化率。该指标是跨事件的漏斗分析，
  不要求也不新增关联 ID。

## 验证策略

### 事件契约

- 为新增 `feature_opened.feature`、`feature_action_completed.domain`、
  `operation_failed.operation` 和 `smart_app_installed.install_source` 编译并
  断言类型、属性白名单和值约束。
- 在 telemetry 客户端测试中断言未列入白名单的标识符与敏感字段不会被发送。

### 路由

- 对市场、我的工作台和 `/app/harness-*` 分别断言一次正确的
  `feature_opened` 调用。
- 对非智能工作台的既有 `/sites` 与 `/app/*` 路由保留原有 feature，防止
  特例改变其他入口的统计。
- 改变同一路径的查询参数时，断言统计映射按新视图更新。

### 安装业务

- 市场首次安装：mock API 成功前不记录；成功并完成状态更新后，仅记录一次
  `smart_app_installed { install_source: 'marketplace' }`。
- 市场更新：仅记录一次 `feature_action_completed` 的 `smart_app/update`，不
  记录 `smart_app_installed`。
- ZIP 导入：仅在预览、校验与安装均成功后记录一次
  `smart_app_installed { install_source: 'zip_import' }`。
- 各失败分支只记录对应 `operation_failed`，不同时记录成功；取消选择 ZIP 不
  记录任何安装或失败事件。

实现阶段先完成上述单元/组件测试；变更触及 Wework UI 与 Electron 本地流程时，
再依照 `wework/AGENTS.md` 为受影响核心流程补充 CI 覆盖的桌面 E2E，并在隔离
的真实 Electron 会话中完成验证。

## 分期

本设计为第一阶段。第二阶段再评估搜索、筛选、详情、创建/复制、关联目录、
导出、删除、开发助手和添加插件的统计需求。只有在明确某项决策需要它们时，
才定义新的成功条件、粗粒度枚举与隐私边界。
