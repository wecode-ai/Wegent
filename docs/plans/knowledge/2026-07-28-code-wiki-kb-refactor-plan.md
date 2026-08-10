---
sidebar_position: 1
---

# Code Wiki 重构 — 一期实施计划(范围与步骤)

> Status: **一期已完成**。归档时按落地结果校正,凡与实现不一致处标注「⚠️」并说明为什么变了
> ——写下时是对的、执行中发现不成立的判断,比一份读起来一切顺利的计划有用。
> Spec: [`../../specs/knowledge/2026-07-28-code-wiki-kb-refactor-design.md`](../../specs/knowledge/2026-07-28-code-wiki-kb-refactor-design.md)
> 二期: [`../../specs/knowledge/2026-07-30-code-wiki-phase2-code-index-design.md`](../../specs/knowledge/2026-07-30-code-wiki-phase2-code-index-design.md)(不在本计划内)
> 本计划界定**工作范围、步骤顺序与实现机制**;spec 只写结论与不变量,机制细节落在这里。

> **改写说明(2026-07-31)**:spec 的发布模型已由「原地页级发布」改为「版本库 + 投影」,
> 本计划据此重写。原计划中的**孤儿对账、页级发布门禁、KB MCP 写入工具(含删除工具的
> 独立 server 与软删设计)、`source_ref` 预留**全部作废 —— 详见「已有代码处置」与 §0。

## 0. 相对原计划,消失了哪些工作

记录于此,避免执行者从旧上下文里把它们捡回来:

| 原计划工作项 | 为何消失 |
| --- | --- |
| 补齐 KB MCP 工具(建文件夹 / 删文档 / 删文件夹) | **agent 不再写 KB**,只写版本库。这些工具的需求整体消失 |
| 删除工具的双层安全设计(独立 `knowledge_wiki` server + 服务端作用域校验) | 同上。agent 够不到 KB,不存在"通用工具被别的 agent 引用而破防" |
| 软删除 + 墓碑 + 延迟清理窗口 | 其动机是"LLM 误删且无版本可恢复";现在**有版本库可回退**,投影侧可硬删 |
| 孤儿页对账(生成集 + 启发式守卫) | 投影拿到的是完整快照,孤儿 = 纯集合差 |
| 页级原子发布门禁(写入成功 + 索引成功才放行) | 发布 = 投影事务;索引改为提交后最终一致(spec §5.3) |
| `source_ref` 迁移字段 | 一期零使用;二期要强类型列,届时纯加法(spec §8) |
| "不要中途弄坏旧路径"的编排约束 | 旧写入路径(`save_generation_contents`)是**被复用**的,不是被替换的 |

## 总体原则

- Python 用 `uv run`;提交前跑聚焦测试;E2E 走真实后端、不得跳过、且必须被 CI 套件调用;保留/同步 `data-testid`。
- 动 `frontend/**` 前先读 `frontend/AGENTS.md`。
- **迁移 revision id 必须用 `alembic revision -m` 生成**,不得手写(初稿手写 id 与 main 的 `add_knowledge_artifacts` 撞号导致 CI 失败)。
- 迁移列一律 **NOT NULL + `server_default`**(内网 DBA 规范不接受 nullable),模型定义上也要写。
- 存量 wiki 数据不迁移,`wiki_generations.kind_id = 0` 即老数据。

## 分支策略

**同分支 `refactor/code-wiki-kb` 重写,force push 覆盖 #2328**,并在 PR 描述中说明设计变更。已确认。

- force push 前先确认没有他人基于该分支工作。
- PR 描述需说明:发布模型变更的原因、以及哪些早先提交的内容已作废。

## 已有代码处置(重写的第一步)

分支上现有 6 个提交 / 22 文件 / ~2900 行,按新设计分类:

| 文件 | 处置 |
| --- | --- |
| `code_wiki_source.py` + test | ✅ 保留 — 创建门禁,spec §6 已定部分 |
| `mermaid_check.py` + test | ✅ 保留 — 改归入发布闸门(spec §5.3/5.4) |
| `code_wiki_run_mode.py` + test | 🔧 改造 — 删 `reconciles_orphans`、`MIN_PRODUCED_PAGES`、`MAX_REMOVED_SHARE`;模式改存 `wiki_generations.generation_type` |
| `content_scope.py` + test | 🔧 改造 — 去掉对账相关 scope;**必须接进生产查询**(见步骤 1) |
| `models/knowledge.py` | 🔧 保留 `origin`(补 `server_default`);删 `last_generation_run_id`、`source_ref`、索引 `(kind_id, origin)` |
| `schemas/knowledge.py`、`schemas/kind.py`、`api/endpoints/knowledge.py`、`knowledge_service.py`、`orchestrator.py` | 🔧 `kbKind` → 复用 `kbType`;spec 加 `publishedGenerationId` |
| `code_wiki_reconcile.py` + test | ❌ 删除 — 被投影取代 |
| `code_wiki_generation_state.py` + test | ❌ 删除 — 状态塌缩到 `wiki_generations` 行 + 一个指针 |
| `test_knowledge_base_kind.py` | ❌ 删除 — kbKind 不存在了 |
| 两个迁移文件 | ❌ 已 `git rm`(撞号) |

> **删 `code_wiki_generation_state.py` 时注意保住两件事**(它们在新设计里仍然必需,不可随文件一起消失):
> ① **在飞运行的超时回收**(spec §4.4)—— 崩溃的 RUNNING 会永久阻塞该 wiki;
> ② **`RunMode(mode) == RunMode.FULL` 用值比较而非 `is`** —— 模式经任务载荷序列化后是字符串,身份比较会静默失效。

## 落地策略:5 个 PR

接缝按新架构重切,**PR2/PR3 的分界落在「版本库 / 投影」上**——这是新架构的关键边界,分开更好 review。

| PR | 内容 | 风险 | 验证重点 |
| --- | --- | --- | --- |
| **1** | 步骤 1:数据模型、`kbType`、创建 API + 门禁、scope 接线;**并清理作废代码** | 低 | 聚焦 pytest;Alembic `upgrade head` **与回滚**实测 |
| **2** | 步骤 2:版本库(`path`、种子、模式判定、超时回收、agent 删除声明) | 中 | 单测;种子幂等;超时回收 |
| **3** | 步骤 3:投影 + 事务顺序 + 发布闸门 | **最高** | 单测 + **真跑一轮生成**;事务失败回滚;RAG 清理重试 |
| **4** | 步骤 4:生成 agent 定义 + prompt | 中 | 真跑 full 与 incremental 各一轮 |
| **5** | 步骤 5 + 6:前端阅读壳;下线旧服务路径 | 中 | E2E(须被 CI 调用)+ grep 残留 |

**读权限映射(spec §6.1)不在任何一个 PR 内** —— 它待定,且与上述都正交。PR1–PR4 期间 code_wiki 的读权限暂用 KB 默认 ACL,不实现仓库映射。

---

## 步骤 1:数据模型与类型(PR1)

**迁移(一次,三列,零新索引)**

```
+ knowledge_documents.origin    String(20)  NOT NULL  server_default 'user'
+ knowledge_folders.origin      String(20)  NOT NULL  server_default 'user'
+ wiki_generations.kind_id      Integer     NOT NULL  server_default '0'
```

**类型**
- `kbType` 复用为三值 `notebook | classic | code_wiki`,删除 `KnowledgeBaseKind` 枚举与 `kb_kind` 字段。
- `KnowledgeBaseSpec`(`schemas/kind.py`)需显式声明 `source` 与 `publishedGenerationId` —— 该 Pydantic 模型**会丢弃未声明的 spec 键**,不声明就静默丢数据。
- 现有"切换 KB 视图类型"的接口需拒绝把 code_wiki 改成 notebook/classic。

**scope helper 接线(本步的关键交付,不可只写不接)**
- `content_scope` 去掉对账相关函数,保留 wiki 页 / 用户内容的作用域。
- **必须接进 `list_documents`、`get_folder_tree` 以及后续投影**。原实现零调用方,等于没埋预留(spec §3.4)。

