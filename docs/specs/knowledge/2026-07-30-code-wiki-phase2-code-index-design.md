---
sidebar_position: 4
---

# Code Wiki 二期:代码索引设计轮廓

> Status: **Draft — 核心存储决定处于重新开放状态,未定稿**。一期未实现其中任何一项。
> Date: 2026-07-30(自一期 spec §13/§14 拆出)
> 一期设计见 [`2026-07-28-code-wiki-kb-refactor-design.md`](./2026-07-28-code-wiki-kb-refactor-design.md)

目标:代码级 RAG,让 Ask 能捞出任意代码块(对标 DeepWiki 体验)。

**不做 CodeGraph 图索引(②)** —— DeepWiki 类 Ask 只需 chunk RAG,且我们无图地基;仅"符号→位置跳转"用轻量符号表,非图。

---

## 0. 先定这个:代码目标存在哪里(⚠️ 重新开放)

一期初稿曾称「代码目标复用 `KnowledgeDocument`」是唯一难以回头的结构性决定并已敲定。**该决定现予重新开放**,因为两个成本被低估:

1. **索引管线依赖附件。** 若每个源文件都需一个 `SubtaskContext` + 一个对象存储对象,索引一个万文件仓库 = **把整份代码库复制进对象存储**。这与「索引负责定位、不承载内容」的原则直接冲突。
2. **大量不可见记录污染既有逻辑。** `get_document_count` / `_update_document_count_cache` / 分页 / 统计都会被上万条代码记录带偏,「这个知识库有多少文档」会给出错误答案。

**三条待权衡路径(二期开工前必须先定):**

| 方案 | 得 | 失 |
| --- | --- | --- |
| (a) 接受附件复制,完全复用现有管线 | 最大复用 | 对象存储与 DB 双份代码副本 |
| (b) 扩展索引管线支持非附件来源 | 不复制内容 | 改动共享管线,影响面外溢 |
| (c) 代码目标不进 documents 表,用更轻的存储直接对接 knowledge_runtime | 计数/分页/可见性问题一次性消失 | 放弃 index-target 单路径,需新增一套状态管理 |

> **§1 以下的内容是在方案 (a) 前提下写的初稿轮廓。** 若最终选 (b) 或 (c),§1 与 §1.1 的落库形态需整体重写;§2–§5(切分、筛选、增量、splitter 约束)基本不受影响。

## 0.1 与一期的根本差异:二期不需要版本库与投影

| | 一期(wiki 页) | 二期(代码目标) |
| --- | --- | --- |
| 产出方式 | LLM 生成,非确定 | 由 `(path, blob_sha)` **确定性**导出 |
| 单元耦合 | 页面互相引用,整套需自洽 | 每个文件**彼此独立** |
| 半成品的含义 | 页面互相矛盾 → **错** | 搜到的少了 → 只是**不全**,不会搜到错的 |
| 收敛方式 | 完整快照 + 原子投影 | **集合差**:desired = 树中文件,actual = 已索引的 sha |

**崩了就是待办没做完,下次比 sha 续上 —— 收敛靠集合差,不靠事务。** 不要把一期的版本库/投影/发布闸门机制搬过来。

二期真正需要的持久化只是**每个目标记录其 blob sha**(强类型列,不是 nullable JSON)。一期已据此取消 `source_ref` 预留。

## 1. 统一存储模型(index-target 单路径)—— 方案 (a) 下

代码源与 wiki 文档走同一条 index-target 路径,复用 `KnowledgeDocument`;区别在于正文是否入库、谁是真源:

| | 生成的 wiki 页 | 代码文件 |
| --- | --- | --- |
| 正文 | **存 DB**(DB 即真源) | **不存**,只留位置引用 |
| 真源 | 自身 | git |
| discriminator | 普通 wiki 文档 | `source_type="code"` |

> **一期已埋的部分,以及一处需要注意的**:`DocumentSourceType.CODE` 枚举值一期就已加上,
> 读侧作用域(`content_scope.wiki_pages`)也已把它排除在读者可见范围之外。但**公共建文档 API
> 会拒绝 `source_type=code`** —— 一期短暂开放过,结果是「建得出来、计数 +1、列表里看不见、
> 界面上删不掉」,因为 `get_document_count` 不做同样的过滤。二期的摄入作业应走自己的写入路径
> (像 wiki 投影那样),而不是复用公共 API。

- 不新建 `indexed_source` 表,不泛化状态机到新表——`index_state_machine` 现成可用。
- **不引入 `content_mode` 列**:"正文存不存"可由 `source_type` 推导。
- chunk 一律带位置元数据;下发/过滤走检索层已有的 `metadata_condition`。

### 1.1 落库记录形态

**先澄清"不存正文"的含义**:不存的是"再复制一份完整文件正文当 document body";**chunk 必然带代码文本**(RAG 要返回片段)。两种模式的真实差别只是**要不要重复存**。

而 cAST 的设计目标之一是"**chunk 拼接可逐字还原原文件**",故只要满足下述要求,拼 chunk 即可重建整个文件 —— "看源码"既不需要副本也不必回 git 拉。

**每个入选源文件 = 1 条索引目标:**

```
source_type:   "code"
path:          "src/foo/bar.py"      # 强类型列(二期新增)
blob_sha:      "<sha>"              # 强类型列,增量比对的唯一依据
body:          空
folder_id:     -1(不进 folder 树)
origin:        generated(但投影时按 source_type 排除)
```

**每个文件 = N 条 chunk:**

```
text:      该块代码(前置上下文头:路径 + 所属作用域/类 + 依赖)
vector:    嵌入
metadata:  { path, commit, line_range, order }   # order 支撑顺序拼接还原
```

