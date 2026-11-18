---
sidebar_position: 2
---

# 验证方案与回滚

单元测试使用隔离的 React/jsdom 和可持久化的接口夹具，不修改用户项目。

| 场景         | 前置条件与步骤                                     | 预期结果                                                                            |
| ------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 普通云端创建 | 当前用户 1，搜索返回 1、2、3；选择 2、3 后创建     | 不可重复选择 1；2、3 写入 Developer；重读服务端成员与项目快照，立即显示确认成员名称 |
| 部分成员失败 | 2 添加成功，3 返回权限错误；修复权限后重试         | 显示 3 与原因，草稿和选择保留，仍只有一个项目，仅重试 3                             |
| 搜索失败     | 选择两人，下一次查询失败，再点击重试               | 错误可恢复，已选成员和项目草稿不变                                                  |
| 服务端确认   | add 返回成功但名单没有成员；或添加已落库但响应丢失 | 前者不能误报成功；后者以重读名单为准，不重复添加                                    |
| 协作模板     | 选择成员、智能体、设备与多个小组；成员失败后重试   | 成员验证通过后才进入原有模板配置链，保留多小组、执行环境、智能体及更新后的项目结果  |
| 本地项目     | 切换本地位置，宿主仅提供云端目录                   | 隐藏云端成员选择，并解释限制                                                        |
| 开关关闭     | 构建配置为 false，再打开普通创建入口               | 返回创建后管理成员的原有流程；不删除任何已有成员关系                                |

`collab.projectCreateMembers.v1` 对应 Wework 的 Vite 构建设置 `VITE_COLLAB_PROJECT_CREATE_MEMBERS_V1`，默认启用。在 Wework 构建环境（例如 `wework/.env.local`）设置为 `false` 并重新构建即可关闭普通入口能力；该配置方式兼容 Windows、macOS 和 Linux。协作平台原有资源能力不受此回滚开关影响。

E2E 覆盖加入现有 `collaboration-shared-core` checkpoint，通过原有 Core CI shard 执行。它创建两个测试账号，验证真实成员搜索、Developer 持久化、成员列表和重载后仍存在。按根目录 `AGENTS.md` 的测试执行策略，本地未运行 E2E 或 `ai:verify`；这不替代 GitHub CI 的真实桌面验证结果。

普通任务页的看板实际由 `DesktopWorkbenchLayout` 挂载 `TaskBoardView`，项目页另行以 `embedded=true` 挂载 `CloudTodoWorkspace`。普通任务页现通过标题栏“更多 → 新建项目空间”打开共享创建对话框，项目页的更多菜单和无项目空态也能创建；这些入口共用 `ProjectSpaceCreateDialog` 宿主适配及同一资源配置工厂。侧栏“新建项目 → 云端项目”仍用于远程代码工作区。

## 初始基准已执行检查

以下记录基于 `a451b8183`，保留首次复现和验证事实。PR 集成最新主线后的检查另行记录。

- `pnpm --filter @wegent/collaboration build`：通过。
- `pnpm --filter wework typecheck`：通过。
- 共享对话框、controller 相关的 8 项聚焦测试：通过。
- 协作平台、成员持久化、模板配置器的 133 项测试，以及随后新增的目录恢复测试：通过。
- 普通入口的两人成员持久化、失败成员重试、本地隐藏与开关关闭测试：通过；共享 API 适配器测试通过。
- 变更文件格式及差异空白检查：通过。Wework ESLint 无错误，有 4 项既有 hook 警告；共享平台按同一规则检查发现的 5 项问题均已与 HEAD 对照，属于既有问题。
- 三文件并行验证出现既有人工任务回复用例的 5 秒超时。阶段诊断没有发现接口断言失败；独立运行时回复流程完成于 0.56–2.59 秒，完整并行运行的总耗时明显放大。测试准备改为预选项目并复用一个 userEvent 实例，保留全部断言及 5 秒限时。随后按本机资源约束使用单 worker 执行同样三个文件，133 项全部通过，总耗时 26.09 秒；不把此前并行运行记为通过。

完整普通入口与适配器验证命令：

```text
pnpm --filter wework test src/features/todo/CloudTodoWorkspace.test.tsx src/features/collaboration/createProjectResourceSetup.test.ts src/features/collaboration/weworkSharedWorkspaceApi.test.ts --maxWorkers=1
```

## 最新主线集成验证

已整合 `c2fdb7266`。主线已有的人员选择器、`searchUsers`、模板预校验、多小组草稿、智能体物化、执行环境和模板看板流程继续复用；成员失败在任何模板资源写入之前停止，重试同一项目。其他资源失败沿用主线的“打开已创建项目”流程。

- 共享创建目录与完整协作平台：10 个文件、211 项测试通过，20.29 秒。
- 普通入口、资源工厂和共享 API 适配器：3 个文件、86 项测试通过，14.92 秒。
- 共享包构建、Wework TypeScript 检查通过；Wework 完整 lint 通过，0 个错误、4 个既有警告。
- 双语导航及文档打包契约：7 项测试通过。
- E2E 文件语法和 ESLint 检查通过；本地未执行 E2E 或真实 Electron 验证。

最初同时执行完整 lint、两个类型检查和两个 jsdom 套件时，5 个用例触发 5 秒超时，另有人员搜索错误缺少本地化前缀。前缀已修复并保留后端原因。对普通入口超时用例加入临时 Profiler 和请求计数后，3 条完整交互分别在 109、133、123 毫秒完成，每项仅读取项目和看板各一次；没有观测到循环加载。诊断代码随后移除。按同一原有超时和断言串行执行上述两个完整套件，297 项全部通过；此前并行失败不记为通过，也没有提高超时或跳过测试。

完整推送前检查通过，包含两分片的全量桌面 renderer 单元测试。首轮 CI 发现导航脚本的两种布局夹具没有传入新增 `members` 参数，稳定复现为 `members is not iterable`；补齐真实调用契约中的成员、名单、重载就绪与导航断言后，4 项脚本测试通过。