**创建 API**
- `POST /knowledge-bases/code-wikis`:`SourceRepository.from_url` 从 URL 推导全部字段并剥离凭据;`assert_user_can_read_source` 做仓库门禁。
- 通用创建接口拒绝直接创建 code_wiki。

**清理**:删除 `code_wiki_reconcile.py`、`code_wiki_generation_state.py`、`test_knowledge_base_kind.py` 及对应测试。

**测试**:迁移 upgrade/downgrade 实测(本地 docker `wegent-mysql`,**不碰内网库**);创建 API 的门禁通过/拒绝;scope 确实作用于 `list_documents`。

---

## 步骤 2:版本库(PR2)

**页面身份 `path`**
- `save_generation_contents` 扩展接受 `path`,存 `wiki_contents.ext`;匹配键由 `(type, title)` 改为 `path`。
- path 归一化校验:禁 `..`、禁绝对路径、长度上限、**版本内唯一**。

**种子机制**
- 创建 `incremental` generation 时,一条 `INSERT ... SELECT` 把已发布版本内容复制为种子,发生在 agent 启动**之前**。
- `full` 不播种;首次运行无已发布版本 → 等同 `full`。
- 种子必须幂等(重试不产生重复行)。

**运行模式**
- 改造 `code_wiki_run_mode`:保留升级到 `full` 的条件判定,删掉与对账相关的一切。
- 结果写 `wiki_generations.generation_type`。

**超时回收**
- 锁 `wiki_generations` 行(`with_for_update()`)串行化;in-flight 超过阈值(建议 6h,大仓库需宽裕)即视为废弃,置 FAILED 并允许被新一轮取代。判定用行上已有的 `created_at`/`updated_at`,**不加新列**。

**agent 删除声明**
- 提供"从在飞版本移除某 path"的写入语义(只作用于版本库)。

**保留策略**
- 最近 N 个成功版本 + 时间上限;失败/被拒版本给短窗口。
- **不变量:`publishedGenerationId` 指向的版本永不回收。**

**测试**:种子后版本 = 已发布版逐字节副本;`full` 不播种;超时回收能解除阻塞;path 校验拒非法值;保留策略不回收已发布版(**连续失败**与**长期无提交**两个场景都要覆盖)。

---

## 步骤 3:投影与发布闸门(PR3)

**plan 对象**
- 产出显式 `adds / updates / deletes / skips`,支持 dry-run 与日志。按 `path` 集合运算,作用域 `origin='generated'`。

**事务顺序(不可违反,spec §5.2)**

```
提交前 :  为 新增/修改 的页写新附件(行 + 对象)
事务内 :  改指针、插新行、删旧行、删空目录
提交后 :  删被取代的旧附件、删已移除文档的 chunk、入队重索引
```

- 生产附件在对象存储(`ATTACHMENT_STORAGE_BACKEND`),**字节不在事务里**。
- **「修改」不得原地覆写附件**(提交前销毁旧内容,事务失败即不可恢复)。
- **不得直接调 `delete_document`**(它内部 `commit()`,且清理只记日志);但其级联内容必须照做:document 行 → RAG 索引 → attachment → converted attachment。
- **待删 `doc_ref` 落库记账 + 可重试**。只删行不清 chunk 会留下幽灵内容(页面没了,RAG 仍拿它作答并生成指向死 id 的引用)。
- 处理 `converted_attachment_id` 过期。

**发布闸门**
- 页数跌幅阈值(agent 驱动删除的主要安全网)、mermaid 结构性检查、悬空链接。
- 通过才前移 `publishedGenerationId`;结论写 `wiki_generations.ext.publishGate`。
- **发布 = 投影事务成功**;索引失败不阻止发布、不回滚版本。

**回退**
- 用指定历史版本重新投影一次即可,无需额外机制。

**测试**:四种情况(增/改/不变/删)各一;hash 相同确实零动作;事务中途失败后 KB 完全未变;删除页的 chunk 被清理;闸门拦住页数骤降;**回退到上一版**恢复被删页。

---

