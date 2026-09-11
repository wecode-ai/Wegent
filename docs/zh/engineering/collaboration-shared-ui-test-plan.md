---
sidebar_position: 25
---

# 协作共享 UI 双端 E2E 与验收计划

审计日期：2026-09-10

## 目标

本计划用于证明以下结论，而不只是证明两个宿主“看起来都能用”：

1. Wegent Web 与 Wework 挂载的是 `@wegent/collaboration` 导出的同一个协作 UI 根组件。
2. 两端对云端项目空间提供相同的页面结构、交互流程、状态语义和后端能力。
3. 宿主差异只通过显式的 host adapter 或 capability 注入；云端业务逻辑、状态管理和视图不得在宿主目录中重复实现。
4. Wework 的本地项目、终端、原生文件选择等桌面能力可以作为适配能力存在，但不能改变或替代共享云端主流程。
5. “我的任务”和默认看板必须保留，并在两端使用同一共享实现。

本文只规划新增测试与验收门禁。现有 E2E 不修改、不弱化，也不以新用例替代历史回归。

## 当前状态审计

### 挂载结构

当前代码不能证明共享 UI：

- Web 的 `frontend/src/features/collaboration/CollaborationPage.tsx` 直接挂载
  `@wegent/collaboration` 的 `CollaborationApp`。
- Wework 的 `wework/src/features/todo/CollaborationWorkspace.tsx` 挂载本地
  `CloudTodoWorkspace`。
- 因此当前是两个不同的 UI 根组件。即使二者访问同一后端，也不满足“同一共享 UI”。

### Web Playwright

当前 `frontend/e2e/tests/collaboration/collaboration.spec.ts` 有两个串行场景：

- 从任务侧栏进入协作，并验证 `/inbox` 旧路由跳转到 `/collaboration`。
- 使用真实后端创建项目、创建 Issue、更新标题、添加评论、按钮式移动状态、刷新后验证持久化。

当前缺口：

- 没有“我的任务”和默认看板。
- 没有项目首页的完整状态。
- 没有真实拖拽。
- 没有 Issue 删除或归档、附件、负责人、截止日期、标签等完整 CRUD。
- 没有成员、文件、自动化、设置的端到端操作。
- 没有角色权限、并发版本冲突和跨端更新。
- 没有深链、浏览器前进后退、非法路由和刷新恢复矩阵。
- 没有证明 Web 与 Wework 挂载同一组件的结构断言。

### Wework desktop checkpoints

现有 Wework 场景覆盖较广，但主要绑定 `cloud-*`、`cloud-todo-*` 和其他桌面专属
`data-testid`：

| 现有 checkpoint / 流程               | 已有证据                                                                       | 不能证明的内容                                    |
| ------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| `workspace-tabs`                     | 固定项目空间 tab、默认关联项目、“我的任务”上下文、避免重复 tab                 | Web 路由；共享组件挂载                            |
| `task-status-sync` 中的 My Work 流程 | 完成任务进入“我的任务”，陈旧运行态不会复活任务                                 | Web 的我的任务；完整视图与筛选对等                |
| `offline-local-project-space`        | 本地项目创建、空看板引导、Issue 创建/更新/拖拽，并能进入文件、成员和自动化入口 | 云端双端对等；文件/成员/自动化的 CRUD             |
| `board-focus-view`                   | 看板运行态、分组、专注视图、列宽和状态恢复                                     | Web 对等；共享 DOM 结构                           |
| `project-automation`                 | 大量真实后端自动化、工作流、执行、机器人、设置与冲突相关桌面流程               | Web 使用同一自动化 UI；基础协作模块的完整能力矩阵 |
| `task-attachments`                   | 云端交付物文件树、面包屑和预览                                                 | 普通共享文件的上传、重命名、删除、下载双端对等    |
| `project-assignment-notification`    | 分配通知和用户隔离                                                             | 协作页面上的角色可见性和操作权限矩阵              |

历史 Wework 场景仍有保留价值，但它们不能作为“双端共享 UI”的证据，因为 Web 不运行这些
场景，且选择器来自 Wework 私有实现。

### 首个可执行共享 checkpoint

`.github/scripts/classify-wework-desktop-e2e.sh` 和 CI 分片声明了
`collaboration-shared-core`。该 checkpoint 现已具备完整的 scenario、catalog 注册和 runner
映射，可由现有 desktop E2E CI 分片真实执行。

