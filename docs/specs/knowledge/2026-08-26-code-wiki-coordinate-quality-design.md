---
sidebar_position: 6
---

# Code Wiki Coordinate 生成质量设计

## 背景与经验

最初的 Code Wiki 由一个 Claude Code Writer 完成仓库探索、页面规划、写作和发布。它通常能生成
合理的目录和工程概览，但会较快结束：读取范围有限，复杂模块容易只列职责和文件，缺少控制流、
状态转换、约束、失败恢复和必要图示。

第一版 Coordinate 方案加入了 Plan Reviewer 和最终 QA。实际运行表明，Plan Reviewer 能发现目录、
页面范围和源码依据问题，整体规划通常没有明显缺陷；但所有页面仍由同一个 Writer 撰写时，长任务
中的上下文竞争没有消失。Writer 即使按计划创建了全部页面，也可能在具体章节中丢失重要机制。
例如运行时页面可以列出 `context`、`guard` 等目录，却没有解释它们何时介入、如何影响执行，也没有
给复杂流程配图。最终 QA 对这种系统性深度不足的改善有限，因为它发生在大批页面完成之后，通常只
定位少量事实或引用错误。

早期门禁还尝试从 Executor 的 subagent 生命周期事件判断 Reviewer 是否完成。同步 Reviewer 已经
返回 verdict 时，事件观察仍可能停在 `awaiting_observation`，导致 Writer 重启 Reviewer、重复提交或
在 generation 已终止后继续尝试。这类检查防住了假设中的 Writer 绕过，却让正常协作路径变得脆弱。
当前实现改为由 Writer 和 Reviewer 直接写入、读取 generation 上的持久状态；Executor 事件只用于
展示和诊断，不再决定能否发布。

因此当前方案把主要质量投入前移到“计划内容合同 + 合理分工”，默认只保留 Plan Review。复杂仓库
按源码领域拆成少量 Work Package，由独立 Section Writer 在受限上下文中研究和撰写；Coordinator
最后编写跨领域综合页。这样解决的是每页可用注意力和源码覆盖，而不只是增加一次事后评审。

## 目标与范围

- 仅 Coordinate Team 执行的手动 `FULL` rebuild 使用本协议；incremental、定时更新和 Solo baseline
  保持精简路径。
- 同一 Task 内复用 Claude Code 原生 subagent：Coordinator、Plan Reviewer，以及按需调用的 Section
  Writer。它们是协作角色，不是权限隔离边界。
- 默认策略为 `plan_only`。`plan_and_qa` 及 Recheck 仍保留在服务端合同中，便于后续实验，但新建
  generation 不使用。
- 不增加候选版本或用户确认步骤。失败 generation 不发布，Reader 继续展示上一版本。
- 不追求 OpenWiki 式近乎全仓无上限探索；通过显式 scope、持久交接和确定性门禁控制成本。

## Team 与写作模式

Coordinate Team 包含三个资源角色：

- **Coordinator**：探索全局、制定 Plan 和 Writing Plan、委派 Work Package、编写首页及跨领域综合
  页面，并完成发布。
- **Reviewer**：只评审 Plan，检查覆盖、页面职责、`Must explain` 问题、源码证据、图示意图和分工
  是否合理；不写页面、不代替 Coordinator 发布。
- **Section Writer**：只处理一个持久化 Work Package，研究共享源码范围并写入被分配的页面；不
  修改计划、不发 Reviewer verdict，也不写其他 Package 的页面。

Writing Plan 支持两种模式：

- `coordinator`：适合结构紧凑、主要机制能装入一个连贯写作上下文的工程。全部路径归 Coordinator，
  不委派 Section Writer。
- `scoped`：适合存在多个独立运行时、业务领域或跨系统流程的工程。相关的小章节可以归入同一个
  Work Package，但不默认按一页一个 Worker。Coordinator 保留首页、快速开始、总体架构等需要跨域
  综合的页面，并在相关 Package 完成后撰写。

每个计划路径必须恰好有一个 owner。`scoped` 模式还必须持久化输出语言，Section Writer 只凭
generation ID 和 Work Package ID 就能恢复完整上下文，不依赖 Coordinator 的对话历史。

## Plan 内容合同

Plan 不只是路径列表。每个页面必须声明：

- 面向读者的用途及与父页、子页、跨页的关系；
- 可核验的源码入口、关键 symbol、测试或命令；
- 一组源码派生的 `Must explain` 问题，覆盖该页重要机制、状态、边界或失败路径；
- 关系、时序或生命周期是否值得用 Mermaid 表达；没有信息增益时可明确写 `none`；
- 所属 Work Package，以及与相邻 Package 的边界。

Reviewer 重点判断信息架构和执行分工，而不是润色标题。通过时必须提交完整计划路径和非空
`focusPaths`。首次 `changes_requested` 后允许 Coordinator 修订并复审一次；第二次仍不通过则终止
generation，避免无界循环。

## 持久交接与状态机

