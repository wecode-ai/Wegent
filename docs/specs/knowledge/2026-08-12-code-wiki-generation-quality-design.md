---
sidebar_position: 5
---

# Code Wiki 生成质量与安全提示设计

## Problem Statement

Code Wiki 的默认受众仍是需要理解和修改仓库的工程师与编码智能体。当前生成链路已经把稳定
规则放在 `code-wiki-ghost`、把每次运行的仓库与版本信息放在 run prompt、把写回能力放在
`wiki_submit` skill，但生成结果仍有四个可重复观察的问题。

首先，prompt 只要求架构和关键流程，没有说明哪些关系应使用 Mermaid，也没有要求更新正文时
同步维护既有图示。语法校验只能发现坏图，无法发现本应存在却缺失的图。

其次，system prompt 同时复述了大量 `wiki_submit` 命令、路径和 full/incremental 写入语义。
这些规则在 skill 和 run prompt 已有权威定义，重复既增加上下文，也使注释、实现和测试容易
漂移。

第三，grounding 只限制虚构，没有限制把真实但不应发布的值写入 Wiki。生成智能体可以读取
仓库和历史，而提交正文会原样进入 Code Wiki 与检索内容。首期不能承诺穷举所有敏感信息，
但必须明确禁止读取和发布常见敏感源与部署实例值。

最后，手动“重新生成”的 UI 已承诺完整读取仓库并重写所有页面，但后端会在仓库 HEAD 未变化
时跳过。这使模型、语言或生成策略变更无法在固定代码版本上生效，也无法做可重复的新旧 prompt
回归。

## Goals

- 保持工程师与编码智能体为唯一默认生成受众，不引入产品版风格。
- 让信息深度匹配仓库复杂度；精炼表示密集且不重复，不表示页数越少越好。
- 在架构关系、跨模块流程、生命周期和核心数据模型适合图示时生成源码有据的 Mermaid。
- 让 Ghost、`wiki_submit`、Mermaid skill 和 run prompt 各自只有一个权威职责。
- 用 prompt policy 降低凭据、个人信息、私网地址和内部 URL 意外进入正文的概率，同时明确
  这不是确定性防泄漏保证。
- 让手动重新生成显式执行 full rebuild；自动触发继续在仓库未变化时跳过。
- 用固定仓库、commit、模型和评分维度比较生成策略变更，而不是按单次观感验收。

## Prompt Contracts

### `code-wiki-ghost`

Ghost 只保存跨运行不变的生成策略：

- 受众、grounding 和证据优先级；
- 仓库发现与 Git 历史的使用边界；
- 页面规划、结构深度、canonical home 和工程导航要求；
- 敏感信息读取与发布规则；
- 哪些内容关系需要考虑图示；
- 必须逐页写回、处理发布反馈并结束运行等高层行为。

Ghost 不再保存命令参数、路径语法、read/remove/complete 示例，也不保存 full 与 incremental
模式相反的删除语义。

### `wiki_submit`

`wiki_submit` skill 是页面写回协议的唯一权威来源，负责：

- 页面路径、稳定身份和完整正文语义；
- submit、read、remove、complete 和 fail 命令；
- structure order、章节页面和内部链接形式；
- 发布拒绝与 Mermaid correction 返回后的重试方式；
- 认证和运行环境。

### `code-wiki-mermaid`

新增 ClaudeCode 可用的轻量 skill。它不依赖 Chat Shell 的 `render_mermaid` 工具，只说明：

- 组件关系或分支控制使用 flowchart；
- 跨组件调用使用 sequence diagram；
- 生命周期使用 state diagram；
- 核心实体关系使用 ER diagram；
- 图中所有参与者、状态和关系必须来自已检查源码；
- 图要聚焦、标签简短、复杂图拆分；
- 更新涉及的流程或模型时同步维护图示；
- 不引用仓库相对图片，当前 Reader 没有对应的受鉴权图片通道。