## 步骤 4:生成 agent(PR4)

- **新建** `code-wiki-ghost` / `code-wiki-team`;**不改**现有 `wiki-ghost`(它服务旧路径,留到步骤 6 一并删)。
- agent 只写版本库,**不需要 KB MCP 工具**。
- **两套 prompt**:`full` = 分析仓库 → 页面结构计划 → 逐页写入;`incremental` = 变更窗口 + 种子中现有页清单 → 只改受影响页 + 显式声明删除 + 刷新 index/log。
- 覆盖面与内容基调写进 prompt → 见**附录 A-1 / A-2 / A-5**。
- mermaid 结构性 warning 回喂 agent 自修(附录 A-3)。
- 模型:默认系统 wiki 模型,允许覆盖,**任何情况回落 public**,保证 upstream 可跑。

**触发与运行**(本步实际交付)
- `POST /knowledge-bases/{id}/code-wiki/generations` 直接触发一次运行,要 manage 权限(一次 run 重写 KB 全部内容,接近替换而非查看)。「无需运行」返回 **202 + `started=false`**——这是调用方问的答案,不是错误。
- **generation 先于 Task 提交**:崩在中间只留下「有版本没 Task」,由 6 小时 staleness 回收;反过来是「有 Task 没版本」,没人回收,且它会往不存在的版本写页面。
- Task 建不出来**立刻判失败**,不留 RUNNING 等回收——配置错误让 wiki 六小时拒绝重生成,比立刻报错糟得多。
- **仓库状态自读**(`code_wiki/repo_state`):不传 commit 时自行取默认分支 HEAD 与 diff,否则 `decide_run_mode` 三个答案里有两个不可达,每次都是全量重建。github/gitlab/gitea 各加两个窄读取,**不复用 `get_branch_diff`**(它为 PR 展示拉完整 patch,还有反向兜底,会回答错误的问题)。
- 所有读取**只降级成「未知」,绝不猜**:provider 挂了 / GitLab `compare_timeout` / GitHub compare 到 300 上限 / Gitea 老版本无该端点 → 全量重建。局部 diff 被当成完整的,会给一次重塑仓库的变更选增量。
- **删除通道**:写接口加 `removed_paths`;增量版本是已发布版本的副本,「不写」不等于「删除」。
- **agent 回报 commit**:`summary.head_commit`。它读的是工作区,触发方只知道别人告诉它的,而这个值决定下一次的模式判断。
- `wiki_submit` skill 加 `--path` / `remove` / `--head-commit`。

**调度:本期不做,一期只有手动触发**
- 曾实现独立的 `code_wiki_schedule` 模块(1 周下限、拒 `EVENT`、cron 取相邻最小间隔),因**零调用者**已删除——看起来像防线、实际不在任何路径上的校验比没有更危险。
- 下期走 `Subscription`,不自建调度。接入点已查证,见 spec §4.6 末尾的表。

**测试**:真跑 full 与 incremental 各一轮。

---

## 模块布局

后端实现收在 `app/services/knowledge/code_wiki/`(测试镜像到 `tests/services/knowledge/code_wiki/`),文件名去掉 `code_wiki_` 前缀。`mermaid_check` 一并移入——它只有发布闸门一个使用者;`content_scope` 留在原处,`knowledge_service` 也在用。

`__init__.py` **不做任何 re-export**:`app.services.knowledge` 自己是惰性导出以规避循环导入,在子包里做急切导入等于把整条链拉到包导入时刻。调用方一律走子模块路径,顺带让 `publisher` 与 `publish_gate` 在 import 行上就能区分。

---

## 步骤 4.5:归属、读权限与列表(已完成,且中途整体推翻过一次)

这一节先按「wiki 账号持有 + 仓库权限判定」实现,上线前推翻。**推翻的原因值得留着**:那条规则只在 code_wiki 包内部新写的端点上生效,凡是复用既有链路的地方判定都退回 KB ACL——而 KB 归一个谁都不是的账号,ACL 对任何人都不放行。根因不是漏了某一处,是**规则从未写成一句可检查的不变量,也没有判定点清单**。

