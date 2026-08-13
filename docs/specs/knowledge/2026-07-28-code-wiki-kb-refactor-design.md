---
sidebar_position: 3
---

# Code Wiki 重构设计:折叠进 Knowledge Base

> Status: **一期已实现**。2026-08-07 归档时按落地结果校正,凡与实现不一致处标注
> 「**实现修订**」并说明原因;设计中的决策沿革(§8 已否决方案、§6.6 复盘)保持原样,
> 那是这份文档的价值所在。
> Revised 2026-08-04 — 权限模型由「仓库权限取代 ACL」改回「标准 KB ACL」(§6 整节重写)
> Date: 2026-07-28(初稿) / 2026-07-30(发布模型修订) / 2026-08-04(权限模型修订)
> Scope: backend (FastAPI/SQLAlchemy), frontend (Next.js), init_data
> 二期(代码索引)另见 [`2026-07-30-code-wiki-phase2-code-index-design.md`](./2026-07-30-code-wiki-phase2-code-index-design.md)
>
> **本文只写结论、不变量与约束。** 实现机制(投影算法步骤、闸门检查清单、配置默认值、
> 各 PR 文件级改动)属实施计划,见对应 plan 文档。历次被否决的方案集中在 §8,不散在正文。
>
> **待定项**:无。§6 的待定项已在 2026-08-04 关闭。

## 1. 背景与目标

现状的 Code Wiki 是一个独立孤岛:独立三表 + 平行权限(**每次请求**都调 GitHub/GitLab/Gitea API 过滤,重且脆)+ 纯文档无索引。效果不佳,维护成本高。

而 KB 已具备 wiki 需要的几乎全部能力:`Kind`(namespace/name/user_id)、`ResourceMember` ACL、`KnowledgeFolder` 多级树、文档存储与浏览、索引管线 + knowledge_runtime RAG,且 `spec.kbType` 机制已存在。

**目标**:把 Code Wiki 折叠为 `kb_type = "code_wiki"` 的 KB,复用其存储/权限/索引/浏览。

**非目标**:源码级 AST-chunk RAG(二期)、结构关系图谱、git 回写发布。

**链接跳转不属于二期依赖**:页→页用 `wikiLinkResolver`;页→源码文件用路径锚点 / git host URL。要链接**不需要**源码 RAG。

## 2. 架构:三层

| 层 | 载体 | 职责 |
| --- | --- | --- |
| **版本库** | `wiki_generations` + `wiki_contents`(复用旧表,主库) | agent 的写入缓冲 + 版本历史。**没有任何读者路径** |
| **投影** | 服务端确定性作业 | 把「已发布版本」投影成 KB 的 folder/document |
| **服务层** | KB(document/folder/ACL/RAG/前端) | **唯一**的读取、检索、权限、展示路径 |

**「孤岛」的定义是「平行的服务/读取路径」,不是「存在额外的表」。** 旧表在本设计中降级为后台写入缓冲,不再对外提供内容服务,因此不构成孤岛。

**核心取舍:原子性边界只包住一次确定性投影(秒级、幂等、可重试),而不是整个 LLM 生成过程(小时级、高失败率)。** 这是版本库存在的根本理由,其余机制都从它推导而来。

**删除**:`WikiService` 的 git-only 权限与每请求 git 过滤、旧的 wiki 内容服务 API、`wiki_submit` 技能。
**保留复用**:`wiki_generations` / `wiki_contents` 及 `save_generation_contents` 的增量 upsert。

## 3. 数据模型与迁移

### 3.1 职责映射

| 旧表 / 职责 | 新家 |
| --- | --- |
| `WikiProject` 源仓库 meta | KB `spec.source`(表退化为可选) |
| `WikiGeneration`(含 `generation_type` / `status` / `source_snapshot`) | **保留**为版本记录,新增 `kind_id` 归属到 KB |
| `WikiContent` | **保留**为版本内容,新增稳定 `path`(存 `ext`) |
| 每次运行的调度记录 | `BackgroundExecution`(与版本记录并存) |
| 读者看到的内容 | `KnowledgeDocument` + `KnowledgeFolder`(投影产物) |

> `WikiGeneration` 已有 `generation_type`(FULL/INCREMENTAL/CUSTOM)与 `status`(PENDING/RUNNING/COMPLETED/FAILED/CANCELLED),与本设计所需概念几乎重合 —— **不要在 KB spec 里重建一份**。

### 3.2 KB spec(发布指针)

```
spec:
  kbType: "code_wiki"           # notebook | classic | code_wiki(复用,不新增 kbKind)
  source: { sourceType, sourceUrl, sourceDomain, projectName }
  publishedGenerationId: <int>  # 当前生效版本;0 = 尚未发布
  subscriptionId: <int>
```

- **不变量:`publishedGenerationId` 是「哪一版生效」的唯一权威。** 只有投影成功才前移。
- 「wiki 建到哪个 commit」从 `wiki_generations[publishedGenerationId].source_snapshot` 读,不另存。
- **禁止**回退到「取最新 COMPLETED」的隐式规则(旧实现如此):生成完但闸门拒绝或投影失败的版本会被误判为已发布。

### 3.3 版本语义

**保留历史版本。** 依据:旧 `app/api/endpoints/wiki.py` 已暴露三个端点 —— `GET /generations`、`/generations/{id}`、`/generations/{id}/contents`(**按 id 读任意历史版本全文**)。历史是做出来并暴露了的能力,不是副产品。

> **实现修订(2026-08-07)**:那三个旧端点已随 legacy wiki 一并删除 —— 它们按
> `WIKI_DEFAULT_USER_ID` 选账号,那是配置值而非对调用者的判断,默认 0 时任何登录用户
> 可按自增 id 读到任何人的整页正文。**结论未变,承载方换了**:历史由
> `GET /knowledge-bases/{id}/code-wiki/generations` 提供,走普通 KB ACL。
> 代价:`kind_id=0` 的 legacy 版本数据仍在,但不再有浏览入口。

| 能力 | 旧版 | 新版 |
| --- | --- | --- |
| 历史版本可浏览 | 有 | **保留**(版本库 + 保留策略) |
| 发布原子性 | 有(隐式取最新 COMPLETED) | **保留**(投影事务 + 显式指针) |
| 失败后自动收敛 | 弱(靠人重触发) | **加强**(指针不前移 → 下次调度必然重跑) |

**回退 = 把旧版本重新投影一次**,无需额外机制。

**保留策略**:最近 N 个成功版本 + 时间上限;失败/被拒版本给短窗口供排查。

> **不变量:`publishedGenerationId` 指向的版本永不被回收**,即使很老。否则两个场景会吃掉回退基准:① 连续 N 次运行失败/被拒,已发布版被挤出「最近 N 个」;② 仓库长期无提交,时间上限清空全部。

