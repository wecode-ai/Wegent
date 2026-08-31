---
sidebar_position: 6
---

# Code Wiki Coordinate 质量闭环设计

## 背景与目标

当前 Code Wiki 由单个 Claude Code Bot 自行决定探索、写作与结束时机。它通常能得到可用的工程
导航，但对大型仓库容易过早结束：关键运行时边界、控制流细节与图示覆盖依赖同一个模型自行
判断，服务端发布门禁也只验证结构和 Mermaid 的明显错误。

本期为**手动 full rebuild** 增加低成本质量闭环。复用 Executor 的 Claude Code `coordinate`
协作模式，由 Writer 生成 Wiki、Reviewer 进行计划审阅与最终 QA；不新增候选版本、用户确认或
前端工作流。目标是在同模型、同一次 Task 内，以有限回合提高覆盖与可验证性，而不是复刻
OpenWiki 的无上限多智能体循环。

## 范围和非目标

- 仅通过 Coordinate Team 执行的 `FULL` Code Wiki generation 需要本质量闭环；incremental、
  定时更新和保留的 Solo A/B baseline 均维持精简路径。
- Team 由 Writer leader 和一个 Reviewer 组成，collaboration model 为 `coordinate`。
- Reviewer 合并 plan critic 与 content QA 职责。它是协作性质量角色，不是权限隔离或恶意输入
  安全审计边界；两个 Bot 仍在同一 Task 与工作环境中运行。
- 不修改任务 UI 或发布版本模型。Wiki Reader 只展示由持久化 review 证据派生的只读进度；质量
  失败后不发布，用户继续看到旧 Wiki，后续仍可通过既有“重新生成”再次运行。
- 不构建通用 benchmark 平台。本期只在固定 `main` commit 上运行旧 Solo 与新 Coordinate 的
  人工 A/B 对照。

本文件取代 2026-08-12 设计中“默认启用多轮 skeleton critics 或 Wiki QA subagents”的非目标，
但不改变其余 prompt、安全与 full-rebuild 决策。

## 固定执行协议

Writer 必须按以下顺序工作：

1. 探索仓库并按 `REVIEW_CONTRACT.md` 写出包含页面路径、模块覆盖、源码依据和预期图示的 Plan
   handoff。Writer 用 `review-open` 持久化 handoff，使状态变为 `ready`，再同步委派 Reviewer；
   Reviewer 从 `review-status` 读取 handoff，并选择最小的一组结构核心页面作为 `focusPaths`。若首次计划
   `changes_requested`，先修订计划并使用同一 `plan` phase 再审一次；第二次仍要求修改则失败。
2. Reviewer 在自己的原生子任务结束前用 `wiki_submit review --phase plan` 提交计划结论、路径和
   摘要。要求修改时必须提交结构化 Markdown findings。review API 原子生成持久 checkpoint；Writer
   在子任务返回后只读取一次状态并执行服务端返回的 `nextAction`。若仍为 `ready`，说明 Reviewer
   未提交 verdict，Writer 立即 fail，不轮询或重拉 Reviewer。
3. 全部页面写完后，Writer 持久化列出所有写入页的 QA handoff，再同步委派 Reviewer。Reviewer 对每个 `focusPath` 至少提出一个可由源码证伪的机制
   问题，确认页面说明了职责与边界、控制或数据流、状态与转换、适用的约束和失败恢复，以及修改
   与验证方式；并可抽查非核心页面的整体覆盖。图示只在关系、时序或生命周期明显优于文字时要求。
4. QA 通过时 Reviewer 提交 `qa passed` 后 Writer 完成；QA 要求修改时，Writer 按 findings 定向修复，
   持久化逐项说明修复的 Recheck handoff，再委派一次 recheck；`recheck passed` 后完成。
5. recheck 仍不通过或 Task 无法修复时，Writer 使 generation 失败而不发布。不得把失败静默
   降级为“仍然 complete”。

Reviewer 负责提交审阅结论、证据、遗漏和可执行修改项，不负责页面作者职责，也不自行 complete
或 fail generation。Writer 在上下文压缩或恢复后以 `review-status` 作为唯一恢复来源。运行时
prompt 与 `wiki_submit` skill 共同提供这一协议；prompt 是协作指导，服务端门禁才是发布的确定性
条件。

## 服务端质量合同

内部 review-open API 将 Writer handoff、范围、attempt 和当前页面指纹持久化到
`generation.ext.qualityReview`；review API 只接受对应 `ready` handoff 的 Reviewer verdict。每条
checkpoint 保存：

- phase：`plan`、`qa` 或 `recheck`；
- status：`passed` 或 `changes_requested`；
- 计划 checkpoint 的 `focusPaths`：需要机制级深度的最小核心页面集合；
- 本轮检查的页面路径与简短摘要；
- `changes_requested` 的可执行 findings；
- 同 phase 的服务端 attempt 序号；
- 当前 generation 全部页面的稳定内容指纹。

full generation 在发布前必须满足：

- 最近的计划审阅为 `passed`，计划页非空且均已写入，`focusPaths` 非空且属于计划；
- QA 的 checked paths 覆盖全部 `focusPaths`；
- 最终 QA 为 `passed`，或 final QA 曾要求修改且唯一一次 recheck 为 `passed`；
- 最后一个通过 checkpoint 的内容指纹与当前待发布页面一致。

不满足时，沿用既有 publish refusal：generation 标为失败、版本不发布、`wiki_submit complete`
收到机器可读原因。已有 `PUBLISH_REFUSED` 修复通道允许 Writer 补页或修复，然后再次审阅和
complete；不会产生半发布版本。incremental generation 不检查这些 checkpoint。