进一步复核发现：普通项目会继承分组 Viewer；只按用户 ID 判断已加入会错误跳过所选 Viewer。实际 helper 两次复现未调用添加且返回 Viewer 成功，新增回归修复前 3 项失败。现通过既有项目成员 API 授予所选 Viewer 项目 Developer，保留分组角色及已有更高项目角色；回读角色未达到 Developer 时仍报告失败，重试仅处理缺失或权限不足成员。helper 的 11 项测试全部通过，未修改权限不变量或后端契约；随后共享创建目录与完整协作平台的 215 项测试通过。

首轮 Web CI 的两个创建流程稳定报出高级设置按钮被 footer 遮挡，桌面 CI 的成员搜索框也落在视口外。恢复原有 div 滚动容器，将原生 disabled fieldset 放入其中并使用 display: contents，保留锁定行为。现有 Dialog 的 4 项测试通过。内置浏览器的 300×150 诊断视口中，旧结构 scrollIntoView 后整体容器移到 y=-621.5，内部 scrollTop 仍为 0；修复后容器保持 y=55.5，内部 scrollTop=649，目标按钮命中正确。该小视口诊断未复现 CI 的 footer 拦截，完整 Web/桌面流程以新一轮 CI 为准。

第二轮 CI（63ba3178）：单元测试、lint 和完整 Platform E2E 均通过，包含此前失败的两个 Web 分片。桌面 Core shard 10 再次确认首次打开成员菜单后搜索框 y=722.7，位于视口外，尚未进入成员选择断言。真实 Radix、ProjectPeoplePicker 与 base.css 的最小浏览器诊断稳定复现：891×741 视口、触发器 bottom=729 时，禁用碰撞检测使菜单 y=735、搜索框 y=778.25；恢复默认碰撞检测并设置 8px 边距后，菜单自动上翻到 y=570.5，搜索框 y=613.75，命中 INPUT 且实际选择成员成功。修复保留同一组件和交互断言，未增加等待时间或跳过场景；现有 Dialog 4 项测试通过。

第三轮 CI（c8030529）：完整 Platform E2E 再次通过。桌面协作流程已通过创建、两名成员 Developer 及 direct_role 回读，随后在 renderer 刚重连、固定协作标签尚未挂载时立即点击而失败。导航夹具稳定复现两个布局失败；改用现有 clickWhenEnabled 并要求 visible，等待真实标签就绪后再激活，默认等待时限及全部成员断言保持不变，4 项测试通过。

同轮 Cloud shard 5 的既有 task-model-deletion 场景发现独立缺陷：删除本地模型并刷新目录后，store 已判为不可用，但任务缓存仍使 selectionReady 为 true。真实 model store 与任务选择 hook 集成测试稳定复现；现在成功刷新目录时清除已删除的本地模型缓存，当前和后台任务均停止发送，保留改选入口。请求开始后新选的模型和单独验证的隐藏云模型继续有效。4 个相关文件的 48 项模型测试通过，未修改该 E2E 的断言、等待时限或场景。

随后合入主线 06f2cbee8 并解决创建链与双语导航冲突：复用新的 ProjectCollaboratorPicker，删除已被主线替代的 ProjectPeoplePicker，保留搜索失败原因与重试、同项目成员恢复，以及模板和手动协作者合并；模型与设备保持主线的可选契约。共享创建目录与完整平台 217 项、11 文件测试通过，普通入口/资源工厂/API/任务模型 117 项测试通过，模型 readiness 与 diagnostics 另 26 项通过；共享构建及 Wework typecheck 通过，双语文档和 reload 导航 11 项通过。

同轮 Core shard 4 的 runtime-task-queue 未在断言时限内观察到第二个 StandIn 模型请求。官方 executor artifact 显示前一原生 turn 于 10:45:43 完成，第二轮 10:45:53 开始 spawning、10:46:02 才进入 thread/start；同期独立读取请求也耗时约 7–11 秒，尚不足以确认具体堵点。增加仅对超过 250ms 的阶段记录 phase/task_id/elapsed_ms 的诊断，覆盖原生完成、observer、队列释放与下轮准备；没有修改调度逻辑、E2E 断言或等待时限，也不将此次诊断记为根因修复。

该诊断版本已完成 Executor Rust test profile 编译，并用生成的同一测试二进制执行分类并发 7 项和原生生命周期 42 项测试，49 项全部通过；Rustfmt 检查通过。初始 Cargo 测试过滤器未匹配模块，未将其 0 项结果计为测试通过。Wework 完整 lint 通过，0 错误、4 项既有警告。

## 2026-11-17 主线整合与评审复核