### 3.4 可见 wiki vs 隐藏代码目标(二期)

- **可见 wiki 文档**活在 folder 树里:根 `index.md` + 顶层文件夹。
- **代码目标不进 folder 体系**:folder 的唯一用途是给人导航,而代码目标从不被浏览(它们是检索工件);镜像 repo 目录会凭空造出成千上万个全需隐藏的文件夹。

**分离靠结构而非约定**(设计过程中该过滤被漏掉过两次):

| 层 | 做法 |
| --- | --- |
| 1. 哨兵 `folder_id` | 代码目标 `folder_id = -1`(**不是** 0,0 是根,会被"列根级子项"取到) |
| 2. discriminator | `source_type = "code"` |
| 3. **唯一的强制查询作用域** | 所有 wiki 页读取/浏览/投影走**同一个 scope helper**;要取代码目标必须显式换 scope |

> 第 3 层是关键:它覆盖第 1 层管不到的查询形状(如「本 KB 所有 generated 文档」)。**该 helper 必须接入生产查询路径**(`list_documents` / `get_folder_tree` / 投影)—— 初稿曾把它写成零调用方的孤立模块,那等于没埋。

### 3.5 内容归属 `origin` + 位置隔离(双保险)

- **字段** `origin: generated | user`,**同时加在 folder 与 document 上**,默认 `user`(fail-safe)。
  - folder 是权威(顶层决定子树),document 上是写入时落下的冗余值——因为根级文档没有父文件夹,且让投影是一次简单过滤而非逐级回溯。
  - **两类内容是并列的顶层子树,不交错**:generated 文件夹会被 agent 重组甚至删除,放在里面的用户内容会无处安放。
- **用户内容集中在保留顶层文件夹内**,投影永不进入该子树。

> **两者都要,不是冗余。** 位置规则依赖「所有写入路径都被拦住」,而 `transfer_documents_to_kb` 这类方法**现在就存在**,能把用户文档挪进本 KB 且落在保留区外 —— 此时投影会按集合差删掉它。用户内容不可再生;`origin` 默认 `user` 使**任何非投影创建的行天生受保护**,与它被放在哪无关。

**固定 prompt 文件**:保留区内一个固定路径的指令文档(如 `WIKI_INSTRUCTIONS.md`),`origin='user'`,永不参与投影,由 agent 作为生成输入读取。其内容 hash 记入 `wiki_generations.ext`(可回答「哪版指令产出了哪版 wiki」);**其变更是升级到 `full` 的条件**。

### 3.6 迁移

**前置事实(已查证)**:`WikiBase = Base`、`get_wiki_db()` 用 `SessionLocal()`、无独立 engine/bind 残留 —— **wiki 表早已在主库**,故投影可跨两组表单一事务(仅限行,字节除外,见 §5.2)。

**一次迁移,三列,零新索引**(revision id 必须用 `alembic revision -m` 生成,不得手写 —— 初稿手写 id 与 main 的 `add_knowledge_artifacts` 撞号导致 CI 失败):

```
+ knowledge_documents.origin    String(20)  NOT NULL  server_default 'user'
+ knowledge_folders.origin      String(20)  NOT NULL  server_default 'user'
+ wiki_generations.kind_id      Integer     NOT NULL  server_default '0'
```

**DBA 规范**:不接受 `nullable=True`;新增列一律 NOT NULL + `server_default`,模型定义上也要写,否则已有行回填失败。

**存量老数据**:不做数据迁移。`kind_id = 0` 即老数据,代码层容忍。`wiki_projects` 本期不删,仅停止依赖其 `source_url` 唯一约束。

## 4. 生成:版本如何建立

### 4.1 触发与运行模式

生成与更新是同一条通道,区别只在触发来源。模式记录在 `wiki_generations.generation_type`。

| 模式 | 判定 | 版本如何建立 |
| --- | --- | --- |
| `skip` | HEAD == 已发布版本的 commit | 不建新版本(仍写 `BackgroundExecution` 留痕) |
| `incremental` | 有变更且未触发升级(**默认**) | **服务端用已发布版本播种**,agent 在种子上 upsert |
| `full` | 首次;或触发升级条件 | **从空开始** |

**升级到 `full` 的条件**:结构性变更(顶层模块增删、依赖清单变动)、变更量超阈值、防漂移周期(距上次 full 超过 N 次或 X 天)、`WIKI_INSTRUCTIONS.md` 变更。

> **关键性质:模式只影响「版本怎么建」,不影响「怎么发布」。** 两种模式结束时都是完整快照,投影拿到的永远是完整集合 —— **投影层不需要知道模式**。

### 4.2 种子机制

**「增量」指 LLM 少干活,不是版本里少存页。每个版本都必须是自包含的完整快照** —— 这是「回退到任意保留版本 = 一次纯投影」成立的前提,也让投影无需沿版本链回溯。

- `incremental` 创建 generation 时,服务端一条 `INSERT ... SELECT` 把已发布版本的全部内容复制为种子,发生在 agent 启动**之前**;run 失败则该种子随 FAILED 版本被保留策略回收。
- 首次运行无已发布版本 → 无种子,等同 `full`。

> **不变量:保证快照完整的责任在服务端,不在 agent。**
>
> **但 agent 是被充分告知的 —— 被告知 ≠ 负责。** 增量运行喂给 agent 的输入包含仓库 diff、commit 说明、种子中的现有页清单。这正是增量省钱的原因,不应剥夺。

**写入始终要求完整页正文,不做 patch/增量合并** —— 天然幂等、无 merge 逻辑、重跑结果一致。现有 `save_generation_contents` 已是此形态。

### 4.3 页面身份 = 稳定 `path`

旧的 `save_generation_contents` 按 `(type, title)` 匹配、退化到 `title`。投影到 KB 后这是缺陷:**标题一改就等于删旧建新 → `document_id` 变 → 重新 embedding + 历史引用失效**(`delete_document` 中 `doc_ref = str(doc.id)`,检索层亦按 `RetrievalScope(document_ids=[...])` 过滤 —— document id 就是 RAG 的身份)。

- agent 为每页提供稳定 `path`,`title` 降为展示字段;一期存于 `wiki_contents.ext`(零迁移)。
- path 须归一化校验:禁 `..`、禁绝对路径、长度上限、版本内唯一。

### 4.4 在飞版本与生效版本的区分

种子建好那一刻新版本与已发布版逐字节相同,故必须能区分。**不加标记位:**

| 问题 | 由谁回答 |
| --- | --- |
| 哪一版生效 | `spec.publishedGenerationId`(唯一权威) |
| 这轮运行到哪一步 | `wiki_generations.status` |

**不加 `is_published` 布尔位** —— 它是发布指针的反规范化副本,两处会漂移,而漂移的后果是「发布了错误的版本」。

