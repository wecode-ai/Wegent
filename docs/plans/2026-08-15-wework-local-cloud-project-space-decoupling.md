---
sidebar_position: 99
---

# Wework 本地与云端项目空间解耦修复计划

## 1. 背景

Wework 的项目空间同时支持本地存储和云端存储：

- 本地项目空间的数据由本地 Executor 持有。
- 云端项目空间的数据由 Backend 持有。
- 两类项目可以共用界面和领域类型，但不共享数据可用性，也不应共享请求生命周期。

当前实现把本地和云端项目放进同一个项目数组，并在页面运行时根据裸
`projectId` 查找项目、推断来源和选择 API。项目列表、项目详情和全局聚合视图又由
同一个 `CloudTodoWorkspace` 组件管理，导致以下问题：

1. 云端不可用时，本地项目列表需要等待云端请求完成才能结束加载状态。
2. 打开本地项目详情后，部分子功能仍能通过全局 Hybrid Services 发起云端请求。
3. 项目路由只保存 `projectId`，没有保存项目存储来源，恢复本地详情时必须先加载多个
   数据源。
4. 项目列表初始化会预加载每个项目的任务和成员，把列表展示与详情请求绑定。
5. `apiForProjectId()` 在来源未知时使用 `services.deliveryApi` 或第一个可用 API
   fallback，可能把本地操作错误路由到云端。
6. 本地项目自动化详情仍收到云端 `projectAutomationApi`、`teamApi` 等服务，云端故障
   因而会进入本地详情流程。

这不是单个超时或错误处理缺失的问题，而是项目身份、数据所有权和服务注入边界不完整。

## 2. 修复目标

本次修复需要建立以下硬边界。

### 2.1 项目列表

- 本地项目列表只由本地 API 加载。
- 本地列表加载完成后立即展示，不等待云端列表。
- 云端列表作为独立、可选的数据源加载。
- 云端加载中、失败或断开不能改变本地列表的 loading、error 和可交互状态。
- 项目列表请求只返回项目摘要，不预加载任务、成员、文件或自动化详情。

### 2.2 项目详情

- 本地项目详情只持有本地项目服务。
- 本地项目详情的挂载、刷新、切换标签和卸载均不得发起云端请求。
- 云端项目详情只持有云端项目服务。
- 项目详情不再根据裸 `projectId` 从混合项目数组中猜测来源。
- 来源不完整或服务不可用时明确停止请求，不使用其他来源的 API fallback。

### 2.3 全局聚合

- “我的工作”“全局搜索”等确实需要跨来源的功能由独立聚合层负责。
- 每个来源独立加载、独立失败、独立展示。
- 本地结果不得等待云端结果。
- 进入具体项目详情后，不继续运行与该详情无关的跨来源轮询或刷新。

## 3. 非目标

本次修复不做以下工作：

- 不把本地项目迁移到 Backend。
- 不在云端不可用时提供云端数据的伪本地 fallback。
- 不通过增加重试次数掩盖错误路由。
- 不通过缩短云端超时替代数据源解耦。
- 不改变 Backend 对云端项目空间的授权边界。
- 不修改现有 E2E 测试来绕过失败；只有日志和调用链证明测试逻辑错误时才调整测试本身。

## 4. 当前错误模型

当前主流程可以概括为：

```text
CloudTodoWorkspace
  -> 收集 localApi + cloudApi
  -> Promise.all 加载两个来源
  -> 合并为 projects[]
  -> 只保存 selectedProjectId
  -> projects.find(project.id === selectedProjectId)
  -> apiForProjectId(projectId)
       -> 根据 projects[] 推断 location
       -> 推断失败时 fallback 到 deliveryApi 或第一个 API
  -> 把全局 WorkbenchServices 继续传给详情子组件
```

这个模型存在三个结构性错误：

1. `projectId` 不是完整身份。
2. 项目来源是运行时推断结果，而不是请求前已知条件。
3. 详情组件能访问超出自身存储域的服务。

## 5. 目标模型

### 5.1 项目空间身份

所有项目空间选择、路由、缓存和状态索引统一使用完整引用：

