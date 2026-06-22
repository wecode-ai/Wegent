---
sidebar_position: 1
---

# Wework 项目文件夹对话框设计

## 背景

Wework 当前创建和编辑项目的弹窗把“项目记录”“项目名称”“设备”“文件夹”“Git 仓库”等概念放在同一个表单里。实际模型应该更简单：

- Project 是设备无关的中心记录。
- 每台设备可以为同一个 Project 关联一个主文件夹。
- 同一个 Project 的不同设备文件夹可以来自同一个 Git 仓库，但 Git 不是用户在创建弹窗里必须理解或配置的对象。

本设计把交互收敛为“设备 + 文件夹”。Git origin 和仓库一致性暂不在此对话框展示。

## 目标

- 创建项目时，用户只需要为当前设备选择或新建一个项目文件夹。
- 项目名称默认使用第一个已选文件夹的 basename，并允许在选择后轻量改名。
- 编辑项目时，用设备 tabs 管理每台设备的主文件夹。
- 抽取现有 `ProjectCreateDialog` 内置目录选择能力为可复用组件，供创建、编辑和后续任务复制入口复用。
- 每台设备在同一个 Project 下最多关联一个主文件夹。
- 移除创建/编辑对话框里的独立 Git origin 配置、Git 选择器和 Git 状态展示。

## 非目标

- 不在本轮设计里实现 Git origin 配置 UI。
- 不在设备 tab 上展示 Git 仓库不一致状态。
- 不支持同一设备在同一项目下配置多个主文件夹。
- 不设计 worktree 或任务临时目录管理。任务 worktree 仍由运行时任务复制流程管理。
- 不引入新的 native folder dialog 依赖；本轮复用并抽取现有远程目录选择能力。

## 信息架构

### 创建项目

创建对话框顶部是设备 tab 区域，但默认只突出当前设备：

```text
创建项目

[MacBook · 当前设备]                         [添加其他设备]

为这台设备选择一个项目文件夹

[选择已有] [新建]

[取消] [创建项目]
```

规则：

- 默认选中当前或偏好的可用设备。
- 创建态不默认铺开所有设备，避免普通用户误以为必须配置多设备。
- `添加其他设备` 展开其余可用设备 tabs。用户可以在创建时额外配置，也可以创建后再编辑。
- 创建按钮在至少一个设备选择了文件夹后启用。
- 选中文件夹后显示项目名预览，例如 `项目名：Wegent`，旁边提供轻量 `改名` 操作。

### 编辑项目

编辑对话框包含项目名称和完整设备 tabs：

```text
编辑项目

项目名称
[Wegent]

[MacBook · 已关联] [Cloud · 未关联] [Office Mac · 已关联]

Office Mac
/Users/team/Wegent

[更换文件夹] [新建文件夹] [解除关联]

[取消] [保存]
```

规则：

- 编辑态显示全部可用于项目的设备 tabs。
- 每个 tab 展示该设备当前文件夹状态：`已关联`、`未关联`、`设备离线`、`需升级`。
- 不展示 Git 状态。
- 已关联设备提供 `更换文件夹`、`新建文件夹`、`解除关联`。
- 未关联设备提供 `选择已有`、`新建`。
- 离线或版本不满足的设备 tab 可见，但文件夹操作禁用，并显示对应原因和升级入口。

## 组件设计

### DeviceFolderPicker

从 `wework/src/components/projects/ProjectCreateDialog.tsx` 中抽取现有目录选择和新建目录能力，形成可复用 `DeviceFolderPicker`。

职责：

- 根据 `deviceId` 加载起始目录。
- 浏览设备目录。
- 选择已有目录。
- 新建目录。
- 返回 `{ deviceId, path, action }`，其中 `action` 为 `select` 或 `create`。
- 展示目录加载、新建失败、设备不可用等局部错误。

非职责：

- 不创建 Project。
- 不调用 `prepareDeviceWorkspace`。
- 不保存设备映射。
- 不生成项目名称。
- 不展示或判断 Git origin UI 状态。

建议 props：

```typescript
type DeviceFolderPickerMode = 'select' | 'create'

interface DeviceFolderPickerResult {
  deviceId: string
  path: string
  action: DeviceFolderPickerMode
}

interface DeviceFolderPickerProps {
  device: DeviceInfo
  mode: DeviceFolderPickerMode
  disabled?: boolean
  initialPath?: string
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onConfirm: (result: DeviceFolderPickerResult) => void
  onCancel: () => void
}
```