首批场景使用隔离的真实 Backend，通过 REST API 自包含地创建项目和多状态 Issue，并验收：

- 从 Wework 工作区标签进入“协作”；
- 项目首页及真实项目数据；
- “我的工作”的默认分组看板；
- 进入项目后的原有 header、view switcher、board、列和卡片关键 `data-testid`；
- 验收后按项目最新 version 归档 fixture。

该 checkpoint 是 Wework 共享抽取的首批回归骨架，不单独证明 Web 已挂载同一个根组件，也不替代
后续双端能力对等和跨端并发场景。

### `data-testid` 审计

共享包既有 `collaboration-*` 标识，也已承载从 Wework 原界面抽出的 `cloud-*`、
`cloud-todo-*`、项目首页和“我的工作”标识。首个 `collaboration-shared-core` checkpoint
有意使用这些现存稳定标识，以证明抽取没有重写或丢失原界面。

统一的双端 `collaboration-*` 契约仍不足以覆盖完整验收：

- 共享根组件身份、宿主身份和路由就绪状态；
- 项目首页和“我的工作”在 Web 中的同一节点标识；
- 看板拖拽源、dropzone、快速创建、删除/归档；
- 成员角色选择器和搜索提交；
- 文件行、文件夹、预览、下载、重命名和删除；
- 自动化列表、编辑器、启停、立即运行、运行详情；
- 设置各字段、保存、归档和冲突提示；
- 权限禁用原因、只读态和全局错误恢复；
- 路由恢复完成态；
- 共享组件身份和 host capability。

## 验收原则

### 真实后端

- 所有能力场景必须发起真实 REST 请求并验证服务端持久化。
- 可以通过 API 建立最小前置数据，但被验收的用户动作必须从 UI 发起。
- 禁止拦截请求后直接伪造成功响应。
- 禁止在能力缺失时跳过、降级通过或捕获错误后继续。
- Playwright 与 desktop runner 均保持零重试；间歇失败按缺陷处理。

### 同一语义场景

Web 与 Wework 使用同一份场景定义、fixture builder 和断言语义。宿主 driver 只负责：

- 打开协作入口；
- 获取当前 URL 或 Wework tab location；
- 执行宿主级刷新、前进、后退或 tab 重开；
- 调用宿主专属能力。

创建项目、打开首页、拖拽 Issue、管理成员、文件、自动化和设置等步骤不得复制为两份业务流程。

### 自包含与清理

- 每个新增 desktop checkpoint 建立自己的用户、项目、成员、Issue、文件和自动化前置条件。
- 单 checkpoint 运行和从 checkpoint 开始运行都必须有效。
- 项目、文件、自动化和成员在 `finally` 或 runner teardown 中按版本正确清理。
- 清理失败必须使测试失败，不能只记录日志。

## 建议的测试分层

### 第一层：共享组件契约测试

新增共享包测试，建议位置：

- `packages/collaboration/src/__tests__/shared-ui-structure.test.tsx`
- `packages/collaboration/src/__tests__/cloud-capability-contract.test.ts`

验证：

1. 共享包只导出一个生产协作根组件，例如 `CollaborationWorkspace`。
2. 根节点固定包含：
   - `data-testid="collaboration-root"`；
   - `data-collaboration-component="CollaborationWorkspace"`；
   - `data-collaboration-contract-version="<固定版本>"`；
   - `data-collaboration-host="web|wework"`。
3. host 值只能影响适配槽位和 capability，不得改变共享云端视图的组件树。
4. 相同 API fixture、locale、location 和 cloud capability 下，两种 host 渲染得到相同的归一化
   语义树。
5. 归一化树至少比较 element tag、role、`data-testid`、`aria-*` 和交互可用状态；忽略宿主外壳、
   自动生成 ID 和平台字体。
6. 云端 capability 在两端完全一致；只有 `localProjects`、`terminal`、原生文件选择等明确的
   desktop capability 允许不同。

### 第二层：静态共享边界门禁

新增独立架构测试或检查脚本，建议位置：

- `packages/collaboration/scripts/verify-host-boundaries.mjs`
- 或等价的仓库测试文件。

必须断言：

1. Web 与 Wework 的协作宿主都从 `@wegent/collaboration` 导入同一个根组件。
2. 两个宿主文件中只允许创建 API adapter、route adapter、notification adapter 和平台
   capability，不允许定义看板、Issue、成员、文件、自动化、设置或我的任务视图。