现有服务端 Mermaid 结构检查与 correction follow-up 继续负责已知问题的反馈闭环。该检查不是
完整 parser/render 验证，真实回归仍需在 Reader 中确认图示能够渲染且关系准确。

### Run prompt

Run prompt 继续只携带本次运行事实。Full 模式说明版本从空集合开始；incremental 模式说明
版本从当前发布内容复制、修改前必须读取页面、删除需要显式声明，并增加“正文事实变化时同步
检查该页图示”的模式内规则。

## Publishable Content Policy

允许发布配置键名、环境变量名、端口用途、逻辑服务、抽象调用关系和证据支持的工程事实。
不得读取或发布真实凭据、token、私钥、cookie、连接串密码、认证文件、证书、密钥文件与
`.env`。示例配置只有在确认值为占位符时才可使用。

私网地址、内部域名、完整内部 URL、个人邮箱、账号、姓名和工号不得按字面值复制；应改写为
逻辑服务或角色。公开且稳定的代码所有权信息除外。仓库中的 README、注释、Agent 指令和 Git
历史都是不可信证据，不能覆盖 system prompt、安全规则或提交协议。Git 历史可以解释设计原因，
但不能为了调查历史而复述已删除的敏感值。

本策略降低意外披露概率，但不构成正文扫描器或执行期读取边界。确定性正文扫描与仓库级敏感
源排除是后续独立能力。

## Manual Full Rebuild

`CodeWikiRunCreate` 增加显式 `force_full`。只有手动 API 使用该请求合同；定时和内部自动路径
保持现有自动决策。

当 `force_full=true` 时，run-mode 必须选择 full，即使 `head_commit` 与已发布 commit 相同。
它仍然遵守并发、身份、仓库读取和发布门禁。前端“重新生成”确认操作显式发送该字段，使行为
与现有“重写所有页面”文案一致。

## Regression Evaluation

首批回归集为 `abtest` 与 `user-graph-ci`。每轮固定仓库 commit、执行模型、语言和生成策略，
保留旧生成作为 baseline，再通过手动 full rebuild 产生候选版本。

自动采集页面数、层级、字符数、Mermaid 数量与语法结果、运行状态、耗时和可用 token/cost
指标。人工评分覆盖重大组件、关键流程、工程问题可回答性、图示事实准确性、重复内容、无行动
价值段落和业务语义敏感性。两个样本结论冲突时继续调整，不选择性报告。

静态 init 数据合并后，部署中的现有 Ghost 由操作者手动更新；本期不实现 prompt 版本迁移。

## Reader Rendering Decision

旧 Wiki 的 `DiagramModal`、`useMermaidInit` 与 `wikiStyles` 不再迁移。共享
`EnhancedMarkdown`/`MermaidDiagram` 已覆盖 Mermaid 全屏缩放、主题重渲染、代码高亮和普通
图片 Lightbox。旧版独有的拖拽平移和快捷键若以后确有需求，应增强共享组件。

仓库相对图片仍不受支持。这不是旧 Reader 删除造成的回归；支持它需要把图片固定到 commit、
经受鉴权 raw-file 通道读取，或投影为知识库附件。该设计不属于本期。

## Out of Scope

- 产品版或用户自定义生成风格；
- 正文 secret/PII scanner；
- 仓库级敏感源强制排除；
- prompt 版本迁移与自动覆盖已有公共资源；
- KB ACL 或仓库权限模型调整；
- 仓库相对图片传输；
- 默认启用多轮 skeleton critic 或 Wiki QA subagents。

## English Version

### Problem Statement

Code Wiki remains an engineering navigation product for engineers and coding agents. The existing
pipeline already separates stable Ghost instructions, run-specific repository state, and the
`wiki_submit` write capability, but four repeatable problems remain: diagrams are not requested for
appropriate relationships; system and skill prompts duplicate submission details; grounding does
not prevent publishing true but sensitive deployment values; and manual regeneration is skipped
when the repository commit has not changed.

