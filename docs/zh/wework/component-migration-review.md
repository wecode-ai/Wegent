---
sidebar_position: 31
---

# Wework 组件迁移评审记录

此记录区分源码审查、Story 运行检查与原生真实页面验收。源码入口迁移、类型检查或成功构建均不等于产品逐界面验收。证据快照截至 2026-11-19；行号与初始结论属于审查时刻，后续源码修复单独标明。

## 合并后的验证基线

2026-11-19 已合并主分支并解决冲突。应用与 Storybook 类型检查通过；Wework lint 为0错误、6条警告，控件审计2223个生产TypeScript文件、0项待迁移。设置导航与搜索的29个定向测试通过。最新静态 Storybook 构建包含 209 个示例和 54 份 Docs，本轮新增 Composer Context Row。

窄屏设置已抽取共享 SettingsShell，模型连接表单已改用公共字段密度；两项随后在打包实例中复核，见下文。使用 Redis 7 的隔离打包 E2E 已通过 workspace-tabs，包括先前失败的 Issue 描述替换。不得将构建、控件审计或旧截图替代本轮原生验收。

隔离的 macOS arm64 Electron 打包实例已从账户菜单进入设置，在 480、768 和 1440 CSS 像素宽度通过设置导航逐一打开 19 个入口。对应正文 `clientWidth` 分别为 472–480、520–528 和 1192–1200 CSS 像素，57 次测量中 `scrollWidth` 均等于 `clientWidth`。这 19 个入口是关于、外观、Appshots、已归档对话、浏览器、电脑操作、连接、上下文、执行环境、通用、Git 托管、Hooks、快捷键、模型、插件、代理、快捷短语、Runtime 和工作树。

窄屏截图确认快捷键标题、快捷短语行操作和执行环境按钮可见。工作树捕获时仍在加载，Runtime 未连接云端。模型设置 E2E 已覆盖模型连接新增、编辑和删除。

另一个隔离打包实例通过本地项目打开了普通任务、记录事项和创建任务三个 Composer，发现记录事项的项目选择器位于底栏。调整后用隔离源码 Electron 在 1440×869 CSS 像素视口逐一打开协作首页的记录事项与创建任务。两个选择器均高 28 CSS 像素，显示同一项目名称，底边与编辑区顶边相距 11 CSS 像素。打包 `collaboration-issue-task-discovery` E2E 已通过位置和高度比较、切换项目后的草稿恢复及任务提交。该场景使用真实协作服务和测试模型服务。

任务首页迁移到共享 ScrollArea 后，新增内容层未撑满工作区。修复后隔离 Electron 的 1440×900、1024×768 和 768×680 窗口中，首页横向填满工作区，输入框水平居中且底部间距均为 8 CSS 像素。1440 像素宽窗口中的输入框宽度为 736 CSS 像素，四张快捷卡片在同一行。

协作助理面板的桌面通知提示已使用共享紧凑图标按钮。在隔离 Electron 的 1440 和 1180 CSS 像素宽窗口中，关闭按钮均为 28 像素高，位于提示右上角。较窄时两项文字操作换到第二行，点击关闭后提示消失。

打包核心流程的截图还覆盖云端工作空态、拖放浮窗输入框、任务侧栏 Issue 详情、看板 Issue 抽屉、任务关联弹窗和工作树创建进度。逐张核对了可见区域和对应控件。云端工作截图为未连接状态，任务关联截图为首次选择其他项目后的状态。修复后的打包流程已验证再次选择当前项目会打开事项搜索，选择另一事项后可读取新关联的详情和动态。

macOS arm64 打包 `core-task-flow` 已完整通过。任务关联弹窗在加载、过滤和滚动时记录了 125 帧。弹窗、搜索框和创建按钮在这 125 帧中保留同一挂载，位置和尺寸最大变化为 0 CSS 像素。

隔离源码 Electron 在 1440×900 CSS 像素视口复核了插件市场、应用页、已安排、助理首启引导、助理主页、待你处理、通知列表和通知设置。助理通过「先聊天，稍后连接」进入主页。插件市场显示远程插件加载失败提示，同时仍显示本地插件条目。应用页、已安排和待你处理覆盖未配置或空列表。待你处理、通知列表和通知设置的可见容器在 1440 和 768 CSS 像素宽度均无横向溢出。在 768 CSS 像素宽度通过展开侧栏进入插件、应用、已安排和助理，四个实测容器均在窗口内且无横向溢出。插件市场的筛选和搜索在 768 CSS 像素宽度分两行，在 1440 CSS 像素宽度同行排列。已安排列表两种宽度下均保留 20 CSS 像素的内部留白。插件、应用和云端能力加载后的交互仍待复核。

同类控件的底色、尺寸、圆角、交互状态由组件库提供。Composer 的代码工作区、协作项目、执行方式和分支选择共用上下文触发器规格。普通表单输入、下拉和文本域共用描边表面。确认弹窗以及项目、插件、站点和设备设置的对话框页脚用共享按钮的主操作、普通操作和删除变体。业务代码提供标签、状态、选项和处理函数。新增 ComposerContextRow 示例把三个上下文入口放在同一行，可在 Storybook 中对照。

隔离源码 Electron 在协作创建任务中测得代码工作区、协作项目、执行方式三个触发器均高 28 CSS 像素，边框、底色、字重和圆角一致。项目选项浮层在剩余空间足够时从触发器上方展开。插件管理中的创建、安装按钮和安装输入均高 36 CSS 像素，空输入时安装按钮使用共享禁用样式。已安排侧栏的已加载项目行没有六点手柄覆盖。

## 范围与状态

静态入口清单扫描 3311 个生产源文件，识别 234 个 source owner：80 个 popup owner、45 个 Page、76 个 dialog/drawer、25 个 panel 和 8 个 registered surface。source owner 是文件级入口归属，不是 234 个独立页面。下方仅逐项覆盖其中 45 个 Page 文件；壳、re-export、委托子组件也保留为独立源码记录。初始清单有12个未解析入口，最新归属核对见下节。

45 页的 `review_status` 均为 `source_reviewed_ui_not_reviewed`；不将其改写为实机通过。初始 34 项源码发现中，33 项记录了源码修复，剩余 HomePage 文案本轮仅接入 i18n。修复状态 `fixed_source_pending_real_ui_review` 表示源码已改，仍待真实 UI。

应用壳 provider 线索为 `WorkbenchProvider`、`AppUpdateProvider`、`CloudConnectionProvider`、`AuthProvider`、`AppearanceProvider`、`AppPreferencesProvider`、`NotificationTaskSourceProvider`、`WorkspaceTabsProvider`、`RuntimeInteractionsProvider`。provider 在壳中存在，不证明隔离 Story 已满足它；下列权限标识也是静态线索，不是权限断言。

## 动态入口与闲置实现核对

本轮追踪了初始清单中12个未解析入口：5个动态路由、1个全局弹层、1个条件插槽、1个hook返回控件、1个仅库示例使用的组件、1个未挂载占位模块，以及2个没有渲染调用的旧实现。未解析入口归属已查清，但动态注册的静态证据不代表实际进入并验收。旧任务创建弹窗和详情面板共1680行已删除；仍被使用的数据类型移至todoTypes.ts，6处类型引用同步调整，不保留兼容转发。

