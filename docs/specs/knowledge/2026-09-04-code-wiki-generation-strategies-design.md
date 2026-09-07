---
sidebar_position: 8
---

# Code Wiki 多生成策略与 Coordinator 自适应写作设计

本文是
[`2026-09-03-code-wiki-planner-writer-design`](./2026-09-03-code-wiki-planner-writer-design.md)
之后的下一阶段设计。09-03 方案作为 `planner_writer` 的参照实现保留，不再作为唯一执行路径。

## 背景与最新观察

Planner + Section Writer 方案在一次真实仓库生成中带来了明确收益：页面更详实，持久 handoff、按依赖
顺序写作和前序经验传递也有效。但同一次运行没有验证“角色收敛会降低消耗”这一假设，实际体感反而
更慢。当前只有单次运行观察，尚没有同仓库、同 commit、同模型的量化对照，因此本文不把“必然更慢”
当作结论；可以确认的是它存在结构性的重复阅读风险：

- Planner 为了形成完整计划先建立全局认识；
- 每个 Writer 为回答自己的 `Must explain` 又读取相关源码；
- 如果 Coordinator 先委派“探索”，再委派另一个 Writer 写作，同一范围还会出现第三次上下文建立；
- 全量委派即使提高单页深度，也固定支付 subagent 启动、handoff 和串行调度成本，小仓库尤其不划算。

因此下一步不继续把所有仓库压到一个更复杂的固定工作流里，而是先让几种有限、可命名、可回放的策略
并存，再用真实运行数据决定哪一种应成为默认值。

## 决策

### 1. `RunMode` 与 `GenerationStrategy` 是两个正交概念

- **RunMode**：现有 `full` / `incremental` / `skip`，回答“这次重建多少内容”。
- **GenerationStrategy**：回答一次 `full` 重建中“谁规划、谁写、是否委派、是否评审”。

不得把策略继续编码进 `Team.spec.collaborationModel`，也不得从 Team 成员是否恰好包含 Reviewer 来反推
策略。`collaborationModel=coordinate` 只是 Team 的通用执行能力，不是 Code Wiki 的生成协议。

首批内建四种策略：

| 策略 ID                | 写作方式                                                 | Reviewer / QA | 定位                     |
| ---------------------- | -------------------------------------------------------- | ------------- | ------------------------ |
| `coordinator_adaptive` | Coordinator 按范围决定自己写或委派 Writer                | 无            | 新的默认候选             |
| `coordinator_reviewed` | Coordinator + Section Writer，保留原 Coordinate 评审流程 | 有            | 质量基线与回归对照       |
| `coordinator_solo`     | Coordinator 自己研究并写完全部页面，不启动子 agent       | 无            | 写作规范改进的单人基线   |
| `planner_writer`       | Planner 不写页，全部交给 Writer                          | 无            | 09-03 方案的参考实现，暂未注册为可选策略 |

策略 ID 表达稳定的执行方案，`revision` 表达该方案的实现版本。Prompt、阈值或 handoff 格式等兼容演进
只递增 `revision`；只有执行语义发生根本变化并且新旧方案必须同时存在时才新增 ID，优先使用描述性名称，
不预先添加 `_v1`。策略集合是代码中的有类型注册表，不做用户可编排的工作流 DSL。新增策略必须新增明确 ID、版本、Team
要求、gateway 协议和测试用例，不能通过任意 JSON 拼装角色状态机。

### 2. 策略是一次 generation 的一等输入

策略选择分为创建与运行两个时点：

1. 创建 Code Wiki 时，使用请求显式选择的策略，否则使用系统默认策略，并把结果写入 Wiki；
2. 启动 generation 时始终使用 Wiki 自身保存的策略；
3. 历史 Wiki 没有该字段时使用与上线前行为一致的 legacy fallback，而不是动态继承系统默认值。

Wiki 的策略在创建或其高级设置中保存；定时、自动与手动 generation 都使用这个值。修改系统默认值
只影响之后新建的 Wiki，不批量改变存量 Wiki 的行为。第一阶段策略只作用于 `FULL`。

生成创建时必须把解析结果快照到 `WikiGeneration.ext`：

```json
{
  "generationStrategy": {
    "id": "coordinator_adaptive",
    "revision": 1,
    "teamName": "code-wiki-adaptive-team"
  }
}
```

`WikiGeneration.team_id` 继续记录实际执行 Team。历史页显示 generation 的策略 ID；重跑历史版本时仍按
当前请求重新解析策略，而不是假装旧 Team 和旧 prompt 永远可重放。`revision` 用于解释结果差异，不把
可变的 prompt 全文复制进数据库。

