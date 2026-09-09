---
sidebar_position: 1
title: Wework 自动统计与内外网分流设计
status: approved
supersedes:
  - 2026-09-07-wework-smart-app-telemetry-design.md
  - 2026-09-08-smart-app-telemetry-taxonomy-design.md
---

# Wework 自动统计与内外网分流设计

## 文档状态

- 状态：已确认
- 确认日期：2026-09-09
- 适用范围：仅 `wework/`
- 取代文档：
  - `2026-09-07-wework-smart-app-telemetry-design.md`
  - `2026-09-08-smart-app-telemetry-taxonomy-design.md`

本设计是 Wework 统计功能的唯一权威方案。被取代文档中的通用事件复用、手工
调用点和旧事件名称不再作为实现依据。

## 1. 背景与核心判断

目标是获得类似 Google Analytics “应用启动时部署一次，后续功能自动纳入统计”
的开发体验，同时避免依赖 DOM 点击监听。点击只能说明用户表达了意图，无法证明
安装、更新或导入已经成功，也无法可靠处理取消、异步失败、重试和 UI 重构。

因此，Wework 采用混合式自动采集：

1. 路由注册表提供“用户打开了什么”的事实；
2. 命令注册表提供“用户发起了什么语义动作”的事实；
3. 操作注册表提供“业务最终成功或失败”的事实；
4. Telemetry Agent 在启动时注册一次，统一订阅上述注册表和运行结果；
5. 页面、按钮和具体功能组件不直接调用 `track()`。

这里的“自动”不是从任意 DOM 中猜测业务含义。新增功能必须先进入统一的
Route、Command 或 Operation 抽象。这个动作属于功能注册，而不是在各页面增加
统计埋点。注册完成后，事件名称、监听、字段校验、字典生成和发送均自动完成。

## 2. 目标

- 统计逻辑只部署在 Wework 的统一采集层，不散落到页面和按钮组件。
- 自动覆盖通过统一路由、命令和业务操作服务注册的功能。
- 所有智能工作台事件使用清晰、可读的 `smart_app_` 前缀。
- 所有智能工作台事件统一携带 `domain: 'smart_app'`。
- 从功能注册表自动生成事件字典，并同步到 PostHog 的事件定义。
- GitHub 公共发行版只发送匿名、非敏感事件。
- GitLab 内部发行版通过私有 DeepSeek Harness 插件发送额外的内部字段。
- 私有统计代码不进入公开仓库，不要求在 Wework 中维护私有代码目录。
- 统计故障、插件故障和网络故障都不能影响 Wework 业务流程。

## 3. 非目标

- 不处理 GitHub 到 GitLab 的代码同步方式。
- 不为 `frontend/`、`backend/`、`executor/` 或独立 DSH 产品建立统计。
- 首版不统计智能工作台内部页面、按钮或插件的使用行为。
- 不通过 DOM、CSS 选择器或按钮文案推断业务事件。
- 不采集用户输入、工作台内容、ZIP 内容、原始异常正文或本地路径。
- 不在公共仓库中存放内部 PostHog 地址、密钥、内部字段定义或私有插件源码。
- 不把遥测是否成功作为任何业务操作成功的前置条件。

## 4. 总体架构

```text
Wework 启动
  └─ Telemetry Agent（注册一次）
       ├─ Route Registry Observer
       ├─ Command Registry Observer
       ├─ Operation Registry Observer
       ├─ Event Normalizer + Policy Projector
       └─ Telemetry Sink Registry
            ├─ Public Sink（公共发行版）
            └─ Internal Sink（内部私有 Harness 插件注册）

功能注册表
  ├─ semantic key
  ├─ domain
  ├─ name / description
  └─ lifecycle/result
       │
       ├─ 运行时：Telemetry Agent 自动生成并发送事件
       └─ CI：生成事件字典并同步 PostHog Event Definitions
```

事件只有一个来源：功能注册表及其真实运行结果。事件字典不是第二套需要人工维护
的事件源，而是同一份注册信息的生成产物。

### 4.1 启动顺序

内部发行版的建议顺序为：