最终落点:

- **归属**:`Kind.user_id` = **创建者**,namespace 默认创建者个人空间,可在弹层里选。code_wiki 就是一个普通知识库,只是绑了仓库
- **读权限**:**标准 KB ACL**,和任何知识库一样。仓库只在**创建时**校验一次,之后不再查。`code_wiki/read_access.py` 已删除
- **排重**:`wiki_projects` 复合唯一 `(source_url, kind_id)` —— 一个仓库可以有多个 wiki,一人一个。迁移 `c3d4e5f6a7b8` 取代了 `2b5791acc5fa` 的单列唯一
- **列表**:**不做隔离**。code_wiki 出现在普通知识库列表里,图标区分。`content_scope` 里只剩一段注释说明为什么没有 `exclude_code_wikis`
- **创建**:走**普通知识库创建弹层**,整包透传;`GET /knowledge-bases/code-wikis` 保留,只因它的列表项带仓库字段
- **触发权限**:仓库**写**权限。**执行身份始终是 KB owner**,不是触发者——共享成员触发一次会把 clone 凭据、版本归属和页面归属全换成他自己

**测试**:归属落在创建者;同一人对同一仓库二次创建返回已有,不同人各自建各自的;共享成员触发时执行身份仍是 owner。

---

## 步骤 5:前端阅读壳(PR5)

- 视图由 `kb_type` 驱动:`code_wiki` → 只读阅读壳;`notebook` → 现有编辑壳。
- 复用 KB 原语(文件夹树、`DocumentContentViewer`、权限、路由);`WikiSidebarList` / `WikiContent` / `WikiDetailSidebar` / `useWikiDetail` / `wikiLinkResolver` 重构入壳,而非另起一套。
- wiki 特有:多级导航、交叉链接、概览页、生成状态、重新生成入口、源仓库链接、版本浏览。
- 生成内容**只读**,不暴露编辑入口。
- **Mermaid 优雅降级**:已完成,渲染失败回落到可复制的原始源码。

**已定**:一个知识库只有一个 URL。`knowledge/[namespace]/[kbName]` 按 `kb_type` 决定渲染阅读壳还是文档工作台;曾经的 `/knowledge/code-wiki/[id]` 独立路由已删除。中间试过「独立路由 + 重定向」,行不通——这个页面自己用 `history.pushState` 改 URL,重定向抢不过它。

**已做**:**版本回退入口**。运行历史里「已完成且不是当前版本」的那些带恢复按钮,服务端 `republish_generation` 强制同一条规则,客户端 `canRepublish` 与之同名同义。走的是和任何一次发布同一条投影路径。注意回退**恢复不了 document id**:路径对不上的按新页面插入,引用它们的东西不会因为内容回来而修好——按钮上写了这句。
**测试**:E2E 覆盖「创建 → 生成 → 浏览多级页 → 跳转交叉链接」;新交互元素补 `data-testid`;E2E 必须被 CI 套件调用。

---

## 步骤 6:下线旧服务路径(PR5)

- 删除:`WikiService` 的 git-only 权限与每请求过滤、旧 `wiki-ghost` 回写路径、孤儿页 `/knowledge/project/[projectId]` 与 `useWikiDetail`,以及只有它在用的 `apis/wiki.ts` 调用。
- ⚠️ **`init_data/skills/wiki_submit/` 不能删**。这条是本 plan 写下时的错误:它当时只是旧 wiki 的回写通道,而现在 **`code-wiki-ghost` 靠它写入版本库**——`submit` / `read` / `remove` / `complete` / `fail` 全在里面,新路径没有替代品。要删得先拆出新的 writer skill,那是另一件事,不属于 PR5b。
- ⚠️ **`GET /generations*` 与 cancel 已全部删除**(推翻本条原文的「授权后保留」)。中间确实先做了授权:原先它们按 `WIKI_DEFAULT_USER_ID` 选账号,那是配置值而不是对调用者的判断,默认 0 时任何登录用户可按自增 id 读到任何人的整页正文。后来发现**唯一的调用方是够不到的前端**——`useWikiProjects` 仍挂在知识库页上每次请求 `/wiki/config`,但它服务的 `AddRepoModal` 的唯一打开函数 `handleAddRepo` 零调用方,`handleCancelClick` 同样零调用方。全仓再确认没有脚本、wework、executor 或其他服务调用,遂整体下线 public `/wiki` router。
  **存量影响**(明确接受):`wiki_generations` / `wiki_contents` 数据未删,但 `kind_id=0` 的 legacy 版本失去全部浏览与取消入口。新 code wiki 的历史由 `GET /knowledge-bases/{id}/code-wiki/generations` 承载,走普通 KB ACL。