```ts
type ProjectStore = "local" | "backend";

interface ProjectSpaceRef {
  projectStore: ProjectStore;
  projectId: string;
}
```

统一 key：

```ts
function projectSpaceKey(ref: ProjectSpaceRef): string {
  return `${ref.projectStore}:${ref.projectId}`;
}
```

`ProjectStore` 是持久化和路由身份，`ProjectSpaceLocation` 只是 UI 服务选择使用的
`"local" | "cloud"` 表达。二者只允许在明确边界转换：

- `projectStoreLocation("local") -> "local"`
- `projectStoreLocation("backend") -> "cloud"`
- 从创建位置回写项目身份时，`"local" -> "local"`，`"cloud" -> "backend"`

`projectId` 全程保持字符串语义，不允许通过 `Number(...)` 或其他数值转换推断身份。路由
解析、缺失 store 的兼容入口和缓存索引最终都必须产出完整 `ProjectSpaceRef`。

以下状态不得继续仅用 `project.id` 索引：

- 当前选中项目
- 工作区标签页路由
- 项目任务缓存
- 项目成员缓存
- 项目统计缓存
- 项目菜单状态
- 重命名、归档和创建任务目标
- 详情抽屉所属项目

### 5.2 路由

看板路由保存完整项目身份：

```text
/todo?projectStore=local&projectId=<id>
/todo?projectStore=backend&projectId=<id>
```

不再通过加载所有项目来反推 `projectStore`。

旧的、只包含 `projectId` 的持久化标签页不能触发来源猜测或跨来源请求。迁移时应提升工作区
标签存储版本，并把无法确定来源的旧看板路由恢复到 `/todo` 项目首页。不要保留
“依次请求本地和云端直到找到项目”的兼容路径。

### 5.3 来源固定的项目上下文

选中项目后创建来源固定的上下文：

```ts
interface ProjectSpaceContext {
  ref: ProjectSpaceRef;
  project: CloudProject;
  services: ProjectSpaceDetailServices;
}
```

详情服务接口按功能声明，而不是传入完整 `WorkbenchServices`：

```ts
interface ProjectSpaceDetailServices {
  projectApi: DeliveryApi;
  projectChatAgentApi?: ProjectChatAgentApi;
  projectChatClient?: ProjectChatClient;
  executionApi?: ExecutionListApi;
  automationApi?: ProjectAutomationRulesApi;
  deviceApi?: ProjectDeviceApi;
  modelApi?: ProjectModelApi;
  teamApi?: ProjectTeamApi;
}
```

构造规则：

```text
projectStore=local
  -> 只能构造 LocalProjectSpaceDetailServices

projectStore=backend
  -> 只能构造 CloudProjectSpaceDetailServices
```

详情组件不再接收整个 Hybrid `WorkbenchServices`，从类型层面移除访问其他存储域的能力。

### 5.4 列表控制器

列表状态按来源拆分：

```ts
interface ProjectListSourceState {
  status: "idle" | "loading" | "loaded" | "error";
  projects: CloudProject[];
  error: string | null;
}

interface ProjectListsState {
  local: ProjectListSourceState;
  cloud: ProjectListSourceState;
}
```

加载顺序：

```text
挂载项目首页
  -> 启动本地列表请求
  -> 本地返回
  -> 立即展示本地项目

  -> 云端已配置且当前允许加载时，独立启动云端列表请求
  -> 云端返回后增量展示云端项目
  -> 云端失败只更新 cloud.error
```

本地与云端请求之间不得存在 `Promise.all`、共享 loading 或共享 catch/finally。

### 5.5 详情控制器

详情控制器的输入必须是完整 `ProjectSpaceRef`：

```text
路由 ProjectSpaceRef
  -> 选择对应来源的列表缓存或 getProject API
  -> 构造固定来源 ProjectSpaceContext
  -> 挂载 ProjectSpaceDetail
  -> 所有详情请求从 context.services 发出
```

进入本地详情时：

- 不加载云端项目列表。
- 不调用云端 `listMyWork()`。
- 不调用云端成员、任务、文件、自动化或执行 API。
- 不调用会在后台刷新云端目录的混合 model/team/device API。
- 不为确定项目来源发起探测请求。

