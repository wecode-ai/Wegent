---
sidebar_position: 7
---

# Code Wiki Planner/Writer 角色收敛设计

本文取代 [`2026-08-26-code-wiki-coordinate-quality-design`](./2026-08-26-code-wiki-coordinate-quality-design.md)
中的两处决策:「Team 与写作模式」里 Coordinator 承担首页与跨领域综合页的职责,以及
`coordinator` / `scoped` 双写作模式。其余部分(持久交接、Plan 内容合同的基本要求、Reader 进度)
继续有效。

## 背景与证据

08-26 的 Coordinate 方案在 wegent 上有效:45 个页面、平均约 10KB,模块页有机制、有状态转换、有图。
在 abtest 上重跑同一套协议后暴露三类问题。abtest 是 1603 文件 / 约 15 万行的多模块 Java 仓库,
**比 wegent(6717 文件 / 约 55 万行)小四倍** —— 所以问题不来自规模。

**证据 1:决定成本的是依赖拓扑,不是规模。** abtest 的 Maven 依赖图有一个共享契约核心和一个聚合层:
`abtest-traffic-api` 被 10 个模块依赖,`abtest-common` 被 11 个;`abtest-web-deploy`(517 文件,占全仓
三分之一)依赖 6 个域,其中 `-> auth` 455 处、`-> experiment` 449 处、`-> metric` 352 处。wegent 的模块图
近似森林,域边界与依赖边界重合;abtest 不重合。`scoped` 模式隐含"域边界 ≈ 依赖边界"这一前提,
abtest 违反了它。

**证据 2:scope 覆盖不住 purpose 的委派会迫使 Section Writer 自开子委派。** generation 40 的 WP-04
同时拥有 `modules/metric` 与 `workflows/metric-task`,而其 source scope 只有 metric / olap / schedule ——
这条流程的触发端在 `abtest-web-deploy`。Section Writer 在此契约下无法既完成任务又守住 scope,
于是自行开启嵌套 subagent 去建立 web-deploy 对 metric 的消费面。它最终推导出的结论
(`CalculateController` 等入口)可由两条 grep 直接得到:89 个引用文件、`CalculateTaskService`
`MetricService` 等 21 个符号,按引用次数排序。**被重复推导的事实中,编译期耦合这一类是可机械计算的。**

**证据 3:Coordinator 写出的页面系统性偏薄,成因是角色而非上下文长度。** generation 40 共 17 页,
Section Writer 拥有 8 页,Coordinator 拥有 9 页(`architecture` `domain-concepts` `integration` `modules`
`workflows` `operations` `testing` `index` `quickstart`),实测明显薄于 WP 页面;**在无委派的小工程上
Coordinator 的页面同样偏薄**,排除了"长上下文末尾"这一解释。结构性原因有三:

- Section Writer 的授权是"研究直到答完每一条 `Must explain`",答不完就没有交付;Coordinator 的
  提示词里声音最大的是协议合规(review 状态机、nextAction、终止码、完成清单),写作只是其职责之一;
- Coordinator 写自己那些页时,当初那份 handoff 里对应的 `Must explain` 从不被重新推到它面前;
- 其 Discovery 段的"读的预算就是写的预算"是规划者的经济学,在它切换到写作时仍然生效,而
  Section Writer 的提示词里没有这条刹车。

同时,最需要横向证据的综合页(`integration` `testing` `operations`)被安排在全部 WP 之后由
Coordinator 撰写,而这些事实已经在各 WP 的上下文里出现过 —— WP 的交付物里没有横切事实的上报
通道,于是构成第六次全仓级横向研究。

**证据 4:交接开销与截断风险。** `review-status` 返回整轮全量状态,实测 38.6KB,无 Work Package
切片。每个 Section Writer 启动即拉取全部 17 页的 `Must explain` 与所有 WP 定义,而它只需要自己那一份;
该输出已触发运行时落盘截断,writer 能否可靠读到自己的 scope 变成不确定。

**参照实现。** openwiki(langchain-ai/openwiki)的仓库生成只有 `planning` 与 `generating` 两个阶段,
**没有 reviewer 与 QA 角色**:planner 的工具集不含写入能力且只能提交计划;每页一个全新 worker,
写权限被后端限定为自己那一页;`task` 工具由中间件从模型可见工具中移除;质量由确定性校验
(证据可解析性、链接、Mermaid、索引生成)与离线评测承担。其离线评测报告显式声明不度量覆盖度 ——
覆盖度完全压在 planner 的纪律上。

## 目标与范围