**但存在表达力缺口:`COMPLETED ≠ 已发布`。** agent 跑完即 COMPLETED,而闸门与投影尚未发生,故 COMPLETED 混了四种处境(等待闸门 / 被拒 / 已发布 / 曾发布已被取代)。**做法**:闸门结论写入 `wiki_generations.ext.publishGate`(现成 JSON,零迁移),只解释「为什么没生效」,**不参与判定**。

> **自我保护性质**:agent 早期崩溃、几乎没写页 → 该版本是已发布版的逐字节副本 → plan 全是 skip,无害空操作。种子不会把「什么都没干」放大成破坏。

**在飞版本必须有超时回收**:并发控制锁 `wiki_generations` 行并检查状态,若某轮 worker 死亡、状态永停在 RUNNING,**新运行将被永久挡住**(早期 review 已指出过该缺陷)。超时阈值内未推进即视为废弃,置 FAILED 并允许被取代。判定用行上已有的 `created_at` / `updated_at`,无需新列。

### 4.5 agent 驱动的删除

**允许 agent 对在飞版本显式声明删除某 path**(仅作用于版本库,够不到 KB)。

必要性:一期没有 provenance,**服务端只看得见文件路径变了,推不出该删哪一页**;只有 agent 掌握「哪一页覆盖哪个模块」的语义映射。

安全性由架构而非禁令保证:

| | 原地更新(已否决) | 版本库(现方案) |
| --- | --- | --- |
| agent 声明删除 | **立刻销毁线上文档** | 只是新版本里没有这一页 |
| 可恢复性 | 不可逆 | 上一版仍在,回退即恢复 |
| 能否拦截 | 无处可拦 | **发布闸门**查页数跌幅 |

> 周期性 `full` 因此不再是纠错的唯一手段,但仍有价值:它对付 agent 自己重新规划页面结构造成的遗留,那类在增量里 agent 同样看不见。频率可放宽。

### 4.6 调度策略与最小间隔

> **状态:本期不实现。一期只有手动触发。**
>
> `POST /knowledge-bases/{id}/code-wiki/generations` 已可直接触发一次运行,且会自行读取仓库 HEAD——无变更时不建 Task 直接返回。订阅接入只多一件事:**谁来定期按这个按钮**,§4.1–§4.5 的核心逻辑一行不改。
>
> 本节决议是下一期的输入,不是已生效的约束。曾按本节实现过独立的 `code_wiki_schedule` 模块,因**零调用者**被删除——一份看起来像防线、实际不在任何路径上的校验比没有更危险,谁做运维评审都会误以为 1 周下限已生效。届时随调用点一并加回。

**现状(已查证)**:`SubscriptionTriggerType` 已原生支持 `ONE_TIME`(配 `execute_at`),**一次性任务无需新建机制**;已有 `SUBSCRIPTION_MIN_INTERVAL_MINUTES`(默认 15)。

**三个缺口必须补**:① **`CRON` 完全不校验频率**(`expression` 是裸 `str`,`* * * * *` 可被接受);② `INTERVAL` 下限只对 `unit == "minutes"` 生效;③ 通用 15 分钟对全仓库 LLM 生成远远过松。

**决议**:

- **默认 `ONE_TIME`**;周期性为显式开启项。
- **code_wiki 专属最小间隔,默认 1 周**,独立配置项(不复用通用值),对 `CRON` 与 `INTERVAL` **一并生效**。
- cron 校验须取**相邻触发的最小间隔**而非平均值 —— `0 0 * * 1,2` 平均看似很长,却存在相邻仅 1 天的触发对。校验在创建/更新订阅时拒绝,不留到运行期。
- **`EVENT`(git push)对 code_wiki 默认禁用**:活跃仓库会导致近乎持续的重生成。

> **1 周是安全下限,不是推荐值。** 因 §4.1 规定无变更直接跳过,空闲仓库的周期运行几乎零成本;真正开销只在仓库确有变更时 —— 而那正是需要更新的时候。**周期性建议开启**,且取值须与防漂移周期协调,避免「周期触发比强制全量还稀疏」。

**接入方式:复用 `Subscription`,不自建调度**(已查证,下期直接用)

自建一套「KB spec 存 schedule + beat 扫到期」第一版确实更小,然后它会依次长出分布式锁、下次执行时间推进、僵死执行恢复、执行历史——正是 `check_due_subscriptions` 已经调好的东西(含锁续期、批量迭代、PENDING/RUNNING 回收、过期停用),再加通知 webhook 与现成前端。

四个接入点已查证:

| 关注点 | 结论 |
| --- | --- |
| prompt 是算出来的,不是套模板 | **有现成缝**:`resolve_prompt_template` 支持 `extra_variables`(webhook 数据已在用)。模板写 `{{code_wiki_instructions}}`,`create_execution` 时注入 |
| 模式决策必须早于 prompt | **唯一需要新缝**:`_dispatch_due_subscription` 是「到期」与 `create_execution` 之间的接缝。分支收进一个 knowledge 侧函数,调度器只多一个 `if` |
| SKIP 没有对应状态 | **有现成的**:`COMPLETED_SILENT`(静默完成,默认不进时间线),语义正好 |
| git 仓库来自 `workspaceRef` | **绕过**。仓库绑定的唯一权威是 KB `spec.source`;建 Workspace 会让同一个仓库有两处存储 |

标识用 spec 上的 `codeWikiRef` 字段(它存在即代表这是 code wiki 订阅)。**不用 `taskType` 枚举**——已查证该字段在订阅服务里没有任何行为分支,全是透传展示,加值不产生分支。

配套:`start_run` 拆成「决定」(选模式 + 建版本 + 播种 + 出 prompt)与「派发」两半——直接触发走 `create_task_or_append`,订阅走 `create_chat_task`。这个拆分本身就该做。

### 4.7 Task 策略与回写接口

- 每次生成/更新新建 task(`preserve_history=False`),无状态、不累积上下文。
- **agent 只写 `wiki_contents`,没有任何写入 KB 的能力。** 由此「agent 不能自行让页面可见」**结构性成立**,不再依赖工具层门禁(通用工具一旦被绕过即失效)。这同时消掉了初稿的一个隐患:为 agent 开放 folder-create / delete-document。
- 完成判定:`summary.status` + Task 终态 → 闸门校验 → 投影 → 前移指针。中途崩溃则指针不动,版本留在库里。

## 5. 发布:投影

### 5.1 投影规则

确定性作业,按 `path` 做集合运算,作用域限定 `origin='generated'`。**先产出显式 plan 对象(adds/updates/deletes/skips)再执行** —— plan 可日志、可单测、可 dry-run;「本次要删 37 页」这类事实应当能被看见并拦下。