### 3. 一个部署级 Policy 承载策略与 Team 的联动

backend 定义一个有类型的 `CodeWikiGenerationPolicy`，作为部署中唯一的联动配置源：

```json
{
  "defaultStrategy": "coordinator_reviewed",
  "legacyFallbackStrategy": "legacy",
  "strategies": {
    "coordinator_adaptive": {
      "enabled": true,
      "teamRef": { "namespace": "default", "name": "code-wiki-team" }
    },
    "coordinator_reviewed": {
      "enabled": true,
      "teamRef": { "namespace": "default", "name": "code-wiki-team" }
    },
    "coordinator_solo": {
      "enabled": true,
      "teamRef": { "namespace": "default", "name": "code-wiki-team" }
    },
    "legacy": {
      "enabled": true,
      "teamRef": { "namespace": "default", "name": "code-wiki-team" }
    }
  }
}
```

Policy 只表达部署选择：支持哪些策略、各自绑定哪个 Team、创建新 Wiki 时默认哪一种、历史 Wiki 如何
兼容。不同策略可以复用同一个 Team；只有模型、工具权限或角色能力确有差异时才需要独立 Team。它不承载
prompt、状态机或任意工作流定义。策略行为仍由代码中的 registry 定义，防止生产配置演变成无类型 DSL。

`legacy` 是不可选择、不会出现在 UI 的内部策略，只为兼容尚未迁移到新 Policy 的部署，保留升级前
“是否评审由 Team collaborationModel 决定”的行为。完成 Policy 迁移后，新 Wiki 必须固化正式策略 ID。
上例是三种正式策略全部落地后的目标配置；PR-1 的默认 Policy 只启用
`coordinator_reviewed` 与内部 `legacy`，其余策略随对应协议实现再启用。

Policy 首版放在 backend 的 Code Wiki 配置中，通过一个结构化配置项加载；默认值与
`backend/init_data/02-public-resources.yaml` 中的内建 Team 对齐。不要分别用三个散落的 Team 环境变量，
也不要让前端维护策略到 Team 的映射。backend 提供只读 capabilities API，前端只展示当前启用且 Team
校验通过的策略。

兼容期内，未配置 Policy 的部署由现有 `WIKI_CODE_WIKI_TEAM_NAME` 自动构造只含
`coordinator_reviewed` 与内部 `legacy` 的 Policy，其新旧 Wiki 都使用 `legacy`，从而严格保持升级前行为。
显式配置 Policy 后，新 Wiki 固化其正式默认策略，旧 Team 配置不再参与解析。

每个新 Wiki 把最终选择写入 `spec.generationStrategy`。这才是“当前 Wiki 用哪一种”的权威来源；全局
`defaultStrategy` 只是创建默认值。这样可以让不同 Wiki 同时跑不同策略，而不因全局配置调整影响全部
定时任务。

### 4. Team 与 gateway 都显式支持策略

backend 增加一个集中式 `GenerationStrategyRegistry`。每个定义至少包含：

- 稳定的 `id` 与整数 `revision`；
- 所需角色，例如 Coordinator、Writer、Reviewer；
- gateway 协议，例如是否需要 Plan review、QA、Writer 委派能力；
- 构建 prompt 所需的策略模板 ID。

启动 generation 时，gateway 用 Policy 中的 `teamRef` 加载 Team，再用 registry 校验所需角色并返回
一个不可变的 resolved strategy；后续创建 generation、构造 prompt、初始化 gate 都只消费这个对象。

Team 负责提供角色和工具能力，gateway 负责执行 Code Wiki 协议。两者边界如下：

| 责任                          | Team       | Code Wiki gateway |
| ----------------------------- | ---------- | ----------------- |
| Bot / Ghost / model / tools   | 是         | 否                |
| 策略行为定义                  | 否         | registry          |
| 启用策略、Team 映射、全局默认 | 否         | Policy            |
| Wiki 默认值、请求覆盖         | 否         | gateway           |
| 角色是否齐全                  | 被校验对象 | 校验并拒绝启动    |
| plan / review / QA 状态转换   | 否         | 按策略执行        |
| generation 策略快照与历史展示 | 否         | 是                |

Reviewer/QA 不做全局删除。`coordinator_adaptive` 的状态机不创建这些阶段，旧策略仍可使用它们；这使
对比和维护不依赖反复修改同一个 Team。

## `coordinator_adaptive` 执行协议

### 核心规则：每个源码范围只有一个深度阅读者

Coordinator 先做足以划分页面和风险的浅层 discovery，然后针对每个写作范围二选一：