- ⚠️ 原文写「`GET /wiki/generations` 仍被在用页面调用,不可直接删」——那是写下时的事实,随 `useWikiProjects` 一并作废。
- **保留**:`WikiGeneration` / `WikiContent` / `save_generation_contents` / `WikiBase`。
- ⚠️ `core/wiki_config.py` 的删留**与本条原文相反**。原文要删 `CONTENT_WRITE_*` / `INTERNAL_API_TOKEN` / `MAX_CONTENT_SIZE`、保留生成配置;实际是**反过来**:后两者守着新路径的写入端点必须留,`CONTENT_WRITE_*` 只被旧 `_build_generation_ext` 用(新 skill 从任务自己的 API domain 拼 URL)所以删。旧的生成配置(`ENABLED` / `DEFAULT_TEAM_NAME` / `DEFAULT_AGENT_TYPE` / `DEFAULT_USER_ID` / `MAX_CONCURRENT_GENERATIONS` / `RESULT_POLL_*` / `DEFAULT_SECTION_TYPES` / `SUPPORTED_FORMATS`)随 legacy 路径一起删。最终留 5 项:`CODE_WIKI_ENABLED` / `CODE_WIKI_TEAM_NAME` / `DEFAULT_LANGUAGE` / `MAX_CONTENT_SIZE` / `INTERNAL_API_TOKEN`。
- 同批删除:`wiki-ghost` / `wiki-bot` / `wiki-team` 种子资源、`core/wiki_prompts.py`、`services/wiki_repository_access.py`(仓库读权限只剩 `code_wiki/source.py` 一份实现)、`WIKI_FEATURE.md`。

**测试**:全量后端 + 前端测试;grep 残留(旧端点引用、孤儿页 import)。**不要 grep `wiki_submit`** —— 它是新路径的写入通道,残留在那里是对的。

---

## 验收

- 能创建 code_wiki、生成出一份可浏览的多级 wiki。
- **投影四情况正确**:新增/修改/删除生效;**未变更的页零动作**(不重写附件、不重索引、`document_id` 不变)。
- **原子性**:投影事务中途失败 → KB 完全未变,重跑收敛。
- **闸门**:页数骤降被拦住,被拒版本留在库里可查 `ext.publishGate`。
- **回退**:用历史版本重新投影可恢复。
- **不阻塞**:崩溃的运行经超时回收后,新一轮能正常开始。
- **索引欠账收敛**:投影删页时向量库删除失败 → 发布照常成功、欠账入账,清扫任务后续排空(不会永久留孤儿 chunk)。
- ~~**调度**:默认一次性;cron 频率下限生效。~~ **移出本期**,见步骤 4。
- upstream 可跑(public 模型回落,含 embedding)。

## 风险

| 风险 | 缓解 |
| --- | --- |
| 删旧模块时把超时回收/值比较一起删掉 | 处置表下的显式提醒;步骤 2 有对应测试 |
| 删 KB 文档未清 RAG chunk → 幽灵内容 | 待删 doc_ref 落库记账 + 可重试(步骤 3) |
| 删 blob 早于提交 → 回滚销毁线上内容 | 事务顺序写死 + 针对性测试 |
| 投影事务体量过大被迫分批 → 原子性失效 | 压测;**若触发须回头重新讨论,不得默默降级** |
| agent 误删大量页 | 版本库可回退 + 页数跌幅闸门 |
| 全量重建成本高(hash 跳过在 full 下基本失效) | `full` 仅在结构性变更/超阈值/防漂移周期触发 |
| 生成质量"泛而空" | 附录 A-1/A-5 的覆盖要求与内容原则写进 prompt |
| 执行者 git 凭据失效导致静默失败 | FAILED + 可见告警;支持服务账号 |
| force push 覆盖他人工作 | 推送前确认无人基于该分支 |