### 5.6 全局聚合控制器

跨来源功能使用独立数据源适配器：

```ts
interface GlobalProjectSource {
  source: "local" | "cloud";
  listMyWork(): Promise<CloudMyWorkItem[]>;
  search(query: ProjectSearchQuery): Promise<ProjectSearchResult[]>;
}
```

聚合层分别维护来源状态：

```text
GlobalMyWork
  -> local source: loading/loaded/error
  -> cloud source: idle/loading/loaded/error
  -> UI 合并已完成来源的结果
```

项目详情不持有 `GlobalProjectSource[]`。

## 6. 需要删除的错误路径

实施时优先删除以下代码和抽象，再依靠 TypeScript 和测试暴露需要补齐的调用点：

1. 删除详情流程中的 `availableProjectSpaceApis`。
2. 删除 `apiForProjectId(projectId)`。
3. 删除项目 API 的 `services.deliveryApi` fallback。
4. 删除项目 API 的 `availableProjectSpaceApis[0]` fallback。
5. 删除列表 effect 中为所有项目执行的 `listLoopItems()`。
6. 删除列表 effect 中为所有项目执行的 `listCloudProjectMembers()`。
7. 删除本地和云端共用的单一 `loading` 状态。
8. 删除详情子组件对完整 `WorkbenchServices` 的依赖。
9. 删除看板路由和页面状态中只保存裸 `projectId` 的路径。
10. 删除本地项目自动化对 Backend `projectAutomationApi` 的引用。
11. 删除本地项目自动化对云端 `teamApi.listTeams()` 的引用。
12. 删除本地详情中 `services.deliveryApi.stopExecution` 优先于来源 API 的路径。
13. 删除通过请求多个来源来寻找项目的兼容或探测逻辑。

## 7. 分阶段实施计划

### 阶段一：建立完整项目身份

目标：让项目来源在进入页面和发出请求前已经确定。

主要修改：

- 复用并扩展 `projectSpaceRef()`、`projectSpaceKey()`。
- 将工作区看板标签页的选择状态改为 `ProjectSpaceRef`。
- 路由增加 `projectStore`。
- 将 `activeProjectId`、`onActiveProjectChange` 改为完整项目引用。
- 将项目相关 Map 的 key 改为 `projectSpaceKey`。
- 提升 Workspace Tabs 持久化结构版本，失效无法确定来源的旧看板详情路由。

预计涉及：

- `wework/src/features/todo/projectSpaceSelection.ts`
- `wework/src/features/todo/CloudTodoWorkspace.tsx`
- `wework/src/components/layout/DesktopWorkbenchLayout.tsx`
- `wework/src/features/workspace-tabs/`
- `wework/src/lib/navigation.ts`

验收条件：

- 本地和云端存在相同 `projectId` 时仍可分别打开。
- 恢复本地看板标签页不需要加载云端项目列表。
- 来源缺失时回到项目首页，不猜测 API。

### 阶段二：拆分项目列表生命周期

目标：本地项目列表独立加载和展示。

主要修改：

- 提取 `useLocalProjectSpaces()`。
- 提取 `useCloudProjectSpaces()`。
- 每个 hook 独立维护 status、projects 和 error。
- 项目首页根据两个来源的已完成结果组合展示。
- 云端未连接时不启动云端列表 hook。
- 删除总的 `Promise.all` 和全局 `loading`。
- 删除项目列表阶段的任务和成员预加载。

预计涉及：

- `wework/src/features/todo/CloudTodoWorkspace.tsx`
- 新增 `wework/src/features/todo/useLocalProjectSpaces.ts`
- 新增 `wework/src/features/todo/useCloudProjectSpaces.ts`
- `wework/src/features/todo/CloudProjectsHome.tsx`

如果拆分后 `CloudTodoWorkspace.tsx` 仍承担列表、详情和所有子功能，应继续拆成：

```text
ProjectSpacesWorkspace
  -> ProjectSpacesHome
  -> ProjectSpaceDetail
```