此前提交 `d94034bdb` 的 GitHub CI 全部通过，包括 [Wework E2E](https://github.com/wecode-ai/Wegent/actions/runs/43870839548) 和 [Platform / Executor E2E](https://github.com/wecode-ai/Wegent/actions/runs/43870839588)。实际 `collaboration-shared-core`、`task-model-deletion`、`runtime-task-queue` 检查点均通过。并发队列此次从第一轮完成事件到下一轮 Codex turn RPC 为 582ms，旧延迟没有复现，根因仍未确认。

主线更新后 PR 再次出现冲突。本次整合 `cbacc633a`，中文导航保留主线新增入口与本项普通项目成员选择说明；自动合并的 Codex provider 切换逻辑和耗时诊断均保留。

评审意见先以组件或集成测试复核，确认并修复了以下路径：

- 对话框先打开本地项目，再切到云端时，资源配置刚变为可用但模型目录未请求。现在按有效资源作用域加载，普通重新渲染或语言切换不丢失生成模型选择。
- 智能体或小组请求失败、持续等待时，原 `Promise.all` 丢失成功的成员目录。现在独立发布结果，对应标签显示各自错误并复用重试入口。
- 切换分组后的新成员请求仍在等待时，原目录可能仍显示。现在成员结果绑定分组 ID，不展示前一分组目录。
- 未选择额外成员时，原配置器仍强制读取名单与刷新看板。现在使用原有创建成功链；新项目看板加载失败继续显示看板错误，项目只创建一次且创建弹窗正常关闭。
- 后台任务在模型目录请求期间编辑选项会自动恢复旧模型，被错误视为新的显式选择。新增集成用例先稳定失败；现在按显式模型选择版本区分恢复与改选，删除模型不能发送，保留选项并允许改选恢复。

共享创建、模板与完整协作平台 22 文件、301 项测试通过；普通入口与资源工厂 2 文件、71 项完整回归通过，随后新增的看板失败负路径 1 项单独通过；模型相关 4 文件、49 项测试通过。共享包构建、Wework typecheck、完整 lint 通过（0 错误、4 项既有警告），双语文档契约 8 项通过；Prettier、Rustfmt 与差异检查通过。未提高超时、跳过断言或修改 E2E 行为。本次最新提交的 CI 以 PR 对应 head 的检查为准，不沿用旧提交结论。

随后 `77b542644` 的全部 GitHub CI 再次通过（60 项通过、0 失败或待定），三个实际桌面检查点均通过。新评审提示的资源重载边界又获得稳定复现：已选 workspace/personal 智能体后重试人员目录，其他资源请求仍在等待时提交，会创建项目却不绑定智能体。现在同一 API、账户及分组作用域重载保留有效目录快照，切换作用域立即隔离旧数据；新目录确认已选智能体不存在时，创建前明确报错，失效项可见且可取消，名称、说明和其他选择保留，合法模板智能体不受影响。

新测试同时确认：成员已经以 Developer 保存后，看板读取失败仍曾阻止成功回调。现在项目快照读取使用原有页面错误报告路径，不再把看板错误包装为成员配置失败；保留名单回读及成功成员提示。无成员和有成员两条看板失败路径均覆盖。此轮完整 Platform 与 Dialog 共 193 项、普通入口与工厂共 73 项测试通过；共享构建、Wework typecheck、格式检查及针对性 lint 通过，未新增 lint 问题。新增目录 mock 补齐了 `defaultSelection: null`。最新提交仍须取得其自身的 CI 结果。

对 `25250db76` 的补充评审获得另一条稳定复现：协作平台入口未选额外成员，只选智能体与当前设备时，项目成员名单接口失败仍阻断资源配置，项目创建一次但智能体未绑定。平台现在与普通入口一致，仅在选择了当前用户之外的成员时调用成员配置器；保留配置器完整名单回读及错误契约。新用例验证智能体与设备均正常配置、成员 API 不被调用且创建弹窗关闭；原模板用例补强为成员 API 不可用仍可完成无成员模板创建。相关平台 7 项与原成员配置器 11 项测试全部通过，真实所选成员的失败、持久化校验与同项目重试断言保持。最终 CI 仍以包含此修复的新 head 为准。

## 2026-11-17 再次主线整合

`efd030cab` 的全部 CI 已通过：59 项成功、16 项按规则跳过，三个实际桌面检查点均 PASS；随后主线更新使 PR 再次产生冲突。本轮合入 `976cdf938`，保留主线拆分后的创建表单、模板配置、草稿保护和键盘交互，将成员持久化、同项目失败重试、独立目录错误及失效智能体取消迁入共享结构。主线原 `ProjectCreateDialog.test.tsx` 保持原样，本项成员用例移入 `ProjectCreateDialog.members.test.tsx`，保留双方断言。

生成模型目录沿用主线按需加载 hook，并按项目位置、当前用户及分组隔离请求。新增两项测试先稳定复现切换后保留旧目录、未读取新目录，以及旧请求覆盖新目录的问题；修复后通过，保留同作用域模型选项和按需加载行为。

共享桌面场景同时保留主线创建窗口与私有项目验证、本项两人成员选择与服务端 Developer/direct_role 回读。窗口交互验证会关闭并重开草稿，因此在成员选择之前执行。成员选择脚本仍等待旧的空结果文案；新的协议单元测试稳定复现两项失败，实际请求文本为“暂无其他可添加项”，当前组件契约为“没有匹配项，请换个关键词或切换类别。”。现只同步该等待文案，保留原选择器、250ms 稳定窗口、当前用户去重和成员持久化断言；完整导航协议 6 项通过。

本地验证：共享创建与模板 32 文件、237 项，完整平台 196 项，普通入口与资源工厂 73 项，双语文档契约 8 项全部通过。共享构建、Wework typecheck、完整 lint（0 错误、4 项既有警告）、按目标文件原风格的格式检查及差异检查通过。未执行本地 E2E 或 ai:verify，未放宽断言或等待时限；包含本轮整合的新 head 必须取得自身的全部 CI 结果后再交 QA。

整合提交 `126016bbf` 推送期间，主线新增异步生命周期 Hook 与取消发送改动。`git merge-tree` 确认与 `99963cc43` 在 `executor/src/runtime_work/handler/turns.rs` 存在真实冲突。本轮继续合入该主线：保留原阶段诊断，在校验后、能力准备前启动 lifecycle，observer drain 后完成 hooks，保持主线取消与失败状态分支，未持锁跨 `await`。

Rust 验证通过：`runtime_work::handler::turns::tests` 17 项、`runtime_work::handler::hooks::tests` 1 项、`hooks::lifecycle::tests` 2 项；均使用 locked、all-features 的既有 lib 测试。Rustfmt 与差异检查通过。新主线整合后 Wework typecheck、双语文档契约 8 项再次通过。后续交接只采用最终新 head 的完整 CI 与可合并状态，不沿用 `126016bbf` 因冲突尚未启动的桌面检查。

随后主线进入 `4702fff1`（项目设置与智能体配置维护），再次通过 `git merge-tree` 确认共享桌面场景存在导入及调用冲突。合并保留主线 `verifyCollaborationSettingsUx`，也保留本项 `selectProjectCreateMembers` 与传给成员验证器的真实所选成员，不删除任何一侧场景。自动合并的 Platform 仅增加设置页渲染器透传及分组 scope，创建核心源码未变。完整 Platform/App 15 文件、345 项、普通入口与工厂 73 项、导航协议 6 项、文档契约 8 项通过；共享构建、Wework typecheck、场景格式及差异检查通过。最终 CI 必须属于包含这次整合的新 head。

## 2026-11-17 事件唤醒主线冲突整合

`5c28e7639` 的全部 CI 已通过（59 项成功、16 项按规则跳过，0 失败或等待），三个实际桌面检查点均 PASS。随后主线再次推进；本轮 `git merge-tree` 对 `05a6ce6c1` 稳定确认仅 `executor/src/runtime_work/handler/turns.rs` 存在冲突。

整合沿用主线事件 Goal 与自动输入准入，把 lifecycle 初始化留在原生 turn started 回调，删除旧的提前初始化。observer drain 在自动输入延后判断之前执行且只等待一次，原耗时诊断包裹同一个 await；不修改调度、断言或等待时限。共享创建核心源码相对前一提交未变，普通入口自动合并保留成员资源配置与主线新的任务绑定和事件唤醒逻辑。

本轮共享创建与模板 32 文件、240 项，普通入口、资源工厂与任务模型集成 3 文件、77 项，导航协议 6 项，双语文档契约 8 项全部通过；共享包构建、Wework typecheck、完整 lint（0 错误、5 项既有或主线带入的警告）及差异检查通过。文档检查首次误带 Vitest worker 参数，触发非目标 renderer 收集，已中止且不计为验证结果；移除不适用于 Node 测试的参数后，仅执行所列文档检查并通过。本地未执行 E2E 或 ai:verify，最终新 head 必须取得自身的全部 CI 与可合并结果后再交接。

冲突整合后的 Rust focused lib 测试共 20 项通过：turns 17 项、handler hooks 1 项、hooks lifecycle 2 项；沿用 locked、all-features 与既有共享临时 target，Rustfmt 检查通过。没有修改任何 Rust 测试或新增重跑逻辑。

本轮 `e21c1c0c8` 的桌面 Core shard 7 在 `change-request-status` 检查点等待“已合并”超时，其他独立检查通过。官方 job `133995168162` 与 artifact `14322429103` 显示：重新激活 observer 到 11:21:50.570 才完成，随后强制刷新到 11:21:59.111 完成；原断言于 11:21:58.263 超时。`failure-followup.json` 记录 `outcome=settled-after-failure`、`settledAfterFailureMs=1168`，后续界面已显示“已合并”。因此没有证据表明合并解析或产品恢复失败，实际失败窗口包含首次激活的剩余工作及下一次采集。

真实 provider/collection 协议验证依次执行成功、CLI 不可用、重新发现失败及恢复后 MERGED，共 18 次操作通过。新增受控 deferred 回归证明：初次激活尚未完成时，旧场景准备条件已经返回 `prematurely-ready`；修复后等待现有状态弹层显示“状态同步正常”才进入下一次状态变更。恢复 CLI 后先确认重新启用的 observer 启动成功并完成同步，再写入 merged、触发新刷新；原 merged、checks、同步健康断言和等待时限全部保留。另一项真实 monitor 回归确认激活期间发起强制刷新会在激活后继续新采集并取得 merged，没有丢失请求。

相关 EnvironmentInfoPopover、monitor、visibility、UI observer 共 4 文件、35 项测试通过；Wework typecheck、目标 ESLint、Prettier 与差异检查通过。产品行为未修改，没有本地执行 E2E、固定 sleep、放大超时、跳过断言或原提交 CI 重跑。完整桌面结果仍等待包含此次准备修复的新 head。

## 2026-11-17 最新 QA 与 PR 评审修复

最新评论 3196 的 MAN-08 未通过：任务已使用 B，明确改选 C 但尚未发送，删除 C 后自动恢复 B 并允许发送。前台和后台真实 model store / task-selection hook 集成测试均稳定复现，修复前得到 B 与 `selectionReady: true`。现在分别保存选择身份和可用状态；失效的 C 保留为用户当前选择并阻止发送，只有显式改选有效模型或 C 确实恢复才恢复可发送。选项编辑、重复目录刷新、切换任务以及刷新途中新改选均有回归覆盖，隐藏云模型继续使用原有独立验证路径。

模型 worker 完成 6 文件、94 项验证，随后把刷新中改选案例扩为前台和后台两项，对应两文件 28 项通过。主执行另行验证 model readiness、diagnostics、任务选择、runtime controls 及任务 hooks 共 6 文件、66 项通过。完整 lint 发现 render 直接读取新 ref 的规则错误后，改为统一发布同一不可变 availability 快照给 render state 和即时事件 ref；三个直接受影响文件 34 项与目标 ESLint 通过。现有 CI 的 `task-model-deletion` 检查点已补充真实设置页创建、改选但不发送、删除 C、持续禁止发送及显式改选 B 后继续原任务的覆盖；保留原五次发送及全部断言，本地未运行 E2E。

同一 PR 的静态评审还指出原需求中的实际入口、目录刷新、失败恢复和并发角色问题。目录缩小后旧候选继续存在，已由新增组件测试复现；选择器现在只使用最新目录，已选人员的显示信息单独保留，取消后不会再次成为旧候选。30 条失败原因和已确认成员列表移到既有滚动正文，页脚保留短摘要与重试、取消；使用单一可访问错误区域关联摘要，保留原 Platform 错误原因断言。这里的组件检查只证明 DOM 与既有 CSS 的滚动边界，不替代真实短窗口的几何验收。

修复后的完整共享 Platform/App 测试 197 项通过（39.04 秒），共享创建与模板 32 文件、243 项通过；后续错误区域调整另由 5 个聚焦文件、45 项通过，并保留原平台失败原因断言。真实任务页入口在 1120/320 两种窗口宽度的宿主测试先因缺少入口失败，补齐后通过；普通入口、TaskBoardView 与 helper 完整回归共 109 项通过。最终入口、deferred 服务端名单确认、导航后提示与同项目重试共 37 项通过，最后英文与移动入口相关 10 项通过，双语文档契约 8 项通过。两入口 E2E 复用原有账号与成员设置 reload，不新增 CI job，预计增加 10–15 秒；真实结果须由新 head CI 确认。

创建成员的延迟请求曾在读取 Viewer 后覆盖并发提升的 Maintainer，helper 回归已稳定失败。真实 API 交错用例进一步确认：先通过 PATCH 晋升为 Maintainer，再提交延迟的 Developer POST；旧写入在 inherited/direct Viewer 两种前提均返回 201 却降为 Developer。创建链现显式请求至少 Developer，普通管理请求保留精确角色及降权语义；同一参数通过共享 API、Web 与 Wework 适配器传递。服务端仍使用现有 Python-owned 成员写入 API，不迁移路由，不修改 CP 权限不变量。修复后角色覆盖、CP 契约及 guard 共 95 项通过（38.54 秒）；helper 12 项、Wework 传输与适配器 36 项、Web 适配器 14 项通过。MySQL RR 陈旧快照回归加入既有 CI 套件，本地未设置专用 URL，未计为本地通过。后续交接须采用包含本轮修复的新 head CI，不能沿用 `0a691d1f0c` 的绿色结论。

本轮随后自动整合主线 `ea5eca2558`，无内容冲突。main 的 Issue 邀请权限、项目 Viewer 与执行限制断言，以及中英导航和 locale 更新均保留；本项的 API、成员提示和实际任务入口也完整保留。整合后共享创建、模板及完整 Platform/App 共 33 文件、445 项通过（43.79 秒），后端同一 API/CP/guard 命令 95 项通过（56.92 秒）；文档 8 项、导航与成员 helper 协议 10 项通过。真实任务页宿主的两种宽度、英文入口、等待名单确认及同项目重试共 5 项再次通过（16.46 秒）。共享构建、Wework typecheck 和完整 lint 通过，lint 为 0 错误、5 项既有警告；Black、isort 与相对主线的差异检查通过。

推送后主线推进到 `2a7319fef7`，GitHub 与 `git merge-tree` 均确认 `executor/src/runtime_work/handler/turns.rs` 有新冲突。第二次整合保留 main 的 `result_received`、observer 成功/失败和 `local_result_settled` 清理日志，把原耗时诊断包在同一次 observer await 及结果处理外；原生生命周期、事件 Goal、自动输入和异步问题顺序保持 main。Rust 聚焦回归共 28 项通过：turns 17、主线新增异步问题投递 8、handler hooks 1、hooks lifecycle 2；复用既有 target，Rustfmt 与差异检查通过。

模型自动合并同时保留 main 的默认选择与本地目录失效刷新，以及 MAN-08 的显式选择身份和可用性。三个 hook 与 modelCatalog 全套共 4 文件、53 项通过，hybrid 三项来源快照案例通过，目标五文件 ESLint 和 Wework typecheck 通过；双语文档 8 项与导航/helper 10 项通过。独立 Electron 包在本地未安装完整测试依赖，宿主 model-runtime-request 套件未成功收集，未计为通过；该路径的真实桌面结果和既有单元 CI 结果仍须核对新 head。本地未运行 E2E 或 ai:verify。

## 2026-11-18 完整 CI 复核与真实宿主修复

`a19640887c` 的七个工作流已全部结束，六个成功，Wework E2E 失败；汇总为 61 项成功、10 项按规则跳过、4 项失败，其中包含三个实际失败及一个失败汇总。该提交仍为 MERGEABLE，不能把部分通过记为全绿或交回 QA。

本轮 [Backend API](https://github.com/wecode-ai/Wegent/actions/runs/44120262134/job/134169562572) 实际执行并通过并发角色、精确降级和 CP 权限用例，全套为 12,911 passed、1 skipped、3 subtests。[MySQL 回归](https://github.com/wecode-ai/Wegent/actions/runs/44120262134/job/134169562519) 的 22 项全部通过，包括旧 RR 快照后观察到并发角色晋升的新增用例。MySQL 与宿主单元 CI 使用 PR merge commit `c993b43967`，其 tree 与 `a19640887c` 相同；宿主 `model-runtime-request.test.ts` 实际收集并通过 17 项，不再只依赖本地未成功收集的结果。`runtime-task-queue` 在实际 Core6、`change-request-status` 在实际 Core8 均 PASS，不能沿用旧分片号。

[Plugins 失败日志](https://github.com/wecode-ai/Wegent/actions/runs/44120261011/job/134174499529) 确认已枚举的窗口 `4194314` 查询标题时返回同资源 ID 的 `BadWindow / X_GetProperty`。artifact 确认处于 `core-dsh-ui-plugin-composition`，错误发生于清理终止前；没有证据确认该窗口的具体销毁原因。协议用例稳定复现旧的 `Promise.all` 会因一个已销毁窗口终止查找，即使同批存在真实确认窗。现在仅忽略同一窗口的该原生错误，继续在原 PID 和标题范围内寻找确认窗；其他错误、取消、双确认窗拒绝及 12 秒总截止保持。新增用例先 2 失败、15 通过，修复后该完整协议套件 20 项通过，主执行复核为 601 毫秒。

[Core10 失败日志](https://github.com/wecode-ai/Wegent/actions/runs/44120261011/job/134174499658) 与 artifact 证明 Tasks 看板五列及真实控件已显示，但测试等待 `display: contents` 包装层自身可见，其尺寸恒为零。进一步复核发现真实 App 关闭了 ChromeTitlebar 的 workspace portal，而看板又隐藏了原对话主区的 portal 宿主；原入口组件只向不存在的宿主投递，因此 More 实际没有挂载。移除测试中人为创建的 portal，使用真实 ChromeTitlebar(false) 与 Layout 后，1120/320 宽度两例稳定失败。现在通过显式 `toolbarAction` 复用看板现有动作区，删除失效 portal 路径；创建状态、共享对话框、成员确认及导航后提示生命周期保留。E2E 改等同一固定 Tasks 标签、同一看板内真实分组按钮可见，后续两成员、Developer/direct_role、立即提示与刷新断言保持。入口相关 6 项、Action 与 TaskBoardView 完整 10 项、导航协议 10 项、双语文档 8 项通过；Wework typecheck 和完整 lint 通过，0 错误、5 项既有警告。

[Cloud5 失败日志](https://github.com/wecode-ai/Wegent/actions/runs/44120261011/job/134174499922) 停在新 C 首次选择，尚未删除 C。设置页已保存 C，但随后完整 native catalog 刷新及 composer 均只有原有 21 项，没有 C；这不是滚动定位问题。旧日志没有记录 restart 返回值、任务及后台终端计数或 catalogReady，不能确认此次未就绪的具体 native gate。真实 modelApi、provider 投影与 reconciler 的四个协议用例确认：已有 B 就绪、新 C 已保存时，原生任务或后台终端导致安全重启延后，可以合法返回只有 B；下次 owner 请求在空闲或模型已加载后才发布 B 与 C。该合同测试不是对 CI 具体原因的复现。

MAN-08 的前提现在明确为两个模型均已真实就绪：C 在项目创建和首次任务发送前通过真实设置页创建，并调用既有 native catalog 就绪检查。第五次发送后才首次改选 C，不发送即删除、禁止回退和发送、显式选 B 后第六次发送、保持同任务与 thread 的全部断言保留；没有增加 sleep、超时或重试。另在既有 model-loading 诊断中补充数量、boolean 和未知计数标记，区分目录就绪、安全重启 gate 与已加载模型数，不记录模型 ID、配置或凭证，不改变原生重启安全门或重试行为。新合同、就绪 helper 和诊断协议共 3 文件、12 项通过，既有 reconciliation 聚焦 6 项通过，目标 ESLint 与 Prettier 通过；最终真实桌面回归仍须取得包含这些修复的新 head CI。本地未运行 E2E 或 ai:verify。

## 2026-11-18 个人分组导航与最新主线整合

`38641d0640` 的完整 CI 已结束：七个工作流中六个成功，唯一实际失败仍在 `collaboration-shared-core`，另一个失败是汇总。模型删除（包括第六次发送）、Plugins、运行时队列、change-request-status，以及 Backend API、MySQL RR 和宿主 17 项单元用例均实际通过。普通 Tasks 成员创建已到达确认截图，失败发生在后续既有平台权限验证的个人分组导航，不是此前的入口挂载或 `display: contents` 问题。

[Core10 官方日志](https://github.com/wecode-ai/Wegent/actions/runs/44128583540/job/134204445543) 与 artifact `14351515225` 显示：个人默认分组已经是读者拥有的云端 workspace `73`，普通项目成员页已打开；DOM 存在当前分组的 `collaboration-workspace-nav-projects` 和其他分组入口，没有旧硬编码的 `collaboration-workspace-home-wework-local-workspace`。平台的既有选择规则优先使用用户拥有的云端默认分组，并移除被替代的本地分组；当前选中的入口还会切换按钮 test ID。因此没有证据支持产品导航故障，旧 E2E 对本地分组及未选中按钮身份的假设已经失效。

导航验证现在从既有 workspaces 响应定位 `is_system_default && access_role === Owner` 的真实个人分组，用稳定的 workspace 标签定位其所属按钮，兼容已选与未选中状态。没有增加请求、超时或重试；父分组不可打开、私有 sibling 隐藏以及 Viewer/Developer 权限断言完整保留。两种状态的新回归先 2 失败、10 通过，修复后完整导航协议 12 项通过（744 毫秒），Node 语法、目标 ESLint、Prettier 和差异检查通过。

实际合并父提交为 main `8424d6ad2ffa23c1d19744f78d593ffe658167a9`。原生窗口处理冲突统一为同资源 BadWindow 的严格分支，删除重复实现；双方全部测试断言保留，主线两处简化错误夹具补齐真实 X11 错误字段，协议 23 项通过。localServices 保留主线的新职责：模型列表为只读请求，已保存且待激活的模型保持可见；目录写入与安全重启由任务准备负责。数字诊断保留在对应 owner，删除已失去调用方的读取 trace 透传。合同相应验证读取不触发写入、busy 时保留 pending、准备阶段恢复激活；3 文件 12 项及既有准备、reconciliation 聚焦 10 项通过，未削弱安全重启门禁。

自动合并的运行时对主线仅保留原阶段诊断，observer 仍只等待一次，不改变历史清理、执行容量或异步问题顺序。Rust turns 17、异步问题 8、handler hooks 1、hooks lifecycle 2、主线新增 native capacity 4，共 32 项通过；初次容量模块过滤器未匹配的 0 项结果不计为通过。Rustfmt、Wework typecheck、完整 lint（0 错误、5 项既有警告）、双语文档 8 项和差异检查通过。新 head 仍须取得自己的完整 CI 与可合并状态，不能以 `38641d0640` 的部分成功提前交接；本地未运行 E2E 或 ai:verify。

## 2026-11-18 固定状态分组主线整合

主线 `a9198477b9daf6965998c0722e6bcc6626c00e88` 引入基础看板按状态分组，与共享桌面场景产生单文件冲突。整合保留主线 `withLegacyBoardGrouping` 包装及结束恢复，完整保留普通 Tasks 入口、两人成员选择、Developer/direct_role 回读、立即显示、重载持久化和清理；相对前一 head 的场景内部流程未改。

整合后共享创建、模板、完整 Platform 与状态分组 34 文件、451 项，以及 CloudTodo、状态迁移和普通创建 Action 3 文件、87 项，共 538 项全部通过。导航协议 12 项通过，场景语法、目标 ESLint、Prettier、共享构建、Wework typecheck、完整 lint（0 错误、5 项既有警告）、双语文档契约 8 项和差异检查通过；本地未执行 E2E 或 ai:verify。最终新 head 仍须取得自身完整 CI，不能用前一提交的通过结果替代。

前一提交 `308dcbca2b` 已实际通过 [task-model-deletion](https://github.com/wecode-ai/Wegent/actions/runs/44224766180/job/134539053088)（02:55:58 UTC）与 [Plugins](https://github.com/wecode-ai/Wegent/actions/runs/44224766180/job/134539053029)（02:58:04 UTC），均为 `assertion-errors=none`；此记录仅对应该提交，不表示其他仍在运行的检查已通过。

## 2026-11-18 云端个人分组的本地导入恢复

`308dcbca2b` 的七个工作流全部结束：六个成功，Wework E2E 失败；62 项成功、11 项按规则跳过、3 项失败、0 等待。失败项为 shared-core、change-request-status 及汇总；运行时队列、模型删除和 Plugins 实际通过，不能据此提前报告全绿。

[shared-core 日志](https://github.com/wecode-ai/Wegent/actions/runs/44224766180/job/134539053341) 与官方 artifact `14392619203` 确认本地项目 seed、Git preflight、归档和 reload 均成功，随后等待已被移除的本地分组 tree 超时。真实 UI 显示云端 Owner 个人分组 `73`；只改该 ID 仍无法完成导入，因为该分组原菜单只有云端创建，而本地项目页入口已不可达。真实组件的两项新增用例稳定复现菜单缺失。

个人分组菜单现在复用既有文件夹和已有项目导入动作，始终向本地 workspace 派发，云端普通创建语义保持。缺本地能力、工作区或 importer 时隐藏这些动作。共享场景从已有响应获得 Owner 默认分组，使用其可见菜单；两轮 reload、归档后显式恢复、Git preflight、单行去重、聊天和云项目可见的全部断言保留。完整组件 209 项、实际导航及导入调用协议 13 项通过；协议测试中的文件/Git准备与 Native seed helper 使用测试替身，真实跨边界结果仍以 CI 为准。

同时整合主线 `0c8538c5b0bcc352120e44c63ef13a2312825531`，仅同步其 workspace actions 两种渲染形式的既有选择器修复，无额外冲突。共享构建、Wework typecheck、完整 lint（0 错误、5 项既有警告）、双语文档契约 8 项、场景语法、目标 ESLint、代码 Prettier 和差异检查通过。未运行本地 E2E 或 ai:verify。

## 2026-11-18 PR 状态切换的同步前置

[Core8 官方日志](https://github.com/wecode-ai/Wegent/actions/runs/44224766180/job/134539053260) 与 artifact `14394750313` 显示 `change-request-status` 在修复后等待“检查通过”超时；失败时为“检查失败 + 正在同步状态”，1.339 秒后实际更新为“检查通过，等待合并”。两次顺序采集（03:10:13.880–24.381、24.458–33.271 UTC）跨越原断言窗口 03:10:22.476–32.544，均返回成功。没有证据支持文本隐藏、解析失败或永久不更新；8–10 秒采集耗时的底层原因仍未确认。

场景原步骤只等环境面板出现，不保证此前采集已经完成。新增真实 deferred 组件回归稳定复现旧准备步骤会提前推进；现在在切换 failure、修复后 success 前复用既有同步准备 helper，等待在途采集及打开触发的采集正常结束。回归验证两次基线采集结束前不能推进，之后 FAILURE → SUCCESS 正常更新。其他状态切换已经有同步完成或全新 activation 前置；原状态、observer 数量、错误提示、持久化断言与等待时限完整保留，没有新增重试。

EnvironmentInfoPopover、ChangeRequestMonitor 与 observer 共 3 文件、33 项通过，目标 ESLint、两文件 Prettier、场景语法与差异检查通过。本地未执行 E2E，实际修复结果必须取得新 head 的 CI 证据。

## 2026-11-18 新 activation 主线整合

`d091ff4e12` 的 CI 运行期间，主线推进至 `b5818027e1bf55c281dbb0a04549035d91dd5195`，与状态场景及组件测试发生两处真实冲突。整合保留 failure、修复后 success 的同步基线；最后恢复使用主线 `recoverChangeRequestStatus`，严格确认同一 source、Runtime 和全新有效 lease 后再打开摘要，保留已合并、检查通过和同步正常的全部断言。旧的通用日志等待和额外刷新路径被替换，没有并存第二套恢复流程。

组件测试完整保留 deferred 两次采集回归与主线四条提交反馈回归。状态组件、monitor、observer、主线恢复协议共 4 文件、66 项通过；跨设备通知、交互目录与 hybrid 自动合并回归 4 文件、143 项通过。Electron 启动参数和 Windows 构建键协议 7 项、双语文档契约 8 项通过；Wework typecheck、完整 lint（0 错误、5 项既有警告）、目标 ESLint、格式、场景语法及差异检查通过。

文档自动合并保留普通任务页创建入口和主线跨设备问题说明。共享成员创建实现与其断言未改；未运行本地 E2E 或 ai:verify。包含本次主线整合的新 head 必须取得自身完整 CI 与无冲突结果后再交接。

## 2026-11-18 后台认证基线与 Issue 关闭诊断

`d091ff4e12` 的最终 CI 为 62 项成功、11 项按规则跳过、3 项失败、0 等待，七个工作流中六个成功。实际 [shared-core](https://github.com/wecode-ai/Wegent/actions/runs/44230333813/job/134556621785)、[change-request-status](https://github.com/wecode-ai/Wegent/actions/runs/44230333813/job/134556621780)、运行时队列、模型删除和 Plugins 五个目标全部 PASS。Backend API 为 12,911 passed，MySQL 22 项及宿主模型请求 17 项通过。余下实际失败是插件账号认证并发场景、通知已读场景，另一个失败为汇总。

[Cloud3 日志](https://github.com/wecode-ai/Wegent/actions/runs/44230333813/job/134556621743) 与 artifact `14396535079` 确认 competing lease 属于 renderer 的设备批量同步：它同时持有目标认证插件与独立插件的租约，再等待目标行；独立安装约 2.9 秒后返回 `503 plugin_write_busy`。原行锁 fixture 接受任意 blocked writer，误把该批量同步视为后台认证写入。现在在独立插件准备完成后复用既有 reconciliation 完成协议，离开 Plugins 并确认设备同步结束，再锁认证行；阻塞出现后也确认没有 renderer 同步混入。没有修改服务端 busy 或租约语义，独立 CRUD、锁身份、目标快照和认证恢复断言全部保留。真实 workflow 协议先红后绿，新增编排与既有认证证据两文件 25 项通过，语法、ESLint、Prettier 和差异检查通过。

[Core5 日志](https://github.com/wecode-ai/Wegent/actions/runs/44230333813/job/134556621707) 与 artifact `14395896619` 显示通知已读、未读角标更新均成功；点击 Issue 关闭后，等待 `visible:false` 超时，原 Issue URL 仍保留。旧证据缺少 dismissal 与动画状态，尚未稳定复现，不能认定动画或导航为根因，也不能记为已修复。现只补关闭意图、连接状态和失败 frame 诊断；click 前仅读属性，不读取样式、尺寸或动画，避免提前 flush 改变时序。诊断及既有关闭回归 21 项通过，随后属性预读不 flush 的新增检查与相关套件 10 项通过，目标 ESLint、Prettier、Wework typecheck 和差异检查通过。产品关闭逻辑与 E2E 断言、预算均保持；后续必须依新证据继续调查，不能靠诊断后的偶然通过掩盖间歇问题。

## 2026-11-18 Goal 恢复主线整合与同步身份复核

最新 head `6ba0c601d7` 的 Core / shard 4 失败为 `coordination-runtime` 等待 `stand-in-status-open` 超时。作业日志显示点击在 `04:58:38` 发出、默认 10 秒后超时；该场景已注明状态面板按 15 秒轮询，后续处理和恢复入口也使用同一 20 秒轮询窗口。失败后自动观察记录显示选择器在超时后 `432ms` 已出现，确认是测试等待预算早于既有轮询更新，而非缺少错误入口。现让首次状态入口等待使用同一 20 秒窗口，产品状态、错误恢复和所有断言保持不变。场景语法、目标 ESLint 与 Prettier 通过；真实结果以新 head CI 为准。

head `3230884849` 的后续 Core / shard 4 失败转为 `codex-cloud-config-recovery` 的 `config/read`：日志同时记录云配置 bundle 已回退到默认值，以及 `failed to read configuration layers: Your access token could not be refreshed`；失败 artifact 显示场景中止在该降级读取，模型请求尚未发出。Codex 的认证代码使用 `/oauth/token` 刷新端点，而合成认证服务此前对所有未显式处理的请求返回空对象。现在为隔离进程设置既有刷新端点覆盖，返回与初始身份一致的三字段 access/refresh/id token，并增加协议测试验证响应、ID token 形状、配置 origin 和一次刷新计数；测试 1 项、语法、目标 ESLint、Prettier 与差异检查通过。云配置 503 故障、降级、恢复和后续断言保持不变，实际跨边界结果仍以新 head CI 为准。

主线 `b503a1f985b654df97cd17e05d1bc283942da03b` 与 `changeRequestMonitor.test.ts` 发生单文件冲突。整合同时保留本分支“observer 激活期间手动刷新获取新状态”和主线“收集中注册第二个任务仍能获取状态”的完整回归，运行时保留两种并发处理语义。monitor 三文件 21 项、环境面板与工作区身份/模型目录五文件 55 项、自动化/原生插件协议六文件 46 项全部通过；Rust 队列 17 项、Goal 路由恢复 10 项及双语文档 8 项通过。Wework typecheck、完整 lint（0 错误、5 项既有警告）、目标格式与差异检查通过。没有执行本地 E2E 或 ai:verify。

独立复核发现认证场景的设备同步诊断此前使用了 HTTP record route，而同步注册表按稳定 Executor identity 索引；两者不同时可能错误读到空闲。两个检查现通过已有 `getLocalExecutorStatus.deviceId` 使用真实稳定身份，原有认证与恢复仍使用 record route。两种 ID 不同的协议红测稳定复现旧实现三项失败，修复后新增编排与既有证据两文件 26 项全部通过，语法、ESLint、Prettier 和差异检查通过。该补充仍需新提交真实 CI 验证；通知关闭问题继续按前述诊断取证，没有宣称解决。

主线 `6056494661` 明确清理约 80% renderer 单测，与本分支修改过的五个测试形成 modify/delete 冲突。冲突按主线删除策略解决；创建流程仍保留 `packages/collaboration` 的共享组件/控制器测试和 CI 覆盖的真实成员持久化场景，云配置修复也新增了独立协议测试。合并后合成认证与原生窗口协议两文件 27 项、Wework typecheck 和差异检查通过。

# Verification and rollback

The unit plan covers cloud member creation, partial failures, search recovery, authoritative server-roster checks, the existing template pipeline, local-source hiding and the disabled flag. The CI-covered `collaboration-shared-core` scenario includes real-account member persistence and reload checks. Local E2E and real Electron verification were not run under the repository-level local execution policy; the recorded GitHub CI runs provide the actual desktop E2E results. Earlier test results are tied to their stated revisions, and the latest PR head requires its own green checks. Set `VITE_COLLAB_PROJECT_CREATE_MEMBERS_V1=false` in the Wework build environment and rebuild to disable ordinary-entry member creation without deleting existing memberships.
