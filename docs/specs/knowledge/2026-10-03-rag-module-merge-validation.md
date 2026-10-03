---
sidebar_position: 50
---

# 知识 Module 分支合并 RAG 本地模式移除

## 固定输入

- 工作区：`/Users/zhangyu21/Documents/github/Wegent`
- 目标：`refactor/pure-knowledge-contracts`，`aabc8b8cac4c2e2abcb8b4531730d18777143769`
- 来源：`sunnights/Wegent:refactor/rag-remove-local-mode`，`8e25b7e215f084e34115d69e175f85b2f941bf21`
- merge-base：`8fc1e1ba498eb5f0241b0247898e3519e8af3991`
- 来源：[PR #3767](https://github.com/wecode-ai/Wegent/pull/3767)。远端分支与 PR HEAD 一致。
- 合并前无已跟踪文件改动；未跟踪的修复脚本、规划、知识 Module 设计稿和研究文档均保留，不进入本次提交。

已读取双方根 AGENTS.md、Frontend/Wework 的作用域规则、目标 `.scratch/open-source-knowledge-module/spec.md`、其引用的设计规格和八张实施票。来源 `.scratch/rag-remove-local-mode/spec.md` 与 `issues/` 未存在于来源提交或当前工作区；本次以用户明确给出的八项行为契约、PR 正文和来源提交记录作为来源需求依据。不能声称已读到缺失的本地票据。

## 冲突决策

真正执行 `git merge --no-commit --no-ff`，保留两侧历史，32 个文件产生文本或修改/删除冲突。按双方行为意图处理，不整体选取任一侧。

| 冲突 | 最终决策 |
| --- | --- |
| Backend local 与目标新增授权 | 删除 local 网关、数据面、RetrievalService 和旧配置构造工具；授权预检保留。 |
| RuntimeSpec / Remote 协议 | 保留授权资源引用、显式选择和操作绑定；移除完整执行配置字段及对应构造调用，不恢复已删除类型。 |
| 内部检索身份 | 顶层 `user_id`、`restricted_mode` 生效；持久化上下文只含 `user_subtask_id`，任务身份由该引用解析。 |
| 配置解析 | Backend 判断调用者知识访问和 owner 资源使用；Runtime Adapter 读取授权记录和密钥，Module 唯一组合执行配置。 |
| QA | Adapter 查询活动文档最小 QA 元数据和有效范围；Module 持有通用查询规划。显式 hints 优先，不自动改变模式或注入 QA 权重。 |
| 重依赖 | 执行依赖通过 retrieval extra 供 Runtime 使用，Backend 保持无执行重依赖；五个锁文件由最终声明重新生成。 |
| 测试入口 | 本地执行 mock 改为禁止导入旧执行模块的守卫；跨进程 QA/删除入口传递真实授权引用；保持原失败断言。 |

## 必要适配

1. 在直接注入被拒转为远程查询时重新取得授权引用，内部入口保留任务读取语义，MCP 在线程拥有的 Session 中完成预检。
2. 恢复自动文本合并丢失的公开 Retriever/Embedding 显式参数；运行时不替换成知识库保存引用。
3. QA 按每个知识库独立规划，并把活动文档范围带到 Module 的查询目标；空有效集合不创建存储执行器、不执行整库查询。
4. 覆盖只替换明确传入的合法字段；未覆盖的已保存 hybrid 权重继续有效，QA 只影响提示。
5. 删除 Code Wiki 清理规格构造时的吞错路径；构造失败、远程异常或失败状态均先失败并保留记录。即使文档行已为空，仍在删除知识库配置前清索引。
6. 合并目标的旧索引先删后建与失败停止契约；清理和索引复用同一远程网关。
7. 调整原有 CI 覆盖的远程 E2E 检查入口，验证旧模块和模式开关不存在。本轮未执行 E2E。
8. 将授权单元测试拆成单独文件，使 resolver 测试文件保持在 1000 行以下。
9. Standards 发现删除旧服务后丢失检索主入口 tracing，已用现有 `trace_async` 补齐两处 span；对应内部入口/MCP 并发用例 56 通过。
10. Spec 发现 QA 计划选择仍在 Runtime，已移入 Module 公开 `plan_query`。Runtime 只转换计划记录，执行内核直接使用 Module，不保留旧规划转发文件。独立第二调用方在禁止产品 ORM、Runtime 和执行内核导入的进程中验证同一规则。QA 规划增量验证：Module 5、Runtime 21、执行内核 17 通过。

## 验证记录

所有 Python 命令通过 `uv run` 执行。日志在本机 `/tmp/wegent-*.log`；这些临时日志不进入仓库。先修复失败再定向验证，不跳过测试或放宽授权/依赖守卫。

| 范围 | 验证证据 |
| --- | --- |
| Module 配置、文档、状态、范围及纯协议 | shared 六个知识测试文件：100 通过；新增纯 Module QA 规划与第二调用方用例：5 通过。 |
| Runtime 配置、索引、管理、查询、鉴权及 QA | 首轮 128 通过、20 失败；完成入口适配后，受影响文件 45 通过、3 失败；剩余 3 个问题修复后对应部署/范围/权重用例 7 通过。分阶段覆盖全部 148 个 Runtime 用例，不宣称重复运行的全量绿灯。 |
| 执行内核 | 纯契约/能力依赖边界、查询规划、查询执行和存储工厂：22 通过。 |
| Chat Shell | scope、两组注入策略、文档读取：77 通过。 |
| Converter | 指标回调：18 通过。 |
| MCP、内部 scope、知识管理及 Backend 依赖 | 首轮 92 通过、10 失败；调整最终入口及单测授权前置条件后，失败所在两个文件 19 通过。 |
| 跨进程 QA、Code Wiki 删除 | 4 通过；新增授权失败/空文档失败保留记录及拆分授权测试：9 通过。 |
| 最终 Backend 定向集合 | 277 通过（当前合并结果），覆盖远程三路径、显式引用、授权、生命周期、QA、检索器探测与执行依赖边界。 |

Backend 已按最终锁文件同步环境，卸载 30 个执行相关包。依赖检查同时验证声明、锁文件、实际安装和阻断执行重依赖时的应用导入。QA 规划导入路径收口后，再次定向验证 Backend 执行依赖边界：4 通过。格式化、未定义名称/无效重复绑定检查和 Git diff 空白检查均通过。合并前后的未跟踪文件清单一致。

## 审查及限制

提交前按 code-review 对固定目标 SHA 到合并暂存结果分别进行 Standards 和 Spec 审查。首轮两轴各发现 1 项 P2：主入口 tracing、QA 计划选择归属，均已修复；固定树 `de949f0cbdf64fd3d8c7c332ac8c70af9300a85f` 复审确认两项完整解决；Standards 和 Spec 均为 0 项未解决。

- 未运行 E2E、ai:verify、真实容器、MySQL 部署或生产召回验证；单元与跨进程 SQLite 验证不能替代这些证据。
- 共享内部令牌仍只证明持有令牌，不能验证授权引用一定来自 Backend；保持目标规格接受的内网信任假设。
- [来源桌面构建失败日志](https://github.com/wecode-ai/Wegent/actions/runs/37099123443/job/111135063804)仍为等待 `.ci-artifacts/wegent-executor` 420 秒超时；属于用户已接受的 fork PR 产物交接例外，不修复、不重跑、不声称 CI 全绿。
- 本轮不推送、不合并 GitHub PR、不部署。
