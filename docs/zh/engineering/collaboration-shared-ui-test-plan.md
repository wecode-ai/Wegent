---
sidebar_position: 25
---

# 协作共享 UI 双端 E2E 与验收计划

审计日期：2026-09-10
实施更新：2026-09-13

## 已落地的宿主边界

- Wegent Web 与 Wework 都直接挂载 `@wegent/collaboration` 的
  `CollaborationPlatformApp` / `CollaborationApp` 共享组件树。
- Wework 的固定“协作”标签不再通过 iframe 打开 Wegent Web，也不再注册
  `/collaboration` cloud-web 应用。桌面 E2E 直接操作原生共享组件。
- Wework 的宿主适配器合并本地空间与云端空间：本地空间使用设备上的项目、Issue、评论、
  智能体和执行环境服务；云端空间使用共享云 API。
- Wegent Web 只注入云端 API，因此 Web 不显示或创建本地空间、本地项目。
- 空间、项目、看板、Issue、成员、智能体、执行环境、项目设置和调度策略都由共享包渲染；
  宿主只负责 API、路由、账号区和桌面执行能力适配。

这条边界是后续开发的硬约束：不得为协作模块重新增加 iframe，也不得在任一宿主中复制共享业务
视图。

## 目标

### 独立群与 Thread

群是持续存在的讨论容器；Thread 是群内具有生命周期的子会话，项目仅作可选分类。
下表区分已执行的验收和仍待补齐的范围，不能以一个 checkpoint 通过代替完整上线验收。
加入 Thread 不提升群角色；下表中的讨论和执行仍要求当前写入权限及原有私人资源授权。

| 用户故事                    | 可观察结果                                                                           | 验证入口与状态                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 首次使用时直接建群          | 不要求选择项目，空态提供建群及发起 Thread 的入口                                     | `group-thread-collaboration`，真实 Electron 已通过                                                                          |
| 在群中发现尚未加入的 Thread | 群内卡片和列表可打开，只读可见；左侧不出现                                           | 同上，已通过                                                                                                                |
| 按需加入或退出 Thread       | 加入后可讨论并进入左侧；退出后可继续发现，但不再持续订阅                             | 本地、云端 Group checkpoint 与权限测试，已通过                                                                              |
| 完成后继续讨论              | 完成藏在更多操作中；Thread 从左侧移除，群不关闭，已加入成员可继续讨论                | 本地 Group checkpoint 与原生存储测试，已通过                                                                                |
| 重新打开 Thread             | 仅已加入成员的左侧导航恢复                                                           | 本地 Group checkpoint，已通过                                                                                               |
| 编辑 Thread 元信息          | 设置中可编辑统一状态、任意标签、负责人和可选项目关联                                 | 本地 Group checkpoint 与组件测试，已通过                                                                                    |
| 使用群内完整看板            | 看板、表格、日历、甘特、里程碑及保存视图保持可用；默认视图重载保留                   | 本地 Group checkpoint 和 `collaboration-milestones`，已通过                                                                 |
| 在项目中汇总多个群          | 保留真实所属群；项目成员身份不授予群内容读取权；按当前群授权计数                     | 云端 Group checkpoint 与里程碑测试，已通过                                                                                  |
| 归档、恢复与删除里程碑      | 归档列表按可读范围聚合；清除归档 Thread 的里程碑引用后恢复仍正确                     | 本地、云端 Group checkpoint，已通过                                                                                         |
| 将真实私人任务关联到 Thread | 所属群与执行者身份保留，重载后绑定仍在，私人执行回复不进入群聊天                     | 本地 Group checkpoint，已通过；不代表群内智能体完整分配入口已验收                                                           |
| 权限发生变化后再次执行      | 当前参与关系和生命周期重新校验，不能凭旧绑定重新启动或发布消息                       | 原生存储及云端授权测试；新增入口持续补齐                                                                                    |
| 迁移已有公开事项            | 原 ID、讨论、交付、私人执行归属及退出/静音选择保留；受限事项排除                     | 本地真实 Electron 迁移与原私人会话继续已通过；云端真实数据库、对象存储及 CLI 中断回滚／恢复已通过；完整执行资源映射仍待验收 |
| 处理迁移前的迟到提及        | 保留原事件与来源；即使操作者仍是项目管理员和目标群主，真实 Executor 也拒绝旧来源启动 | 云端 Group checkpoint，已通过                                                                                               |

运行入口仍使用统一 runner：

```bash
pnpm --filter wework e2e:desktop --segment group-thread-collaboration
pnpm --filter wework e2e:desktop --segment collaboration-milestones
```