验收条件：

- 云端列表 Promise 永不结束时，本地列表仍结束 loading 并可点击。
- 云端列表失败时，本地项目创建、重命名、归档和打开不受影响。
- 项目首页初次加载不请求任何项目的任务和成员详情。

### 阶段三：建立来源固定的详情服务

目标：本地详情代码没有发起云端请求的能力。

主要修改：

- 定义 `ProjectSpaceDetailServices`。
- 分别构造 `createLocalProjectSpaceDetailServices()` 和
  `createCloudProjectSpaceDetailServices()`。
- `ProjectSpaceDetail` 只接收 `ProjectSpaceContext`。
- 看板、文件、成员、管理、任务详情和执行队列均使用 context 中的固定 API。
- 去掉所有根据项目 ID 重新寻找 API 的逻辑。
- 去掉详情中的 Hybrid service fallback。

预计涉及：

- `wework/src/features/workbench/workbenchServices.ts`
- `wework/src/api/local/localServices.ts`
- `wework/src/api/hybrid/hybridServices.ts`
- `wework/src/features/todo/CloudTodoWorkspace.tsx`
- `wework/src/features/todo/CloudFilesView.tsx`
- `wework/src/features/todo/CloudProjectManageView.tsx`
- `wework/src/features/todo/TodoEditor.tsx`
- `wework/src/features/todo/TaskActivityView.tsx`
- `wework/src/features/todo/ProjectQueueView.tsx`

验收条件：

- 打开本地项目详情后，云端 API mock 的调用次数始终为 0。
- 切换本地详情中的看板、文件、管理和任务抽屉不会发云端请求。
- 本地 API 不可用时明确显示本地错误，不尝试云端 API。

### 阶段四：修复本地项目自动化服务

目标：本地项目自动化不再复用 Backend 项目自动化服务。

当前 `projectAutomationApi` 仅由 Backend Services 创建，而本地 Executor 已有通用
`automationApi`。本次采用“本地规则能力尚未支持”的主路径：

- 本地详情服务不注入 Backend `projectAutomationApi`。
- `ProjectAutomationRulesSection` 在本地 API 缺失时不挂载，不发规则请求。
- 本地自动化页保留由本地详情服务提供的机器人、执行队列、设备和模型能力。
- 独立自动化页继续使用本地 Executor 的通用 `automationApi`。
- 后续若实现本地项目规则，必须先扩展本地 Executor 的项目作用域契约，不得借用 Backend
  数据所有权。

同时拆分自动化所需的辅助目录：

- 本地设备目录只列本地设备。
- 本地模型目录不得触发云端后台刷新。
- 本地团队目录只提供本地可执行的团队或代理配置。
- 本地项目不显示只能由 Backend 管理的 Wegent Team 执行模式。

预计涉及：

- `wework/src/features/todo/ProjectAutomationView.tsx`
- `wework/src/features/todo/ProjectAutomationRulesSection.tsx`
- `wework/src/api/projectAutomations.ts`
- `wework/src/api/local/localServices.ts`
- `wework/src/api/hybrid/hybridServices.ts`
- 必要时涉及 `executor/src/` 的本地自动化命令

验收条件：

- 打开本地项目自动化标签时云端 HTTP 和云端 Runtime IPC 调用次数均为 0。
- 云端断开时本地自动化页面不报云端连接错误。
- 本地不支持的能力明确不可用，不创建 fallback。

### 阶段五：拆分全局聚合视图

目标：跨来源能力不再污染项目详情生命周期。

主要修改：

- 将 `listMyWork()` 从项目详情组件 effect 中移出。
- 为本地和云端“我的工作”建立独立 source state。
- 全局搜索按来源独立请求和合并。
- 离开全局视图时取消对应请求和轮询。
- 进入项目详情后只保留当前来源的详情刷新。

预计涉及：

- `wework/src/features/todo/CloudTodoWorkspace.tsx`
- `wework/src/features/todo/CloudMyWorkView.tsx`
- `wework/src/components/layout/WorkbenchSearchDialog.tsx`
- 新增全局聚合 hooks 或 controller