- 只改 Coordinate Team 的手动 `FULL` rebuild 路径。
- **incremental 不重新设计,但必须兼容两处。** 它没有 Plan 也没有 Work Package,因此
  ① `--owner` 归属校验只在存在已通过的 Plan 时要求,incremental 的提交无归属;
  ② 引用门禁按「本轮提交的页面」计,不按版本计 —— incremental 的版本以已发布 wiki 的完整副本
  为起点,而既有页面没有引用,按版本校验会让每一轮增量都失败。
  推论需显式声明:**「Coordinator 零 authorship」是 FULL 路径的规则,不是全局规则**;incremental 中
  它仍是唯一写作者。
- **incremental 的重新设计留到引用落地之后。** 证据 3 的成因在 incremental 中同样存在,但严重程度
  低得多:它先读现有页面再改、变更集有界,且 `max_incrementals_since_full` 为 10 —— 每 10 轮增量
  必定强制一次 FULL 重建,深度会被复位。更重要的是,页面带上引用后,「哪些页面受影响」从模型
  猜测变成后端可计算(被引用的 span 变化或消失),`depends_on_pages` 也让「契约页变更 → 依赖页进
  候选集」可计算;在此之前重新设计其定位逻辑会白做。是否给 incremental 加委派,等 FULL 路径的
  页长分布数据出来后再判断。
- 不引入"每页一个 executor task"。那样需要重复 checkout,代价过高;编排仍在进程内由 Coordinator 驱动。
- 不追求全仓无上限探索;成本仍由显式 scope、持久交接和确定性门禁控制。

## 角色收敛

Team 从三个角色收敛为两个:

- **Coordinator = Planner + Orchestrator,零页面 authorship。** 探索全局、产出 Plan 与 Writing Plan、
  提交并持久化、按拓扑序委派、对账 `missingPaths` / `unexpectedPaths`、`complete`。它不再写任何页面。
- **Section Writer = 唯一写作者。** 一个 Work Package,只写自己被分配的路径,不得再委派。

`coordinator` / `scoped` 双模式取消,只保留一种执行模型:**小仓等于 1~2 个 Work Package**,而不是
"Coordinator 自己写完"。

委派分四类,全部走同一套 Work Package 机制,没有特例:

| 类别                 | 内容                                                                                               | 时机                                          |
| -------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **WP-00 前置基础页** | `architecture`、`domain-concepts`、`contracts/*`(运行时契约:缓存键、多数据源、RPC 复用、OLAP 落地) | 所有其他委派之前                              |
| **WP-SS 共享浅端页** | 高出度聚合层的入口面(abtest 即 `modules/web-deploy` 及其纵切子页)                                  | 先于消费它的 WP                               |
| **域 WP**            | 模块页 + 其深端 workflow 页                                                                        | 按 `depends_on_pages` 拓扑序                  |
| **WP-99 横切汇编页** | `integration`、`testing`、`operations`、`modules`、`workflows`、`index`、`quickstart`              | 最后;source scope 是已写好的页面,不是仓库源码 |

WP-00 的输入是 Coordinator 在规划阶段已经掌握的事实(见「共享内容的传递」第 3 层),它做的是
"把已知写成页并补齐引用",不是重新研究。WP-99 只是一个前置页为全部模块页的普通 WP。

## Plan 内容合同(增量)

在 08-26 已有要求之上增加:

- **页面合同结构化**:每页的用途、`Must explain`、seed paths、cross-link 与图示意图从 Markdown handoff
  移入 Writing Plan JSON,Markdown 只保留给 Reviewer 的叙述。两个理由:per-WP 切片需要按包取出条目,
  按标题解析 Markdown 太脆;而机械校验「`Must explain` 路径闭合」本来就要求条目可寻址。
- **阶段归属**:每个 Work Package 声明所属阶段(`foundation` / `shared_boundary` / `domain` / `assembly`),
  取代 `coordinator_paths`。Coordinator 的归属集合为空。`WikiWritingPlan.mode` 同时删除 ——
  `coordinator` 模式的定义是"全部路径归 Coordinator",而它已经一页都不能写,留着就是一条死且自相矛盾
  的路径。这一项原计划在收口阶段做,提前到此。
- **`depends_on_pages`**:该 WP 开工前必须读的页面路径。它同时诱导出 WP 之间的拓扑序,因此不再
  需要单独表达包对包的依赖。
- **workflow 页的深浅端**:每个跨边界流程页必须声明唯一深端(机制主体所在的域,即其归属 WP)与
  全部浅端。归属规则是**深端归属**:流程页跟随机制主体,其余边界只以接口面形式提供。
- **闭合不变量**:每个 WP 的 `Must explain` 必须可在「自己的 source scope + Boundary Brief + 前置页」
  内回答。需要浅端内部实现才能回答的条目即为归属错误。
