---
sidebar_position: 30
---

# Wework 组件库

Wework 使用 [UI SDK](https://github.com/vercel-labs/ui) 的 React 行为层，版本固定在 `@ui-sdk/core`、`@ui-sdk/react` 的 `0.1.0-beta.10`。UI SDK 负责控件语义、键盘、焦点与浮层；项目组件负责设计令牌、尺寸和业务适配。视觉规范以 `wework/DESIGN.md` 为准。

源码逐页结论、实际 Story 运行记录与未验边界见[组件迁移评审记录](./component-migration-review.md)。

## 入口与目录

| 入口                                      | 内容                                                 |
| ----------------------------------------- | ---------------------------------------------------- |
| `@wegent/collaboration/controls`          | 基础控件、设置布局、菜单、权限选择                   |
| `@wegent/collaboration/controls/entities` | 人员、协作者、小组成员、智能体、模型、看板字段选择   |
| `wework/src/components/library/index.ts`  | 桌面组件总入口，包含项目空间、设备、参与者等宿主适配 |
| `wework/src/stories/`                     | 使用生产组件的可运行示例                             |
| `wework/.storybook/`                      | 独立预览、语言、主题和 AI MCP 配置                   |

共享控件实现位于 `packages/collaboration/src/controls/`。业务组件保留在所属领域，通过统一入口导出；请求、权限、标识转换和持久化仍由业务调用方管理。

## 运行示例

```bash
pnpm --filter wework storybook
pnpm --filter wework storybook:build
pnpm --filter wework components:audit
```

本地预览默认使用 `http://127.0.0.1:6006`，支持中文、英文和明暗主题。示例使用局部状态和样例数据，不启动桌面运行时，不连接个人账号。

当前示例包括按钮、文本输入、多行输入、复选框、开关、普通与可搜索选择、多选、滑块、分段选择、设置行、确认与输入弹窗，以及模型、权限、协作者和设备选择。示例分别展示禁用、只读、空结果、加载、失败、混合选择等适用状态。

## AI 使用

Storybook 配置启用了 `@storybook/addon-mcp` 和组件清单功能。启动后，支持 HTTP MCP 的客户端可连接 `http://127.0.0.1:6006/mcp`，读取组件文档和示例。仓库不会自动修改个人 MCP 配置。

优先检索已有组件及其 Story，再编辑生产调用。`componentCatalog.test.tsx` 使用 UI SDK agent 验证基础组合能按可访问名称被发现和操作。每个控件必须有可访问名称；选项必须提供稳定值，业务标识不能使用显示名称代替。

## 选择控件

- 执行命令使用 `ActionMenu`；选择一个值使用 `SelectField`。
- 需要搜索、分组或多选时使用 `SearchableSelect`。异步搜索由业务层提供，保留请求失效和权限过滤。
- 单选的每次激活都会执行后续操作时使用 `activateSelected`。例如任务已经关联到某个项目时，再次选中同一项目可以改绑其中的事项。
- 开关使用 `Switch`；独立勾选使用 `Checkbox`；互斥选项使用 `RadioGroup` 和 `Radio`。
- 页面标签使用 `TabsRoot`、`TabsList`、`TabsTab`。桌面窗口顶部使用 `appearance="surface"`，由选中页签的底色标识当前工作区。少量互斥设置使用 `SegmentedControl`。
- 设置页面复用 `SettingsGroup`、`SettingsRow`，不要再定义另一套行高、边框和标签布局。

```tsx
import { SearchableSelect } from "@wegent/collaboration/controls";
<SearchableSelect
  multiple
  value={selectedIds}
  onChange={setSelectedIds}
  options={people.map((person) => ({ value: person.id, label: person.name }))}
  accessibleLabel="参与者"
  searchPlaceholder="搜索参与者"
  emptyLabel="没有匹配的参与者"
  testId="issue-participants"
/>;
```

实际页面的文案通过 i18n 提供。相同用途的控件使用相同尺寸、圆角、选中态、禁用态和反馈规则；布局差异由容器表达。移动端触控目标至少 44px，桌面密度遵循设计规范。

表单使用共享 `Field`、`FieldLabel`、`FieldDescription`、`FieldError` 组合，显式显示字段名；输入与选择均使用 `default/outline` 并占满字段宽度（桌面 36px，移动 44px）。`MenuSelect field` 必须提供 `label`，自动复用同一组合；SettingsRow 和工具栏继续使用 `dense/plain`，并通过 `accessibleLabel` 提供稳定名称。

Composer 上下文行使用 `ComposerContextButton`，选值时使用 `SelectField` 或 `SearchableSelect` 的 `appearance="composer"`。协作项目有现成的 `ComposerProjectSelector`，调用时传入项目选项和可访问名称。Storybook 的 `Business/ComposerProjectSelector → Composer Context Row` 可对照三个入口的空闲、悬停和展开状态。由于这些控件共用尺寸、色彩和焦点规则，业务调用只处理数据、内容和布局宽度。

工具栏里的人员和插件选择也使用该样式。工作区选定后显示工作区名称。讨论工具栏在空间不足时换行，保留操作名称。事项详情的内联属性选择使用 `appearance="property"`，编辑表单的字段使用描边样式。

新建事项和新建项目共用 `ParticipantField` 与 `ParticipantToken`，已选成员和添加入口放在同一字段。

对话框页脚通过 `Button` 的 `primary`、`ghost`、`outline` 和 `destructive` 变体表达操作语义。行内删除入口复用 `DeleteIconButton` 或 `destructive-ghost`。同一组按钮使用统一的 `size`，禁用状态交由组件处理。

## 弹窗和浮层

`DialogSurface` 组合 SDK Dialog 或 AlertDialog，业务方控制关闭和提交中的取消限制。自定义页面遮罩可使用默认的原位布局；需要浏览器顶层的内容使用 `inline={false}`。嵌入步骤使用 `InlinePanel` 管理 Escape 层级和焦点恢复，父弹层持有模态隔离。

一个弹层只保留一个焦点和关闭所有者。使用 SDK 浮层之后，删除旧的 Escape、Tab 循环、背景隔离、窗口滚动及定位监听。专业编辑器的文本编辑行为继续由其编辑器管理；编辑器外的按钮和选择控件使用项目组件库。

## 覆盖与验证

迁移仍在进行，不能将当前示例列表视为全部界面已经迁移的证明。`components:audit` 报告生产源码中手写的 JSX 控件与交互角色，以及内置 DSH 客户端通过 React `createElement` 创建的原生控件。JSX 中提供给 SDK render 的原生节点和隐藏浏览器文件输入不计入遗漏。清单必须结合生产调用、类型检查、行为测试和真实预览一起审查。

变更公开组件时同步更新示例、说明和生产调用。保留已有 `data-testid`。临时截图、日志和构建产物不提交。完整回归由既有推送和 CI 流程承担；本地按仓库规则执行定向验证。

## 业务组件示例

| Storybook 分组                   | 检查行为                                       |
| -------------------------------- | ---------------------------------------------- |
| Business/IssueOwnerPicker        | 未分配、人员选择和禁用分配                     |
| Business/MemberSearchPicker      | 搜索、多选、加载、目录失败和保存中             |
| Business/ProjectAgentPicker      | 智能体选择、空目录、加载、失败和保存中禁用操作 |
| Business/GroupParticipantsEditor | 负责人、成员、职责和只读名单                   |
| Business/ProjectSpacePickerMenu  | 本地与云端分组、搜索、排序和移除项目选择       |
| Business/ProjectBoardGroupPicker | 看板字段搜索和空字段列表                       |
| Business/BoardViewTagPicker      | 已有标签、占用标签、新建标签和长度校验         |

以上示例使用生产组件、本地状态和确定性示例数据。通过工具栏比较中英文与明暗主题。静态构建仅证明模块可解析，不能替代浏览器渲染和生产服务验证。

已对运行中的开发服务验证 MCP 握手、工具发现、`docs-list`、ProjectAgentPicker 的 `docs-show` 和 `stories-preview`。返回预览地址不代表已经通过浏览器交互验证。

公开目录还包括 Business/IssueParticipantPicker（搜索、空结果、目录失败和禁用）和 Business/GitAccountConfiguration（正常、文本入口、打开失败和设备权限限制）。Git 配置示例仅在本地记录目标地址，不打开外部设置或访问凭证。

Business/BranchPicker 包含加载、空分支、目录失败后重试和分支操作禁用示例。Controls/SelectField 的 KeyboardSequence 在选择器前后放置输入框，用于检查焦点导航。

## 完整示例索引与公开 API 覆盖

下表链接到可运行 Story 的源码，所有示例直接使用生产控件或生产组合适配。工具栏提供中英文与明暗主题。新增控件需要同步加入此索引。

| 示例源码                                                                                       | 覆盖范围                                                                 |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [ActionButtons](../../../wework/src/stories/ActionButtons.stories.tsx)                         | 生产组件与适用状态                                                       |
| [BoardViewTagPicker](../../../wework/src/stories/BoardViewTagPicker.stories.tsx)               | 生产组件与适用状态                                                       |
| [BranchPicker](../../../wework/src/stories/BranchPicker.stories.tsx)                           | 生产组件与适用状态                                                       |
| [Button](../../../wework/src/stories/Button.stories.tsx)                                       | 生产组件与适用状态                                                       |
| [Checkbox](../../../wework/src/stories/Checkbox.stories.tsx)                                   | 生产组件与适用状态                                                       |
| [Collapsible](../../../wework/src/stories/Collapsible.stories.tsx)                             | 关闭、初始展开；保留面板输入值                                           |
| [ComposerComparison](../../../wework/src/stories/ComposerComparison.stories.tsx)               | 生产组件与适用状态                                                       |
| [ComposerProjectSelector](../../../wework/src/stories/ComposerProjectSelector.stories.tsx)     | 生产组件与适用状态                                                       |
| [DeviceSelect](../../../wework/src/stories/DeviceSelect.stories.tsx)                           | 生产组件与适用状态                                                       |
| [Dialogs](../../../wework/src/stories/Dialogs.stories.tsx)                                     | 生产组件与适用状态                                                       |
| [Feedback](../../../wework/src/stories/Feedback.stories.tsx)                                   | 生产组件与适用状态                                                       |
| [GitAccountConfiguration](../../../wework/src/stories/GitAccountConfiguration.stories.tsx)     | 生产组件与适用状态                                                       |
| [GroupParticipantsEditor](../../../wework/src/stories/GroupParticipantsEditor.stories.tsx)     | 生产组件与适用状态                                                       |
| [IconButton](../../../wework/src/stories/IconButton.stories.tsx)                               | 生产组件与适用状态                                                       |
| [IssueOwnerPicker](../../../wework/src/stories/IssueOwnerPicker.stories.tsx)                   | 生产组件与适用状态                                                       |
| [IssueParticipantPicker](../../../wework/src/stories/IssueParticipantPicker.stories.tsx)       | 生产组件与适用状态                                                       |
| [LayoutRegression](../../../wework/src/stories/LayoutRegression.stories.tsx)                   | 生产组件与适用状态                                                       |
| [MemberSearchPicker](../../../wework/src/stories/MemberSearchPicker.stories.tsx)               | 生产组件与适用状态                                                       |
| [MenuPrimitives](../../../wework/src/stories/MenuPrimitives.stories.tsx)                       | 生产组件与适用状态                                                       |
| [Menus](../../../wework/src/stories/Menus.stories.tsx)                                         | 生产组件与适用状态                                                       |
| [ModelSelector](../../../wework/src/stories/ModelSelector.stories.tsx)                         | 生产组件与适用状态                                                       |
| [OverlayParts](../../../wework/src/stories/OverlayParts.stories.tsx)                           | 浮层箭头、快捷键、上下文菜单、数据菜单                                   |
| [PermissionModeSelector](../../../wework/src/stories/PermissionModeSelector.stories.tsx)       | 生产组件与适用状态                                                       |
| [Popover](../../../wework/src/stories/Popover.stories.tsx)                                     | 生产组件与适用状态                                                       |
| [Progress](../../../wework/src/stories/Progress.stories.tsx)                                   | 生产组件与适用状态                                                       |
| [ProjectAgentPicker](../../../wework/src/stories/ProjectAgentPicker.stories.tsx)               | 生产组件与适用状态                                                       |
| [ProjectBoardGroupPicker](../../../wework/src/stories/ProjectBoardGroupPicker.stories.tsx)     | 生产组件与适用状态                                                       |
| [ProjectCollaboratorPicker](../../../wework/src/stories/ProjectCollaboratorPicker.stories.tsx) | 生产组件与适用状态                                                       |
| [ProjectSpacePickerMenu](../../../wework/src/stories/ProjectSpacePickerMenu.stories.tsx)       | 生产组件与适用状态                                                       |
| [RadioGroup](../../../wework/src/stories/RadioGroup.stories.tsx)                               | 生产组件与适用状态                                                       |
| [RangeSlider](../../../wework/src/stories/RangeSlider.stories.tsx)                             | 生产组件与适用状态                                                       |
| [Resizable](../../../wework/src/stories/Resizable.stories.tsx)                                 | 横向、纵向、禁用、受控布局与提交保存（仅局部状态）                       |
| [ScrollArea](../../../wework/src/stories/ScrollArea.stories.tsx)                               | 生产组件与适用状态                                                       |
| [SearchableSelect](../../../wework/src/stories/SearchableSelect.stories.tsx)                   | 生产组件与适用状态                                                       |
| [SegmentedControl](../../../wework/src/stories/SegmentedControl.stories.tsx)                   | 生产组件与适用状态                                                       |
| [SelectField](../../../wework/src/stories/SelectField.stories.tsx)                             | 生产组件与适用状态                                                       |
| [Settings](../../../wework/src/stories/Settings.stories.tsx)                                   | 设置分组、响应式导航、真实模型连接表单（宽屏/窄屏）                      |
| [Switch](../../../wework/src/stories/Switch.stories.tsx)                                       | 生产组件与适用状态                                                       |
| [Tabs](../../../wework/src/stories/Tabs.stories.tsx)                                           | 生产组件与适用状态                                                       |
| [Field](../../../wework/src/stories/Field.stories.tsx)                                         | 表单标签、说明和错误关联；default/outline 字段                           |
| [TextField](../../../wework/src/stories/TextField.stories.tsx)                                 | 生产组件与适用状态                                                       |
| [Textarea](../../../wework/src/stories/Textarea.stories.tsx)                                   | 生产组件与适用状态                                                       |
| [Toast](../../../wework/src/stories/Toast.stories.tsx)                                         | 成功、错误、加载；真实 TransientNotice 锚定长文本、2200ms 关闭与持久操作 |
| [VirtualTree](../../../wework/src/stories/VirtualTree.stories.tsx)                             | 空、禁用、1000 行虚拟化、远端节点显示                                    |
| [InlinePanel](../../../wework/src/stories/InlinePanel.stories.tsx)                             | 真实 TemplatePanel 嵌入父 Dialog；普通与提交中步骤，Escape 与焦点恢复    |
| [AutomationTaskSelection](../../../wework/src/stories/AutomationTaskSelection.stories.tsx)     | 真实自动化工作区的任务搜索、离线项、空态                                 |
| [ConversationQueue](../../../wework/src/stories/ConversationQueue.stories.tsx)                 | 真实生产组件与适用状态                                                   |
| [PlanningDragAndDrop](../../../wework/src/stories/PlanningDragAndDrop.stories.tsx)             | 真实生产组件与适用状态                                                   |
| [RuntimeSettingsPage](../../../wework/src/stories/RuntimeSettingsPage.stories.tsx)             | 真实生产组件与适用状态                                                   |
| [Sortable](../../../wework/src/stories/Sortable.stories.tsx)                                   | 真实生产组件与适用状态                                                   |
| [TaskDescriptionEditor](../../../wework/src/stories/TaskDescriptionEditor.stories.tsx)         | 真实生产组件与适用状态                                                   |
| [ViewportReview](../../../wework/src/stories/ViewportReview.stories.tsx)                       | 真实生产组件与适用状态                                                   |

公开入口对照如下。类型导出不单独计数；低层部件通过有效组合演示，不要求脱离其根组件独立运行。此表是源码覆盖清单，不能当作逐页面 UI 验收结果。

| 类别             | 数量 | 未覆盖项                                    |
| ---------------- | ---- | ------------------------------------------- |
| 直接生产组件示例 | 100  | 0                                           |
| 生产组合间接覆盖 | 5    | 0                                           |
| 非独立视觉 API   | 7    | Context、控制器与 toaster；随对应根组件使用 |

`Resizable` 的拖动与键盘调整交给 SDK；只在 `onLayoutCommit` 保存，`onLayoutChange` 更新受控布局。`CollapsibleRoot/Trigger/Panel` 替代各处独立展开逻辑。`ToastRegion` 持有局部 toaster 队列，`TransientNotice` 负责业务消息和锚定；有操作的消息持续显示，普通消息自动关闭，示例的回调保持稳定。

本轮索引、格式和类型检查不能替代新增示例的浏览器交互验证；静态构建与 MCP 的既有成功记录不自动适用于后续新增控件。

`InlinePanel` 用于既有父弹窗内的步骤，只管理 Escape 层级和卸载后的焦点恢复，不新增 modal role。嵌入模板步骤复用真实 `TemplatePanel`，父弹窗继续拥有背景隔离与整体取消。

初始目录的 52 个 Story 文件涵盖 112 个公开值导出，其中有 100 个直接示例、5 个生产组合示例、7 个非视觉 API。`SortableDragArea` 示例保留独立键盘手柄，并从指针激活区域排除文本输入。此清单来自公开入口和 Story 源码；源码审查、运行 Story 检查和原生真实页面验收是独立证据，不可互相替代。