| 源码归属                                                                              | 分类           | 入口或结论                                                                                                 | 证据                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wework/src/pages/HomePage.tsx`                                                       | 未挂载占位模块 | No production import, JSX consumer, route or dynamic descriptor found                                      | [App.tsx](../../../wework/src/App.tsx) / [HomePage.tsx](../../../wework/src/pages/HomePage.tsx)                                                                                                                           |
| `wework/src/features/todo/TodoCreateDialog.tsx`                                       | 已删除闲置实现 | No render consumer; retained TodoDetailItem/TodoViewState in todoTypes.ts                                  | [todoTypes.ts](../../../wework/src/features/todo/todoTypes.ts)                                                                                                                                                            |
| `wework/src/features/todo/TodoDetailPanel.tsx`                                        | 已删除闲置实现 | No render consumer; retained TodoDetailItem/TodoViewState in todoTypes.ts                                  | [todoTypes.ts](../../../wework/src/features/todo/todoTypes.ts)                                                                                                                                                            |
| `wework/dsh/conversation-export/src/dialog.tsx`                                       | DSH 全局弹层   | conversation-export.open → wework.shell.overlay                                                            | [client.js](../../../wework/dsh/conversation-export/client.js) / [vite.config.ts](../../../wework/vite.config.ts)                                                                                                         |
| `wework/dsh/ui-applications/src/SitesPage.tsx`                                        | DSH 路由       | /sites                                                                                                     | [client.js](../../../wework/dsh/ui-applications/client.js) / [route.tsx](../../../wework/dsh/ui-applications/src/route.tsx) / [vite.config.ts](../../../wework/vite.config.ts)                                            |
| `wework/dsh/ui-automations/src/AutomationsPage.tsx`                                   | DSH 路由       | /automations                                                                                               | [client.js](../../../wework/dsh/ui-automations/client.js) / [route.tsx](../../../wework/dsh/ui-automations/src/route.tsx) / [vite.config.ts](../../../wework/vite.config.ts)                                              |
| `wework/dsh/ui-cloud-work/src/CloudWorkPage.tsx`                                      | DSH 路由       | /cloud-work                                                                                                | [client.js](../../../wework/dsh/ui-cloud-work/client.js) / [route.tsx](../../../wework/dsh/ui-cloud-work/src/route.tsx) / [vite.config.ts](../../../wework/vite.config.ts)                                                |
| `wework/dsh/ui-git/src/environment-section.tsx`                                       | DSH 插槽       | wework.conversation.summary / git-summary; required wework.environment; workspace.isGitRepository != false | [client.js](../../../wework/dsh/ui-git/client.js) / [vite.config.ts](../../../wework/vite.config.ts)                                                                                                                      |
| `wework/dsh/ui-plugin-center/src/PluginCreatePage.tsx`                                | DSH 路由       | /plugins/create                                                                                            | [client.js](../../../wework/dsh/ui-plugin-center/client.js) / [create-route.tsx](../../../wework/dsh/ui-plugin-center/src/create-route.tsx) / [vite.config.ts](../../../wework/vite.config.ts)                            |
| `wework/dsh/ui-plugin-center/src/PluginManagementPage.tsx`                            | DSH 路由       | /plugins/manage                                                                                            | [client.js](../../../wework/dsh/ui-plugin-center/client.js) / [management-route.tsx](../../../wework/dsh/ui-plugin-center/src/management-route.tsx) / [vite.config.ts](../../../wework/vite.config.ts)                    |
| `packages/collaboration/src/project-assistant-status/ProjectAssistantStatusPanel.tsx` | 组件库示例     | ProjectAssistantStatus.stories.tsx; no production mount found                                              | [index.ts](../../../packages/collaboration/src/project-assistant-status/index.ts) / [ProjectAssistantStatus.stories.tsx](../../../packages/collaboration/src/project-assistant-status/ProjectAssistantStatus.stories.tsx) |
| `packages/collaboration/src/project-board/useBoardTagFilter.tsx`                      | hook 返回控件  | useBoardTagFilter().control                                                                                | [CloudTodoWorkspace.tsx](../../../wework/src/features/todo/CloudTodoWorkspace.tsx) / [ProjectBoardAdapter.tsx](../../../packages/collaboration/src/web-adapter/ProjectBoardAdapter.tsx)                                   |

## 45 页源码逐项记录

审查维度包括公共控件选型、按钮语义、字段密度、删除颜色、重复普通控件及 SDK CSS 状态契约。未列发现不代表视觉或行为通过。入口仅记录静态可解析调用方；需结合登录、设备、连接与业务权限进入真实状态。

### 1. HomePage

[wework/src/pages/HomePage.tsx](../../../wework/src/pages/HomePage.tsx)

初始源码结论：纯占位展示，无交互控件；硬编码英文副标题需要纳入 i18n，不能视为已完成产品页面。

修复记录：原英文占位副标题改用 `common.homePage.workspaceComingSoon`，中文与英文保持原占位含义；未增加功能承诺。

入口/调用方：未发现生产导入、渲染调用或动态注册；当前为未挂载占位源码，不属于可进入的产品页面。

依赖/委托：无明确 hook/权限线索；仍需解析 host/provider 与数据前提。

### 2. LoginPage

[wework/src/pages/LoginPage.tsx](../../../wework/src/pages/LoginPage.tsx)

初始源码结论：登录与管理员设密委托生产表单，OIDC 按钮显式 type=button；表单字段和错误密度需到两个真实子表单检查。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[wework/src/App.tsx](../../../wework/src/App.tsx)

依赖/委托：hooks: `useAuth`, `useTranslation`；委托：`AdminPasswordSetupForm`, `PasswordLoginForm`

### 3. OidcCallbackPage

[wework/src/pages/OidcCallbackPage.tsx](../../../wework/src/pages/OidcCallbackPage.tsx)

初始源码结论：只显示 OIDC 处理中状态；没有输入或删除操作，认证跳转逻辑不在视觉结论内。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[wework/src/App.tsx](../../../wework/src/App.tsx)

依赖/委托：hooks: `useAuth`, `useTranslation`

### 4. PopoutWorkbenchPage

[wework/src/pages/PopoutWorkbenchPage.tsx](../../../wework/src/pages/PopoutWorkbenchPage.tsx)

初始源码结论：三个标题栏图标按钮均有 aria-label 和 type=button；重复的 h-8/w-8/rounded-lg 可复用 IconButton，但 Electron 拖拽区域属性必须保留。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[wework/src/App.tsx](../../../wework/src/App.tsx)

依赖/委托：hooks: `useWorkbench`, `useTranslation`；委托：`SquarePen`, `DesktopWorkbenchMain`

### 5. ProcessExplorerPage

[wework/src/pages/ProcessExplorerPage.tsx](../../../wework/src/pages/ProcessExplorerPage.tsx)

初始源码结论：页面仅绑定 ProcessExplorerView 与 host ports；按钮、排序及字段实际属于委托视图。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[wework/src/App.tsx](../../../wework/src/App.tsx)

依赖/委托：委托：`ProcessExplorerView`

### 6. WeworkAuthorizePage

[wework/src/pages/WeworkAuthorizePage.tsx](../../../wework/src/pages/WeworkAuthorizePage.tsx)

初始源码结论：成功/失败/过期状态使用语义图标；两个关闭按钮使用 primary 又本地覆盖圆角、颜色与 padding。

修复记录：重复按钮配方（原证据行 115）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 137）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：[wework/src/App.tsx](../../../wework/src/App.tsx)

依赖/委托：hooks: `useAuth`, `useTranslation`；委托：`CheckCircle2`, `XCircle`, `AlertCircle`

### 7. WorkbenchPage

[wework/src/pages/WorkbenchPage.tsx](../../../wework/src/pages/WorkbenchPage.tsx)

初始源码结论：仅选择桌面/移动布局并绑定运行时；不可把 Page 适配层无控件误判为整个工作台通过。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[wework/dsh/ui-core-apps/src/app-surface.tsx](../../../wework/dsh/ui-core-apps/src/app-surface.tsx)

依赖/委托：hooks: `useWorkbench`；委托：`SystemDragBridge`, `DesktopWorkbenchLayout`, `TaskWorkbenchPage`, `WorkbenchPageLayout`, `MobileWorkbenchLayout`

### 8. WorkbenchErrorPage

[wework/src/components/common/WorkbenchErrorPage.tsx](../../../wework/src/components/common/WorkbenchErrorPage.tsx)

初始源码结论：共享 Button 的重载操作显式 type=button、testid；alert 展示无字段、无删除。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[wework/src/main.tsx](../../../wework/src/main.tsx)；[wework/src/components/common/WorkbenchErrorBoundary.tsx](../../../wework/src/components/common/WorkbenchErrorBoundary.tsx)

依赖/委托：hooks: `useTranslation`

### 9. AboutSettingsPage

[wework/src/components/settings/AboutSettingsPage.tsx](../../../wework/src/components/settings/AboutSettingsPage.tsx)

初始源码结论：设置组和开关已共用；AboutActionButton 重复 primary 视觉配方，AboutLink 也重新指定小字号与间距。

修复记录：重复按钮配方（原证据行 54）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：`/settings/about`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `ReleaseRollbackSettings`, `ProgressBar`, `AboutLink`

### 10. AppshotsSettingsPage

[wework/src/components/settings/AppshotsSettingsPage.tsx](../../../wework/src/components/settings/AppshotsSettingsPage.tsx)

初始源码结论：设置行和开关共用；打开系统设置的 outline 按钮重复定义圆角、边框和 text-xs。

修复记录：重复按钮配方（原证据行 86）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：`/settings/appshots`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `SettingsPageHeader`, `ScanLine`, `KeyboardShortcut`

### 11. ArchivedConversationsSettingsPage

[wework/src/components/settings/ArchivedConversationsSettingsPage.tsx](../../../wework/src/components/settings/ArchivedConversationsSettingsPage.tsx)

初始源码结论：归档过滤/分组委托已有组件；删除确认已是 destructive，仍以本地红色和圆角覆盖共享配方。

修复记录：重复按钮配方（原证据行 305）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：`/settings/archived-conversations`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`DialogSurface`, `SettingsPage`, `SettingsPageHeader`, `ArchivedConversationsFilters`, `ArchivedConversationGroups`, `DeleteArchivedConversationDialog`

### 12. BrowserHistoryPage

[wework/src/components/settings/BrowserHistoryPage.tsx](../../../wework/src/components/settings/BrowserHistoryPage.tsx)

初始源码结论：搜索字段、勾选和操作菜单共用；重试/删除所选按钮仍用 unstyled+完整灰色按钮样式，删除颜色需与统一策略核对。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[wework/src/components/settings/BrowserSettingsPage.tsx](../../../wework/src/components/settings/BrowserSettingsPage.tsx)

依赖/委托：hooks: `useTranslation`；委托：`Globe`, `HistoryEntryFavicon`, `ActionMenu`, `History`, `ChevronDown`, `HistoryEntryRow`, `ClearBrowserDataDialog`, `TransientNotice`

### 13. BrowserSettingsPage

[wework/src/components/settings/BrowserSettingsPage.tsx](../../../wework/src/components/settings/BrowserSettingsPage.tsx)

初始源码结论：设置行、共享 Select 和 Switch 适用；清除数据已走 destructive-ghost，普通管理/重置按钮仍有重复灰色配方。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：`/settings/browser`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`BrowserHistoryPage`, `SettingsPage`, `SettingsPageHeader`, `History`, `FolderOpen`, `ClearBrowserDataDialog`

### 14. ComputerUseSettingsPage

[wework/src/components/settings/ComputerUseSettingsPage.tsx](../../../wework/src/components/settings/ComputerUseSettingsPage.tsx)

初始源码结论：设置行与开关共用，权限操作 outline 按钮再次声明边框、圆角和小字号。

修复记录：重复按钮配方（原证据行 80）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：`/settings/computer-use`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `SettingsPageHeader`, `MonitorCog`

### 15. ConnectionsSettingsPage

[wework/src/components/settings/ConnectionsSettingsPage.tsx](../../../wework/src/components/settings/ConnectionsSettingsPage.tsx)

初始源码结论：设备操作中普通、主、危险按钮已接共享行为但保留完整局部配方；侧栏 resize 仍用自定义按钮调用 hook，需要与新 Resizable 迁移范围核对。

修复记录：重复按钮配方（原证据行 167）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 268）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 397）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 1159）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 1231）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：桌面工作台在设置打开时挂载连接设置壳。核心设置插件注册 `/settings/connections`，并在壳内加载设备设置子页。[/settings/connections 注册](../../../wework/dsh/ui-core-settings/client.js)、[桌面工作台](../../../wework/src/components/layout/DesktopWorkbenchLayoutView.tsx)、[核心设置模块](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useCloudConnection`, `useTranslation`；权限相关标识（非授权结论）：`isConnected`；委托：`Pencil`, `DeviceVersionBadge`, `StatusPill`, `DeviceSurfaceDeviceAction`, `ActionMenu`, `CloudDeviceRestartProgress`, `AlertCircle`, `Terminal`, `RemoteTerminal`, `ConfirmDeleteDeviceDialog`, `CloudDeviceConnectionInfoDialog`, `DeviceCard`, `Code2`, `SettingsPage`, `SettingsPageHeader`, `RemoteTaskAccessSetting`, `DshSettingsSectionSurface`, `CloudConnectionDialog`, `LogOut`, `CloudModelsSection`, `ConnectorConnectionsSection`, `DeviceSection`, `DeviceGitSyncSection`, `AddCloudDeviceDialog`, `WorkbenchCloudDeviceRestarts`, `DesktopTopBar`, `ArrowLeft`, `ExperimentalBadge`, `DshSettingsSurface`, `DshSlotSurface`