组件可以先作为弹窗内嵌面板实现。后续如果要改为独立 modal/sheet，只调整组件 presentation，不改变业务调用方。

### ProjectFolderDialog

创建和编辑项目共用一个外层对话框，内部根据是否存在 `project` 切换创建态或编辑态。

职责：

- 维护设备 tabs 和当前选中设备。
- 维护每台设备的草稿文件夹选择。
- 根据第一个文件夹 basename 生成默认项目名。
- 允许选择后改名。
- 创建时调用 `createProject`，再为已选设备逐个调用 `prepareDeviceWorkspace`。
- 编辑时保存项目名称，并对有变化的设备调用 `prepareDeviceWorkspace` 或解除关联能力。

解除关联如果后端当前没有接口，本轮实现计划需要先补 API；不能在前端仅隐藏映射。

## 数据流

### 创建

1. 用户打开创建项目。
2. 对话框默认选中当前或偏好设备。
3. 用户点击 `选择已有` 或 `新建`。
4. `DeviceFolderPicker` 返回设备和路径。
5. 外层对话框用文件夹 basename 生成项目名预览。
6. 用户点击 `创建项目`。
7. 前端调用 `createProject({ name, config: { mode: 'workspace' } })`。
8. 前端对每个已选设备调用 `prepareDeviceWorkspace({ projectId, deviceId, workspacePath, action })`。
9. 刷新项目和 runtime work 列表，选中新项目。

### 编辑

1. 用户从项目菜单打开编辑项目。
2. 前端从 `runtimeWork.projects[].deviceWorkspaces` 读取现有设备文件夹映射。
3. 对话框展示项目名称和设备 tabs。
4. 用户在某个设备 tab 中更换、新建或解除文件夹。
5. 用户点击 `保存`。
6. 前端保存项目名称变更。
7. 前端对有新增或更换的设备调用 `prepareDeviceWorkspace`。
8. 前端对解除关联的设备调用后端解除映射 API。
9. 刷新项目和 runtime work 列表。

## 错误处理

- 没有可用设备：创建对话框展示空状态和“添加云设备/连接设备”入口。
- 当前设备离线：tab 可见，文件夹操作禁用。
- 设备版本过低：tab 可见，文件夹操作禁用，展示升级入口。
- 目录加载失败：错误显示在 `DeviceFolderPicker` 内，允许重试或返回。
- 新建目录失败：错误显示在 `DeviceFolderPicker` 内，不关闭外层对话框。
- 项目创建成功但设备映射失败：保留已创建项目，显示失败设备和重试入口；不要静默关闭。
- 多设备映射部分失败：保存成功的映射保留，失败 tab 显示错误并允许重试。

## 文案原则

- 创建态使用“项目文件夹”，不解释 Project、Device Workspace、Git origin。
- 设备 tab 状态使用用户可理解的状态：`已关联`、`未关联`、`设备离线`、`需升级`。
- 目录动作使用短文案：`选择已有`、`新建`、`更换文件夹`、`解除关联`。
- Git 相关文案不出现在本对话框。

## 测试

前端单元测试：

- 创建对话框默认只突出当前设备。
- 没有选择文件夹时创建按钮禁用。
- 选择已有文件夹后显示项目名预览并启用创建按钮。
- 新建文件夹后显示新目录路径并启用创建按钮。
- 修改项目名后创建请求使用修改后的名称。
- 创建成功后调用 `prepareDeviceWorkspace` 写入设备映射。
- 编辑对话框展示全部设备 tabs 和现有映射。
- 更换某设备文件夹后保存只更新该设备映射。
- 离线或需升级设备禁用文件夹操作。
- `DeviceFolderPicker` 支持选择已有目录、新建目录、目录加载失败和新建失败。

后端/API 测试：

- 如果实现解除关联接口，覆盖只删除当前用户、当前项目、当前设备的映射。
- 保持 `prepareDeviceWorkspace` 对普通文件夹和 Git 文件夹的现有校验行为。

## 迁移说明

- 保留当前 `ProjectCreateDialog` 的业务入口，但拆分内部结构。
- 先抽取 `DeviceFolderPicker`，再重组创建和编辑对话框，降低一次性改动风险。
- 现有 `data-testid` 需要保留或同步更新对应测试。
- 旧的 Git 仓库选择创建模式不再作为此对话框的主流程；如果仍有入口依赖，需要在实施计划中明确删除或迁移。
