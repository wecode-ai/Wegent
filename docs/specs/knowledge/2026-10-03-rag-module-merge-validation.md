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

## 后续来源同步（2026-10-03）

来源 `refactor/rag-remove-local-mode` 随后移除了 `8e25b7e215f084e34115d69e175f85b2f941bf21`，最新 HEAD 为 `b16227db87dbf5cb9f25f21932cb3429540381bd`。该提交仅修改 `executor/src/local/session.rs` 的原子计数实现及对应新增测试。

目标通过新增撤销提交同步代码，不重写已经推送的合并历史。Executor 文件与最新来源及 `wecode-ai/main` 完全一致；知识 Module／Adapter、授权引用、QA 和 RAG 合并适配保持不变。原提交仍属于历史，但其代码改动已完整撤销。

本次验证：`cargo fmt --check`、`cargo test --all-features --lib`（1454 通过、1 项既有忽略）、`cargo clippy --all-targets --all-features -- -D warnings` 均通过。未重复运行未受影响的知识测试，未运行 E2E 或 ai:verify。

## 最终验收（2026-10-03）

本节记录用户明确授权运行远程 E2E 后的新证据；前文“未运行 E2E”描述的是此前合并阶段，不代表本节的最终结果。

- 固定起点：`refactor/pure-knowledge-contracts`，HEAD `c1b320796d56bd185a5e7d3c46ff37ded1cca2e5`。
- 验收树：该 HEAD 加本节记录及两个 E2E 文件的未提交修复。未修改产品代码、未提交、未推送、未创建 PR、未合并或部署。
- 需求：`.scratch/open-source-knowledge-module/spec.md`、八张基础实施票及其引用的知识 Module 设计规格。
- 保留结论：Engine 与 Module 使用同一个 `finalize_index_result`，规则只有一份；重复调用仅为低优先级可选简化，不作为合并阻断，不修改 Engine 入口或适配链。

### 环境与执行入口

复用本地 `.scratch/open-source-knowledge-module/harness/remote-e2e.sh` 的 `infra`、`migrate`、`serve`、`run` 阶段。`run` 执行的是 GitHub CI 在 `.github/workflows/e2e-tests.yml` 注册的同一入口：

```bash
cd backend
uv run --no-sync python tests/e2e/knowledge_remote_index.py
```

本机新建隔离 MySQL、Redis、Qdrant、MinIO，独立端口为 13306、16379、16333、19000；Backend 与 Runtime 分别为 18000、18200。真实 Backend、Celery 索引 worker、转换 worker、数据库、对象存储和 Qdrant 参与执行；仅 Embedding 与 MinerU 文档解析模型使用已有确定性 HTTP mock。已有开发 MySQL/Redis 未改动。隔离数据库初始化至 Alembic head，未验证迁移回滚。

### 失败诊断与最小修复

1. 首次跨项目聚焦测试误用根 pytest 配置，6 个未标记的异步用例未被执行。显式使用已有 `knowledge_runtime/pyproject.toml` 的 `asyncio_mode=auto` 后，115 项完整通过；没有修改测试、跳过用例或放宽断言。
2. E2E 首次停在删除旧 local 模块的检查。源码已删除，工作区残留 `local_data_plane/__pycache__` 被 Python 识别为命名空间包。仅把这个已确认的旧缓存目录移至 `/tmp/wegent-final-stale-local-data-plane-c1b320796` 保留；不改断言、不改代码。
3. 环境清理后，管理场景报 `build_public_list_chunks_runtime_spec()` 不接受 `user_name`。删除 `knowledge_remote_index_support.py` 中唯一过期的 `user_name=None` 参数；不扩大产品签名。
4. 下一次完整执行到最后的查询故障场景时，首次索引失败文档尚未激活，Runtime 将有效范围裁剪为空并返回 200 空结果，无法用它触发模型故障。修正 `knowledge_remote_index.py` 的前置条件：保留首次索引失败与 processing error 检查；增加未激活文档空结果检查；复用现有模型更新 helper，真实索引成功一个同库兄弟文档后断开模型，再查询该文档。原 Runtime/Backend `>=500` 和错误 detail 断言保留，新增文档在 `finally` 清理。

每次重新执行均有已确认的环境或测试修复；没有以不变条件重跑获取通过，也没有跳过场景或用本地成功掩盖远端失败。

### 本次验证结果