验收条件：

- 云端“我的工作”请求挂起时，本地结果可见且可操作。
- 本地项目详情挂载期间不产生全局云端聚合请求。

### 阶段六：收口独立自动化页面

目标：`/automations` 页面同样按来源独立展示，避免云端设备失败拖垮本地自动化。

主要修改：

- 删除 Hybrid `automationApi.listAutomations()` 中跨设备 `Promise.all` 的全成全败语义。
- 本地自动化作为主数据源独立加载。
- 每个云端设备作为独立数据源加载并记录错误。
- 自动化 ID 的路由映射同时记录 source 和 device ID。
- 本地自动化操作不通过云端设备发现来确定路由。

预计涉及：

- `wework/src/api/hybrid/hybridServices.ts`
- `wework/src/pages/AutomationsPage.tsx`
- `wework/src/types/automation.ts`

验收条件：

- 云端 Runtime IPC 超时 75 秒时，本地自动化列表仍立即可见。
- 一个云端设备失败不会让本地或其他设备的自动化列表报全局错误。
- 对本地自动化的查看、修改、启停和立即运行不触发云端请求。

## 8. 测试计划

### 8.1 单元测试

新增或更新以下测试。

#### 项目身份与路由

- `projectSpaceKey()` 能区分相同 ID 的本地和云端项目。
- 看板路由能够编码和解析 `projectStore + projectId`。
- 缺少 `projectStore` 的旧详情路由恢复到项目首页。
- Workspace Tab 恢复本地项目时不需要云端数据。

#### 项目列表

- 本地列表完成、云端列表 pending：本地项目立即展示。
- 本地列表完成、云端列表 rejected：本地项目仍可交互。
- 本地列表 rejected、云端列表完成：分别展示本地错误和云端项目。
- 未连接云端：云端 API 调用次数为 0。
- 列表加载期间 `listLoopItems()` 和 `listCloudProjectMembers()` 调用次数为 0。

#### 本地项目详情

为所有云端 API 使用严格 mock：

```ts
const cloudApi = {
  listCloudProjects: vi.fn(() => {
    throw new Error("unexpected cloud request");
  }),
  // 其余方法同样在调用时抛错
};
```

覆盖：

- 打开本地看板。
- 刷新本地看板。
- 打开任务详情。
- 创建、修改、移动、归档任务。
- 打开文件页。
- 打开管理页。
- 打开自动化页。
- 打开执行队列。
- 切换和恢复本地项目标签页。

每个场景均断言云端 HTTP、云端 Delivery API 和云端 Runtime IPC 调用次数为 0。

#### 云端项目详情

- 云端项目仍使用 Backend API。
- 云端详情不会错误使用本地项目 API。
- 本地和云端同 ID 项目不会串数据。

#### 自动化

- 本地自动化独立加载。
- 云端设备请求 pending 或 rejected 不影响本地结果。
- 本地自动化操作不调用云端 Runtime IPC。

### 8.2 组件集成测试

主要扩展：

- `wework/src/features/todo/CloudTodoWorkspace.test.tsx`
- `wework/src/components/layout/DesktopWorkbenchLayout.test.tsx`
- `wework/src/features/workspace-tabs/WorkspaceTabsContext.test.tsx`
- `wework/src/pages/AutomationsPage.test.tsx`
- `wework/src/api/hybrid/hybridServices.test.ts`

测试必须使用可控 pending Promise，而不是依赖真实计时：

```ts
const neverResolvingCloudRequest = new Promise<never>(() => undefined);
```

核心断言不是“最终会恢复”，而是“云端请求未完成时本地功能已经可用”。

### 8.3 Desktop E2E

按照现有 Desktop E2E runner 增加 CI 覆盖的回归场景，不创建本地专用孤立命令。

测试环境：

- 隔离的真实 Electron 会话。
- 本地 Executor 正常。
- 保存一份有效但当前不可达的云端连接配置，或通过测试云端服务稳定模拟连接后断开。
- 创建至少一个本地项目和一条本地任务。

场景：

