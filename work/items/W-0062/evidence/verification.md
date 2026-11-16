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

E2E 覆盖加入现有 `collaboration-shared-core` checkpoint，通过原有 Core CI shard 执行。它创建两个测试账号，验证真实成员搜索、Developer 持久化、成员列表和重载后仍存在。依仓库规则，本次没有运行 E2E 或 `ai:verify`。

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

# Verification and rollback

The unit plan covers cloud member creation, partial failures, search recovery, authoritative server-roster checks, the existing template pipeline, local-source hiding and the disabled flag. The existing CI-covered `collaboration-shared-core` scenario now includes real-account member persistence and reload checks. Local E2E and real Electron verification were not run, as instructed. The initial test results above were recorded before integration with the latest main branch. Set `VITE_COLLAB_PROJECT_CREATE_MEMBERS_V1=false` in the Wework build environment and rebuild to disable ordinary-entry member creation without deleting existing memberships.