---

# 附录 A:openwiki 参考实现(`~/iDev/public/openwiki`)

langchain 的 openwiki 是同类纯文档实现,以下是可直接借鉴的具体做法(spec §7 记了结论,这里是细节)。

## A-1. 必需覆盖面与内容基调(`openwiki/INSTRUCTIONS.md`)

它用一份常驻的"仓库指南"文档约束生成,要点:

- **必须覆盖**:concise quickstart、architecture overview、**source map**、key workflows、domain concepts、operations/runbook notes、testing guidance、integration points。
- **基调要求**:检视 **git history** 以理解代码变更的**动因与演进**;页面必须扎根于**仓库结构与近期代码变更**;**"为工程师提供实用导航"优先于泛泛总结**。

→ 落地:把这份覆盖清单与基调写进我们的生成 prompt(步骤 4),对应 `DEFAULT_SECTION_TYPES` 的升级版。

## A-2. 根导航页形态(`openwiki/index.md`)

极简两段式,便于人和 agent 导航:

```markdown
# Files
- [Quickstart](quickstart.md) - 一句话说明这页讲什么、何时该看。
# Directories
- [architecture](architecture/)
- [operations](operations/)
```

→ 落地:我们的根 `index.md`(概览首页)采用同样的"带一句话描述的链接列表 + 子目录列表",天然映射到 KnowledgeFolder 树。

## A-3. Mermaid 校验回喂(`src/mermaid/`、`src/agent/okf-middleware.ts`)

- `fences.ts`:从 markdown 提取 ` ```mermaid ` 围栏(能正确跳过嵌套在其他围栏里的示例)。
- `dom-shim.ts`:headless 解析需要最小 DOM 垫片(mermaid 的 flowchart/state 解析器依赖 DOMPurify)。
- `validate.ts`:解析失败即视为不可渲染,错误经**密钥脱敏**处理。
- `okf-middleware.ts`:`afterAgent` 钩子跑校验,把失败**格式化成修正指令回喂给 agent**;`beforeAgent` 则校验/迁移 frontmatter 并给出警告。

→ 落地:这正是"agent 侧校验 + 自修正"的依据——**校验不是单纯拒绝,而是驱动 agent 修好**。我们做结构性检查即可,不需要 JS 解析器;契约可升级为完整解析,接口不变。

## A-4. 无变更跳过(`src/agent/index.ts`)

检测到自上次更新以来仓库无变化 → 打印 "No repository changes detected…"、**跳过整个 agent 运行**,并记一条 `outcome: "noop"` 的运行记录。

→ 落地:spec §4.1 的 `skip` 模式 + `BackgroundExecution(SKIPPED)`;比对 HEAD vs 已发布版本的 commit。

## A-5. 增量窗口与内容取舍(`src/code-mode.ts`、`src/ingestion.ts`)

- **增量窗口**:以"自上次记录以来的时间/提交"为窗口——"what has happened since we last documented this repo",把**近期变更**喂给 agent,而不是每次从零复述整个仓库。
- **内容取舍原则**(强力,治"泛而空"):
  - 每条事实都要过一遍**"它会改变 agent 在这里的做法吗?不会就删"**;
  - **只记录"读代码无法恢复"的信息**,不复述代码本身已显而易见的架构/正常流程;
  - 只写样本真正支撑的结论;没有就直白说没有,**不要编**。

→ 落地:这三条直接写进生成 prompt;已发布版本的 commit 可据此把"本轮变更范围"注入 prompt。

## A-6. 不采纳

OKF 文件格式、deepagents 框架、connector 生态、把 wiki 写回仓库并开 PR 的发布方式(我们走 KB 存储 + 版本库,git 回写是未来可选)。