- **负载上限**:每个页面覆盖的源文件数存在软上限,超出必须继续拆页。generation 40 的 WP-01 是
  517 文件对 1 页。
- **模块页必需小节**:「集成点」「测试与验证」(必要时「运维与配置」)。这是 WP-99 汇编的原料,
  WP 写模块页时这些事实已在其上下文中,边际成本约十行。

## 共享内容的传递

不新增传输通道,`wiki_submit read` 已能读取本 generation 内任意页面。缺的是约束与声明,分三层:

1. **指针**:`depends_on_pages` 在 plan 中按 WP 精确声明,per-WP 切片返回这些页面的路径、标题与
   一句话职责。不是"读全部前置页" —— abtest 的前置页约 4 页,精确声明后单个 WP 通常只需其中两页。
2. **内容**:Section Writer 用 `read` 按需拉全文。后端把顺序变成硬不变量:**WP 的任意页面提交时,
   若其 `depends_on_pages` 仍有未提交者,直接拒绝。** generation 已在 `writing_progress` 中跟踪已写
   路径,实现成本低。这条杜绝了"前置 WP 确实先跑了但没人被要求消费它"的情况。
3. **Given facts**:5~15 条 Coordinator 规划期已掌握、带源码引用的事实,内联在切片里。用于 WP-00
   的写作输入,以及"一句话事实不值得为它读一整页"的场合。

配套两条写作规则(写入 Section Writer 的系统提示词):

- 先读 `depends_on_pages`,再看源码;**这些页面覆盖的事实不得从源码重新推导**;
- 前置页已建立的事实以链接引用,不复述;必须在本页陈述时,沿用前置页已建立的同一 source span,
  不另建一套引用。第二条使共享契约不会被多个 WP 各自重新接地,与引用门禁不冲突。

## 边界与执行位置

一个必须记录的不对称,否则实现会走错方向:

| 角色            | `tools:` 白名单是否可用                                                                   |
| --------------- | ----------------------------------------------------------------------------------------- |
| Section Writer  | 可用。它是 subagent,`.claude/agents/*.md` 支持 `tools:`;当前只写了 name/description/model |
| **Coordinator** | **不可用。它是主 agent**,工具集来自 Claude Code 启动参数,不来自任何 agent 文件            |

且 `wiki_submit` 经 Bash 调用,而 Coordinator 必须持有 Bash(git、探索、`complete`),因此"禁写不禁其他"
在工具粒度上不可分;进程级 `permissions.deny` 会同时打到 Section Writer。**工具层画不出这条线。**

**决定性闸门在后端,而这也是架构上正确的位置。** openwiki 的写目标是文件系统,边界自然在工具层;
wegent 的写目标是 HTTP API 与 generation 状态机,边界天然在 API,且归属数据已在 Plan 中,只是每次
调用未校验。做法:`submit` 必须携带 `--owner <work-package-id>`,后端校验 `path` 属于该 owner 的归属
集合。Coordinator 的归属集合为空,因此**它的任何 `submit` 都被拒绝**,无需改动其工具或技能。

**威胁模型说明**:这是误行为边界,不是安全边界。Coordinator 与 Section Writer 共享容器与
`TASK_INFO.auth_token`,理论上可谎报 `--owner`。但模型走捷径的动因是规则阻断了任务完成
(证据 2 即如此);当报错明确指出该页归属并给出委派路径时,完成路径通畅,不存在伪造动因。
若将来确需抗伪造,应由后端在委派时签发 per-WP 一次性 submit token,而非共用 task token;
抗仓库内容 prompt injection 是另一条独立边界。

**记账**:每页记录提交者与页面长度,写入 `WikiGeneration.ext`。当前即使 Coordinator 越权写了计划内的
页面也不可见 —— 它不属于 `unexpectedPaths`,`writing_progress` 无感知。记账同时提供"Coordinator 实际
写了几页"和页长分布两个可观测量,用于验证本设计的核心假设。

## 确定性门禁

**仓库依赖图在容器内计算。** `wiki_submit repo-map` 输出节点(模块、文件数)、边、双向引用索引与
按引用次数排序的符号面;Maven 读 pom,pnpm/npm 读 workspace,Python 读顶层 import,兜底用目录与
import 扫描。它随 Plan 一起提交并持久化,后端据此校验 Plan,per-WP 切片复用它生成 Boundary Brief,
无需重算。

**Plan 机械校验(`plan-submit` 硬拒绝)。** 下表右列是 generation 40 那份 Plan 的判定结果:

| 判据                                                     | generation 40                                             |
| -------------------------------------------------------- | --------------------------------------------------------- |
| 高入度节点必须有 WP-00 前置页                            | 拒:`traffic-api` 被 10 模块依赖,埋在 `modules/traffic` 内 |
| 高出度节点必须有独立入口面页且先于其消费方               | 拒:`web-deploy` 是三个 workflow 页的共同浅端,仅 1 页概览  |
| 单页覆盖源文件数上限                                     | 拒:WP-01 为 517 文件对 1 页                               |
| workflow 页必须声明唯一深端与全部浅端                    | 拒:未声明                                                 |
| `Must explain` 引用路径必须落在 scope + Brief + 前置页内 | 拒:`workflows/metric-task` 的触发端在 web-deploy          |
| 归属与 planned paths 完全匹配                            | 通过(已有校验)                                            |

**per-page 引用门禁。** 每页提交时附带一组实质断言,每条引用 `path#Lx-Ly`;后端在被记录的 commit 上
校验其可解析性。普通页与 `focusPaths` 采用不同阈值 —— `focusPaths` 的语义由"评审深挖对象"改为
"更高引用阈值的页面"。这是唯一能自动发现证据 3 那类空洞页面的机制;当前 publish gate 只检查
页数下限、缩水比例、缺失 section 概览页与 Mermaid 可渲染性,对页面实质没有任何约束。

**引用棘轮。** 修订后页面的可解析引用数不得显著低于被替换版本 —— 把 12 条引用的页面改成 3 条应当
被拒。引用一旦持久化,这只是前后计数比较,同时防住 incremental 的逐轮侵蚀和 FULL 路径中"重写一页
把深度写没了"两种情况。

阈值(入度/出度门槛、单页源文件数上限、引用条数)留待 PR-2 的记账上线后,用 wegent 与 abtest 的
真实分布校准,不在本文预先固定。

现有 publish gate 保持不变,仍是发布前的最终保护。

## Reviewer 的处置

**先降级,后删除,顺序不可颠倒。** 上表六条判据搬到后端后,Reviewer 只剩两件真正语义的事:
每条 `Must explain` 是否确实源自源码且有价值;是否每个实质组件都有唯一归宿。这两件在大仓上值一轮
往返,在小仓上不值。

删除条件:机械校验、引用门禁、离线评测三者上线并在 wegent 与 abtest 上各验证一轮。届时删除
`code-wiki-reviewer` 的 Ghost / Bot / Team 成员、`reviewPolicy`、`qa` 与 `recheck` 两个 phase、
以及 `review` verdict 命令与其状态机;`plan_amendment` 保留但简化为"声明 + 机械校验",不再有评审往返。

**删除 Reviewer 不等于删除持久化 Plan 机制。** `review-open` / `review-status` 承载的那份持久 handoff
不是评审产物,而是委派载体 —— Section Writer 靠它恢复 scope。它必须保留,改名为
`plan-submit` / `plan-status`,并新增 `--work-package` 切片。

## 技能与契约文档结构

**不拆分 skill。** executor 把整个 Team 的 skills 收成并集、扁平部署到同一目录,任何角色都能进入任意
skill 目录执行任意命令,因此拆 skill 本就不是硬边界;而拆开会迫使共享核心代码重复。改为**按角色
拆契约文档**,同样消除动机与知识,且零重复:

| 文档                     | 读者           | 内容                                                                    |
| ------------------------ | -------------- | ----------------------------------------------------------------------- |
| `SKILL.md`               | 全部           | 路径规则、认证、按角色标注的命令索引                                    |
| `PLAN_CONTRACT.md`       | Coordinator    | Plan 内容合同、阶段化、深浅端、`depends_on_pages`、机械判据、委派与对账 |
| `WRITE_CONTRACT.md`      | Section Writer | WP 恢复、前置页阅读规则、引用要求、提交与校验                           |
| ~~`REVIEW_CONTRACT.md`~~ | —              | 删除,内容分流至上两份;QA / Recheck / verdict 整节移除                   |

收益是可量化的:死契约文本在 LLM 系统里不是零成本,它按调用次数计费。当前 `REVIEW_CONTRACT.md`
283 行中约 3.5KB(QA、Recheck、`plan_and_qa`、verdict 状态机)在 `plan_only` 下一次都不会执行,但每个
Coordinator 与每个 Section Writer 都被要求完整读取 —— abtest 那轮 5 个 WP,即付了 6 遍。拆分后
Section Writer 读约 210 行,而非 SKILL.md + REVIEW_CONTRACT.md 的约 534 行。