- **自己写**：适用于它已经掌握充分证据的全局页、小仓库页面、索引与跨页汇编；
- **委派一个完整 Work Package**：同一个 Section Writer 在同一次 subagent 调用中完成“补充探索 +
  写作 + 提交”，不再先派探索 agent、再派写作 agent。

一旦某个范围决定委派，Coordinator 不再对该范围做深度源码研究。Writer 不得再次委派。当前执行层
没有可靠的、可持久恢复同一 subagent 上下文的句柄，因此“先让 agent 探索，之后再召回同一 agent
写作”不作为 v1 能力；v1 通过把探索和写作合并成一次 Work Package 达到同样目的。

### 规划不是全量预读

Coordinator 的 planning 产物保留有价值的 handoff，但缩小为写作合同：

- 页面路径、用途和 `Must explain`；
- seed paths 与已知 source spans；
- 页面依赖和建议生成顺序；
- Coordinator 已确认的少量 given facts；
- `author=coordinator` 或 `author=writer:<work-package-id>`。

它不需要在分配前证明每个 `Must explain` 的完整答案。决策顺序应为“看见复杂度后尽早决定委派”，
而不是“Coordinator 研究清楚后才决定让别人再研究”。

### Coordinator 的自写质量合同

Coordinator 与 Section Writer 使用同一份页面质量标准。每次写页前必须重新看到该页的 `purpose`、
`Must explain`、seed paths 和依赖页，而不能只依靠规划阶段记忆。自写页面同样必须：

- 解释机制、关键状态变化和失败路径，而不只列目录或组件；
- 对核心结论给出可解析的源码引用；
- 使用已经生成的前置页面传递共享事实，避免重新从源码推导；
- 满足现有页面、链接、Mermaid 与发布 gate。

因此“允许 Coordinator 写”不等于恢复薄页路径；它只取消强制委派，质量合同和确定性 gate 对两类作者
一致。

### 委派启发式

v1 把选择权交给 Coordinator，但给出少量可审计原则，不实现评分器：

- 单一、局部、Coordinator 已有证据的页面优先自写；
- 需要跨多个模块建立机制链路，或 `Must explain` 明显超出当前证据时，委派一个 Work Package；
- 同一领域的模块页与 workflow 页尽量交给同一 Writer，复用其上下文；
- `index`、`quickstart` 和最终汇编页在依赖页完成后由 Coordinator 写；
- 不为达到某个固定 subagent 数量而拆包，也不允许每页机械启动一个 agent。

这些是 prompt 合同，不是后端硬编码阈值。真实指标稳定后，才能决定是否把其中某条升级为机械规则。

## 可观测性与对比方法

第一阶段不建设新的观测链路。token 和 source-read 去重需要 executor 可靠回传角色级事件，当前成本和
准确性都不合适，不作为本方案的依赖。

只新增 generation 必需的策略快照，其余对比复用现有数据：

- `WikiGeneration` 的状态与创建/完成时间看成功率和总耗时；
- `WikiGeneration.task_id` / `team_id` 关联实际 Task 与 Team；
- `WikiContent` 计算页数和页长分布；
- 已持久化的 Plan / Work Package 信息若能直接得到作者或委派数就使用，不能得到也不新增埋点；
- 人工抽查少量核心页的机制完整性、跨模块链路、运维和测试内容。

对比时固定 repository、commit、模型、语言和 RunMode，至少各运行一次
`coordinator_adaptive` 与 `coordinator_solo`（需要时另行启用 09-03 参考实现）。一次体感结果只用于
发现问题，不直接决定默认策略。

### PR-2 不新增质量阈值

`coordinator_adaptive` 的首版依赖统一写作合同、计划页面对账和现有 publish gate（最低页面数、section
overview 与 Mermaid 校验）；不在 PR-2 新增“大仓判定”“单页最小长度”或“最少引用数”等阈值，因此
不需要在实现前人工提供参数。

单页长度不能稳定代表内容质量，不同类型页面也不应共享同一阈值。先从真实对比中查看现有
`WikiContent` 的页长分布并人工抽查；如果确认存在可机械识别的退化，再单独设计一个有数据依据的 gate，
而不是把未经校准的阈值塞进策略框架。

## API 与 UI

- Code Wiki 创建/设置页可选择该 Wiki 的默认生成策略，只展示 Policy 中启用且 Team 校验通过的策略。
- 手动“完整重新生成”确认层可覆盖本次策略，并提示不同策略在耗时与质量上的取舍。
- 运行历史展示策略名称；运行中的阶段由 resolved strategy 决定，不为无 Reviewer 的策略显示
  `plan_review`、`qa_review` 或 `recheck`。