### 16. ContextSettingsPage

[wework/src/components/settings/ContextSettingsPage.tsx](../../../wework/src/components/settings/ContextSettingsPage.tsx)

初始源码结论：两个相同保存按钮重复 primary 配方；文本域重复背景、边框、圆角、focus 样式，普通字段密度须实测。

修复记录：重复按钮配方（原证据行 243）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 281）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：`/settings/personal/context`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `SettingsPageHeader`, `Terminal`, `CodexPersonalitySettings`, `Save`

### 17. ExecutionEnvironmentsSettingsPage

[wework/src/components/settings/ExecutionEnvironmentsSettingsPage.tsx](../../../wework/src/components/settings/ExecutionEnvironmentsSettingsPage.tsx)

初始源码结论：Node/Python 操作直接使用共享 Button outline/ghost，未发现直接重复视觉配方；状态与权限仍需真实运行时。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：`/settings/execution-environments`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `SettingsPageHeader`, `Box`, `FolderOpen`, `RotateCcw`, `RefreshCw`, `Download`

### 18. GeneralSettingsPage

[wework/src/components/settings/GeneralSettingsPage.tsx](../../../wework/src/components/settings/GeneralSettingsPage.tsx)

初始源码结论：共享设置行、选择和开关已复用；外部导入、快捷键记录和行为选项仍有局部 unstyled 配方，不能仅以标签类型判断正确性。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：`/settings`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useCloudConnection`, `useWorkbench`, `useTranslation`, `useContext`；权限相关标识（非授权结论）：`isConnected`；委托：`SettingsPage`, `SettingsPageHeader`, `DefaultRunnerSetting`, `SettingsSegmentedControl`, `GeneralFixedWorkspaceTabs`, `DshSettingsSectionSurface`, `RuntimeConcurrencySettings`, `Bell`, `ReplyPredictionSettings`, `TelemetryCollectionNotice`, `KeyboardShortcut`, `Pencil`, `ExternalContentImportDialog`, `ConfirmDialog`

### 19. GitHostingSettingsPage

[wework/src/components/settings/GitHostingSettingsPage.tsx](../../../wework/src/components/settings/GitHostingSettingsPage.tsx)

初始源码结论：Git CLI 刷新、安装、登录复制均有相同 unstyled 灰色按钮配方，可提取共同样式；开关复用 SettingsSwitch。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[wework/dsh/ui-git/src/settings-page.tsx](../../../wework/dsh/ui-git/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `SettingsPageHeader`, `RefreshCw`, `GitBranch`

### 20. HarnessSettingsPage

[wework/src/components/settings/HarnessSettingsPage.tsx](../../../wework/src/components/settings/HarnessSettingsPage.tsx)

初始源码结论：工具展开、启用和权限选择语义分离；可执行文件选择 outline 再写完整配方，重置图标可复用 IconButton。

修复记录：重复按钮配方（原证据行 309）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：`/settings/harnesses`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `SettingsPageHeader`, `ExperimentalBadge`, `SquareTerminal`, `ChevronDown`, `FolderOpen`, `RotateCcw`

### 21. KeyboardShortcutsSettingsPage

[wework/src/components/settings/KeyboardShortcutsSettingsPage.tsx](../../../wework/src/components/settings/KeyboardShortcutsSettingsPage.tsx)

初始源码结论：搜索用 compact TextField；快捷键录制和重置为共享行为，清除用 DeleteIconButton；录制按钮 min-h-8 的移动触控目标需实际确认。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：`/settings/personal/keyboard-shortcuts`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`KeybindingPart`, `CornerDownLeft`, `SettingsPage`, `SettingsPageHeader`, `KeybindingPill`, `RotateCcw`

### 22. MobileSettingsPage

[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)

初始源码结论：移动菜单和返回按钮显式 44px 或 56px，源码尺寸符合移动最低值；大量重复返回/菜单 DOM 可复用统一移动导航组件。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：移动工作台在 `/settings` 及其子路径挂载此页。应用页也在移动布局中通过设置入口直接挂载此页。[移动工作台](../../../wework/src/components/layout/MobileWorkbenchLayout.tsx)、[设置路径判定](../../../wework/src/lib/navigation.ts)、[应用页](../../../wework/dsh/ui-applications/src/SitesPage.tsx)

依赖/委托：hooks: `useTranslation`；委托：`ArrowLeft`, `DshSettingsSurface`, `ConnectionsDeviceSettingsPage`, `QuickPhrasesSettingsPage`, `RuntimeSettingsPage`, `GeneralSettingsPage`, `AppearanceSettingsPage`, `ContextSettingsPage`, `AboutSettingsPage`, `ArchivedConversationsSettingsPage`, `ExperimentalBadge`, `HarnessSettingsPage`, `PluginSettingsPage`, `SlidersHorizontal`, `ChevronRight`, `Palette`, `Terminal`, `UserRound`, `Server`, `MessageSquareText`, `ModelSettingsPage`, `Plug`, `Globe2`, `Archive`, `Package`

### 23. ModelSettingsPage

[wework/src/components/settings/ModelSettingsPage.tsx](../../../wework/src/components/settings/ModelSettingsPage.tsx)

初始源码结论：模型选择/切换用统一控件；详情、刷新、同步 outline 按钮重复边框圆角配方；隐藏文件导入不应误报原生表单遗漏。

修复记录：重复按钮配方（原证据行 206）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 751）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 900）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：`/settings/personal/models`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useCloudConnection`, `useTranslation`；权限相关标识（非授权结论）：`isConnected`；委托：`CodexOfficialModelsSection`, `LocalCodexModelRow`, `ChevronDown`, `ConfirmDialog`, `SettingsPage`, `SettingsPageHeader`, `CodexAuthSettingsSection`, `LocalCodexSubscriptionToggle`, `DisconnectedCloudCodexSyncSection`, `ProviderSettingsSection`, `CloudModelsSection`, `DisconnectedCloudModelsSection`, `RefreshCw`, `ShieldCheck`, `Upload`, `AlertCircle`

### 24. PluginSettingsPage

[wework/src/components/settings/PluginSettingsPage.tsx](../../../wework/src/components/settings/PluginSettingsPage.tsx)

初始源码结论：页面委托共享 SettingsPage/Group/Row/Switch，无独立普通按钮或删除；加载错误状态需要真实插件端口。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：`/settings/plugins`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `SettingsPageHeader`, `Package`, `AlertCircle`

### 25. ProxySettingsPage

[wework/src/components/settings/ProxySettingsPage.tsx](../../../wework/src/components/settings/ProxySettingsPage.tsx)