3. `frontend/src/features/collaboration/**` 与 `wework/src/features/todo/**` 中不存在第二个云端
   协作根实现。
4. 宿主不得复制共享包的 API path、状态转换、乐观更新、冲突处理或权限判断。
5. 共享云端组件的 `data-testid` 只能在共享包中定义；宿主只能定义外壳测试标识。
6. 两个 package manifest 都解析到 workspace 中同一个 `@wegent/collaboration` 包。

静态检查与运行时 DOM 指纹必须同时通过。单独检查 `data-testid` 相同不够，因为复制实现也能
伪造相同标识。

### 第三层：双端云端能力对等 E2E

新增一份宿主无关的场景描述，例如：

- `packages/collaboration/e2e/cloud-parity-scenarios.ts`

再由两个很薄的 driver 执行：

- Web：`frontend/e2e/tests/collaboration/shared-cloud-parity.spec.ts`
- Wework：`wework/e2e/desktop/scenarios/collaboration-cloud-parity.scenario.mjs`

Wework 新增独立 checkpoint：`collaboration-cloud-parity`。它必须同时注册到：

- `wework/e2e/desktop/checkpoints.mjs`；
- `wework/e2e/desktop/run-checkpoints.mjs`；
- desktop E2E CI 分类和分片；
- 分类脚本自身测试。

不要修改现有 `workspace-tabs`、`offline-local-project-space`、`board-focus-view`、
`project-automation` 或其他历史 E2E。

### 第四层：跨端一致性与并发

新增一个以同一真实后端为真值、同时启动 Web page 与 Wework desktop session 的场景。若当前
CI 资源不适合在一个 job 中同时启动两个宿主，可用两个阶段共享唯一 fixture：

1. Web 创建或修改数据并记录服务器版本；
2. Wework 打开相同项目并验证；
3. Wework 修改；
4. Web 刷新或收到事件后验证；
5. 两端制造旧版本提交并验证 `409` 恢复。

只分别跑两套同名测试不能证明跨端一致性；至少一个场景必须让两端操作同一个项目和 Issue。

## 统一 `data-testid` 契约

共享组件迁移后，双端云端流程统一使用 `collaboration-*`。建议最小契约如下：

| 区域       | 必需标识                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根节点     | `collaboration-root`, `collaboration-project-home`, `collaboration-route-ready`                                                                                                                                                                         |
| 我的任务   | `collaboration-my-work`, `collaboration-my-work-board`, `collaboration-my-work-filter`, `collaboration-my-work-item-{id}`                                                                                                                               |
| 项目首页   | `collaboration-project-list`, `collaboration-project-create`, `collaboration-project-{id}`, `collaboration-home-my-work`, `collaboration-home-manage`                                                                                                   |
| 看板       | `collaboration-board`, `collaboration-board-search`, `collaboration-board-group-by`, `collaboration-column-{status}`, `collaboration-column-dropzone-{status}`, `collaboration-issue-{id}`                                                              |
| Issue      | `collaboration-issue-create`, `collaboration-issue-detail`, `collaboration-issue-save`, `collaboration-issue-archive`, `collaboration-issue-delete`, `collaboration-issue-close`                                                                        |
| 成员       | `collaboration-members`, `collaboration-member-search`, `collaboration-member-search-submit`, `collaboration-member-add-{id}`, `collaboration-member-role-{id}`, `collaboration-member-remove-{id}`                                                     |
| 文件       | `collaboration-files`, `collaboration-file-upload`, `collaboration-folder-create`, `collaboration-file-{id}`, `collaboration-file-preview-{id}`, `collaboration-file-download-{id}`, `collaboration-file-rename-{id}`, `collaboration-file-delete-{id}` |
| 自动化     | `collaboration-automation`, `collaboration-automation-create`, `collaboration-automation-{id}`, `collaboration-automation-save`, `collaboration-automation-toggle-{id}`, `collaboration-automation-run-{id}`, `collaboration-automation-run-detail`     |
| 设置       | `collaboration-project-settings`, `collaboration-settings-name`, `collaboration-settings-visibility`, `collaboration-settings-statuses`, `collaboration-settings-save`, `collaboration-project-archive`                                                 |
| 权限与冲突 | `collaboration-readonly-reason`, `collaboration-forbidden`, `collaboration-conflict`, `collaboration-reload-latest`                                                                                                                                     |