云端 Group 场景复用既有云端 checkpoint、真实 Rust/Python 服务、数据库和对象存储，
不得以模拟内部服务替代。截图与日志仅保存在本地 `wework/test-results/`，不提交仓库。

### 返回看板和聊天身份布局验收

环境继续使用隔离的真实 Electron 与现有本地／云端 Group checkpoints，复用双人云端账号、存储、设备和模型协议；仅模拟模型服务。所有截图与日志留在本地，统一 runner 负责清理测试数据及进程。

1. 在群看板输入搜索词，打开具体事项；应看到明确的“返回看板”。点击后仍是原群、原视图、原搜索与筛选，卡片仍可继续操作。
2. 在项目聚合看板输入搜索词并打开属于群的事项；点击“返回看板”应回到原项目看板，而非群首页，搜索与筛选保留。由群聊天或通知直接打开的事项保留返回所属群的路径；返回不产生加入或授权。
3. 切换账号立即移除旧账号内容和保留的看板状态；隐藏看板清理订阅和请求副作用，恢复时重新读取当前权限及数据。
4. 双人讨论都显示姓名及头像。依据真实当前用户 ID 判断左右，不能用同名或智能体 ID 冒充本人；验证头像实际横坐标：本人在右，另一成员在左。系统生命周期消息居中，事项入口卡片仍可点击。
5. 继续验证历史消息定位、提及、附件、退出和已完成事项讨论。保留首次使用、双人讨论、群看板返回及项目看板返回的截图链，交独立 reviewer 检查。
6. 里程碑筛选下钻取跨里程碑子事项后，隐藏并恢复同一看板仍保留临时钻取；切换项目或视图才清除临时钻取，基础里程碑筛选保留。组件回归同时覆盖未传默认分组的既有调用。

当前结果：组件与状态保留测试通过；新构建的真实 Electron 已验证群看板和项目聚合看板返回后保留搜索词。真实双人云端讨论的姓名、头像与左右坐标断言通过；关键截图独立 review 进行中。

### 群内个人分身手动执行验收

此用例验证既有个人分身入口，不决定群共享智能体的资源策略。环境复用现有云端 checkpoint 的真实 Electron、Rust/Python Backend、MySQL、对象存储、设备及 Codex，仅模型响应受控；所有数据均为隔离测试数据，沿用统一清理。

1. 创建未关联项目的群及事项，保留未指派状态。为当前用户保存一个自动接入关闭、显式选择当前设备 Codex 模型的个人分身。
2. 退出事项后手动执行：必须因尚未加入而拒绝，不调用模型，不创建云端私人任务绑定。
3. 加入事项后再次手动执行：实际创建并完成原生 Codex 会话；事项目标讨论显示分身明确公开的最终回复。
4. 核对绑定属于原执行者和原设备、事项仍属于群且没有被自动指派；保留实际截图。这里的公开分身回复不同于另行关联的私人任务历史，不允许将后者自动同步。
5. 另一位群内只读成员读取该事项的执行绑定，返回空列表；移除其群权限后，同一请求返回 404。

状态：`group-thread-cloud` 已注册同一 CI shard；真实云端完整用例已通过，包括未加入拒绝、加入后的实际执行、原执行者／设备绑定、执行前后未分配、其他只读成员看不到私人绑定及撤权后 404。

独立 UI review 在完整截图链和关键交互收敛后进行；执行权限、迁移写入和资源复制另设关键节点 review。

### 评论区多类型转派

评论输入框的分配菜单与 Issue 详情属性复用同一份候选列表和保存流程，支持成员、
项目机器人、空间智能体、Wegent 智能体及协作小组。成员仍受可分配权限和只读角色限制。
@ 只产生建议，不自动填入转派下拉框。回形针旁显示“转派给：名字”的紧凑提示，
✓ 只把建议填入下拉框，× 忽略本条评论的建议；点击蓝色 @ 标签可切换或重新打开建议。
手动选了 A 后再 @B，A 保持不变，只有采纳 B 的建议才会替换。选择或采纳都不调用转派接口。
有明确目标时，主按钮显示“发送并转派”，先保存评论再提交分配；空正文显示“转派”，不创建空评论。
未选择目标时仍只发送评论，未采纳的建议在发送后保留，已忽略的建议不会重新出现。
转派失败保留目标以便重试，不重复发送已保存并清空的评论。