full run prompt 使用 Executor 实际生成的 Reviewer agent type，并明确每次委派的 phase。状态为
`not_started -> ready -> passed | changes_requested`，且返回 `attempt` 和 `nextAction`；`ready` handoff
与 Reviewer verdict 之间页面发生变化时拒绝提交。Executor 的
subagent 生命周期继续用于普通任务展示和诊断，但不参与 Wiki 发布门禁。该模型明确把 Reviewer
作为协作性质量角色，而不是针对恶意 Writer 的安全隔离角色，避免依赖 prompt 文本解析和两条异步
事件链的时序关联。

## Reader 进度投影

运行状态 API 从 `qualityReview` handoff/checkpoint 和当前候选页面数量实时派生进度，不另存一套
总体流程状态。Coordinate full rebuild 展示四个有证据的阶段：规划、撰写、QA、发布；计划复审、
QA 修复和 Recheck 使用各自更具体的文案。没有质量 review 证据的旧版、Solo 或 incremental run
只展示通用“正在生成”，不伪造阶段编号或完成百分比。首次生成和已有 Wiki 的重新生成均在 Reader
主内容区看到默认展开、可折叠的四阶段卡片；计划通过后显示计划页总数，撰写阶段显示候选页完成数。
状态进入 `running` 时启动轮询、离开时停止，因此从已完成页面手动重新生成也会持续刷新；状态转为
`completed` 时重新加载页面树并尽量保留当前阅读路径。stale 或已结束任务不再显示运行进度。

## 验证与 A/B

以已提交的 Wegent `main` SHA、相同模型、语言和 full rebuild 参数，创建两个隔离的临时 Code
Wiki：A 使用现有 Solo Team，B 使用 Coordinate Team。记录每次的运行耗时、可用 cost/token、
页面数、字符数、Mermaid 数量、发布结果与 checkpoint；这些是信号而非质量结论。

人工对照重点检查 Reviewer 为目标仓库选择的核心章节：是否从目录清单深入到真实边界、控制或数据
流、状态转换、约束与恢复机制、修改和验证方式；是否覆盖计划中的主要模块与跨边界流程；必要图示
是否源码有据；Reviewer 的机制问题是否都能从 Wiki 得到准确答案。满足这些前提下，以显著成本/
时长增幅换取稳定的内容增益为通过标准。

## English Version

# Code Wiki Coordinate Quality Loop

## Goal and Scope

For manual `FULL` Code Wiki rebuilds through the Coordinate Team, replace the single self-directed
writer flow with one Writer leader and one cooperative Reviewer in the existing Claude Code
`coordinate` Team mode. The Reviewer combines plan criticism and content QA. Incremental, scheduled,
and retained Solo A/B baseline runs remain lean. This is not an access-control boundary: both bots
still run in the same task environment.

No candidate-version UI, confirmation step, task UI, or benchmark platform is added. The Reader adds
only a derived progress display. A failed quality gate publishes nothing, so the previously published
Wiki remains visible and a normal regeneration can be run later.

## Bounded Protocol

The Writer persists a contract-formatted Plan handoff with `review-open`, then delegates the Reviewer
synchronously. The Reviewer reads that durable handoff, selects the smallest structurally central set
of `focusPaths`, and submits the `plan` verdict. After the native task returns, the Writer reads state
once and follows `nextAction`. QA uses a handoff covering every written page; requested changes carry
actionable findings; Recheck uses a handoff mapping those findings to repairs. A Reviewer that returns
while state remains `ready` fails the generation rather than starting a polling or replacement loop.

## Server Contract

The internal review-open endpoint stores the Writer handoff, scope, server-side attempt and stable
candidate fingerprint in `generation.ext.qualityReview`. The review endpoint accepts a verdict only
for that ready handoff and stores status, checked paths, Plan focus paths, summary, actionable findings
and the reviewed fingerprint. `review-status` exposes `not_started`, `ready`, `passed`, or
`changes_requested` plus a server-derived `nextAction`. The full-run prompt still names the generated
Reviewer agent type for delegation, but Executor lifecycle callbacks are diagnostics rather than
publication evidence. Before
publishing, the server requires a non-empty passed plan whose paths exist, non-empty focus paths that
belong to the plan, QA coverage of every focus path, plus either passed QA or
QA changes followed by passed recheck, and it requires the latest passing checkpoint fingerprint to
match the pages being published. The collaboration improves quality but is deliberately not treated
as an access-control boundary against a malicious Writer.

## Reader Progress Projection

The polled run-status API derives progress from durable handoffs, checkpoints, and the candidate page
count instead of persisting another workflow state. Coordinate full rebuilds expose four evidenced
steps: planning, writing, QA, and publishing, with specific labels for plan revision, QA repair, and
Recheck. Legacy, Solo, and incremental runs expose only generic generation with no invented step or
percentage. The Reader main area shows the same expanded-by-default, collapsible four-step card for
initial generation and regeneration. Once the Plan passes it shows the planned page total, and while
writing it shows candidate pages written versus planned. Polling starts whenever status enters
`running` and stops when it leaves, including a manual regeneration begun from an idle page. On
completion the Reader reloads the page tree while preserving the current path when possible. Terminal
and stale runs do not show active progress.

## Evaluation

On one committed Wegent `main` SHA, run two isolated temporary full rebuilds with the same model and
language: existing Solo (A) and Coordinate (B). Compare duration, available cost/tokens, page and
diagram counts, publish/checkpoint results, and human review of coverage and factual usefulness.
For the repository-specific focus pages, check real boundaries, control/data flow, state and
transformations, applicable constraints and recovery, change guidance, and source-grounded diagrams
where a visual materially improves comprehension.