| 情况 | 投影动作 | RAG | `document_id` |
| --- | --- | --- | --- |
| **纯新增** | 建 document + attachment + 父目录,`is_active=False` | 入队索引,成功后自动转 active | 新分配 |
| **修改**(hash 不同) | 新建附件 + 事务内改指针 | 重索引,`doc_ref` 不变 | **不变** |
| **不变**(hash 相同) | **完全跳过** | **完全不动** | **不变** |
| **删除** | 删除,**必须连带清 RAG** | 按 doc_ref 删 chunk | 销毁 |

生成的目录空掉后一并清理(按 `origin` 区分,不碰用户目录)。

> **全量重建时「不变」这一档基本失效**:LLM 重新生成同一页,语义相同但字面几乎必然不同 → hash 变 → 判成「修改」→ 全量重新 embedding。**hash 跳过的收益几乎全在增量上**(种子逐字节复制,hash 必然相等)。这正是 `full` 应当周期性、少见的原因 —— 其成本接近整库重灌。

### 5.2 事务边界与清理顺序(不可违反)

**生产环境附件在对象存储**(`ATTACHMENT_STORAGE_BACKEND` 支持 `mysql`/`s3`/`minio`,LONGBLOB 只是开发默认),因此**字节不在事务里**:

```
提交前 :  为 新增/修改 的页写新附件(行 + 对象)
事务内 :  改指针、插新行、删旧行、删空目录        ← 原子(仅主库行)
提交后 :  删被取代的旧附件、删已移除文档的 chunk、入队重索引   ← 可重试
```

- **写 blob 必须在提交之前**;失败仅留孤儿对象,线上未动。
- **删 blob 必须在提交之后**;放进事务内则回滚会**销毁线上内容**。
- **因此「修改」不能原地覆写附件** —— 覆写会在提交前销毁旧内容,事务一旦失败即不可恢复。

**投影不能直接调 `delete_document`**:它内部 `db.commit()`(逐个调用即逐个提交,原子性没了),且其清理在 commit 之后、外层 `try/except` 只记日志。

但**级联清理必须照做**(该函数会删:document 行 → RAG 索引 → attachment → converted attachment)。**只删行不清 chunk 会留下幽灵内容**:页面没了,RAG 仍拿它作答并生成指向死 id 的引用 —— 比留着旧页糟得多。

> **待删 `doc_ref` 必须落库记账 + 可重试兜底。** RAG 是外部系统、进不了事务,这是本设计**唯一**无法用事务解决、必须靠重试收敛的环节(旧版没有此问题,因为旧 wiki 根本不进 RAG)。

### 5.3 发布闸门

版本是完整快照这一性质**由构造保证,但不由 agent 的诚实保证** —— 若 agent 只写了 4 页就标 COMPLETED,投影会照常删掉另外 2 页。

**发布前对完整快照校验**:页数跌幅、Mermaid 结构性检查、章节完整性。

> **实现修订(2026-08-07)**:闸门**降级为咨询性**。唯一仍然拒绝的是「版本一页都没有」
> ——那是一次什么都没产出的运行,不是一个空仓库。跌幅阈值改为**只告警**。
>
> 原设计把跌幅当作「agent 驱动删除的主要安全网」,抽象上成立;实践中它连续拦下三次运行
> 而 wiki 一次都没更新,每次被拒的形状都是 agent 在重组结构而不是失败。**衡量方式也分了两种**
> ——全量重建从空版本开始、路径本身不携带意图,按**规模**判;增量版本以已发布版为种子,
> 缺失的路径是被显式指令删掉的,按**路径集合**判。按路径去判全量,等于任何重命名过的重建
> 都永远发布不了。
>
> 代价说清:一次真正被截断的运行现在会发布,它没写的页面连同 document id 一起被删。
> 版本库保留上一版,**内容可恢复,id 不可恢复**。

> 相较初稿的「对账期启发式守卫」,优势在于**校验对象是完整、可检视、可留存的快照**,而非已改了一半的线上状态;被拒版本留在库里可供排查。

**「全成功才算成功」的定义修订**:早前裁决包含「索引也必须成功」。新架构下**发布 = 投影事务成功**;索引是提交后的最终一致,由现有 per-document 状态机重试并在 UI 可见。索引失败**不**阻止发布、**不**回滚版本。

**投影事务体量红线**:需压测。若规模迫使分批提交则原子性不成立,**须回头重新讨论,不得默默降级**。

### 5.4 Mermaid(不阻断发布)

前端已客户端渲染 mermaid,坏图是局部渲染问题。两层处理,均不阻断:

- **前端优雅降级(必做)**:渲染失败时展示错误提示 + 原始源码(可复制),而非空白/破损框。现组件无错误处理,需补。
- **写入时结构性校验 → warning 回喂 agent**(围栏配对、图类型关键字、括号配对等常见 LLM 失误),agent 自行修正。复刻 openwiki「校验驱动修正」而非「校验即拒绝」,且**不需要 JS 解析器**。契约可升级为完整解析,接口不变。

### 5.5 页面的名字、位置与顺序(已定)

投影原本丢弃 agent 的 title(文档名取路径末段),前端建树需要的三样有两样不存在。

| | 存哪 | 为什么 |
| --- | --- | --- |
| **名字** | `document.name` = title | 路径末段无法区分 `architecture/backend` 与 `services/backend`;path 仍是身份,改标题是原地重命名,RAG 索引依赖的 id 不变 |
| **顺序** | `spec.pageOrder`(路径数组) | 来源是 agent 的 `structure_order`(协议里一直有,收下就丢)。**不能存在文档上** —— 只调顺序时指纹不变,页会被跳过,新位置永远写不进去 |
| **层级** | 从 `wiki_page_path` 前缀推 | 每个节点都是一篇文档(Devin 模型),没有纯文件夹 |

**title 进入指纹**:它现在是文档名,不覆盖的话改标题会被静默忽略。代价是只改标题也重写附件——标题基本总是跟着正文变。

**章节缺自己的页面只警告,不拒绝发布**:导航从 path 建树,无页面的章节渲染成不可点击的分组标题——比较难读,但远不值得丢弃一个其余完好的版本。这与 mermaid 渲染失败是同一个取舍。prompt 里要求写章节页,让警告保持罕见。

### 5.6 索引欠账在下一次发布时结清(已定,推翻中途方案)

删页时行的删除在事务内、chunk 的删除在事务外。后者失败时**发布照常成功**并把欠账记在 KB spec 上。

结清放在 `publish_generation` 开头,**不设周期任务**。曾加过一个 celery 清扫,但那让 `pendingIndexCleanup` 有了两个写者,各自做读-改-写:清扫读了列表、并发的发布追加一条、清扫写回它读到的那份 —— 丢掉的那条永久留成孤儿 chunk。**清扫之间加分布式锁挡不住它**,因为发布不持有那把锁。写者减到一个,这个竞争类别整个消失。