- API 使用 `strategy_id`，响应和历史也返回 resolved `strategy_id` 与 `strategy_revision`。
- 缺失策略、禁用策略或 Team 角色不完整时在创建 generation 前返回明确错误，不回退到另一策略。

## 兼容性与迁移

- 新建 Wiki 把部署默认策略解析后写入自身 spec；之后修改部署默认值不改变它。
- 现有 Wiki 没有默认策略字段时映射到 Policy 的 `legacyFallbackStrategy`，避免升级后无提示改变生成结果。
- 现有 `generation_type` 和 RunMode 决策不改名、不改语义。
- 09-03 分支只作为选择性移植来源：可复用 Writer 工具白名单、`wiki_submit` 模块拆分、per-WP 切片、
  页面依赖和作者记账；不整体移植“Coordinator 零 authorship”和“所有页面必须归属 Work Package”。
- 不在兼容逻辑里按 Team 名称猜策略；历史 generation 没有快照时显示 `legacy`。

## 分阶段落地

| PR   | 内容                                                                    | 成功标准                                                             |
| ---- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| PR-1 | strategy registry、配置、解析与 generation 快照；保留当前行为           | 不选择策略时行为不变；API / DB / 单测可辨识策略                      |
| PR-2 | `coordinator_adaptive` prompt、无 Reviewer/QA gateway 路径、Team 初始化 | Coordinator 可混合自写与委派；无伪造 review 阶段；现有策略测试不退化 |
| PR-3 | 创建/设置高级选择器、系统策略配置与历史展示                              | 默认值可见；不可用策略不能选择；运行阶段准确                         |
| PR-4 | 复用现有 generation / task / content 数据做同仓对比，再决定默认迁移     | 形成可复现对照结果，不引入新的 executor 观测依赖                     |

PR-1 不改 prompt，先建立选择、持久化和回放边界。PR-2 只做最小自适应协议，不同时引入 repo-map、
复杂评分器、Reviewer 删除或 incremental 重构。后续 gate 按数据逐项加入。

## 非目标

- 不设计任意角色/节点/条件可组合的工作流平台；
- 不承诺在 executor 进程之间恢复同一 subagent 的隐藏上下文；
- 不在本阶段重做 incremental；
- 不用更长 handoff 代替源码证据，也不要求 Coordinator 预读所有 Writer 范围；
- 不因新策略上线而删除旧策略、旧 Team 或 Reviewer 能力。

## 待实现前确认的两项产品决策

1. 新建 Code Wiki 默认先保持 `coordinator_reviewed`，还是灰度使用
   `coordinator_adaptive`；本文建议先保持旧默认，完成同仓对比后切换。
2. 普通用户是否能选择所有已启用策略，还是只有管理员可改变 Wiki 默认、普通用户只能做单次覆盖；
   这不影响 registry 和 generation 快照，可在 PR-3 前决定。

## English Summary

# Code Wiki Generation Strategies and Adaptive Coordinator Writing

`RunMode` (`full`, `incremental`, `skip`) remains the rebuild-scope decision. A new first-class
`GenerationStrategy` describes how a full rebuild is orchestrated. The initial built-in strategies are
`coordinator_adaptive`, `coordinator_reviewed`, and `coordinator_solo`. The older `planner_writer` work remains a
reference implementation rather than a registered selectable strategy. Stable IDs name execution
semantics while a separate `revision` tracks compatible implementation changes. They are finite,
versioned profiles rather than a user-defined workflow DSL.

The selected strategy is resolved from the wiki default, the system default at Wiki creation time, and finally a
legacy-compatible default. Its ID, revision, and Team are snapshotted on every generation.
The Team supplies role capabilities; the Code Wiki gateway owns strategy resolution and protocol state.
Strategies must never be inferred from `collaborationModel` or from the accidental presence of a
Reviewer.

The adaptive strategy follows one central rule: each source scope has one deep reader. The Coordinator
does shallow discovery and either writes a scope itself or delegates one complete research-and-writing
Work Package to one Section Writer. Writers cannot delegate. Coordinator-written pages use the same
quality contract and are re-anchored to their `purpose`, `Must explain`, seed paths, dependencies, and
source citations before writing.

The solo strategy keeps the same writing contract but makes the Coordinator the only researcher and
author for the full run. It does not create review state or delegate a subagent, making it a controlled
baseline for comparing the writing improvements independently from orchestration.

Rollout first adds the registry and durable snapshot without changing behavior, then adds the adaptive
no-review protocol, then UI selection and history, and only then runs controlled same-repository
comparisons. The role-consolidation branch is a selective source of reusable mechanics, not a branch to
merge wholesale.