聚焦组件测试覆盖各类目标选择、最新版本号保存、权限限制和发送失败恢复。
`collaboration-shared-core` 新增真实 Electron 回归：复用已有项目与机器人，创建独立
Issue 和人类负责人小组，依次从评论菜单转派给机器人、小组及成员，逐次检查真实持久化
字段和互斥关系。`collaboration-issue-assignment-activity` 验证 @ 不填值、蓝色标签切换建议、
忽略与重新打开、采纳只填值、未选目标时发送不转派及主按钮实际提交。最后完成并归档新增 Issue，
移除新增小组并返回原 Issue，遵循后端仅允许归档已完成事项的约束。
环境及运行方式沿用下方的统一 checkpoint；仅模型服务使用模拟。

### 长会话追问与后台执行显示

`follow-up-task-switch` 使用隔离 Electron、真实 Executor 与 Codex，仅替换模型响应。
通过原生 Goal 连续执行构造跨页历史，重启后确认最新历史页只有助手回复。

1. 在阅读历史时发送新 Goal，等待真实工具启动并产生进度和计划，再从左侧任务列表切到另一任务并返回。
2. 原生历史必须已经保存追问；无需等待工具完成或下一次模型输出，追问就应完整显示在视口内、输入框上方。
3. 另一任务先完成一轮回复，再打开真实 Wework 内置浏览器并缩窄会话列、开始新 Goal；后台进度返回后必须仍可见。
4. 切回后先向上阅读，再滚动到底，必须能到达最新追问。组件测试同时保证向前翻页补入旧用户消息不会抢走阅读位置。
5. 在两个原生轮次中复用同一个子代理，让新轮次超过历史分页预算；切回任务后，旧回复必须保留原轮次身份，不能被并入新追问。

子代理线程身份不能用于判定两个执行轮次相同。原生历史缺少旧轮次结束记录时，仅最新原生轮次显示实时计时；保留旧轮次的原生状态，不补造结束时间。
组件测试覆盖旧历史计时停止、当前轮次计时继续，并确认原生历史对象未被修改。

运行命令：`pnpm --filter wework e2e:desktop --segment follow-up-task-switch`。
该 checkpoint 注册于统一桌面 runner 与 Core CI；截图、日志和隔离历史只保留在 `wework/test-results/`。

### 父子事项与并发看板

Web 协作与 Wework 在现有看板工具栏提供一致的个人「按父事项」布局，不替换已有泳道或保存视图。
Web 平台组件测试覆盖入口显示、切换后按父事项展示子事项，以及关闭后恢复普通看板。
普通布局继续只展示当前层事项；父子布局按直接父事项分行，保留独立事项与进入子级的入口。
完成数量和并行数量按当前用户可读取的直接子事项计算，并按事项 ID 去重；搜索和泳道筛选只
改变卡片投影，不改变父事项的整体完成数量。详情提供父项链接、子项列表与新建子项入口。

`collaboration-parent-board` 在统一桌面 runner 和 CI checkpoint 列表中注册，使用隔离
Electron、真实本地 Executor 和真实持久化接口，无需模型响应。每次独立建立项目及三层事项。

1. 普通看板保持原外壳及当前层投影；开启父子布局后，同一父项的开发与测试子项同时展示。
2. 验证父子详情双向跳转、完成数量、展开收起及进入孙级看板。
3. 拖动 tag 卡片只改源/目标标签，保留业务标签、状态和父项；跨父空白单元格及卡片落点不得改写数据。
4. 独立更新子项状态后，只更新父项完成数量，其他子项不自动完成或启动。
5. 从详情新建子项，验证真实存储中的 `parent_id`；刷新后保留关联与个人布局。
6. 检查完整窗口、窄窗口和深色主题，保留每一步的本地截图；不可读子项与跨项目关系由聚焦组件测试覆盖。

聚焦命令：`pnpm --filter wework e2e:desktop --segment collaboration-parent-board`。
截图和运行日志仅保留在 `wework/test-results/`，不得提交仓库。

### 交付批次与会话快照回归

`collaboration-deliveries` 使用隔离 Electron、真实本地 Executor 和文件存储；无需模型响应。
每次独立创建项目、Issue 和三批已完成交付：说明＋选中消息＋两个文件、项目讨论会话、单个文件。

1. 列表默认显示最近两批，展开后展示全部批次；显示说明首行、消息数、附件数与文件名、交付人及本地时间。
2. 点击混合交付，验证说明、Markdown 加粗、从 3 开始的有序列表和附件路径；
   详情的左边界、宽度必须与原 Issue 抽屉一致，不能再次按侧栏宽度缩窄。
