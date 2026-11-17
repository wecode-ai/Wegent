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

当前桌面外壳以 `embedded=true` 挂载普通任务工作区，隐藏该组件的创建侧栏，因此普通入口使用组件测试覆盖；没有为测试新增产品导航。

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

# Verification and rollback

The unit plan covers cloud member creation, partial failures, search recovery, authoritative server-roster checks, the existing template pipeline, local-source hiding and the disabled flag. The CI-covered `collaboration-shared-core` scenario includes real-account member persistence and reload checks. Local E2E and real Electron verification were not run under the repository-level local execution policy; the recorded GitHub CI runs provide the actual desktop E2E results. Earlier test results are tied to their stated revisions, and the latest PR head requires its own green checks. Set `VITE_COLLAB_PROJECT_CREATE_MEMBERS_V1=false` in the Wework build environment and rebuild to disable ordinary-entry member creation without deleting existing memberships.