**硬性要求**:代码切块必须 **零 overlap + 覆盖整个文件**,以保住"拼接可还原"。现有 splitter 配置带 overlap 选项,代码路径必须设 0。

## 2. 复用 vs 新建

- **复用(硬且值钱)**:splitter 框架、embedding、向量库、**现成 hybrid 检索 + 查询规划**(`knowledge_runtime` 已有 dense+sparse + `hybrid_weights`)、`index_state_machine`、metadata 下发。
- **新建(小)**:cAST/AST splitter 类型(tree-sitter,或薄封装 supermemory `code-chunk`);逐文件摄入作业;`source_type="code"` 的可见性过滤。

## 3. 存储范围与切分

**核心原则:索引负责「定位」,不负责「承载内容」。** 不要把整个代码库向量化成一份可检索的副本(数据量、成本,且内容会立刻过时)。索引的价值是让 agent **知道该去看哪个文件的哪一段**,内容它有工具可以现读。这条原则一旦确立,规模问题就从"不可行"降到"可控"。

- **全量(筛选后)索引,不做 AI 筛选**:wiki 文档是策展视图,代码索引存在的意义正是答文档没覆盖的代码;AI 筛选会带回策展缺口。狠排 vendored / 生成物 / lockfile / 二进制。
- **文件筛选策略是二期最需要调参的地方**,直接决定成本:扩展名白名单、体积上限、排除 vendor/生成物。
- **第三方依赖文件不索引**;**import 语句当上下文头**,按大小预算合并兄弟节点,不产生碎 import 块。
- **上下文头**:每块前置 文件路径 + 所属作用域/类 + 依赖(治裸片段嵌入失效)。
- **chunk 粒度待定**:整函数?函数 + 调用上下文?过细则检索碎片化,过粗则 embedding 浪费。

## 4. 增量更新(与文档更新解耦)

- 已知上次索引的 commit 与 HEAD → `git diff --name-status` 得增/改/删文件 → 按 path 找目标,**改/增重切重嵌(整文件替换 chunk)、删则删目标**、未变跳过;`blob_sha` 是权威依据。复用逐文档增量 + `index_generation` 陈旧保护。
- 崩溃后无需特殊恢复:下一轮的集合差自然包含未完成的部分。

## 5. Splitter 系统约束(code_wiki 专属)

code_wiki 的 splitter **由系统按目标类型固定,用户不可选/不可改**(与"生成内容 agent 拥有、只读"同源):

- 代码源 → 强制 AST/cAST。
- 生成 wiki 文档 → markdown 感知系统默认。
- `kb_type="code_wiki"` 门禁:系统按目标类型解析 splitter,UI 不给选、API 拒改。

## 6. 与一期的协同(值得当成目标而非副作用)

代码索引一旦具备,**wiki 生成本身可以用它来检索而不是通读全库** —— 二期会反过来降低一期的生成成本与幻觉率。这应写进二期目标,而不是当作意外收获。

## 7. 用户自定义内容(B)与纠错反馈(C)

**B — 用户自定义内容**(一期已埋 `origin`,故为纯加法):

1. 开放 API:在 code_wiki 下创建 `origin='user'` 的**顶层文件夹**及其内文档(子级继承 user);根 `index.md` 仍归 generated。
2. **投影侧零改动** —— 一期已把投影作用域限定在 `origin='generated'`。
3. 前端:同一棵树内按 `origin` 切换交互——user 子树可编辑(复用 notebook 的编辑原语),generated 子树只读。
4. 索引:user 文档即普通 `KnowledgeDocument`,照常进 RAG,与生成页一起被 Ask 检索。

**C — 纠错反馈回圈**(依赖 B 的归属原语):

1. 在 B 之上加 note → page 关联字段;note 本身是 `origin='user'` 的文档,故**扛过重生成**。
   - **靠关联而非物理放置**:note 存放在 user 顶层子树内,用关联字段指向生成页,UI 再把它展示在该页旁边。**不要**把 note 放进 generated 文件夹——那里会被 agent 重组/删除。
2. 重生成某页时,把该页关联的 notes 一并喂进生成 prompt,让 agent 采纳人类纠正。
3. 保持"生成是唯一真源":人不直接改生成页,只提供反馈。

## 8. 早期 spike(降风险,可与一期并行,不进一期交付)

验证整个投资的最大假设——**代码 RAG 的 Ask 在我们的栈/模型约束下能否达到 DeepWiki 级价值**——在大投入前止损。

- **方式**:派生一个测试分支,取一个有代表性的真实仓库,加一个 cAST/tree-sitter splitter,把代码嵌进**现有 hybrid 检索**,跑 Ask 评测。
- **廉价**:hybrid + 查询规划现成,只需临时 splitter + 一次性嵌入,不做产品化(不折叠、不 UI、不增量)。
- **评测**:准备一组真实问题(如"X 在哪实现""改 Y 影响什么"),人工判 Ask 回答是否捞到正确代码块 + 引用;注意避免 exact-match 泄漏式假高分。
- **产出决策**:效果好 → 一期完即 fast-follow 产品化;不佳 → 重估方向,避免按 DeepWiki-parity 重投。
- **不阻塞一期**。

## 9. Context7 借鉴(偏 Ask 质量)

① **服务端过滤、只回答案片段**(不倒原始 chunk,省 token);② **嵌入前 LLM 元数据增强**(强化版上下文头);③ `context7.json` 式**每仓库筛选/规则配置**;④ 可选 `llms.txt` 扁平索引入口。

不纳入其 5 指标排序 / 多嵌入模型 / 专有 ranking。