3. 返回后打开项目讨论会话，按原顺序展示用户和助手消息；同时支持 Runtime 的 `role`
   与项目讨论的 `sender.type` 快照格式。只有会话时不显示空说明和附件区域。
4. 只有文件时不显示会话和空说明；关闭并重新打开同一 Issue 后仍可读取持久化的交付。
5. 单元测试补充不同交付人、成员姓名不可用、内容加载中及失败状态；加载失败不能误报无内容。

聚焦命令：`pnpm --filter wework e2e:desktop -- --segment collaboration-deliveries`。
该 checkpoint 在统一 runner 与 Core CI shard 中注册。隔离项目与文件随 runner 环境清理；
日志和截图只保留在 `wework/test-results/`，不提交到仓库。

### 执行动态顺序回归

在隔离 Electron 中分别运行 `collaboration-local-agent-dispatch` 和
`collaboration-remote-agent-dispatch`。场景使用独立项目与 Issue，只模拟模型响应，
其余存储、调度和执行器保持真实。

1. 将 Issue 分配给单个智能体，保持模型响应未完成。动态中“进行中”状态记录必须位于执行卡片之前。
2. 释放模型响应，等待 Issue 进入“待确认”。完成状态记录必须位于执行详情之前，卡片必须显示实际结果。
3. 用户评论触发执行时，讨论保留创建时间位置，执行卡片单独排在状态记录后。
   后续回复仍关联原讨论和执行会话，不能因展示分组而创建重复执行。
4. 后端持久化测试检查状态记录与活动时间；同秒但不同子秒精度的状态和结果也必须正确排序。
   成功、失败、取消及断线恢复均覆盖，用户讨论始终使用创建时间。

执行卡片使用服务端在状态修改后记录的 UTC `metadata.activity_at`；缺少该字段的历史执行
使用已存储的更新时间，其精度取决于原始数据。展示时间与排序使用同一个共享函数。
验证结束后停止隔离 Electron，保留 runner 日志和截图于测试结果目录，不提交这些临时产物。

### 合并队列中的异步保存回归

- `task-model-deletion` 使用真实设置界面删除模型。原生配置通知与保存后的刷新并发时，
  保存必须等待最终快照发布后关闭编辑框；随后在原任务内选择替代模型并继续原会话。
- Web `settings-bot.spec.ts` 在真实执行引擎目录尚未返回时不能提交创建。
  加载结束后保存共享基础能力，检查 Bot 和 Team 的请求及持久化结果，并清理创建的资源。
- 定向单元测试分别延迟原生刷新和执行引擎响应，覆盖上述等待条件；现有 E2E 断言保持不变。

### 执行时长时区回归

`collaboration-shared-core` 在 `TZ=Asia/Shanghai` 下运行真实 Backend 和隔离 Electron。
通过现有评论执行流程创建任务绑定，返回 Issue 详情后读取 `issue-execution-duration`，
与真实 `/loop-items/{id}/tasks` 的最早有效绑定时间比较，允许一分钟的显示取整误差。
新建执行必须显示分钟数，不能因无时区后缀的 UTC 时间被当成本地时间而多出八小时。
单元测试同时覆盖显式偏移、混合时间排序和无效时间；全部无效时不显示时长。
场景沿用现有清理流程归档测试项目，不接触用户项目。

运行命令：`pnpm --filter wework e2e:desktop --segment collaboration-shared-core`。

Linux 和 macOS 桌面构建缓存指纹必须包含 `packages/collaboration`，否则共享 UI
改动可能复用旧产物。缓存脚本测试覆盖新增和修改共享包文件时的缓存失效。

配套状态回归使用 `e2e:desktop:cloud --segment model-routing`：真实远程执行器完成文本轮次后，
工具轮次必须继续发送并生成文件，不能因旧运行快照覆盖终态而滞留队列。状态单测重放
毫秒精度启动时间与同秒、秒精度完成时间，要求旧快照不能复活任务，而更新的执行仍可启动。
`e2e:desktop:cloud --segment goal-lifecycle` 覆盖远程目录控件挂载后的读取与完整 Goal 生命周期；
控件挂载和值检查共用原有步骤超时，场景结束后清理隔离设备与数据库。
执行器任务列表必须保留 `goalExecutionStatus`，让重启后的界面在轮次间隙仍能识别运行或恢复中的
Goal；响应序列化单测覆盖运行、恢复、需要处理以及普通任务不带该字段的情况。

本计划用于证明以下结论，而不只是证明两个宿主“看起来都能用”：