规则：

- 动态标识必须使用稳定的后端 ID，不能使用数组下标或翻译文本。
- 同一云端控件在两端必须使用同一标识。
- host 外壳标识必须以 `web-collaboration-host-*` 或 `wework-collaboration-host-*` 命名，不得
  冒充共享控件。
- 旧 `cloud-*` 标识可在历史 E2E 保留期间由同一个共享节点兼容暴露，但不得通过渲染第二个节点
  或第二套视图实现兼容。最终删除应单独进行，并同步迁移历史测试。

## 功能场景矩阵

下列每一行必须在 Web 与 Wework 的 shared cloud parity suite 中执行相同业务步骤。

### 1. 我的任务与默认看板

前置条件：

- 用户拥有至少两个项目；
- 存在分配给当前用户的待处理、进行中、审核中、已完成 Issue；
- 存在未分配给当前用户和无权访问的 Issue。

步骤与断言：

1. 从协作首页进入“我的任务”。
2. 默认看板可见，且不是空白项目列表或新建项目引导。
3. 只显示当前用户可访问且与其相关的 Issue。
4. 状态分组、项目筛选、搜索和视图切换在两端一致。
5. 打开 Issue 后返回，保留筛选、滚动位置和所选视图。
6. 完成一个 Issue 后刷新，条目进入完成分组且不会被陈旧运行态恢复为进行中。
7. 直接打开“我的任务”的宿主 location，刷新后仍恢复同一视图。

### 2. 项目首页

步骤与断言：

1. 首页显示项目列表、我的任务入口、新建项目和管理入口。
2. 创建云端项目，校验名称、描述、项目 key、访问角色和后端 store。
3. 新项目立即出现在两端；不得要求重新登录或创建第二份项目。
4. 项目卡打开同一个共享项目首页/看板。
5. 搜索、排序或管理筛选结果在刷新后正确恢复。
6. 空状态与有数据状态均验证，不允许出现 Wework 私有空白侧栏或 Web 私有简化首页。

### 3. 看板

步骤与断言：

1. 打开项目后默认进入共享看板。
2. 校验状态列、Issue 数量、卡片标题、优先级、负责人、标签、日期和权限态。
3. 搜索 Issue，并在清空搜索后恢复全部卡片。
4. 切换 status、priority、assignee、tag 分组；保存后另一端读取相同分组配置。
5. 使用真实 pointer/drag action 将卡片拖入目标 dropzone。
6. 验证乐观位置、服务端 status/sort order 和刷新后位置一致。
7. 模拟服务端失败时，卡片回滚到原位置并显示错误，不能保留假成功状态。
8. 长列表滚动、空列快速创建和窄窗口布局不遮挡主要操作。

### 4. Issue CRUD、详情与拖拽

步骤与断言：

1. 创建 Issue，填写标题、描述、状态、优先级、负责人、截止日期和标签。
2. 深链自动打开新 Issue 详情。
3. 修改所有可编辑字段并保存，验证版本递增和另一端读取一致。
4. 新增评论和附件，刷新后仍存在。
5. 删除附件，验证服务端和两端都不再显示。
6. 关闭详情并通过卡片重新打开。
7. 使用拖拽变更状态和顺序。
8. 归档或删除 Issue，确认看板、我的任务和直接深链都不再显示有效条目。
9. 取消删除确认时不得发出删除请求。
10. 无编辑权限时所有变更入口不可操作，不能只依赖后端报错。

### 5. 成员

使用 Owner、Maintainer、Developer、Reporter 和无成员用户。

步骤与断言：

1. Owner 搜索用户并添加成员。
2. 修改成员角色，另一端立即或刷新后读取相同角色。
3. 移除成员后，被移除用户失去项目访问。
4. Owner 不可被普通角色降级或删除。
5. Maintainer 的可管理范围与后端权限一致。
6. Developer/Reporter 看不到或不能操作成员管理控件。
7. 后端拒绝时 UI 保留原成员列表并显示明确错误。

### 6. 文件

仅验收云端共享文件；Wework 的本机路径 reveal 等能力作为额外宿主场景。

步骤与断言：