代价说清:**再也不重新生成的 wiki 会一直留着孤儿 chunk**。欠账记在 spec 上、停放时打 WARNING 日志,是可见的。

## 6. 权限与唯一性

> **2026-08-04 整节重写。** 前一版把授权依据从 KB ACL 换成仓库权限,归属放在 wiki 账号
> (`WIKI_DEFAULT_USER_ID`)。实现后连续暴露四个同源缺陷,原因见 §6.6。本节改回标准 KB ACL。

### 6.1 归属:创建者的知识库(已定,推翻 2026-07-30 版)

code wiki 是一个**普通知识库**,`Kind.user_id` = 创建者,`namespace` 由创建者选(个人 / 群组 / 组织),
和其它 KB 完全一致。没有特殊账号,`WIKI_DEFAULT_USER_ID` 整条链路移除。

由此,**ACL、分享、chat 引用、MCP 全部天然可用,既有链路一行不改**。

### 6.2 授权:标准 KB ACL,不引入第二套判定(已定)

**不变量:code wiki 的可见性与可写性,完全由 KB 自身的 ACL 决定 —— 与其它知识库无任何差异。**

仓库权限只在**一个时刻**参与:

```
创建时:调用者必须能读该仓库  → 否则 403
创建后:不再跟踪仓库权限
```

一次性校验,而非持续对齐。持续对齐正是 2026-07-30 版难以收口的根源。

**已知后果(接受):**

1. **可见性与仓库脱钩。** 创建者可以把私有仓库的 wiki 分享给没有仓库权限的人。
   这是**创建者的责任**,与今天把代码粘进共享 KB 同性质 —— 已有 ACL 就是为这个场景设计的。
2. **创建者事后失去仓库权限,wiki 仍然存在。** 不做撤销。同上,由分享者负责。

> 本条是安全策略判断,不是技术取舍。若日后策略收紧,应新增「跟随仓库权限」的可选开关,
> 而**不是**再次把仓库权限做成唯一授权 —— 那条路已经验证过成本。

### 6.3 公开仓库(已定)

创建时的「能读该仓库」判定必须认识公开仓库,否则会出现 **wiki 比它的源更封闭**:任何人在浏览器里能读的仓库,反而建不了 wiki。

实测(2026-08-04,`api.github.com`):

```
公开仓库 + 无 token   → 200,响应含 "visibility": "public"
私有/不存在 + 无 token → 404(GitHub 故意不用 403,避免泄露仓库是否存在)
匿名限流              → 60 次/小时/IP(带 token 5000)
```

判定顺序:

```
有该 host 的 token → 走 provider 的成员/权限判定(现状)
无 token          → 匿名探测 GET /repos/{repo}:200 = 可读,其余 = 不可读
```

三条约束:

- **匿名 404 有歧义**,只能理解为「匿名不可读」,不得推断仓库是否存在
- **60/h/IP 必须缓存**,打满后返回 403 会被误判成「无权限」(fail-closed,不泄露,但会造成无法解释的拒绝)
- 现状里 `assert_user_can_read_source` 的第一道闸是「没 token 直接拒」,**必须放开**才走得到判定

GitLab 的 `check_user_project_access` 是纯成员制(非成员 404),GitHub 已有一条 403 兜底会退到
`GET /repos/{repo}` —— 两者行为不一致,需在这一层抹平。

**判定放开还不够:公开仓库在 UI 上根本选不中。** 仓库选择器的两个数据源都带 `membership=true`
(`gitlab_provider:261`,搜索同理),**非成员的公开仓库永远不出现在列表里**,与有没有 token 无关。
连带两处也走不通:

- **分支列表**:`get_branches` → `_pick_git_info` → `_get_git_infos`,无 token 直接 400
- **`source_type` 无法从 URL 可靠推断**:`from_url(source_type, source_url)` 的 type 由调用方传入。
  选择器模式下来自 `GitRepoInfo.type`;手输 URL 时自建 GitLab 的域名猜不出来

因此 §6.3 必须连同录入方式一起设计,见 §6.8。

#### 6.3.1 仓库解析端点(已定)

```
POST /knowledge-bases/code-wikis/resolve
  { source_type, source_url }
→ { exists, visibility, default_branch, name, description,
    access: "public" | "member" | "none" }
```

一次调用同时服务三件事,避免三条各自为政的探测路径:

1. §6.3 的可读性判定(有 token 走 provider,无 token 走匿名)
2. **默认分支** —— 由此**不需要**打通匿名的分支列表接口
3. §6.8 名称/描述自动填充的**展示数据**(实际填充仍在创建时由后端完成,理由见 §6.8)

**分支能力降级(已定)**:URL 录入模式**只提供默认分支**,不做完整分支列表。匿名列分支要额外打通
一条路径,而「建 wiki 时选非默认分支」是低频需求 —— 需要时由有 token 的人创建,或事后在 KB 设置里改。

**`source_type` 推断顺序**:URL 域名匹配用户已配置的 git 域名 → 用该条目的 type;
`github.com` / `gitlab.com` 硬编码;都不匹配则要求用户显式选择,**不猜**。

#### 6.3.2 外部仓库范围(暂不限制)

手输 URL 意味着任何人可为任何公开仓库建 wiki,包括与公司业务无关的。**本期不限制** ——
生成占用执行 team 与模型额度,滥用不是零成本;真出现问题再加。

若日后要限,两个口子:限定在已配置 git 域名内(会同时挡掉合理的开源仓库调研),
或加 `WIKI_ALLOW_EXTERNAL_REPOS` 开关。**优先后者**,前者把两类需求一起挡了。

### 6.4 一个仓库多份 wiki(已定,推翻 2026-07-30 版)

归属改为创建者后,「一个仓库一份 wiki」不再成立:A 建的私有 wiki 对 B 不可见,
禁止 B 再建等于先到先得地剥夺后来者。**允许 N 份。**

数据模型:`wiki_projects` 的语义从「仓库注册表」改为「(仓库, wiki) 关联行」。

```sql
-- 原
source_url UNIQUE
-- 改
UNIQUE (source_url, kind_id)
```

- 一个仓库 N 行,每行一个 wiki;`kind_id` **保留**且含义明确
- legacy 行(`kind_id = 0`)共存,一个仓库最多一行
- `wiki_generations.kind_id` 无需改动 —— 它**本来就**把版本线挂在 KB 上而非 project 上
- **「已有 N 人建过」**直接由 `SELECT COUNT(*) FROM wiki_projects WHERE source_url = ? AND kind_id > 0` 得到,
  不查 JSON,不加 join 表