1. Wegent Web 与 Wework 挂载的是 `@wegent/collaboration` 导出的同一个协作 UI 根组件。
2. 两端对云端项目空间提供相同的页面结构、交互流程、状态语义和后端能力。
3. 宿主差异只通过显式的 host adapter 或 capability 注入；云端业务逻辑、状态管理和视图不得在宿主目录中重复实现。
4. Wework 的本地项目、终端、原生文件选择等桌面能力可以作为适配能力存在，但不能改变或替代共享云端主流程。
5. “我的任务”和默认看板必须保留，并在两端使用同一共享实现。

本文同时记录测试与验收门禁。架构迁移导致旧 E2E 断言 iframe 时，必须依据真实组件挂载证据将其
改为共享原生组件断言；不得弱化业务步骤或用模拟响应替代真实后端。

## 当前状态审计

### 挂载结构

当前代码已经建立共享 UI 边界：

- Web 的 `frontend/src/features/collaboration/CollaborationPage.tsx` 挂载
  `@wegent/collaboration` 的共享 `CollaborationPlatformApp`。
- Wework 固定“协作”标签挂载 `WeworkCollaborationPlatform`，由它适配本地与云端 API，并渲染
  同一个共享 `CollaborationPlatformApp`。
- `CloudTodoWorkspace` 只保留在独立的 legacy `defaultWorkItemsOpen` 路径中，不是固定“协作”
  标签的 UI 根节点，也不能再作为共享挂载验收目标。

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

Wework 场景现在从 `wework-collaboration-platform` 和
`collaboration-platform-root` 进入原生共享模块；共享 Issue 编辑器或桌面 Runtime 能力仍保留
各自的功能选择器：

| 现有 checkpoint / 流程               | 已有证据                                                                       | 不能证明的内容                                 |
| ------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| `workspace-tabs`                     | 固定项目空间 tab、默认关联项目、“我的任务”上下文、避免重复 tab                 | Web 路由；共享组件挂载                         |
| `task-status-sync` 中的 My Work 流程 | 完成任务进入“我的任务”，陈旧运行态不会复活任务                                 | Web 的我的任务；完整视图与筛选对等             |
| `offline-local-project-space`        | 本地项目创建、空看板引导、Issue 创建/更新/拖拽，并能进入文件、成员和自动化入口 | 云端双端对等；文件/成员/自动化的 CRUD          |
| `board-focus-view`                   | 看板运行态、分组、专注视图、列宽和状态恢复                                     | Web 对等；共享 DOM 结构                        |
| `project-automation`                 | 原生共享挂载，以及通过真实后端创建和恢复“项目设置”内的调度策略                 | 所有 Runtime 执行分支；完整 Web 对等矩阵       |
| `task-attachments`                   | 云端交付物文件树、面包屑和预览                                                 | 普通共享文件的上传、重命名、删除、下载双端对等 |
| `project-assignment-notification`    | 分配通知和用户隔离                                                             | 协作页面上的角色可见性和操作权限矩阵           |

这些场景提供真实桌面证据；由于 Web 不运行桌面 checkpoint，双端对等仍需结合 Web
Playwright 套件验收。

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

### 导航归属

- 顶层“任务 / 协作 / 智能体”等模块切换属于宿主外壳。
- 进入协作模块后，空间首页、项目、成员、智能体、执行环境和设置等上下文导航属于共享协作
  平台；Web 不得同时挂载任务/对话侧栏，形成两套并列主导航。
- 桌面端使用共享协作侧栏。移动端使用同一组共享导航项的横向滚动布局，交互控件高度不得低于
  `44px`，不能回退到任务模块侧栏。

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

共享架构删除 Wework 私有页面或选择器时，应更新受影响的现有 E2E，使其进入原生共享模块，并保留
仍然有效的业务断言。已经不存在的画布或 iframe 页面不得继续作为验收目标。

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

1. 打开“项目设置”，进入“分配与调度”。
2. 创建调度策略，配置触发方式、计划、时区、分配模式和管理者指令。
3. 保存后验证真实后端 definition。
4. 切换其他策略、新建额外策略，并验证编辑、启用、停用和删除。
5. 执行“立即运行”，验证生成运行记录和关联 Issue/Task。
6. 打开运行记录，验证状态、开始/结束时间和错误。
7. 刷新并从另一端打开相同策略与运行记录。
8. 未保存草稿、离开确认和版本冲突行为两端一致。
9. 无管理权限时只展示允许的只读信息，或明确提示联系项目管理员。

项目级流程画布不再属于此生命周期；共享 parity suite 负责覆盖完整的调度策略主流程。

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