1. DSH 启动 `app-wework` 服务；
2. 内部私有插件加载并向 `ctx.wework.telemetry.sinks` 注册 Internal Sink；
3. React 应用挂载；
4. Telemetry Agent 开始订阅路由、命令和操作事件；
5. 启动阶段的少量事件由内存启动队列暂存，Sink 就绪后再投递。

插件没有注册、注册失败或超时，Telemetry Agent 仍正常启动。内部发行版不得因为
内部统计不可用而延迟或阻止应用进入主界面。

### 4.2 发行版默认行为

| 发行版            | 默认 Sink     | 用户控制                           |
| ----------------- | ------------- | ---------------------------------- |
| GitHub 公共发行版 | Public Sink   | 服从现有匿名统计同意设置           |
| GitLab 内部发行版 | Internal Sink | 由组织构建配置管理，不提供用户开关 |

内部发行版默认不注册 Public Sink，避免同一业务事件被同时发送到两套系统，也避免
设置项产生歧义。Sink Registry 仍支持多个 Sink，以便测试隔离能力或满足将来经
明确批准的策略变化；即使双 Sink 同时启用，两边也必须使用互不关联的标识。

## 5. 自动发现模型

### 5.1 Route Registry

Route Registry 声明用户可打开的产品入口。Telemetry Agent 观察规范化后的路由
进入事件，而不是监听 React 组件渲染。

示意注册信息：

```ts
{
  key: 'smart_app.marketplace',
  domain: 'smart_app',
  feature: 'marketplace',
  name: '智能工作台市场',
  description: '用户进入智能工作台市场入口'
}
```

事件名生成规则：

```text
<domain>_<feature>_opened
```

同一规范化路由连续重渲染不重复发送。只有从其他入口进入，或完成一次明确的离开
再进入，才视为新的打开事件。

### 5.2 Command Registry

Command Registry 适用于具有统一语义、但可能从菜单、快捷键或命令面板等多个入口
触发的动作。Telemetry Agent 订阅命令总线，从而自动覆盖所有入口。

命令事件只用于“命令已触发”本身就是需要统计的事实。对于安装、更新、导入等
异步业务，最终指标必须来自 Operation Registry，不能把命令触发当作成功。

命令事件命名规则：

```text
<domain>_<command>_triggered
```

首版智能工作台漏斗不需要单独发送安装按钮的 `triggered` 事件，避免把意图与结果
混合。将来只有在存在明确的“发起到完成”漏斗问题时才启用相应命令事件。

### 5.3 Operation Registry

Operation Registry 包装具有明确业务结果的统一服务边界。市场卡片、详情页、更新
提示和 ZIP 导入等入口最终必须调用语义化操作：

```text
smart_app.install
smart_app.update
smart_app.zip_import
```

底层即使都调用 `harnessAppsApi.install()`，也不能直接根据底层 API 名称推断语义。
上层操作必须保留 `install`、`update` 和 `zip_import` 的业务意图，Telemetry Agent
观察最终结果并自动产生：

```text
<domain>_<action>_succeeded
<domain>_<action>_failed
```

取消文件选择不属于失败。一次手动重试是一次新的业务尝试；每次尝试最多产生一个
最终结果事件。

### 5.4 自动化覆盖边界

满足以下任一条件的功能不需要另加统计调用：

- 注册为可观察路由；
- 通过统一命令总线触发；
- 通过统一业务 Operation 执行。

无法进入以上抽象的特殊业务事实，才允许在统一服务边界补充一次语义事件发布。
禁止在展示组件、按钮组件或 DOM 监听器中补 `track()`。

CI 应增加架构约束，阻止新的功能组件直接依赖底层 telemetry 客户端。允许调用该
客户端的模块仅限 Telemetry Agent、Sink 和测试基础设施。

## 6. 智能工作台首版事件