1. 新建文件夹并上传文本文件和二进制文件。
2. 校验路径、大小、类型、创建者和更新时间。
3. 进入文件夹、使用面包屑返回。
4. 预览可预览文件；二进制文件显示正确的下载或不可预览状态。
5. 下载内容与上传内容哈希一致。
6. 重命名文件和文件夹，另一端读取新路径。
7. 删除文件；非空文件夹删除规则与后端一致。
8. 同名、非法路径、超限文件和无权限上传显示确定错误。
9. 交付物与普通共享文件不得混淆，且云端语义两端一致。

### 7. 自动化与运行记录

当前共享 `CollaborationApp` 的 automation 视图只是 capability 占位，这是 P0 能力缺口；完成
共享前不能以“入口存在”通过。

步骤与断言：

1. 打开自动化列表并创建规则。
2. 配置触发器、条件、执行节点、机器人/智能体、模型和工作区绑定。
3. 保存后验证真实后端 definition。
4. 编辑、启用、停用和归档规则。
5. 执行“立即运行”，验证生成运行记录和关联 Issue/Task。
6. 打开运行详情，验证状态、开始/结束时间和错误。
7. 刷新并从另一端打开相同规则与运行记录。
8. 未保存草稿、离开确认和版本冲突行为两端一致。
9. 无管理权限时只展示允许的只读信息。

复杂编辑器细节可继续由现有 `project-automation` 回归覆盖，但共享 parity suite 至少必须覆盖完整
生命周期主路径。

### 8. 项目设置

步骤与断言：

1. 修改名称、描述、可见性和标签。
2. 新增、重命名、重排和删除状态，并设置 processing status。
3. 修改卡片字段显示配置。
4. 对 GitHub/GitLab/钉钉 AI 表格 provider 配置执行允许的云端更新。
5. 保存后校验后端版本和另一端显示。
6. 归档项目后返回项目首页，两端不再显示活跃项目。
7. 非 Owner/Maintainer 看不到或不能操作受限字段。

### 9. 权限和乐观锁冲突

权限矩阵至少包括：

| 角色           | 读取项目 | 创建/编辑 Issue | 管理成员   | 修改设置 | 管理自动化 |
| -------------- | -------- | --------------- | ---------- | -------- | ---------- |
| Owner          | 是       | 是              | 是         | 是       | 是         |
| Maintainer     | 是       | 是              | 按后端契约 | 是       | 是         |
| Developer      | 是       | 是              | 否         | 否       | 否         |
| Reporter       | 是       | 按后端契约      | 否         | 否       | 否         |
| 非成员私有项目 | 否       | 否              | 否         | 否       | 否         |

冲突场景：

1. 两端同时读取同一 project/Issue version。
2. Web 先保存，Wework 使用旧 version 保存。
3. Wework 收到 `409`，显示共享冲突提示，并加载服务器最新版本。
4. 未提交的本地字段不得静默覆盖服务器内容；产品约定若要求保留草稿，需明确展示。
5. 对项目设置、Issue 编辑和拖拽 reorder 分别执行一次冲突。
6. `403`/不可见项目不得渲染残留敏感字段；`404` 与无权限响应遵循后端防枚举契约。

### 10. 路由与状态恢复

Web：

- `/collaboration`
- `/collaboration/{projectId}`
- `/collaboration/{projectId}?view=files|members|automation|runs|manage`
- `/collaboration/{projectId}/issues/{itemId}`
- 浏览器刷新、前进、后退；
- 非法 projectId、非法 itemId、无权限深链；
- `/inbox` 迁移入口。

Wework：

- 从顶部“协作”tab 打开；
- 固定项目空间 tab 和项目选择；
- 关闭并重新打开协作 tab；
- 应用重载后恢复 project、view 和 issue detail；
- 从通知、任务关联或项目上下文打开指定 Issue；
- 不产生重复项目空间 tab；
- “我的任务”默认看板可恢复。

共同断言：

- 共享组件读取的 `CollaborationLocation` 完全一致；
- location 未恢复完成前显示明确 loading，不渲染错误首页；
- 恢复完成后只有一个 `collaboration-root`；
- 返回操作回到预期的共享父视图，而不是宿主默认页。

## 结构对等断言

每次 shared cloud parity E2E 启动后都执行：

1. `collaboration-root` 数量严格为 1。
2. 根节点的 component 名和 contract version 相同。
3. Web 与 Wework 的 cloud capability 序列化值相同。
4. 对首页、我的任务、看板、Issue 详情、成员、文件、自动化、设置分别采集归一化语义快照。
5. 两端快照的共享区域必须完全相等；差异只允许出现在预先登记的 host slot：
   - Wework 本地项目创建选项；
   - Wework 终端/本地执行入口；
   - Wework 原生文件或 reveal 操作；
   - Web URL 和浏览器外壳；
   - Wework tab 外壳。