**重复创建的防抖**:复合唯一挡不住「同一人连点两次」。**不加 DB 约束** —— 因为「同一人给同一仓库
建个人版和群组版」是合理需求,焊死反而错。创建时查一次 + 前端禁用重复提交即可。

### 6.5 触发生成(已定)

- **权限**:仓库写权限。`check_user_project_access` 已返回 `access_level`,加阈值即可。
  语义上「改 wiki ≈ 改仓库的衍生物」
- **创建后自动触发一次**。创建完是空的、要用户自己找按钮,是说不通的流程
- **在途不可重复触发**:`start_generation` 已有单 KB 互斥(`GenerationInFlight` → 409),**现状即成立**
- 更复杂的并发度与频率控制,留到订阅任务那一期
- **执行身份 = KB owner(创建者),用其 git 凭证 clone**。token 过期则该 wiki 生成失败,
  责任清晰;优于共享账号失效导致全体挂掉

### 6.6 为什么推翻:一条规则只在新代码里生效(复盘)

2026-07-30 版把授权依据换成仓库权限,但**只在 code_wiki 包内部新写的端点上换**。
凡是复用既有链路的地方,判定都退回 ACL —— 而 KB 归 wiki 账号,ACL 对任何人都不放行。
四个缺陷同源:

| 位置 | 判定 | 后果 |
| --- | --- | --- |
| `POST /{id}/code-wiki/generations` | `can_manage_knowledge_base`(ACL) | 触发必然 403 |
| `GET /documents/{id}/detail` | `_get_document_with_access_or_raise`(ACL) | 正文必然 403 |
| chat 引用 / MCP(5 处) | `get_acl_accessible_knowledge_base_ids` 等 | 静默退化成「无知识库」 |
| 公开仓库 | 成员制,不查 `visibility` | wiki 比源更封闭 |

**根因不是遗漏了某一处,是缺一个结构**:规则从未写成一句可检查的不变量,也没有判定点清单。
每次只在眼前的文件里想问题,遗漏是必然的。§6.2 的不变量与本表即是补上的那个结构;
新增 KB 判定点时必须回到此表登记。

### 6.7 列表与管理端(已定)

**列表深度融合。** code wiki 与文档知识库同列表、同 ACL、同端点,按 `kbType` 区分卡片内容
(仓库、分支、已发布 commit、重新生成)。移除文档/代码两个 tab。

`content_scope.exclude_code_wikis`(14 处调用)的理由从「权限」变成「分类」,**绝大部分删除** ——
code wiki 要能被 chat 引用,就不该在查询层被排除。

**功能开关**:`WIKI_CODE_WIKI_ENABLED`,env 变量,**只控写不控读** —— 关闭后创建弹层不出现「代码」
类型,已有 wiki 照常可读。灰度回滚不应让数据消失,也不应让「别人分享给我的 KB 打不开」。

**不做 admin 管理页。** 前一版需要它,是因为 KB 归 wiki 账号导致「没人看得见、配置改不了」的死角;
归属改回创建者后死角不存在 —— 创建者在常规 KB 设置页里就能看能改。

管理端能力(版本浏览/回退、强制重生成、删除目标)沿用平台既有 admin 判定;
**仍不允许手工编辑生成页正文** —— 生成页由 agent 拥有,手改会在下次发布时被静默覆盖。

### 6.8 创建弹层(已定)

一级先选**文档 / 代码**,再进各自表单。复用 `CreateKnowledgeBaseDialog`,按类型切换字段
(它已有 `kbType` 参数与 `handleKbTypeChange`)。

| 字段 | 文档 | 代码 |
| --- | :-: | :-: |
| 默认打开方式(笔记本/经典) | ✅ | ❌ |
| 仓库地址 | ❌ | ✅ 必填 |
| 分支 | ❌ | ✅ 默认分支 |
| 生成语言 | ❌ | ✅ |
| 归属(个人/群组/组织) | ✅ | ✅ |
| 名称 | 必填 | **选填**,空则用仓库名 |
| 描述 | 选填 | **选填**,空则用仓库描述 |
| 文档摘要 + 摘要模型 | ✅ | ✅ |

- **名称/描述留空时由客户端带上已解析的值提交**,输入框本身不预填 —— 预填会让用户以为是自己填的。
  服务端**不再二次解析**:创建路径上 `assert_user_can_read_source` 已经问过 provider 一次,
  再解析一次只在「表单刚好预热过缓存」时才不慢,那是隐式耦合。服务端只保留一层兜底 ——
  名称仍为空时用 URL 解析出的 `project_name`,否则会建出一个列表渲染不出来的无名知识库
- 选完仓库后提示**「已有 N 人为此仓库建过 wiki」**,不阻止创建,只给出「去要一份分享」的机会
- 提交前调 `get_wiki_config?code_wiki=true`,**执行 team 未绑定模型时禁用提交并说明原因**
- 提交后**直接进入阅读器**,空状态显示生成进度,而非「点击生成」按钮

**仓库录入有两种方式**(§6.3 的公开仓库在选择器里选不中):

```
仓库  ( • ) 从我的仓库选择   (   ) 输入仓库地址
      ┌────────────────────────────────────┐
      │ [RepositorySelector 原样嵌入]       │
      └────────────────────────────────────┘
      ── 切到「输入仓库地址」 ──
      类型  [GitLab ▾]      ← 按 §6.3.1 的顺序推断,推断不出才要求选
      地址  [https://github.com/foo/bar   ]
            ✓ 公开仓库 · 默认分支 main     ← resolve 返回
```

**不修改共享的 `RepositorySelector`**,在 code wiki 弹层里包一层。该组件被任务创建等处使用,
改动会外溢到与本设计无关的路径。
- **KB 配置(检索器 / embedding / 摘要)不做系统级配置项**。归属回到创建者后,
  `get_default_retriever(db, user.id, ...)` 里的 `user` 就是创建者本人,自动解析结果本就在他视野里

### 6.9 配置面(已定)

| 配置 | 位置 | 说明 |
| --- | --- | --- |
| `RUNTIME_ENABLE_CODE_WIKI` | 前端 env | **灰度在这里控**,默认关;决定要不要显示「新建 code wiki」 |
| `WIKI_CODE_WIKI_ENABLED` | 后端 env | 默认**开**;显式关掉时端点直接拒绝,不管客户端怎么说。只控写 |
| `WIKI_CODE_WIKI_TEAM_NAME` | 后端 env | 执行 agent,基础设施而非用户选项 |
| `WIKI_DEFAULT_LANGUAGE` | 后端 env | **降级为创建弹层的默认选中项**,不再是运行时真相 |
| `REPOSITORY_READ_TIMEOUT_SECONDS` | 后端 env | 仓库读取超时;`requests` 无默认超时,不设则挂到 socket 放弃为止 |
| `spec.language` | KB | 生成语言的真相来源;旧 wiki 无此字段时回落全局值 |