**`wiki_submit.js` 拆分。** 该文件已从 678 行增长到 1069 行(其中 `coordinate quality` 一次 +331),本次
新增 `repo-map`、`--owner`、`--work-package` 切片、`plan-*` 改名与引用载荷后约 1250 行,超过仓库的
1000 行上限。按现有函数边界拆:

```
wiki_submit/
  wiki_submit.js         CLI 入口:parseArgs / printHelp / main 分发
  lib/context.js         getTaskInfo / getAuthToken / getWikiEndpoint
  lib/http.js            makeRequest / endpoint 派生 / 终止错误处理
  lib/pages.js           submit / read / remove / complete / fail
  lib/plan.js            plan-submit / plan-status / amendment
  lib/repo_map.js        依赖图、双向引用索引、Boundary Brief(新增)
  mermaid_validation.js  不变
```

## 落地顺序与验证

| PR       | 内容                                                                                                                                                                                     | 验证                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **PR-0** | Ghost 增加 `tools` 字段;executor 为 coordinate subagent 输出 `tools:` frontmatter,移除 Section Writer 的 `Task`                                                                          | abtest 跑一轮,无嵌套 subagent                                     |
| **PR-1** | 角色收敛:结构化 Plan、Coordinator 零 authorship、四类委派、`depends_on_pages` 顺序不变量、`--owner` 归属校验、per-WP 切片、双模式删除、Ghost 与契约文档按角色拆分、`wiki_submit.js` 拆分 | ① Coordinator 提交 0 页 ② 两组页面长度分布收敛 ③ 切片不再触发截断 |
| **PR-2** | per-page 引用门禁、`focusPaths` 语义变更、`ext` 记账(提交者 / 页长 / 耗时 / token)                                                                                                       | 引用密度分布可见;空洞页被拒                                       |
| **PR-3** | `repo-map`、Boundary Brief、`plan-submit` 六条机械校验、负载上限                                                                                                                         | **回放 generation 40 的 Plan,应被拒五次**                         |
| **PR-4** | 收口:删除 Reviewer、`qa` / `recheck` / `reviewPolicy`;离线评测跑通 wegent / abtest / openwiki 三仓                                                                                       | 三仓基线建立                                                      |

PR-0 独立,可最先落地。PR-1 是最小自洽交付,也是验证"Coordinator 不写页"这一核心假设的那一步。
PR-2 可与 PR-3 并行。PR-4 必须在 PR-3 之后 —— 机械校验上线之前删除 Reviewer 会让 Plan 完全失去
把关,而 Plan 正是本次问题的发源处。

## English Summary

# Code Wiki Planner/Writer Role Consolidation

The 08-26 Coordinate design works on wegent (45 pages, ~10KB each) but regressed on abtest, a Maven
monorepo four times _smaller_ than wegent. The cause is dependency topology, not size: abtest has a
shared contract core (`traffic-api` consumed by 10 modules) and an aggregator (`web-deploy`, a third of
the repository, consuming six domains), so domain boundaries do not coincide with dependency
boundaries — the premise `scoped` mode assumes.

Three findings drive this design. First, a Work Package owning `modules/metric` plus
`workflows/metric-task` while scoped to metric/olap/schedule cannot satisfy its own contract, because
that workflow is triggered from `web-deploy`; the Section Writer spawned a nested subagent to derive a
consumer inventory that two greps produce mechanically. Second, the Coordinator's own pages are
systematically thin — including on small repositories with no delegation — because its mandate is
orchestration, its pages are never re-anchored to their `Must explain` contract, and its planner-economy
instruction ("budget spent reading is budget not spent writing") still applies while it writes. Third,
`review-status` returns the whole run (38.6KB measured) with no per-package slice, and already truncates.

The design consolidates three roles into two: the Coordinator becomes planner and orchestrator with
zero page authorship, and the Section Writer becomes the only writer. The `coordinator`/`scoped` modes
collapse into one model. Delegation takes four shapes through the same mechanism — foundation pages
first, the shared shallow end before its consumers, domain packages in topological order, and a final
assembly package whose source scope is the already-written pages. Cross-boundary facts are supplied
once: compile-time coupling mechanically through a repository dependency map, runtime contracts through
foundation pages written before delegation, and cross-cutting facts reported upward through required
sections in module pages.

Write authority is enforced in the backend by page ownership rather than by tools, because the
Coordinator is the main agent and `wiki_submit` is invoked through Bash — the tool layer cannot draw
this line. Depth is enforced by a per-page citation gate resolvable against the documented commit, and
plan quality by six mechanical criteria that would have rejected the abtest plan five times. The Reviewer
is demoted to two semantic checks and deleted only once those gates and an offline evaluation exist.
