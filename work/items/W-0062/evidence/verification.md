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
| 协作模板     | 选择成员、智能体、设备与小组，后续配置失败后重试   | 保留已完成配置，统一成员选择，不重复创建成功的资源绑定                              |
| 本地项目     | 切换本地位置，宿主仅提供云端目录                   | 隐藏云端成员选择，并解释限制                                                        |
| 开关关闭     | 构建配置为 false，再打开普通创建入口               | 返回创建后管理成员的原有流程；不删除任何已有成员关系                                |

`collab.projectCreateMembers.v1` 对应 Wework 的 Vite 构建设置 `VITE_COLLAB_PROJECT_CREATE_MEMBERS_V1`，默认启用。在 Wework 构建环境（例如 `wework/.env.local`）设置为 `false` 并重新构建即可关闭普通入口能力；该配置方式兼容 Windows、macOS 和 Linux。协作平台原有资源能力不受此回滚开关影响。

E2E 覆盖加入现有 `collaboration-shared-core` checkpoint，通过原有 Core CI shard 执行。它创建两个测试账号，验证真实成员搜索、Developer 持久化、成员列表和重载后仍存在。依仓库规则，本次没有运行 E2E 或 `ai:verify`。

当前桌面外壳以 `embedded=true` 挂载普通任务工作区，隐藏该组件的创建侧栏，因此普通入口使用组件测试覆盖；没有为测试新增产品导航。

## 已执行检查

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

# Verification and rollback

The unit plan covers cloud member creation, partial failures, search recovery, authoritative server-roster checks, template-resource retries, local-source hiding and the disabled flag. The existing CI-covered `collaboration-shared-core` scenario now includes real-account member persistence and reload checks. E2E and real Electron verification were not run, as instructed. Set `VITE_COLLAB_PROJECT_CREATE_MEMBERS_V1=false` in the Wework build environment and rebuild to disable ordinary-entry member creation without deleting existing memberships.