1. 云端不可达时启动 Wework。
2. 打开项目空间首页。
3. 断言本地项目在普通步骤超时内可见。
4. 打开本地项目。
5. 查看、创建和修改本地任务。
6. 打开本地项目的文件、管理和自动化标签。
7. 打开独立自动化页面，确认本地自动化可见。
8. 检查日志，确认上述本地详情操作期间没有云端项目详情请求。

不得通过重试获得通过结果。出现间歇性失败时必须定位并修复。

### 8.4 真实 Electron 验证

由于修改 Wework UI、服务路由和本地运行时边界，必须使用
`pnpm --filter wework ai:verify` 完成真实 Electron 验证。

至少验证：

- 冷启动。
- 云端断开启动。
- 本地列表。
- 本地详情。
- 本地任务编辑。
- 本地自动化。
- 从本地详情返回项目首页。
- 重新加载和标签页恢复。

保留 `app.log`、`executor.log` 和 Electron 日志作为请求边界证据。

## 9. 诊断日志

为验证请求边界，可在项目空间 API 入口增加结构化诊断日志，但不得记录 token 或项目内容：

```ts
console.info("[ProjectSpace] request", {
  source: "local",
  operation: "listLoopItems",
  projectStore: ref.projectStore,
  projectId: ref.projectId,
});
```

测试和真实 Electron 验证应能够根据日志确认：

- 本地详情只出现 `source=local`。
- 云端列表失败不会阻塞本地列表完成事件。
- 项目来源在请求发出前已经确定。

日志用于确认边界，不用于替代类型约束和自动化测试。

## 10. 风险与处理

### 10.1 Workspace Tab 持久化兼容

旧标签页没有 `projectStore`。不要通过同时请求本地和云端来恢复，避免重新引入耦合。通过存储
版本迁移将旧详情标签恢复到项目首页。

### 10.2 项目 ID 冲突

所有缓存和 UI 状态改用 `projectSpaceKey` 后，必须检查项目卡片 key、详情抽屉、菜单、统计和
任务缓存，防止残留裸 ID。

### 10.3 本地自动化能力不完整

先确认 Executor 的实际能力。缺少能力时应明确禁用，不得调用 Backend 作为隐式实现。

### 10.4 组件拆分范围

`CloudTodoWorkspace.tsx` 已同时承担过多职责。实施过程中应优先删除混合路径并拆分组件，
避免继续在大组件内增加条件分支。

### 10.5 云端连接状态

本次解耦不能依赖 `isConnected` 完全准确。即使缓存状态暂时仍是 connected，只要请求边界
正确，云端故障也只能影响云端数据源。连接状态后续可以独立改进，但不能成为本地正确性的
前提。

## 11. 完成标准

同时满足以下条件后才算完成：

1. 项目身份统一为 `projectStore + projectId`。
2. 本地和云端项目列表拥有独立状态和请求生命周期。
3. 项目列表不再预加载所有项目详情。
4. `apiForProjectId()` 和跨来源 API fallback 被删除。
5. 本地项目详情组件无法访问云端项目服务。
6. 本地项目详情所有功能的云端 API 调用次数为 0。
7. 本地项目自动化不使用 Backend 项目自动化 API。
8. 全局聚合视图按来源独立加载和失败。
9. 独立自动化页面中本地数据不等待云端设备。
10. 聚焦单元测试、组件测试、Desktop E2E 和真实 Electron 验证全部通过。
11. 云端不可达时，本地项目列表和详情在正常交互时间内可用。
12. 没有通过重试、fallback、静默 catch 或跳过测试掩盖失败。

## 12. 建议提交顺序

为降低评审和回归风险，建议按以下顺序提交：

1. `refactor(wework): scope project space identity by store`
2. `refactor(wework): split local and cloud project list loading`
3. `refactor(wework): inject source-bound project detail services`
4. `fix(wework): keep local project automation offline`
5. `refactor(wework): isolate cross-source project aggregations`
6. `fix(wework): load local automations independently from cloud`
7. `test(wework): cover offline local project boundaries`

每个提交都应保持可编译，并运行对应的聚焦测试。最终提交前运行 Wework 的完整测试和真实
Electron 验证。