| 业务事实           | 自动生成的事件名                 | 触发事实                           |
| ------------------ | -------------------------------- | ---------------------------------- |
| 打开智能工作台市场 | `smart_app_marketplace_opened`   | 进入市场规范化路由                 |
| 打开我的工作台     | `smart_app_owned_opened`         | 进入我的工作台规范化路由           |
| 打开一个具体工作台 | `smart_app_opened`               | 进入 `/app/harness-*` 对应运行路由 |
| 市场安装成功       | `smart_app_install_succeeded`    | 安装服务成功且本地状态确认完成     |
| 市场安装失败       | `smart_app_install_failed`       | 安装尝试最终失败                   |
| 市场更新成功       | `smart_app_update_succeeded`     | 更新服务成功且本地状态确认完成     |
| 市场更新失败       | `smart_app_update_failed`        | 更新尝试最终失败                   |
| ZIP 导入成功       | `smart_app_zip_import_succeeded` | 预览、校验、安装和状态确认均成功   |
| ZIP 导入失败       | `smart_app_zip_import_failed`    | 预览、校验或安装最终失败           |

上述事件均携带 `domain: 'smart_app'`。事件名已经表达业务事实，因此不再同时发送
`feature_opened`、`feature_action_completed` 或 `operation_failed` 作为重复事件。

市场描述下载失败如果属于本次安装或更新尝试的一部分，归入相应的
`smart_app_install_failed` 或 `smart_app_update_failed`，并通过受限枚举
`failure_stage` 区分阶段。首版允许的阶段为：

```text
download | validate | install | confirm
```

ZIP 导入只允许：

```text
preview | validate | install | confirm
```

不发送原始异常类型、错误正文、文件名或路径。

## 7. 事件注册契约与事件字典

### 7.1 注册契约

每个 Route、Command 或 Operation 定义至少包含：

```ts
interface ObservableFeatureDefinition {
  key: `${string}.${string}`;
  domain: string;
  feature: string;
  name: string;
  description: string;
  lifecycle: "opened" | "triggered" | "operation";
  publicProperties: readonly PropertyDefinition[];
}
```

`name` 和 `description` 是功能定义的一部分，可同时供开发工具、诊断和事件字典使用，
不是散落的代码注释。注释可以解释复杂实现，但事件的业务含义必须进入可生成、可
校验的结构化注册信息，不能只存在于注释中。

Operation 定义还需要成功条件、失败阶段枚举和内部扩展字段声明。事件名由 `domain`、
`feature/action` 和 lifecycle 自动生成，功能代码不得自由拼接事件名。

### 7.2 生成的字典内容

CI 从注册表生成机器可读 JSON 和供评审的 Markdown。每个事件至少包含：

- 精确事件名；
- domain；
- 中文名称和英文名称；
- 事件用途；
- 准确触发时机；
- 成功或失败判定；
- 公共字段及类型、枚举、说明；
- 内部发行版可扩展字段；
- schema 版本；
- 首次引入版本；
- 状态：active、deprecated；
- 负责人或所属模块。

同一注册表是运行时和字典的共同来源，因此不存在“自动发现事件”和“字典事件”两套
名称。注册缺少说明、命名不合规、属性未声明或事件冲突时，CI 必须失败。

### 7.3 命名约束

- domain 使用小写 snake_case；智能工作台固定为 `smart_app`。
- 智能工作台事件全部以 `smart_app_` 开头。
- 路由事件使用 `_opened`。
- 命令事件使用 `_triggered`。
- 操作结果使用 `_succeeded` 或 `_failed`。
- 已发布事件不得直接改名或复用为其他含义。
- 语义改变时新增事件或提升 schema 版本，旧事件标记 deprecated。

## 8. PostHog 事件说明同步

事件字典可以同步到 PostHog，使分析人员仅查看事件名时也能查到用途、触发时机和
字段含义。

### 8.1 同步方式

桌面客户端只发送业务事件，不携带 PostHog 管理权限。CI 使用独立管理密钥调用：