初始源码结论：代理方式采用 RadioGroup；多个保存/重启 primary 按钮使用 h-8/h-9、text-xs/text-sm 的不同局部配方。

修复记录：重复按钮配方（原证据行 342）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 363）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 506）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：`/settings/personal/proxy`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useCloudConnection`, `useTranslation`；权限相关标识（非授权结论）：`isConnected`；委托：`Laptop`, `RadioGroup`, `Radio`, `AlertCircle`, `SettingsPage`, `SettingsPageHeader`, `Network`, `RefreshCw`, `ShieldCheck`

### 26. QuickPhrasesSettingsPage

[wework/src/components/settings/QuickPhrasesSettingsPage.tsx](../../../wework/src/components/settings/QuickPhrasesSettingsPage.tsx)

初始源码结论：纯 SettingsPage 包装 QuickPhrasesEditor；字段、排序、删除均需在真实编辑器进一步 review。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：`/settings/personal/quick-phrases`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `SettingsPageHeader`, `QuickPhrasesEditor`

### 27. RuntimeSettingsPage

[wework/src/components/settings/RuntimeSettingsPage.tsx](../../../wework/src/components/settings/RuntimeSettingsPage.tsx)

初始源码结论：运行配置创建/保存重复圆角和小字号 primary 配方，删除已用 DeleteIconButton；MenuSelect 与输入密度需真实比较。

修复记录：重复按钮配方（原证据行 139）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 286）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：`/settings/personal/runtimes`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `SettingsPageHeader`, `CloudTodoModal`, `LoaderCircle`

### 28. WorktreesSettingsPage

[wework/src/components/settings/WorktreesSettingsPage.tsx](../../../wework/src/components/settings/WorktreesSettingsPage.tsx)

初始源码结论：分支保留确认与恢复语义；禁用清理的 destructive 确认重新设置红色圆角，工作树行条件式按钮配方仍重复。

修复记录：重复按钮配方（原证据行 607）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：[wework/dsh/ui-git/src/settings-page.tsx](../../../wework/dsh/ui-git/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `SettingsPageHeader`, `RefreshCw`, `WorktreeRow`, `CircleCheck`, `ConfirmDialog`, `DialogSurface`

### 29. AppearanceSettingsPage

[wework/src/features/appearance/AppearanceSettingsPage.tsx](../../../wework/src/features/appearance/AppearanceSettingsPage.tsx)

初始源码结论：字体数字字段已 compact、滑块与开关复用；重置和选择背景重复按钮配方，背景移除已 destructive-ghost。

修复记录：重复按钮配方（原证据行 225）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 418）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：`/settings/appearance`；[wework/src/components/settings/MobileSettingsPage.tsx](../../../wework/src/components/settings/MobileSettingsPage.tsx)；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `SettingsPageHeader`, `RotateCcw`, `RangeSlider`, `WorkbenchBackgroundPreview`, `Image`, `FontSizeControl`

### 30. AutomationsPage

[wework/src/features/automations/AutomationsPage.tsx](../../../wework/src/features/automations/AutomationsPage.tsx)

初始源码结论：页面主要组合列表/详情工作区和统一 ConfirmDialog/MobileDrawer；移动菜单 44px，详情错误重试仍局部样式。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[wework/src/features/todo/StandInConnectionSettings.tsx](../../../wework/src/features/todo/StandInConnectionSettings.tsx)；[wework/src/features/todo/StandInScheduleDialog.tsx](../../../wework/src/features/todo/StandInScheduleDialog.tsx)

依赖/委托：hooks: `useAuth`, `useWorkbench`, `useTranslation`；权限相关标识（非授权结论）：`userId`；委托：`MobileSettingsPage`, `ConnectionsSettingsPage`, `ConfirmDialog`, `DesktopSidebar`, `Menu`, `MobileDrawer`, `DesktopCollapsedSidebarToggle`, `AutomationListPane`, `AutomationDetailWorkspace`, `AutomationEmptyState`, `WorkbenchSearchDialog`

### 31. HooksSettingsPage

[wework/src/features/hooks/HooksSettingsPage.tsx](../../../wework/src/features/hooks/HooksSettingsPage.tsx)

初始源码结论：导入/新增操作功能清楚，新增 primary 又重复完整按钮样式；HookEditorDialog 为字段与删除审查边界。

修复记录：重复按钮配方（原证据行 38）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：`/settings/hooks`；[wework/dsh/ui-core-settings/src/settings-page.tsx](../../../wework/dsh/ui-core-settings/src/settings-page.tsx)

依赖/委托：hooks: `useTranslation`；委托：`SettingsPage`, `SettingsPageHeader`, `Upload`, `RefreshCw`, `HookListItem`, `HookEditorDialog`

### 32. RuntimeInteractionsPage

[wework/src/features/notifications/RuntimeInteractionsPage.tsx](../../../wework/src/features/notifications/RuntimeInteractionsPage.tsx)

初始源码结论：列表、清除、查看历史、返回均使用共享行为并有移动 min-h-11；已迁移 Collapsible，真实嵌入通知视图仍需权限与数据。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[wework/src/App.tsx](../../../wework/src/App.tsx)；[wework/src/features/notifications/runtimeInteractionsProvider.fixtures.tsx](../../../wework/src/features/notifications/runtimeInteractionsProvider.fixtures.tsx)

依赖/委托：hooks: `useTranslation`；权限相关标识（非授权结论）：`userId`；委托：`RefreshCw`, `InteractionDraftRecovery`, `IssueWaitingTime`, `InteractionTime`, `CollapsibleRoot`, `CollapsibleTrigger`, `CollapsiblePanel`, `ArrowLeft`, `ArrowUpRight`, `WorkbenchErrorBoundary`, `NotificationEntitySurface`

### 33. StandInOverviewPage

[wework/src/features/todo/StandInOverviewPage.tsx](../../../wework/src/features/todo/StandInOverviewPage.tsx)

初始源码结论：分身角色、配置和详情委托真实业务控件；新增/详情按钮移动 44px、桌面32px；角色切换样式仍由局部 roleTabClass 控制。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[wework/src/features/todo/PersonalStandInWorkspace.tsx](../../../wework/src/features/todo/PersonalStandInWorkspace.tsx)

依赖/委托：hooks: `useTranslation`, `useContext`；权限相关标识（非授权结论）：`userId`, `isConnected`, `readOnly`；委托：`StandInProposalCard`, `StandInSettingsEntry`, `UserRound`, `StandInIcon`, `Tooltip`, `SlidersHorizontal`, `StandInConversation`, `StandInDetailsPopover`, `TemporaryChatPanel`, `StandInScheduleDialog`, `StandInReviewDialog`, `StandInWorkList`, `StandInProcessingNotice`, `DialogSurface`, `StandInMemoryPanel`, `StandInPrimaryProfile`, `StandInSettingsPage`, `StandInOnboarding`

### 34. StandInSettingsPage

[wework/src/features/todo/StandInSettingsPage.tsx](../../../wework/src/features/todo/StandInSettingsPage.tsx)

初始源码结论：分身删除入口用 destructive-ghost，但最终删除确认使用 primary，本地中性色；与统一危险操作规则存在可确认的选型不一致。

修复记录：重复按钮配方（原证据行 837）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 删除确认变体（原证据行 837）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：[wework/src/features/todo/StandInOverviewPage.tsx](../../../wework/src/features/todo/StandInOverviewPage.tsx)；[wework/src/features/todo/StandInPopover.tsx](../../../wework/src/features/todo/StandInPopover.tsx)

依赖/委托：hooks: `useTranslation`；权限相关标识（非授权结论）：`userId`；委托：`StandInSettingsEditor`, `DialogSurface`, `StandInSettingsHeader`, `StandInProjectSetup`, `StandInRequirements`, `StandInSettingsEntry`, `Folder`, `StandInConnectionSettings`, `StandInComposer`, `StandInSettingsError`, `ConfirmDialog`, `StandInSettingsActions`

### 35. SitesPage

[wework/dsh/ui-applications/src/SitesPage.tsx](../../../wework/dsh/ui-applications/src/SitesPage.tsx)

初始源码结论：应用 Sites 壳委托 SitesWorkspace/市场和工作台导航；移动菜单显式44px，内部卡片/编辑器未因壳 review 自动验收。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：DSH动态路由 `/sites`，由[client.js](../../../wework/dsh/ui-applications/client.js)注册，经[route](../../../wework/dsh/ui-applications/src/route.tsx)挂载；构建映射见[vite.config.ts](../../../wework/vite.config.ts)。

依赖/委托：hooks: `useAuth`, `useCloudConnection`, `useWorkbench`, `useTranslation`；权限相关标识（非授权结论）：`isConnected`；委托：`MobileSettingsPage`, `ConnectionsSettingsPage`, `DesktopWindowControls`, `DesktopCollapsedSidebarToggle`, `DesktopSidebar`, `Menu`, `MobileDrawer`, `SitesWorkspace`, `SmartAppsMarketplacePage`, `WorkbenchSearchDialog`

### 36. SmartAppsMarketplacePage

[wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx](../../../wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx)

初始源码结论：导入/安装/发布大多共享 Button 与 Select；卡片可见性 outline 又重写局部配方，访问成功提示内按钮带 success 修饰需检查只限状态语境。

修复记录：重复按钮配方（原证据行 1456）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。 重复按钮配方（原证据行 2070）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：`/sites` 的应用页在智能应用标签中通过 `SitesWorkspace` 挂载此组件。默认显示市场，`view=owned` 显示我的应用。[应用页调用方](../../../wework/dsh/ui-applications/src/SitesPage.tsx)、[智能应用标签面板](../../../wework/src/components/sites/SitesWorkspace.tsx)

依赖/委托：hooks: `useTranslation`；权限相关标识（非授权结论）：`accessRole`；委托：`Upload`, `CirclePlus`, `FolderOpen`, `Download`, `ApplicationContextToolbar`, `SmartAppsSectionNav`, `CheckCircle2`, `EmptyState`, `Box`, `PackageCheck`, `SmartAppCard`, `Play`, `ActionMenu`, `SmartAppDetails`, `HarnessAppInstallDialog`, `SmartAppPublishDialog`, `SmartAppShareDialog`, `SmartAppDevelopmentDialog`, `SmartAppPluginDialog`, `SmartAppRemoveLocalDialog`, `VisibilityIcon`, `Puzzle`, `DialogSurface`, `Boxes`, `ShieldCheck`, `PackageOpen`, `CalendarDays`, `ReactMarkdown`, `TargetPicker`, `SmartAppFilePicker`

### 37. AutomationsPage

[wework/dsh/ui-automations/src/AutomationsPage.tsx](../../../wework/dsh/ui-automations/src/AutomationsPage.tsx)

初始源码结论：只是 re-export 主 AutomationsPage；真实控件审查归对应 feature 页面，不重复宣称 UI 验收。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：DSH动态路由 `/automations`，由[client.js](../../../wework/dsh/ui-automations/client.js)注册，经[route](../../../wework/dsh/ui-automations/src/route.tsx)挂载；构建映射见[vite.config.ts](../../../wework/vite.config.ts)。

依赖/委托：无明确 hook/权限线索；仍需解析 host/provider 与数据前提。

### 38. CloudWorkPage

[wework/dsh/ui-cloud-work/src/CloudWorkPage.tsx](../../../wework/dsh/ui-cloud-work/src/CloudWorkPage.tsx)

初始源码结论：云端添加设备主按钮保留旧配方；最低版本 outline 按钮仅增加响应式最小高度，不属于重复视觉配方。

修复记录：重复按钮配方（原证据行 275）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：DSH动态路由 `/cloud-work`，由[client.js](../../../wework/dsh/ui-cloud-work/client.js)注册，经[route](../../../wework/dsh/ui-cloud-work/src/route.tsx)挂载；构建映射见[vite.config.ts](../../../wework/vite.config.ts)。

依赖/委托：hooks: `useAuth`, `useWorkbench`, `useTranslation`；委托：`DesktopCollapsedSidebarToggle`, `DesktopSidebar`, `Menu`, `MobileDrawer`, `Settings`, `DeviceSection`, `FolderGit2`, `WorkbenchSearchDialog`

### 39. PluginCreatePage

[wework/dsh/ui-plugin-center/src/PluginCreatePage.tsx](../../../wework/dsh/ui-plugin-center/src/PluginCreatePage.tsx)

初始源码结论：创建插件页面为工作台壳与 PluginCreateWorkspace；移动菜单44px，创建表单由子视图负责。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：DSH动态路由 `/plugins/create`，由[client.js](../../../wework/dsh/ui-plugin-center/client.js)注册，经[route](../../../wework/dsh/ui-plugin-center/src/create-route.tsx)挂载；构建映射见[vite.config.ts](../../../wework/vite.config.ts)。

依赖/委托：hooks: `useAuth`, `useWorkbench`, `useTranslation`；委托：`MobileSettingsPage`, `ConnectionsSettingsPage`, `DesktopSidebar`, `Menu`, `MobileDrawer`, `PluginCreateWorkspace`, `DesktopWindowControls`, `WorkbenchSearchDialog`

### 40. PluginManagementPage

[wework/dsh/ui-plugin-center/src/PluginManagementPage.tsx](../../../wework/dsh/ui-plugin-center/src/PluginManagementPage.tsx)

初始源码结论：插件管理页面为工作台壳与 PluginManagementWorkspace；移动菜单44px，管理操作与失败状态需要子视图实际验证。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：DSH动态路由 `/plugins/manage`，由[client.js](../../../wework/dsh/ui-plugin-center/client.js)注册，经[route](../../../wework/dsh/ui-plugin-center/src/management-route.tsx)挂载；构建映射见[vite.config.ts](../../../wework/vite.config.ts)。

依赖/委托：hooks: `useAuth`, `useCloudConnection`, `useWorkbench`, `useTranslation`；委托：`MobileSettingsPage`, `ConnectionsSettingsPage`, `DesktopWindowControls`, `DesktopSidebar`, `Menu`, `MobileDrawer`, `PluginManagementWorkspace`, `WorkbenchSearchDialog`

### 41. PluginsPage

[wework/dsh/ui-plugin-center/src/PluginsPage.tsx](../../../wework/dsh/ui-plugin-center/src/PluginsPage.tsx)

初始源码结论：插件首页为可延迟加载 Workspace 的工作台壳；移动菜单44px，Suspense 和错误后恢复属于真实 UI 验证。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[wework/dsh/ui-plugin-center/src/catalog-route.tsx](../../../wework/dsh/ui-plugin-center/src/catalog-route.tsx)

依赖/委托：hooks: `useAuth`, `useCloudConnection`, `useWorkbench`, `useTranslation`；委托：`MobileSettingsPage`, `ConnectionsSettingsPage`, `DesktopCollapsedSidebarToggle`, `DesktopSidebar`, `Menu`, `MobileDrawer`, `Suspense`, `PluginsWorkspaceRouteFallback`, `DesktopWindowControls`, `PluginsWorkspace`, `WorkbenchSearchDialog`

### 42. MilestonesPage

[packages/collaboration/src/milestones/MilestonesPage.tsx](../../../packages/collaboration/src/milestones/MilestonesPage.tsx)

初始源码结论：里程碑表单使用共享 TextField/Textarea，但 buttonClass/primaryButtonClass 保留完整本地按钮配方，删除确认仍为普通 buttonClass。

修复记录：删除确认变体（原证据行 209）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：[packages/collaboration/src/CollaborationApp.tsx](../../../packages/collaboration/src/CollaborationApp.tsx)

依赖/委托：权限相关标识（非授权结论）：`canManage`；委托：`MilestoneForm`, `Flag`, `MilestoneProgress`, `ProgressBar`

### 43. ResourceCatalogPage

[packages/collaboration/src/platform/ResourceCatalogPage.tsx](../../../packages/collaboration/src/platform/ResourceCatalogPage.tsx)

初始源码结论：资源目录搜索和删除图标已共用；主体 action 仍依赖 collaboration-primary-button 等 CSS 配方，删除智能体/小组确认沿用 primary 样式，需统一危险操作选型。

修复记录：删除确认变体（原证据行 927）：已复用公共控件配方/变体；业务 handler、权限与 pending 取消归属保留，待真实 UI 复核。

入口/调用方：[packages/collaboration/src/platform/CollaborationPlatformApp.tsx](../../../packages/collaboration/src/platform/CollaborationPlatformApp.tsx)

依赖/委托：权限相关标识（非授权结论）：`currentUserId`；委托：`UserRound`, `UsersRound`, `PageIcon`, `DeviceCatalogFeedback`, `Monitor`, `DeviceLastSeen`, `Tooltip`, `Settings`, `ResourceDestinationDialog`, `ResourceBindingDialog`, `DeviceDeleteDialog`, `DialogSurface`

### 44. ProjectSettingsPage

[packages/collaboration/src/project-manage/ProjectSettingsPage.tsx](../../../packages/collaboration/src/project-manage/ProjectSettingsPage.tsx)

初始源码结论：通用项目设置布局只接收 actions/children，无控件实现；内容宽度是布局职责，不视为字段密度缺陷。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[packages/collaboration/src/project-manage/ProjectAutomaticProcessing.tsx](../../../packages/collaboration/src/project-manage/ProjectAutomaticProcessing.tsx)；[packages/collaboration/src/templates/ProjectTemplateSettings.tsx](../../../packages/collaboration/src/templates/ProjectTemplateSettings.tsx)

依赖/委托：无明确 hook/权限线索；仍需解析 host/provider 与数据前提。

### 45. CollaborationTemplatePage

[packages/collaboration/src/templates/CollaborationTemplatePage.tsx](../../../packages/collaboration/src/templates/CollaborationTemplatePage.tsx)

初始源码结论：模板页面使用共享搜索字段及 Dialog 业务组件；按钮视觉依赖旧 collaboration CSS，危险操作已有 danger class，仍应逐步收敛共享变体。

修复记录：此页无单独确认的源码缺陷；委托边界不算作已验收。

入口/调用方：[packages/collaboration/src/platform/CollaborationPlatformApp.tsx](../../../packages/collaboration/src/platform/CollaborationPlatformApp.tsx)；[packages/collaboration/src/templates/GroupTemplateCreator.tsx](../../../packages/collaboration/src/templates/GroupTemplateCreator.tsx)；[packages/collaboration/src/templates/ProjectTemplateSettings.tsx](../../../packages/collaboration/src/templates/ProjectTemplateSettings.tsx)；[packages/collaboration/src/templates/TemplateCreateSection.tsx](../../../packages/collaboration/src/templates/TemplateCreateSection.tsx)

依赖/委托：权限相关标识（非授权结论）：`isConnected`；委托：`ScopedCollaborationTemplatePage`, `RefreshCw`, `Layers3`, `TemplatePanel`, `TemplatePreview`, `TemplateImportDialog`

## 跨界面覆盖一致性矩阵

同一用途的控件必须同时满足公共实现、规范及实际跨界面行为证据。表单和工具栏可以采用明确的不同密度，不能按页面自由定义。以下是合并main后的待验收矩阵：调用数/源码归属数只按命名JSX导入及别名扫描，包含底层组合，不是页面数或验收数。所有行仍未完成，不能用一个消费者通过推断其余消费者。

| 控件族        | 实际界面范围                         | 一致性契约                                                                                         | 当前证据与缺口                                                           | 调用数 / 源码归属数                                                                        |
| ------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 操作按钮      | 工具栏、表单、列表、卡片             | 同一语义使用同一variant；主操作中性反色；尺寸由公共API持有，移动44px；结构性点击容器与普通操作分清 | 已有公共规范和实机初始画面；不能将全部未分类unstyled调用自动视为一致     | Button: 1770 / 521; IconButton: 6 / 6                                                      |
| Composer      | 普通任务、记录事项、创建任务         | 公共Surface/Toolbar/项目选择；桌面28px，移动44px；同一输入状态与禁用规则                           | 普通任务首页和协作双模式布局已实测；协作草稿与提交通过打包 E2E           | ProjectChatComposerSurface: 1 / 1; ComposerProjectSelector: 2 / 2                          |
| 删除          | 快捷短语、Runtime、设置/列表/卡片    | 资源删除共用danger；取消队列不冒充资源删除；disabled/pending一致                                   | 快捷短语原生图标和取消焦点已观察；Runtime云端CRUD及跨主题对照未验        | DeleteIconButton: 21 / 18                                                                  |
| 单值选择      | 设置表单、设置行、Composer工具栏     | 表单default/outline36px；工具栏dense/plain28px；移动至少44px；稳定可访问名称                       | 已有Story测量；原生模型表单32px已记录，需按实际字段角色核对修复          | SelectField: 21 / 16; MenuSelect: 9 / 3; ComposerProjectSelector: 2 / 2                    |
| 搜索选择      | 人员/协作者、项目、分支、自动化任务  | 共享搜索、选中、disabled/empty/error/retry与关闭焦点；值用业务ID                                   | 已有 Story 交互证据；协作项目选择通过打包 E2E，其他原生入口仍待复核      | SearchableSelect: 30 / 28                                                                  |
| 文本字段      | 设置、配置、创建/编辑表单            | Field标签/说明/错误组合；普通表单36px、移动44px；专业编辑器不以普通textarea代替                    | Issue 描述替换已在打包 workspace-tabs 中复验通过；其余专业编辑器待复核   | TextField: 200 / 113; Textarea: 53 / 40                                                    |
| 布尔/互斥选择 | 设置、自动化、模型权限               | 共享checked/disabled语义及命中区域，不能仅画Check；至少一项约束归业务                              | 星期单多选Story已测；合并后的新助手名单仍需原生与互斥状态复核            | Checkbox: 49 / 34; Switch: 8 / 7; Radio: 18 / 15; RadioGroup: 14 / 14                      |
| 菜单和浮层    | 侧栏、卡片、工具栏、设置             | 公共density28/32/36px、移动44px；SDK拥有键盘/定位/关闭/焦点，不并行监听                            | 组件密度与星期行为已测；各原生入口可达性和跨界面状态仍待完成             | ActionMenu: 45 / 37; Popover: 41 / 35                                                      |
| 弹窗          | 创建、编辑、删除确认及内嵌步骤       | 一个焦点/关闭所有者；内嵌步骤用InlinePanel；pending取消规则由业务提供                              | 内嵌步骤Story及快捷短语原生焦点有证据；其余页面不能据此推断通过          | DialogSurface: 132 / 117; ConfirmDialog: 33 / 30                                           |
| 排序/跨列拖拽 | 队列、侧栏、状态列、Issue看板        | 排序与transfer用SDK；保留服务端/发送中归属；取消不保存；失败回滚                                   | 基础/生产组件契约通过；相关合并后原生E2E未完成                           | SortableRoot: 3 / 3                                                                        |
| 分屏与尺寸    | 工作台、体验页、设置共享布局         | SDK交互配合业务持久化；键盘/取消/卸载清理一致；窄屏不丢入口                                        | 共享设置布局已在 19 个入口、三种宽度复验；工作台与协作分栏见下方打包记录 | Resizable: 2 / 2; ResizableHandle: 3 / 3                                                   |
| 导航与展开    | 主导航、页面标签、互斥设置、等待条件 | 相同状态采用共同选中/焦点规范；共享SDK键盘和展开状态，不保留原生details第二套监听                  | main新等待条件已迁公共Collapsible；真实跨页面状态与键盘仍待复核          | TabsRoot: 13 / 12; SegmentedControl: 2 / 2; CollapsibleRoot: 32 / 29                       |
| 滚动与树      | 文件树、设置导航、对话/长列表        | 共享滚动/树行为；业务保留虚拟化与数据归属，焦点、选择、过滤不能相互覆盖                            | 1000项Story已测；原生文件系统/导航/长列表全范围未验                      | ScrollArea: 4 / 4; VirtualTree: 3 / 3                                                      |
| 反馈与提示    | 通知、错误/进度、图标提示、悬浮预览  | 共享语义颜色、可访问名称、关闭/持续规则、主题；不通过业务局部样式另造控件                          | Toast明暗及定位Story有证据；全部原生反馈入口、对比度和恢复路径未验       | Toast: 2 / 2; ProgressBar: 3 / 3; ProgressRing: 4 / 4; Tooltip: 102 / 57; HoverCard: 8 / 7 |

## 实际运行记录：24 条

以下来自 Wework 内置浏览器的生产组件 Story 记录，主要环境为 784×526、zh-CN、浅色；视口辅助示例另测 360/768/1280。24 条是观察记录，包含同一 Story 修复前后或不同状态，既不是 24 个独立页面，也不是全 234 owner 的验收。键盘证据中明确标记的 synthetic events 不能替代原生键盘、Tab 或 IME。

### 1. `patterns-composercomparison--three-production-flows`

实测行为：三个可见表单均为 744×98，工具栏控件均为 28px，无水平溢出。记录事项的项目选择通过 End/Enter 提交 example-1，并恢复触发器焦点；提交文本调用本地结果端口，清空草稿后空提交禁用。getAppPreferences 拒绝计数仍为 8，没有新增。

边界/限制：本地目录/提交端口，无原生桌面或真实传输；未截屏，未验证原生 Tab。

### 2. `controls-resizable--controlled-commit`

实测行为：ArrowRight 将 35/65 调整为 36/64 并提交；End 限制为 70/30，Home 限制为 20/80；ARIA 数值与状态一致，面板内容无溢出。

边界/限制：仅共享控件；生产分屏会话与 portal 生命周期未完成浏览器验收。

### 3. `controls-toast--persistent-action-notice`

实测行为：448px 锚定区域内通知宽 416px，两侧各留 16px；scrollWidth 与 clientWidth 均为 414，长文本换行。操作执行一次后通知仍显示，clear 计数为 0，操作保留焦点；SDK anchor-width 为 416px。

边界/限制：测量后将 SDK sideOffset 调为 0 以保留 112px 顶部位置；最终纵向位置仍需重新检查。

### 4. `patterns-inlinepanel--template-inline-step`

实测行为：内嵌步骤打开时仅一个 dialog。Escape 只关闭步骤并恢复其触发器焦点；重开保留草稿；第二次 Escape 关闭父弹层并恢复外部打开按钮焦点。

边界/限制：未记录额外单项限制；仍受 Story 本地数据与非原生验收边界约束。

### 5. `patterns-inlinepanel--pending-step`

实测行为：提交中按 Escape，步骤与父弹层均保留；取消禁用，dialog 数量为 1。

边界/限制：未记录额外单项限制；仍受 Story 本地数据与非原生验收边界约束。

### 6. `pages-runtimesettings--ready / --loading / --delete-pending`

实测行为：通过已有公共服务端口打开创建弹窗，名称提交新增第二行，并恢复 New Runtime 焦点。删除控件为 32×32、透明背景、rgb(220,38,38)，页面无溢出。删除中 aria-busy=true、禁用且显示 spinner；fixture 释放前保留行，释放后删除并返回正确公共结果。初次列表等待误显示空态；创建表单混用 36px 输入和 28px 无标签选择器。

当时发现（后续复测另列）：初次加载/错误反馈与表单字段角色和密度委托 composer_migration 修复，修复前记录不视为通过。

边界/限制：内存端口，无真实执行器或云端变更；该创建弹窗记录早于字段修复。

### 7. `pages-runtimesettings (fresh after Field and loading fix)`

实测行为：Field/加载修复后复测：名称、设备、模型均有标签，均高 36px、宽 480px、1px 边框，784px 视口弹窗无溢出。初始等待显示 role=status Loading，不再显示空态，创建仍可用。首次失败显示独立 alert 与 Retry；真实点击 Retry 后列表恢复并清除错误。

边界/限制：仅公共内存服务端口。

### 8. `patterns-viewportreview--production-surfaces (Runtime ready)`

实测行为：独立 iframe 实测宽度为 360/768/1280px，均无文档水平溢出。真实 DeleteIconButton 在 360px 为 44×44，在 768/1280px 为 32×32，颜色均 rgb(220,38,38)。1280px 居中，360px 标题与行换行。

边界/限制：仅 DOM 几何/状态检查；外层 784px 浏览器会裁切宽画布，不代表原生全窗口视觉排版验收。

### 9. `patterns-viewportreview--production-surfaces (Composer)`

实测行为：独立 360/1280px 视口中三个生产表单尺寸一致：360px 为 320×210；1280px 三列各 392×130，动作尺寸分别为 44px/28px，无水平溢出。768px 同级 iframe 出现动态导入错误，资源响应仍为 200。随后辅助器改为单个存活 iframe，以减少资源并保留切换草稿；新的 768px 检查三表单均为 728×98，无溢出或模块错误。

边界/限制：多 iframe 导入错误的根因未证实；不能据此认定生产组件缺陷，或声称通用缓存修改解决了问题。

### 10. `patterns-viewportreview--production-surfaces`

实测行为：单 iframe 中记录草稿“跨视口保留的草稿”，768→360→1280 调整后内容保持。360px 表单为 320×210、动作 44px；1280px 表单为 392×130、动作 28px；无文档或表单溢出。

边界/限制：本地预览端口，无原生传输或 IME。

### 11. `business-conversationqueue--mixed-ownership`

实测行为：Space、ArrowDown 预览顺序为 sending,two,server,one,failed，保存状态仍为 sending,one,server,two,failed；再次 Space 后才提交预览顺序。焦点保留在源手柄，无文档溢出。

边界/限制：浏览器工具合成键盘事件；未测试指针拖拽。

### 12. `controls-sortable--production-board-states`

实测行为：Space/End 将 Open 预览到末尾；Escape 恢复原顺序与源焦点。再次 Space/End/Space 提交 In progress,Done,Open，焦点仍在 Open，无文档溢出。

边界/限制：仅本地状态保存，无云端保存。

### 13. `business-taskdescriptioneditor--empty`

实测行为：在真实 contenteditable 填入“统一组件说明”，生产编辑器与展开 Markdown 输出均同步更新，无文档溢出。

边界/限制：工具按可打印斜杠未插入字符；直接填入斜杠不能证明按键触发菜单正确。未验原生 IME、选区或剪贴板。

### 14. `business-planningdraganddrop--persist-failure`

实测行为：真实键盘拾取、ArrowRight、放下后显示保存失败“保存失败示例：保留原数据”；卡片状态仍为待开始、所在列仍为 pending，标签保留。

边界/限制：失败 fixture；未执行原生或后端写入。

### 15. `business-branchpicker--retry-directory-failure`

实测行为：打开选择器显示目录失败；Retry 后替换为 3 个选项。ArrowDown/Enter 选中 main，弹层关闭并恢复原触发器焦点，无溢出。

边界/限制：合成键盘事件与本地列表端口。

### 16. `controls-virtualtree--reveal-distant-item`

实测行为：生产静态 Story 定位到 1000 项中的第 900 项，仅挂载 15 个 treeitem；点击选中 src/file-900，ArrowDown 将焦点移动至 901，选择仍为 900，无溢出。

边界/限制：Story 数据；未验证原生文件系统集成。

### 17. `patterns-composercomparison--three-production-flows`

实测行为：正式静态预览 6007 加载三条真实生产链路，三个可见表单均为 744×98，无水平溢出或失败资源响应。Storybook 隐藏错误模板的 display 为 none。

边界/限制：静态构建早于最新 Transfer 焦点和 Platform 源码改动；仅本地端口，不等于原生应用验收。

### 18. 看板跨列焦点闭环

正式静态构建中，拾取与 ArrowRight 后焦点在原卡片按钮，aria-pressed=true；放下后状态保存为“进行中”，焦点仍在同一卡片的新按钮。此前 BODY 失焦已通过 SDK keepFocus 主路径修复，并以浏览器的“状态已保存且焦点相同”条件复核。异步保存期间外部移焦不抢回另有真实 Adapter 契约覆盖；这些不是原生传输验收。

### 19. 看板只读入口

只读示例中 Space、ArrowRight、Space 不改变“待开始”状态，不出现 aria-pressed，也不触发打开回调。本地只读 fixture 不证明服务端权限执行。

### 20. 星期菜单语义

多选菜单暴露 menuitemcheckbox 与 aria-checked；选择周二后结果为1,2，菜单保持打开。Escape 关闭。单选暴露 menuitemradio；选择周二后结果为2，菜单关闭并恢复原触发器焦点；多选值保持1,2。未执行调度持久化。

### 21. 操作菜单桌面密度

正式静态示例在784px视口实测 dense/compact/default 为28×28、32×32、36×36。尺寸由公共 density 配方持有。

### 22. 通知最终位置与暗色

正式静态暗色示例确认通知顶部为112px、宽416px；暗色主题实际生效，背景rgb(33,33,33)、前景rgb(255,255,255)，无文档溢出。此项关闭先前最终纵向位置未复测的限制；不代表全部页面对比度通过。

### 23. 操作菜单移动端密度

实际独立iframe为360px时三种密度均44×44，无水平溢出；同一iframe调整至768px后分别为28×28、32×32、36×36。仅证明公共组件尺寸，不能替代每个业务菜单入口验收。

### 24. 自动化任务选择

真实 AutomationDetailWorkspace 示例显示可用任务与离线不可选任务（aria-disabled=true）。选择可用任务记录设备online、任务ready、代码目录/example/project，关闭菜单并恢复原触发器焦点，无文档溢出。共享工作日复选框移除旧原生输入尺寸覆盖后，桌面命中区域为24×24，并有明确可访问名称。未执行调度保存或真实设备操作。

## 组件目录初始加载检查

正式构建中54个分组各打开一个代表性示例（优先Default），等待Storybook主界面及根节点挂载后读取DOM。784×526浅色视口中，54项均未出现可见Storybook错误或文档横向溢出。此项仅验证初始加载，不表示206个状态、交互、全部页面或原生入口已经通过。

| 分组                               | 初始示例                                              | 可见错误 | 横向溢出 |
| ---------------------------------- | ----------------------------------------------------- | -------- | -------- |
| Controls/DeleteIconButton          | `controls-deleteiconbutton--state-matrix`             | 0        | 0        |
| Controls/Button                    | `controls-button--default`                            | 0        | 0        |
| Controls/Checkbox                  | `controls-checkbox--default`                          | 0        | 0        |
| Controls/Feedback                  | `controls-feedback--hint`                             | 0        | 0        |
| Controls/Field                     | `controls-field--default`                             | 0        | 0        |
| Controls/IconButton                | `controls-iconbutton--default`                        | 0        | 0        |
| Controls/MenuChoices               | `controls-menuchoices--default`                       | 0        | 0        |
| Controls/Menus                     | `controls-menus--selection`                           | 0        | 0        |
| Controls/OverlayParts              | `controls-overlayparts--arrow-and-shortcut`           | 0        | 0        |
| Controls/Popover                   | `controls-popover--default`                           | 0        | 0        |
| Controls/Progress                  | `controls-progress--in-progress`                      | 0        | 0        |
| Controls/RadioGroup                | `controls-radiogroup--default`                        | 0        | 0        |
| Controls/RangeSlider               | `controls-rangeslider--default`                       | 0        | 0        |
| Controls/Resizable                 | `controls-resizable--horizontal`                      | 0        | 0        |
| Controls/ScrollArea                | `controls-scrollarea--vertical`                       | 0        | 0        |
| Controls/SearchableSelect          | `controls-searchableselect--default`                  | 0        | 0        |
| Controls/SegmentedControl          | `controls-segmentedcontrol--default`                  | 0        | 0        |
| Controls/SelectField               | `controls-selectfield--default`                       | 0        | 0        |
| Controls/Sortable                  | `controls-sortable--editable-items`                   | 0        | 0        |
| Controls/Switch                    | `controls-switch--default`                            | 0        | 0        |
| Controls/Tabs                      | `controls-tabs--default`                              | 0        | 0        |
| Controls/TextField                 | `controls-textfield--default`                         | 0        | 0        |
| Controls/Textarea                  | `controls-textarea--default`                          | 0        | 0        |
| Controls/Toast                     | `controls-toast--success`                             | 0        | 0        |
| Controls/VirtualTree               | `controls-virtualtree--default`                       | 0        | 0        |
| Patterns/ComposerComparison        | `patterns-composercomparison--three-production-flows` | 0        | 0        |
| Patterns/Dialogs                   | `patterns-dialogs--confirmation`                      | 0        | 0        |
| Patterns/InlinePanel               | `patterns-inlinepanel--template-inline-step`          | 0        | 0        |
| Patterns/Settings                  | `patterns-settings--group`                            | 0        | 0        |
| Patterns/ViewportReview            | `patterns-viewportreview--production-surfaces`        | 0        | 0        |
| Business/AutomationTaskSelection   | `business-automationtaskselection--pinned-tasks`      | 0        | 0        |
| Business/BoardViewTagPicker        | `business-boardviewtagpicker--default`                | 0        | 0        |
| Business/BranchPicker              | `business-branchpicker--default`                      | 0        | 0        |
| Primitives/Collapsible             | `primitives-collapsible--details`                     | 0        | 0        |
| Business/ComposerProjectSelector   | `business-composerprojectselector--default`           | 0        | 0        |
| Business/ConversationQueue         | `business-conversationqueue--mixed-ownership`         | 0        | 0        |
| Business/DeviceSelect              | `business-deviceselect--default`                      | 0        | 0        |
| Business/GitAccountConfiguration   | `business-gitaccountconfiguration--default`           | 0        | 0        |
| Business/GroupParticipantsEditor   | `business-groupparticipantseditor--default`           | 0        | 0        |
| Business/IssueOwnerPicker          | `business-issueownerpicker--default`                  | 0        | 0        |
| Business/IssueParticipantPicker    | `business-issueparticipantpicker--default`            | 0        | 0        |
| Business/ContentLayout             | `business-contentlayout--navigation-and-long-notice`  | 0        | 0        |
| Business/MemberSearchPicker        | `business-membersearchpicker--default`                | 0        | 0        |
| Business/ModelSelector             | `business-modelselector--default`                     | 0        | 0        |
| Business/PermissionModeSelector    | `business-permissionmodeselector--default`            | 0        | 0        |
| Business/PlanningDragAndDrop       | `business-planningdraganddrop--board`                 | 0        | 0        |
| Business/ProjectAgentPicker        | `business-projectagentpicker--default`                | 0        | 0        |
| Business/ProjectBoardGroupPicker   | `business-projectboardgrouppicker--default`           | 0        | 0        |
| Business/ProjectCollaboratorPicker | `business-projectcollaboratorpicker--default`         | 0        | 0        |
| Business/ProjectSpacePickerMenu    | `business-projectspacepickermenu--default`            | 0        | 0        |
| Pages/RuntimeSettings              | `pages-runtimesettings--ready`                        | 0        | 0        |
| Business/TaskDescriptionEditor     | `business-taskdescriptioneditor--editable`            | 0        | 0        |
| Design/Project Assistant Status    | `design-project-assistant-status--project`            | 0        | 0        |
| Navigation/ProjectViewSwitcher     | `navigation-projectviewswitcher--grouped-work`        | 0        | 0        |

机械扫描另报告1项border-accent-on-rounded警告；对应WeworkIssueHomeComposer.tsx的TabsTab选中下划线（border-b-2），不是卡片装饰边框，已按实际源码归为误报并保留。检测没有进行原生渲染。

## 打包 Electron 复核（93154da584）

- 云端连接的会话同步设置通过 `transcript-sync`，覆盖默认关闭、显式开启和云同步。[Core 5 日志](https://github.com/wecode-ai/Wegent/actions/runs/44685838973/job/136122269750)
- 插件管理的创建入口与工作区调试侧栏通过 `plugin-development`。[Core 8 日志](https://github.com/wecode-ai/Wegent/actions/runs/44685838973/job/136122269414)
- 协作分栏通过 `collaboration-exp`，覆盖键盘调整、真实拖拽和 Escape 恢复布局。[Core 4 日志](https://github.com/wecode-ai/Wegent/actions/runs/44685838973/job/136122269385)
- 看板重新加载后保留顺序及跨列变更。通知进入看板的专项在关闭详情后开始拖拽时失败，已根据命中日志补上关闭完成的等待，待同场景复测。[Core 10 日志](https://github.com/wecode-ai/Wegent/actions/runs/44685838973/job/136122269383) [Core 5 日志](https://github.com/wecode-ai/Wegent/actions/runs/44685838973/job/136122269750)

## Linux 打包 Electron 复核（e20dfde2d8）

- 已查看 `issue-handoff-02-project-pending.png`。待你处理的事项预览只显示一个详情标题，项目路径、时间与打开原页面操作共用一行。截图左栏含测试夹具的云端点错误，真实云设备仍未验收。[事项介入与工具条 E2E](https://github.com/wecode-ai/Wegent/actions/runs/44707080529/job/136191327554)
- Stand-in 日历设置从放弃确认返回详情的完整路径已通过。[Stand-in E2E](https://github.com/wecode-ai/Wegent/actions/runs/44707080529/job/136191327052)
- 看板分配通知与待处理互动已通过。小组流程通过 Escape 与回焦，后续智能体选择的键盘断言失败。[看板分配通知 E2E](https://github.com/wecode-ai/Wegent/actions/runs/44707080529/job/136191327248) · [互动与小组 E2E](https://github.com/wecode-ai/Wegent/actions/runs/44707080529/job/136191327144)

## 实际运行证据与页面对应

以下条目只记录已覆盖的页面路径和状态。上方 45 页的初始源码记录仍保留，未列出的真实状态仍待验收。

- 设置页 9–11、13–21、23–29 共 19 个入口，对应上文 macOS arm64 打包实例的 480、768、1440 像素测量。覆盖导航和正文宽度，工作树当时仍在加载，Runtime 云端操作仍待验；模型连接另有新增、编辑和删除行为证据。
- 第 32 页待你处理的项目事项预览直接截图及互动闭环见上节。第 34 页已验证日历放弃确认后返回设置和邮箱配置专项，其中包括窄屏暗色表单、配置失败保留表单和直接回复确认。删除确认与其他设置授权状态仍待逐项验收。[日历返回](https://github.com/wecode-ai/Wegent/actions/runs/44707080529/job/136191327052) · [邮箱与待你处理](https://github.com/wecode-ai/Wegent/actions/runs/44707080529/job/136191327554)
- 第 35、37、38、41 页已有应用空态、已安排、云端工作未连接空态和插件市场远程加载失败时本地条目仍可见的 Electron 记录。第 39、40 页的创建入口和调试侧栏另有打包 E2E。应用、插件和云端能力在真实环境加载后的操作仍待验。[插件开发 E2E](https://github.com/wecode-ai/Wegent/actions/runs/44685838973/job/136122269414)
- 第 45 页相关的协作模板专项已覆盖发现、预览、发布、导入、小组绑定和重新进入后的持久化。已查看 `collaboration-templates-07-published.png`，发布状态、角色布局及页脚关闭操作可见。同一任务的项目小组和自动化场景也已通过。[模板与项目自动化 E2E](https://github.com/wecode-ai/Wegent/actions/runs/44707080529/job/136191327554)
- 工作台会话状态专项在 Linux 打包实例通过。该专项的截图覆盖默认分屏和恢复分屏。协作分栏的键盘、拖拽及取消证据见上一轮 `collaboration-exp`，同一场景在 e20 的后续失败发生于返回看板后等待发布正文。[工作台分屏与协作场景日志](https://github.com/wecode-ai/Wegent/actions/runs/44707080529/job/136191327037)
- macOS 打包 `system-drag-panel-only` 已验证系统拖放后的 Popout 会话输入与焦点隔离，主窗口未获得焦点，草稿进入 Popout，截图可见草稿及工具栏。已查看 `system-drag-popout-window.png`。这一路径的证据记录于 2026-11-20 02:12 UTC 启动的本地批次，覆盖拖放浮窗，完整独立工作台页面及 Aqua 前台激活仍待复核。

## 仍需真实验收的边界

- 未逐一打开全部 234 个 source owner 或 45 个真实 Page。DSH 动态入口、委托表单、弹出工作台、进程视图、设备/插件/应用工作区仍需登录与原生 host 前提。
- Story 的本地请求端口不证明云端保存、真实执行器、Git/文件系统、更新回滚、系统权限或连接服务的兼容性。角色、所有者、只读、失联和失败状态需在真实授权场景复核。
- 原生 IME 组合输入、剪贴板/选区、Tab/Shift+Tab 全流程、指针拖拽与触控尚未形成完整证据；明暗主题、对比度与所有原生窗口尺寸也未完成逐页验收。
- 通知最终位置已复测；生产分屏/portal 生命周期仍有专项限制。多 iframe 动态导入错误没有被证明是生产组件缺陷，不以减少 iframe 冒充根因修复。
- 源码 CSS 曾发现模板弹层 `[open]` 与 SDK `data-open` 不符，已修为 `[data-open]`。旧设备操作 `[open]` 规则在该快照无活跃 TSX 引用，只能归为死规则，不能编造视觉失败；业务 `data-state` 不等同于 SDK 状态。

公共导出示例覆盖为 112 项：100 直接示例、5 生产组合、7 非视觉 API（含最新 SortableDragArea 真实组合）。该数字只表示组件目录覆盖，详见[组件库](./component-library.md)，不改变上述页面验收状态。