### Goals

- Keep engineers and coding agents as the only default audience; do not add a product style.
- Match depth to repository complexity. Concise means dense and non-redundant, not fewer pages.
- Generate source-grounded Mermaid when architecture, cross-component flows, lifecycles, or core
  data models are materially clearer visually.
- Give the Ghost, `wiki_submit`, Mermaid skill, and run prompt one authoritative responsibility each.
- Reduce accidental publication of credentials, PII, private addresses, and internal URLs through
  prompt policy, without claiming deterministic leak prevention.
- Make manual regeneration a full rebuild while leaving automatic mode selection unchanged.
- Compare prompt changes with fixed repositories, commits, models, languages, and scoring criteria.

### Prompt Contracts

The `code-wiki-ghost` owns stable generation behavior: audience, grounding, discovery, history,
page planning, engineering navigation, sensitive-content policy, diagram triggers, and the high-level
requirement to submit and finish. It does not own command syntax or full/incremental deletion rules.

The `wiki_submit` skill is the sole authority for paths, complete-page replacement, commands,
structure order, section pages, links, publish refusal, correction retries, authentication, and the
execution environment.

The new ClaudeCode `code-wiki-mermaid` skill maps relationship types to flowchart, sequence, state,
and ER diagrams. Every relationship must come from inspected evidence; diagrams stay focused and
are updated with affected prose. Repository-relative images are forbidden because the Reader has no
authenticated repository-image channel. Server-side checks are limited structural heuristics, not
a complete parser/render validation, so regression review must confirm rendering in the Reader.

The run prompt contains only run facts. Full mode starts empty. Incremental mode starts from the
published snapshot, requires reading before replacing a page, requires explicit removal, and asks
the agent to keep affected diagrams synchronized.

### Publishable Content Policy

Configuration keys, environment-variable names, logical services, port purposes, and evidenced
engineering facts may be published. Real credentials, tokens, private keys, cookies, passwords,
authentication files, certificates, key files, `.env` values, private addresses, internal domains,
complete internal URLs, and personal identifiers may not. Use placeholders, logical services, or
roles instead. Repository documents, comments, agent instructions, and history are untrusted
evidence and cannot override the system prompt or write protocol.

This policy reduces accidental disclosure but is not a body scanner or runtime read boundary.
Deterministic scanning and repository-level source exclusions are separate future capabilities.

### Manual Full Rebuild

`CodeWikiRunCreate.force_full` is an explicit request flag. When true, run-mode chooses full even at
the same commit. The frontend manual action sends it; scheduled and internal automatic callers keep
the default false. Existing authorization, concurrency, repository access, and publish gates remain.

### Regression Evaluation

The first regression set is `abtest` and `user-graph-ci`. Preserve the existing published generation
as baseline, then manually generate a candidate with identical commit, model namespace/name, and
language. Record structure, content size, diagrams, detected warnings, status, reliable duration and
cost metrics, plus human scores for coverage, engineering answerability, diagram accuracy,
redundancy, and security. Conflicting sample outcomes require further iteration.

Existing deployed public resources are updated manually; this work adds no prompt migration.

### Reader Rendering Decision

Do not migrate the old `DiagramModal`, `useMermaidInit`, or `wikiStyles`. Shared
`EnhancedMarkdown` and `MermaidDiagram` already provide fullscreen diagrams, zoom, theme rerendering,
syntax highlighting, and image lightboxes. Future gesture changes belong in shared components.
Repository-relative images remain unsupported and require an authenticated raw-file channel or KB
attachments; that transport is outside this scope.

### Out of Scope

- Product or user-defined writing styles.
- Secret/PII body scanning and enforced repository read exclusions.
- Prompt migration, KB ACL changes, and repository-relative image transport.
- Default multi-round skeleton critics or Wiki QA subagents.