- [PostHog Event Definitions API](https://posthog.com/docs/api/event-definitions)：
  创建或更新事件说明、标签、验证状态和默认列；
- [PostHog Property Definitions API](https://posthog.com/docs/api/property-definitions)：
  在属性首次通过真实事件出现后，更新属性说明、标签、类型和验证状态。

Event Definition 通过精确事件 `name` 关联。属性定义接口不负责预创建普通事件属性，
因此属性说明同步允许在首个真实事件进入后重试。

### 8.2 两套目录和项目

公共和内部数据必须使用独立 PostHog host/project，并生成两份目录：

- Public Catalog：仅包含公共字段；由 GitHub CI 同步公共项目；
- Internal Catalog：由 GitLab CI 合并公共事件定义和私有插件字段，再同步内部项目。

公开仓库永远不读取私有插件源码或内部字段清单。私有插件以版本化 catalog artifact
向 GitLab CI 提供内部扩展定义。

### 8.3 Schema 漂移规则

- 新事件或新字段必须先进入注册定义并通过 CI，再进入运行时。
- 运行时出现目录之外的字段时，Sink 必须丢弃该字段。
- CI 不自动删除历史 Event Definition。
- 废弃事件添加 deprecated 标签和替代事件说明。
- 描述变化允许原地更新；事件语义变化不允许只改描述掩盖。

## 9. 公共和内部数据模型

### 9.1 数据级别

| 级别           | 示例                                              | Public Sink | Internal Sink |
| -------------- | ------------------------------------------------- | ----------- | ------------- |
| 公共匿名字段   | event、domain、应用版本、平台、受限失败阶段       | 允许        | 允许          |
| 匿名运行标识   | 公共匿名安装/会话标识                             | 允许        | 禁止复用      |
| 内部身份字段   | 内部稳定用户 ID、企业邮箱前缀                     | 禁止        | 允许          |
| 智能工作台身份 | 稳定 key、名称、版本、来源                        | 禁止        | 允许          |
| 禁止字段       | 完整邮箱、路径、ZIP 文件名、内容、原始错误、token | 禁止        | 禁止          |

### 9.2 显式字段投影

Telemetry Agent 先产生不含业务对象的规范化事实，随后由不同策略显式构造 payload：

```text
Normalized Fact
  ├─ Public Projection  -> Public Sink
  └─ Internal Projection -> Internal Sink
```

投影必须逐字段列出 allowlist，禁止使用对象展开、序列化完整 User、manifest、安装记录
或异常对象。业务模型新增字段不会自动进入统计。

建议公共基础字段：

```text
event
domain
event_schema_version
app_version
platform
release_channel
occurred_at
```

事件特有公共字段仅包括字典明确声明的受限枚举，例如 `failure_stage`。公共项目不得
包含智能工作台 ID、名称、市场 ID、插件列表或本地来源信息。

### 9.3 内部字段

Internal Sink 在事件允许时扩展：

```text
internal_user_id
user_key
smart_app_key
smart_app_name
smart_app_version
smart_app_source
```

规则如下：

- `user_key` 是经过小写规范化的企业邮箱前缀，例如 `zhongyang`；
- 只有配置 allowlist 中的企业邮箱域才允许生成 `user_key`；
- 完整邮箱永远不进入 payload；
- PostHog `distinct_id` 使用稳定、不可读的 `internal_user_id`，不使用邮箱前缀；
- 优先使用认证系统提供的稳定 opaque user id；需要再派生时由内部网关使用服务端
  密钥完成，客户端不保存派生密钥；
- 智能工作台字段只在具体工作台相关事件中发送；市场入口事件不虚构工作台字段；
- `smart_app_key` 使用稳定内部键，不使用本地安装路径；
- ZIP 文件名、manifest 全文和插件配置禁止发送。

### 9.4 标识隔离

Public Sink 与 Internal Sink 不得共享：

- event id；
- session id；
- device/install id；
- PostHog distinct id。

即使将来在内部发行版同时开启两个 Sink，也必须分别生成标识，防止跨项目重新关联
匿名公共数据和内部身份数据。

## 10. 私有 DeepSeek Harness 插件

### 10.1 代码和分发位置

私有统计实现是独立包，例如：

```text
@company/wework-internal-telemetry
  ├─ client.js
  ├─ index.js
  ├─ cordis.patch.yml
  └─ telemetry-catalog.json
```

该包位于内网 GitLab 的私有项目或 Package Registry，不进入 Wegent GitHub 仓库，
因此不需要在公开仓库建立只存在于 GitLab 的特殊目录。

GitLab 内部构建将固定版本的包加入 `wework-core` 组织管理 profile。普通用户不能
安装、更新、停用或卸载它。插件版本必须被 lockfile 固定，并通过包哈希或签名校验。

### 10.2 客户端职责

`client.js` 通过 `ctx.wework.telemetry.sinks.register()` 注册 Internal Sink：

```ts
ctx.wework.telemetry.sinks.register({
  id: "internal",
  protocol: "telemetry-sink/v1",
  accept: (event) => bridge.send(event),
});
```

客户端职责仅包括：

- 接收经过公共契约校验的规范化事实；
- 从 Wework 已有用户上下文和智能工作台安装上下文选择允许字段；
- 生成 Internal Projection；
- 通过 DSH bridge 发送到插件 host。

### 10.3 Host 插件职责

`index.js` 负责：

- 再次校验事件名、schema 版本和字段 allowlist；
- 批量、超时、重试和队列控制；
- 只连接配置的内部 HTTPS Gateway；
- 记录不含 payload 的运行指标；
- 暴露给受控管理员诊断的健康状态。

建议通过内部 Telemetry Gateway 再进入 PostHog。Gateway 负责认证、服务端身份派生、
策略检查、限流和审计，桌面应用不持有 PostHog 管理密钥。

### 10.4 队列和失败策略

默认参数：

| 参数         | 默认值                       |
| ------------ | ---------------------------- |
| 批量大小     | 20 条                        |
| 最大等待时间 | 5 秒                         |
| 最大内存队列 | 500 条                       |
| 单次请求超时 | 5 秒                         |
| 重试         | 3 次，间隔 1 秒、5 秒、30 秒 |
| 持久化       | 不落盘                       |

超过队列上限时丢弃最旧事件，并只增加聚合的 dropped count。应用退出时进行一次有
时间上限的 flush；超时后直接退出，不阻塞关闭流程。

### 10.5 信任边界

DSH 插件共享 JavaScript 信任域，内部统计插件必须被视为组织管理的受信代码：

- 只允许来自内网 registry 和批准 publisher 的版本；
- Wework 与插件协议显式版本化；
- 不兼容插件拒绝注册但不影响 Wework 启动；
- endpoint 必须为 HTTPS 且命中域名 allowlist；
- 禁止跟随到未授权域名的重定向；
- token 仅存在于插件 host 或 Gateway 的受控配置中；
- 普通日志不得输出 endpoint、token、用户、工作台名称或事件 payload。

## 11. 内部发行版界面策略

内部统计由组织构建策略管理，产品界面不明确展示相关信息：

- 设置页不展示“内部使用统计”模块；
- 不展示采集字段、发送位置或启用状态；
- 不提供用户开关；
- 私有统计插件不出现在普通插件管理界面；
- 不弹出统计成功、失败或队列状态提示。

内部发行版默认不启用 Public Sink，因此也不显示公共匿名统计开关。若未来经明确
策略批准同时启用 Public Sink，公共开关只能描述和控制“匿名产品改进数据”，不得
声称控制全部数据收集。

产品界面之外，可以在权限受控的内网治理文档中保留数据用途、保留期和责任人。
管理员诊断只显示发送成功数量、失败数量、丢弃数量、队列长度和插件版本，不显示
用户、工作台名称或原始 payload。

## 12. 数据保留和治理

- 建议内部原始事件默认保留 180 天；确需更长周期时单独审批。
- 只包含聚合结果的报表可以按组织数据策略保留更久。
- 桌面端不建立落盘遥测队列。
- Gateway 和 PostHog 的访问权限按最小权限授予。
- 管理密钥只存在于 CI 或 Gateway secrets，不进入源码和构建产物。
- 应支持按内部稳定用户 ID 执行查询或删除，以满足组织治理流程。

## 13. 现有实现迁移

当前 `feature/statistics` 分支已经按照早期方案实现了一部分智能工作台统计。新方案
不会推翻已有的隐私保护和测试成果，但会替换智能工作台的事件命名、采集入口和业务
调用位置。

### 13.1 保留和复用

以下基础设施继续使用：

- PostHog 初始化、批量发送和内存队列；
- `before_send` 二次字段过滤；
- 事件属性 allowlist 和枚举约束机制；
- 公共发行版的匿名统计授权逻辑；
- 安装成功后才统计、更新不计为首次安装、取消 ZIP 选择不统计等业务测试场景；
- 路由能够区分智能工作台市场、我的工作台和具体工作台的识别条件。

现有 PostHog 客户端逐步封装为 Public Sink。现有类型化事件和字段白名单机制可以
继续作为生成产物的运行时接口，不要求为了本次智能工作台迁移而同时重写其他 Wework
事件。

### 13.2 替换和删除

| 现有位置                                                          | 迁移后处理                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| `App.tsx` 中的 `track('feature_opened', ...)`                     | 删除智能工作台的直接上报，由 Route Registry 和 Telemetry Agent 接管 |
| `telemetry/routes.ts` 中的智能工作台硬编码 feature 集合           | 将匹配条件迁入 Route Registry；保留正确的路由识别语义               |
| `SmartAppsMarketplacePage.tsx` 中的安装、更新、ZIP 导入 `track()` | 全部删除，由语义化 Operation 发布真实结果                           |
| `events.ts` 中的 `smart_app_installed`                            | 被新的成功事件取代                                                  |
| 通用 `feature_opened` 中的智能工作台 feature 枚举                 | 切换后移除                                                          |
| 通用 `feature_action_completed` 中的 `smart_app/update`           | 切换后移除                                                          |
| 通用 `operation_failed` 中的智能工作台 operation 枚举             | 切换后移除                                                          |

其他 Wework 功能现有的 `track()` 暂时不在本次迁移范围内。架构约束首先禁止智能
工作台模块和新增代码直接依赖底层 telemetry 客户端；其他历史调用点以后按功能域
逐步迁移，不能让本次方案扩张成一次全量遥测重构。

### 13.3 旧事件到新事件映射

| 旧事件和属性                                                                | 新事件                           |
| --------------------------------------------------------------------------- | -------------------------------- |
| `feature_opened { domain: 'smart_app', feature: 'smart_apps_marketplace' }` | `smart_app_marketplace_opened`   |
| `feature_opened { domain: 'smart_app', feature: 'smart_apps_owned' }`       | `smart_app_owned_opened`         |
| `feature_opened { domain: 'smart_app', feature: 'smart_app' }`              | `smart_app_opened`               |
| `smart_app_installed { install_source: 'marketplace' }`                     | `smart_app_install_succeeded`    |
| `smart_app_installed { install_source: 'zip_import' }`                      | `smart_app_zip_import_succeeded` |
| `feature_action_completed { domain: 'smart_app', action: 'update' }`        | `smart_app_update_succeeded`     |
| `operation_failed { operation: 'smart_app_marketplace_install' }`           | `smart_app_install_failed`       |
| `operation_failed { operation: 'smart_app_marketplace_update' }`            | `smart_app_update_failed`        |
| `operation_failed { operation: 'smart_app_zip_import' }`                    | `smart_app_zip_import_failed`    |

旧 `smart_app_marketplace_download` 没有记录下载属于安装还是更新，历史数据不能可靠
拆分。它保留为旧版“市场下载准备失败”指标。新实现根据 Operation 的明确意图发送
`smart_app_install_failed` 或 `smart_app_update_failed`，并使用
`failure_stage: 'download'`。

### 13.4 测试迁移

现有测试的业务语义需要保留，但断言位置发生变化：

- 页面测试只验证交互、取消和错误展示，不再 mock `track()`；
- Operation 测试验证何时构成成功、失败或取消，以及一次尝试只有一个最终结果；
- Telemetry Agent 测试验证 Operation 结果自动转换成正确事件；
- Projection 测试继续验证路径、错误正文和新增业务字段不会进入公共 payload；
- 路由测试从“调用通用 `feature_opened`”改为“注册路由后自动生成专属事件”。

### 13.5 原子切换和历史连续性

正式发行版不双写新旧智能工作台事件。迁移按以下顺序实施：

1. 增加 Registry、Telemetry Agent、Sink Registry 和新事件契约，在测试环境验证，
   但不与旧调用同时向生产发送；
2. 把安装、更新和 ZIP 导入迁入统一 Smart App Operation 服务；
3. 在同一个发行切换中启用 Agent，并删除 `App.tsx` 和页面中的旧智能工作台上报；
4. 发布前由 CI 同步新事件和属性定义；
5. PostHog 中的旧 Event Definition 标记 deprecated，不删除历史数据；
6. 过渡期报表按上述映射合并新旧事件，并以发行版本或切换时间作为边界。

不增加长期兼容分支或运行时双写开关。测试环境可以比较新旧结果，但同一次生产业务
事实只能进入一套智能工作台事件。

## 14. 测试设计

### 14.1 自动发现与业务事实

必须覆盖：

- 注册 `smart_app.marketplace` 后生成 `smart_app_marketplace_opened`；
- 注册 `smart_app.install` 后生成成功和失败两个结果定义；
- 页面重渲染不重复上报打开事件；
- 不同入口调用同一语义 Operation 时得到相同事件；
- 点击安装但取消或尚未完成时不产生成功事件；
- 安装、更新和 ZIP 导入只在真实状态确认后产生成功事件；
- 取消文件选择不产生失败事件；
- 一次尝试最多产生一个最终结果，重试作为新的尝试处理。

### 14.2 字典和命名

CI 必须验证：

- 智能工作台事件均以 `smart_app_` 开头；
- `domain` 恒为 `smart_app`；
- 事件含中英文名称、说明、触发时机和字段定义；
- 缺失说明、命名冲突、未声明属性或不受限枚举导致失败；
- 运行时生成的事件集合与 catalog 完全一致；
- PostHog Event Definition 同步支持 dry-run，并且重复执行保持幂等；
- 历史事件只废弃、不自动删除。

### 14.3 投影与隐私

对每个事件分别生成 Public Projection 和 Internal Projection 快照，断言：

- 公共载荷不含邮箱、邮箱前缀、用户 ID、工作台身份和本地文件信息；
- 内部载荷只包含该事件声明的字段；
- 非企业邮箱不产生 `user_key`；
- 完整邮箱在任何 Sink 中都不存在；
- 新增业务模型字段不会自动进入载荷；
- Public 与 Internal 标识完全不同；
- 原始错误和对象展开无法通过类型及运行时校验进入 payload。

### 14.4 Sink 和故障隔离

分别模拟 Public Sink、Internal Sink、两个 Sink、内部插件和 Gateway 的不可用、超时、
限流与 4xx/5xx。所有情况下都必须满足：

- 智能工作台业务操作按自身结果完成；
- 一个 Sink 不阻塞另一个 Sink；
- 队列有界且不落盘；
- 应用退出不被无限等待；
- 普通日志不出现敏感字段。

### 14.5 安全测试

- 内部 endpoint 仅接受 HTTPS allowlist；
- 未授权重定向被拒绝；
- 管理密钥不进入渲染进程、安装包或日志；
- 插件版本和完整性校验失败时拒绝加载；
- 协议版本不兼容时安全降级；
- 内部事件永远不能发往公共 PostHog；
- Public Sink 不能因为私有插件存在而得到内部字段。

### 14.6 真实 Electron 验证

实施涉及 Wework UI、Electron host、DSH bridge 和本地运行时，必须使用
`scripts/ai-verify.mjs` 在隔离的真实 Electron 中验证，不能只依赖浏览器或 mock。

公共发行版验证：

1. 不安装内部插件；
2. 仅发送匿名公共事件；
3. 关闭公共统计后停止发送；
4. 统计不可用不影响智能工作台功能。

内部发行版验证：

1. 私有插件由构建 profile 自动加载；
2. UI 不展示内部统计模块、字段、地址、开关或普通插件条目；
3. 事件到达内部测试 Gateway；
4. 断网、插件故障和 Gateway 故障不影响业务；
5. 管理员诊断只出现聚合健康状态；
6. 如执行双 Sink 隔离测试，两边载荷和标识严格分离。

关键成功路径保留可复现的 Electron 验证记录、脱敏测试 Gateway 载荷和界面截图。

## 15. 发布、监控与回滚

### 15.1 分阶段发布

1. 在公共代码中落地注册表、Telemetry Agent、Public Projection、Sink Registry 和
   catalog generator，不启用新的内部发送；
2. 在内网测试环境接入私有插件、Internal Projection 和测试 Gateway；
3. 选择少量内部发行版灰度，核对重复率、失败率、队列长度和性能；
4. 全量启用 Internal Sink；
5. 后续功能逐步迁移到统一 Route、Command、Operation 注册表。

### 15.2 运行监控

只监控聚合健康指标：

- accepted event count；
- sent batch count；
- failed batch count；
- dropped event count；
- queue length；
- validation rejection count；
- event-to-send latency 分桶。

健康监控不得把 payload、用户或智能工作台名称写入日志或告警正文。

### 15.3 回滚

- 内部 Sink 可通过内部构建/profile 配置或 Gateway 接收策略集中停用；
- 停用私有插件不需要回滚 Wework 业务功能；
- Public Agent 与私有插件解耦，内部插件故障不要求关闭公共能力；
- 已同步的 PostHog 定义不删除，只标记 deprecated；
- 协议不兼容时拒绝插件注册并继续启动 Wework。

## 16. 验收标准

实现只有在同时满足以下条件时才算完成：

- 统计范围严格限定在 `wework/`；
- 智能工作台页面和按钮没有散落的 `track()`；
- 新功能进入统一注册表后可以自动获得事件名、监听和字典；
- 智能工作台事件全部使用 `smart_app_` 前缀和 `smart_app` domain；
- 事件字典可自动生成并同步 PostHog；
- 公共发行版不发送敏感信息；
- 内部发行版能发送经过 allowlist 的内部身份和智能工作台名称；
- 内部统计信息不在产品界面明确展示；
- 私有插件不在普通插件管理界面出现，普通用户无法关闭或卸载；
- 公共和内部数据没有可复用的关联标识；
- 任意统计、插件或网络故障都不影响业务；
- 单元测试、集成测试、CI catalog 检查、桌面 E2E 和真实 Electron 验证通过。

## 17. 实施边界

公共仓库负责：

- Wework Route、Command、Operation 的可观察契约；
- Telemetry Agent 和 Sink Registry；
- 自动命名和公共事件 catalog；
- Public Projection、Public Sink 和匿名同意控制；
- DSH 内部 Sink 注册接口；
- 公共契约、隔离和 Electron 回归测试。

内网私有项目负责：

- Internal Sink 插件；
- 企业邮箱域 allowlist 和内部字段投影；
- 私有 package 发布与完整性校验；
- 内部 Gateway、认证和 PostHog 配置；
- Internal Catalog 合并与同步；
- 内部构建 profile、灰度、监控和停用策略。

两者只通过版本化的 `telemetry-sink/v1` 契约连接。公共实现不得对私有包产生编译时
依赖，私有插件也不得绕过 Agent 直接监听页面 DOM 或业务组件。

---

# English summary

This approved design limits telemetry to Wework. A single Telemetry Agent observes shared
Route, Command, and Operation registries. Feature components do not call `track()` directly.
Event names and the event catalog are generated from the same semantic registrations, so
automatic discovery and documentation cannot drift into two competing event sources.

All Smart App events use the `smart_app_` prefix and `domain: 'smart_app'`. The initial set
covers marketplace, owned-app, and installed-app opens, plus the success and failure of
install, update, and ZIP import operations. Business-result events are emitted only after the
underlying operation reaches a confirmed outcome.

The GitHub distribution uses an anonymous Public Sink. The GitLab distribution uses a private,
organization-managed DeepSeek Harness plugin that registers an Internal Sink and may add an
opaque internal user ID, an approved corporate-email prefix, and allowlisted Smart App identity
fields. The private package is published from GitLab and is not stored in the public repository.
The internal distribution does not expose telemetry details, controls, or the managed plugin in
the normal product UI.

Public and internal payloads are explicit projections and never share event, session, device,
installation, or distinct IDs. Full email addresses, local paths, ZIP filenames, manifests,
content, raw errors, and credentials are forbidden in both paths. CI generates public and
internal catalogs separately and synchronizes descriptions through PostHog's Event and Property
Definitions APIs. Telemetry and plugin failures are isolated from every Wework business flow.