> **实现修订(2026-08-07)**:一个功能两侧各一个开关,**后端默认开、前端默认关**。
> 从没配过的部署不该得到一个默默拒绝的功能,所以后端那个只用来表达「这个部署根本不要它」;
> 灰度节奏由前端决定,而前端那个是运行时变量——构建期的开关改了还得重新部署,和灰度想要的相反。
> 两者可能不一致(只开前端会让用户填完表单拿 403),这是为了不多一次往返、并与仓库里其它
> 开关保持同一写法而接受的取舍。

**执行模型维持 team 绑定,不做 KB 级选择。** `modelRef` 挂在 `BotSpec` 上,
`create_task_or_append` 只接受 `team_id`、无 model override 参数 —— 要让用户在 KB 上选执行模型,
需新增「按任务覆盖 bot 模型」的通用能力,影响所有 shell 类型。
若确需该能力,应作为**独立于 code wiki** 的任务级特性单独设计,不在本次开口子。

## 7. 其余约束

**模型**:默认用配置好的 wiki 模型(public-safe),允许覆盖,**任何情况回落 public**,保证 upstream 与内网都能跑。不硬依赖 protected 模型。KB embedding 模型同样需能回落 public。

**前端**:视图由 `kb_type` 驱动(`notebook` → 编辑壳,`code_wiki` → 阅读壳),但建在共享 KB 原语上(文件夹树组件、`DocumentContentViewer`、权限、路由)。现有 `WikiSidebarList` / `WikiContent` / `WikiDetailSidebar` / `useWikiDetail` 重构为「folder-tree 的 wiki 阅读模式」,而非独立栈。保留既有 `data-testid`,变更同步更新 E2E。

**执行者身份**:手动触发在 **KB owner(创建者)** 身份下执行(§6.5);订阅更新在 `subscription.user_id` 身份下执行。风险是 token 过期/权限回收/离职导致静默失败 → 失败时置 FAILED 并给出可见告警(指针不动),并允许绑定**服务账号**用于长期自动化。

**openwiki 借鉴**:无变更跳过(§4.1);Mermaid 校验驱动修正而非拒绝(§5.4);保留 `index.md` + `log.md`(后者是 agent 维护的变更说明文本,与版本库是两回事);typed 文档 + frontmatter;标准 markdown 链接做交叉引用;内容原则「每条事实是否会改变 agent 在此的做法」写进 prompt,治泛而空。不纳入 OKF 格式、deepagents 框架、connector 生态。

## 8. 已否决方案(集中记录,避免重复论证)

| 方案 | 否决原因 |
| --- | --- |
| **原地页级发布**(初稿主方案) | 原子性边界套住整个 LLM 生成过程(小时级、高失败率)。为守住它需要附件暂存位、影子行、双向 GC、覆盖盖戳、对账启发式守卫;复盘中连续三轮各暴露一个新缺陷(盖戳语义与跳过优化冲突、删行遗留幽灵 chunk、新页无处挂载暂存) |
| **丢弃历史版本(latest-only)** | 判定依据是本设计自身的注释而非查证。实际有三个已暴露端点在读历史(§3.3) |
| **独立 staging 表做缓冲** | 内容在 documents 表外则**无法走索引管线**,导致「导入后才能索引」,提交闸门无法包含索引成功 —— 恰好破坏所选的 all-or-nothing 语义 |
| **影子行(每页新建行,提交时删旧行)** | churn `document_id`,而它是 RAG 身份(`doc_ref`)与检索过滤键 → 历史引用失效 + 全量重新 embedding |
| **`is_published` 布尔标记位** | 发布指针的反规范化副本,可漂移,漂移后果是发布错版本 |
| **`last_generation_run_id` 覆盖戳记** | 投影拿到完整快照,孤儿 = 纯集合差,不需要戳记与启发式守卫 |
| **`source_ref`(nullable JSON)预留** | 一期零使用、违反 DBA 规范;二期要的是强类型列,**追加叶子列是最安全的迁移**,晚加不痛 |
| **新增 `kbKind` 字段** | `kbType` 三值互斥(notebook/classic/code_wiki),复用即可 |
| **索引 `(kind_id, origin)`** | 对账查询已不存在;`origin` 仅 2 值、基数极低,`kind_id` 既有索引足够。二期真正的区分列是 `source_type` |
| **增量运行禁止删除** | 该结论继承自原地更新方案(彼时删除不可逆);版本库下删除可恢复、可拦截,应「配闸门」而非「收回能力」(§4.5) |
| **去重粒度 = (namespace, 仓库)** | 其动机(跨组织泄漏)假设两家公司共用一套部署,内网单部署不成立 |
| **读权限用组织级映射** | 与「仓库全局唯一」不相容 —— 该前提已在 2026-08-04 取消(§6.4),但结论仍成立:私有仓库 wiki 不能全部署可读 |
| **同步仓库成员到 `ResourceMember`** | 方向是 git → wegent,要把成员反查成 wegent 账号:多对多、凭证在 JSON 列、**没配过 token 的人映射不出来**——同步完他仍然看不到,与不同步无异 |
| **归属挂 wiki 账号(`WIKI_DEFAULT_USER_ID`)**(2026-07-30 版 §6.1) | KB ACL 对其他任何人都不放行,迫使仓库权限成为**唯一**授权;而该判定只在新写的端点上生效,复用既有链路的地方全部退回 ACL → 四个同源缺陷(§6.6)。已改回创建者归属 |
| **仓库权限**取代**KB ACL**(2026-07-30 版 §6.2) | 每条既有链路都要改(chat / MCP / 正文 / 触发,已知 4 处),且后续每个新 KB 场景都要重新适配一次。删除约 400 行(`read_access.py` 164 + `content_scope.py` 109 + registry 部分)与 14 处调用点后,四个缺陷不复存在 |
| **ACL 授予 + 仓库权限扣除**(2026-08-04 中途方案) | 为解决「可见性脱钩」而设,但脱钩已由 §6.2 判定为创建者责任 → 需求消失。且它把语义反转成「默认允许、扣除失效即泄露」,风险等级高于 403;扣除还与 `apply_acl_deny_filter` 不同构(SQL 谓词 vs 带缓存的网络调用) |
| **一个仓库一份 wiki** | 归属改为创建者后,A 的私有 wiki 对 B 不可见,禁止 B 再建等于先到先得地剥夺后来者(§6.4) |
| **code wiki 的 KB 配置做成系统级配置项** | 其唯一理由是「归属在 wiki 账号、用户看不见也选不了」;归属改回创建者后,常规 KB 创建路径的自动解析本就针对创建者本人 |
| **admin code wiki 管理页** | 为解决「KB 归 wiki 账号 → 无人可见 → 配置改不了」的死角而设;死角随归属改回而消失(§6.7) |
| **KB 级选择执行模型** | `modelRef` 在 `BotSpec` 上,`create_task_or_append` 无 model override;需新增影响所有 shell 的任务级能力。应独立设计,不在 code wiki 里开口子(§6.9) |
| **改造共享 `RepositorySelector` 使其能列出公开仓库** | 该组件被任务创建等处使用,改动外溢到与本设计无关的路径;且列表源本身是 `membership=true` 的服务端语义,不是组件层能修的。改为在 code wiki 弹层包一层、增加 URL 录入(§6.8) |
| **为公开仓库打通匿名分支列表** | 只为「创建时选非默认分支」这一低频场景多打通一条匿名路径。resolve 端点已返回默认分支,需要时由有 token 的人创建或事后在 KB 设置里改(§6.3.1) |
| **周期任务清扫索引欠账** | 让 `pendingIndexCleanup` 有两个写者做读-改-写;清扫之间加分布式锁挡不住,因为发布不持有那把锁(§5.6) |
| **顺序存 `source_config.wiki_order`** | 只调顺序时指纹不变,页被跳过,新位置永远写不进去。改存 `spec.pageOrder`(§5.5) |
| **章节缺页面时拒绝发布** | 一个其余完好的版本因某章节缺概述页被整个丢弃,代价远大于收益;导航从 path 建树,无页面的章节渲染成分组标题即可 |
| **`decide_run_mode` 的顶层模块守卫** | 它为「按文件类型过滤过的 diff」而设,我们的 diff 不过滤,该场景不存在;没接线的分支不是防线 |
| **`code_wiki_schedule` 独立调度模块** | 零调用者。看起来像防线、实际不在任何路径上的校验比没有更危险,届时随调用点一并加回 |