| 范围 | 本次证据 |
| --- | --- |
| Module 配置、执行配置、文档、状态、查询操作、QA 规划及共享模型类别；Runtime 模型类别执行与 QA | 显式 `-c knowledge_runtime/pyproject.toml`，上述九个文件：115 通过。 |
| 执行核纯契约依赖边界、非 Wegent 调用方的 Module 执行 | `uv run --project knowledge_engine --no-sync pytest -c knowledge_engine/pyproject.toml knowledge_engine/tests/test_contract_import_boundary.py knowledge_engine/tests/test_knowledge_module_execution.py -q`：12 通过。 |
| Backend 授权、显式资源、普通文档远程索引、转换生命周期、资源解析和任务补偿 | 在 backend 下定向运行 `test_authorized_remote_query.py`、`test_explicit_retrieval_resources.py`、`test_plain_document_remote_index.py`、`test_conversion_lifecycle.py`、`test_retrieval_resource_resolver.py`、`test_resource_authorization.py`、`test_knowledge_tasks.py`：62 通过。 |
| 完整远程 E2E | 修复后的原 CI 入口退出码 0，输出 `Knowledge remote index E2E passed`。普通文档创建、正文更新与重建，转换后索引，重复/旧代次回调和 broker 任务，显式 Retriever/Embedding 生效及无权资源拒绝，列块、purge、drop，删除不影响兄弟文档、删除后的迟到任务不恢复引用，索引/转换/查询/管理/删除失败与恢复均通过。 |
| 空范围与多库 QA 的验证层次 | E2E 实际验证未激活失败文档的空有效范围。多库 QA 各自计划、有效范围裁剪、显式 hints 优先和 hybrid 权重保持由本次 Runtime 聚焦测试验证；未新增真实多库 QA HTTP E2E，不把该层测试描述为端到端证据。 |
| 格式与审查 | 两个修改的 E2E 文件 Black/isort 检查及 `git diff --check` 通过；本轮新增修复 Standards、Spec 均无问题。 |

本次聚焦集合共 189 项通过。完整成功日志：`/tmp/wegent-final-remote-e2e-active-scope.log`；首次缓存失败、过期参数失败及故障前置条件失败分别保留在 `/tmp/wegent-final-remote-e2e.log`、`/tmp/wegent-final-remote-e2e-after-cache.log`、`/tmp/wegent-final-remote-e2e-fixed.log`。Backend 聚焦日志为 `/tmp/wegent-final-backend-focused.log`；隔离迁移日志为 `/tmp/wegent-final-migrate.log`。不提交临时日志、凭据或服务会话文件。

### 限制与交付状态

- 已完成上述本机隔离环境的远程 E2E 与聚焦验证；本轮没有读取或触发远端 CI，不声称 CI 全绿。
- 原 E2E 的迟到任务在文档已删除后才投递，只证明任务拒绝执行、不恢复引用；实际已开始的索引写入晚于删除及其清理重试由本次任务聚焦测试验证，未新增真实并发迟到写入 E2E。不能把现有 E2E 的通过当作票 07 该并发场景的端到端证据。
- 未运行 `ai:verify`、真实模型/生产召回、生产部署或内部版接入。共享内部令牌的来源不可验证限制仍保持原规格接受的信任假设。
- 本轮测试服务在验收后停止，隔离容器停止并保留以便诊断；无关未跟踪文件保持原状。

## CI 登录修复与补丁交付（2026-10-04）

基线为 `f2640f8019f7fcca607654a75c6de95b11966e08`。PR 的知识 E2E 在登录阶段返回 HTTP 400：CI 为 bootstrap admin 和隔离测试账号生成不同密码；启动 Executor 时已用 bootstrap 密码初始化 `admin`，知识 E2E 却优先使用隔离账号密码。

本次仅修改测试：知识 E2E 的初始化和登录统一使用 `E2E_BOOTSTRAP_ADMIN_USER`（默认 `admin`）与 `E2E_BOOTSTRAP_ADMIN_PASSWORD`，缺失密码立即失败，不回退到隔离账号。同时交付前节已验证但尚未提交的两处补丁：移除列块 helper 的过期参数；查询故障场景先建立有效索引文档，保持空范围与远端失败断言。

验证证据：

- 新增 bootstrap 登录回归 3 项，覆盖两套凭据同时存在、初始化成功/已初始化两种响应和缺失 bootstrap 密码。原代码 3 项失败，修复后 3 项通过。
- 在真实隔离 Backend 中预先初始化 bootstrap 账号，同时设置不同的隔离账号密码，执行基线版本的 `_login`，复现 `login failed: 400`。未打印密码或访问令牌。
- 保持上述前置条件，复用原 CI 入口 `uv run --no-sync python tests/e2e/knowledge_remote_index.py` 完整执行，退出码 0，输出 `Knowledge remote index E2E passed`。日志为 `/tmp/wegent-bootstrap-paired-full-e2e.log`。
- 本次成功包含公开显式资源、普通文档创建/更新/重建、转换与旧代次回调、列块/purge/drop、删除与删除后迟到任务、远端失败及恢复；多库 QA 和真实并发迟到写入的证据限制仍按前节保留。

本节与前节涉及的测试补丁、登录回归和验收记录一起提交推送；产品代码、登录接口和无关未跟踪文件不变。远端 CI 以推送后结果为准，本地通过不等于 CI 全绿。