6. 若差异清单新增条目，测试失败；不能自动更新 allowlist。
7. 截图只用于失败诊断，不能替代结构和服务端断言。

建议在共享根节点暴露只读测试元数据：

```html
<section
  data-testid="collaboration-root"
  data-collaboration-component="CollaborationWorkspace"
  data-collaboration-contract-version="1"
  data-collaboration-host="web"
></section>
```

`data-collaboration-host` 可以不同，其余身份字段必须一致。

## Fixture 与数据设计

每次 suite 创建唯一前缀，例如 `collab-parity-{runId}`，并建立：

- Owner 用户 A；
- Maintainer 用户 B；
- Developer 用户 C；
- Reporter 用户 D；
- 非成员用户 E；
- 一个私有云端项目和一个公共云端项目；
- 至少五个状态；
- 每种优先级、负责人和标签的 Issue；
- 一个父 Issue 和子 Issue；
- 一个文本文件、一个二进制文件、一个文件夹；
- 一个停用自动化、一个可立即运行自动化；
- 至少一个成功运行和一个失败运行。

fixture builder 返回项目、Issue、成员、文件和自动化的 ID 与当前 version。测试不得通过页面文本猜测
动态 ID。

## CI 执行设计

### Web

新增 spec 必须由现有 Chromium CI 项目自动收集，不增加仅供本地运行的死用例。建议将耗时较长的
跨端场景单独 tag，但仍由 CI job 显式调用。

本地聚焦命令：

```bash
pnpm --dir frontend exec playwright test \
  e2e/tests/collaboration/shared-cloud-parity.spec.ts \
  --project=chromium
```

### Wework

新增 checkpoint 后，本地聚焦命令：

```bash
pnpm --dir wework e2e:desktop -- --segment collaboration-cloud-parity
```

CI 必须验证：

- checkpoint catalog、scenario 映射和 CI shard 三者一致；
- 分类脚本对共享包、Web host、Wework host 和共享场景变更都选择 Web collaboration E2E 与
  Wework parity checkpoint；
- 单 checkpoint 可独立运行；
- 失败证据包含 runner 日志、DOM snapshot、请求摘要和失败截图。

### 共享包变更分类

任何 `packages/collaboration/**` 变更至少触发：

- 共享包 unit/typecheck；
- Web shared cloud parity；
- Wework `collaboration-cloud-parity`；
- 静态 host boundary 检查。

只触发其中一端不能作为合并门禁。

## 实施顺序

1. 新增静态 host boundary 测试，让当前两根组件状态明确失败。
2. 定义统一根组件身份、capability schema 和 `data-testid` 契约。
3. 新增共享场景 DSL/fixture builder，先覆盖项目首页、我的任务和基础看板。
4. 添加 Web driver 和 Wework 独立 checkpoint，并修复 CI 注册不完整问题。
5. 依次扩展 Issue、成员、文件、设置、自动化。
6. 添加跨端同项目读写和 `409` 冲突场景。
7. 最后添加归一化语义树对比和宿主差异 allowlist。
8. 保留所有历史 E2E；共享主路径稳定后，另开变更评估旧选择器迁移，不能在本计划实施中顺手
   修改或删除。

## 合并门禁

只有以下证据全部成立，才能声明“完全复用且云端能力对等”：

- 静态边界检查证明两个宿主导入同一个共享根组件，宿主没有第二套云端业务实现。
- 两端运行时根节点身份、contract version 和归一化共享语义树一致。
- 本文十个功能区域在 Web 与 Wework 的同一场景定义下全部通过。
- 至少一个跨端场景在同一项目上完成双向读写和三类 `409` 冲突恢复。
- Web 与 Wework 都使用真实后端，且服务端持久化断言通过。
- “我的任务”默认看板、项目首页、文件和自动化不再缺失。
- 现有 Wework desktop checkpoints 与现有 Web collaboration spec 保持通过。
- `collaboration-cloud-parity` 在 catalog、runner 和 CI 中完整注册，无幽灵 checkpoint。
- 不存在静默 skip、fallback、重试取绿或自动扩张的结构差异 allowlist。

任何一项缺失，都只能称为迁移中，不能称为双端共享完成。