Writer 先用 `review-open --phase plan` 提交 Markdown handoff 和结构化 Writing Plan，使状态从
`not_started` 进入 `ready`，再同步调用 Reviewer。Reviewer 用 `review-status` 读取同一份持久输入，
并在退出前调用 `review` 写入 `passed` 或 `changes_requested`：

```text
not_started -> ready -> passed | changes_requested
```

`generation.ext.qualityReview` 保存 review policy、handoff、Writing Plan、服务端 attempt 和 verdict。
`review-status` 返回 `reviewPolicy`、`nextAction`、handoff、review，以及 Plan 通过后的页面进度：

- `plannedPaths`
- `writtenPaths`
- `missingPaths`
- `unexpectedPaths`

Coordinator 在 Reviewer 返回后只读取一次状态并服从 `nextAction`。若状态仍为 `ready`，说明 Reviewer
没有提交 verdict，generation 直接失败；不得 sleep、轮询或另起 Reviewer 猜测结果。命令返回终态
退出码时，Writer 立即停止，不允许在失败 Task 上继续 review、写页或 complete。原 Code Wiki Task
也不支持会话级重试，用户重新生成会创建新的 generation。

## 写作与发布门禁

Plan 通过后，`scoped` 模式按 Work Package 同步委派 Section Writer。每个 Worker 从持久 Plan 恢复
源码范围、页面路径、语言和 `Must explain` 合同，并只提交自己的页面。Coordinator 以服务端返回的
`missingPaths` 判断完成度，不依赖 subagent 的自然语言总结；所有领域页完成后再写综合页。

默认 `plan_only` 发布门禁要求：

- 最近一次 Plan verdict 为 `passed`；
- 实际页面集合与计划路径集合完全相等，不能缺页或夹带计划外页面；
- `focusPaths` 非空且全部属于计划；
- 页面路径、内容和 Mermaid 通过既有确定性校验。

Plan verdict 只证明计划与分工经过审阅，不声称最终正文经过人工式 QA。内容深度主要由
`Must explain` 合同、受限 Worker scope 和源码核验获得。保留的 `plan_and_qa` 策略可以恢复全量 QA
和一次 Recheck，但只有 generation 明确返回该策略时才能使用，Writer 不得自行开启额外阶段。

## Reader 进度

运行状态由持久 review 状态和候选页面数量实时派生，不另存一套流程状态。默认 `plan_only` 展示
规划评审、页面写入、整合与发布三个阶段；保留的 `plan_and_qa` 展示四阶段。Plan 通过后显示计划
页数，写作中显示已写/总数。

Reader 每 10 秒轮询运行状态，离开 `running` 后停止。generation 完成时重新加载页面树、当前版本和
正文，并在路径仍可读时保留当前页面。轮询的短暂网络失败不会冻结进度；旧版、Solo 和 incremental
任务没有质量证据时只显示通用生成状态。

## 验证方式

在相同提交、模型、语言和 full rebuild 参数下比较 Solo 与 Coordinate 输出，记录耗时、可获得的
token/cost、页面数、字符数、Mermaid 数量和发布结果。这些指标只用于解释成本，不替代人工判断。

人工抽查应从目标仓库的重要页面提出源码可证伪的问题，确认 Wiki 能说明真实控制/数据流、状态与
转换、边界和失败恢复，并在图示确有信息增益时提供源码有据的图。实际 Wegent 验证中，scoped
writing 明显改善了单页深度，但运行时间约提升到小时级；这是当前在 15 分钟浅生成与 OpenWiki
近两小时全量扫描之间接受的成本点，仍需通过更多不同规模仓库验证。

## English Summary

# Code Wiki Coordinate Generation Quality

The first Coordinate design added Plan review and final QA to a single Writer. Runs showed that the
Plan was usually sound while individual pages still lost mechanism-level detail: one Writer retained
too many domains in one long context, and late QA had limited leverage over systematic shallowness.
An early gate also depended on observing Executor subagent events, producing false
`awaiting_observation` states and retry loops even after a Reviewer had submitted a verdict.

The current default is `plan_only`. The Coordinator persists a source-grounded Plan and a structured
Writing Plan. The Plan Reviewer checks page purposes, evidence, `Must explain` questions, diagram
intent, focus pages, and ownership. Compact repositories use `coordinator` mode; larger repositories
use `scoped` mode, where bounded Section Writers recover one Work Package from persisted state and
write only its assigned pages. The Coordinator writes cross-domain synthesis after those packages.

Review handoffs and verdicts live in `generation.ext.qualityReview`; Executor lifecycle events are
diagnostic only. `review-status` returns the backend-derived policy, next action, durable handoff and
verdict, plus planned, written, missing, and unexpected paths. Publication requires a passed Plan,
non-empty valid focus paths, and an exact match between planned and written pages. The reserved
`plan_and_qa` policy retains QA and Recheck but is used only when the generation explicitly selects it.

The Reader derives a three-step Plan/Writing/Publish view for `plan_only`, polls every ten seconds, and
reloads navigation and content after publication. Evaluation compares cost signals but judges quality
with repository-specific, falsifiable questions about mechanisms, state, boundaries, recovery, and
source-grounded diagrams.