## 9. 影响面

**删除**:旧 wiki 内容服务端点、`WikiService` 的 git-only 权限与每请求过滤、旧 `wiki-ghost` 回写路径、前端 `apis/wiki.ts` 旧内容调用。

> **实现修订(2026-08-07),两处与原文相反**:
>
> - **`init_data/skills/wiki_submit/` 不能删。** 写下本文时它只是旧 wiki 的回写通道;
>   实现中 **`code-wiki-ghost` 靠它写入版本库**(`submit`/`read`/`remove`/`complete`/`fail`
>   全在里面),新路径没有替代品。要删得先拆出新的 writer skill,那是另一件事。
> - **`GET /generations*` 的评估已有结论:整体删除。** 中途先做了授权,后来发现唯一调用方
>   是**够不到的前端**——`useWikiProjects` 仍挂在知识库页上每次请求 `/wiki/config`,但它服务的
>   `AddRepoModal` 的唯一打开函数零调用方。全仓确认无脚本、wework、executor 或其它服务调用后,
>   public `/wiki` router 整体下线。

**保留复用**:`WikiGeneration` / `WikiContent`、`save_generation_contents`(需加 `path`)、`WikiBase`(已是 `Base` 别名)。

**新增**:code_wiki 创建/生成/更新 API;种子复制;path 校验;保留策略;**投影作业**(核心新增件);发布闸门与指针前移;订阅集成;权限;前端阅读壳 + 版本浏览/回退入口;init_data 复核与 public 模型回落。

**`wiki_config.py`**:迁入 code_wiki 配置区,保留 `WIKI_` 前缀以免破坏既有部署环境变量。

> **实现修订(2026-08-12),删留与原文相反**:`MAX_CONTENT_SIZE` 守着新路径的写入端点，
> 必须保留；`CONTENT_WRITE_*` 与 `INTERNAL_API_TOKEN` 分别只被旧 `_build_generation_ext`
> 与已删除的固定 token 通道使用，故删。新 skill 从任务自己的 API domain 拼 URL，并以用户
> JWT 或 skill identity token 回写。旧的生成配置(`ENABLED`、
> `DEFAULT_TEAM_NAME`、`DEFAULT_AGENT_TYPE`、`DEFAULT_USER_ID`、`MAX_CONCURRENT_GENERATIONS`、
> `RESULT_POLL_*`、`DEFAULT_SECTION_TYPES`、`SUPPORTED_FORMATS`)随 legacy 路径一起删。
> 最终留 4 项:`CODE_WIKI_ENABLED` / `CODE_WIKI_TEAM_NAME` / `DEFAULT_LANGUAGE` /
> `MAX_CONTENT_SIZE`。

已核实为**零引用**的遗留项,随本次一并删除:`MAX_CONCURRENT_GENERATIONS`、`RESULT_POLL_INTERVAL_SECONDS`、`RESULT_POLL_BATCH_SIZE`、`DEFAULT_AGENT_TYPE`、`SUPPORTED_FORMATS`。
其中 `MAX_CONCURRENT_GENERATIONS` 命名的**能力**是真实缺口(现状只有单 KB 互斥,无全局上限),但需重新实现而非「沿用」,归入订阅那一期。

### 9.1 权限模型修订的增量影响(2026-08-04)

**回退**(归属相关,核心链路不动):

- PR4 的归属改造、B1 列表专用端点的特殊查询、B2 仓库权限读判定
- **不回退**:版本库、投影、发布闸门、生成 agent、阅读器 —— 与归属无关

**删除**:`code_wiki/read_access.py`(164 行)、`content_scope.py`(109 行)及 14 处调用点、
`registry.wiki_owner` / `claim_repository` 的独占语义、`_assert_the_wiki_account_can_clone`、
`WIKI_DEFAULT_USER_ID` 整条链路。

**迁移**:`wiki_projects` 的 `source_url UNIQUE` → `UNIQUE (source_url, kind_id)`。
`kind_id` 列保留(§6.4)。

**不再需要**:admin 管理页、5 项系统级 KB 配置、四个权限缺陷的逐个修补、ACL 授予/扣除机制。

**新增**:公开仓库的匿名探测与缓存(§6.3)、`POST /code-wikis/resolve` 解析端点(§6.3.1)、
仓库写权限阈值(§6.5)、创建弹层合并与双录入方式(§6.8)、列表去 tab 与灰度开关(§6.7)、`spec.language`。

## 10. 留给 plan 的实现细节

投影 plan 算法与执行步骤;事务/清理的具体顺序与重试机制;闸门检查项与阈值取值;配置项名与默认值;cron 校验实现;`ext.publishGate` 结构;超时阈值;并发锁的具体加法(`with_for_update`);`converted_attachment_id` 过期处理;生成文档的 `user_id` 归属(建议 KB owner);发布/回退操作权限(KB owner + 系统管理员);保留策略参数;各 PR 的文件级改动。
