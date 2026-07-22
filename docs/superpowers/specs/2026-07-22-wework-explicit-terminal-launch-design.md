---
sidebar_position: 1
---

# Wework 显式终端启动与工具菜单设计

## 背景

Wework 的底部工作区面板当前向 `WorkspacePanelCards` 传入
`defaultOpenTool="terminal"`。用户打开面板时，组件会立即创建终端会话：

- 创建成功时，面板直接显示命令行，历史任务尤其容易表现为“跳转到终端”；
- 创建失败时，面板回到工具启动器，同时显示“启动失败”并把终端标记为不可用；
- 新任务和历史任务因此呈现不同界面，但差异来自终端请求结果，而不是产品意图。

底部面板标签栏的添加菜单目前只有“终端”一项。用户需要从同一菜单启动
Terminal、IDE 和内网桌面，并要求 IDE 或桌面操作不能破坏已经存在的终端状态。

## 目标

- 新任务和历史任务第一次打开底部面板时均显示工具启动器，不自动创建终端。
- 工具启动器继续展示当前环境可用的 Terminal、IDE 和桌面能力。
- 只有用户显式选择 Terminal 后才创建并显示命令行。
- 已经显式创建的终端按任务保留；关闭后重新打开面板或切换任务再返回时直接恢复。
- 添加菜单提供 Terminal、IDE 和桌面三种可用动作。
- 从添加菜单打开 IDE 或桌面时，保留当前终端、当前标签和底部面板。
- IDE 使用操作系统默认浏览器打开；桌面使用 Wework 内嵌浏览器打开。
- 启动器卡片和添加菜单复用同一套能力判断与启动逻辑。

## 非目标

- 不改变右侧工作区面板中已经明确选择“终端”标签的语义。
- 不改变本地终端、远程终端、IDE 会话或桌面会话的后端协议。
- 不为不包含内网桌面扩展的外网构建伪造桌面能力。
- 不改变任务归档时清理终端会话的现有规则。
- 不重做底部面板、标签栏或工具卡片的视觉设计。

## 选定方案

采用共享工具动作方案。`WorkspacePanelCards` 继续拥有工作区能力判断、加载状态、
错误状态和实际启动操作，并向底部面板暴露当前活动标签可调用的工具动作。启动器卡片
与标签栏添加菜单调用同一组动作，不在 `BottomWorkspacePanel` 中复制本地、云端、远程
和内网扩展分支。

没有选择以下方案：

- 在 `BottomWorkspacePanel` 中复制三套启动逻辑。虽然改动较小，但会让启动器与菜单的
  能力判断再次分叉。
- 点击添加菜单后只返回工具启动器。该方案可以复用现有卡片，但需要用户再次点击，
  不符合菜单项应直接执行动作的要求。

## 交互与状态流

### 第一次打开底部面板

1. 底部面板创建一个尚未绑定工具会话的标签。
2. 活动标签渲染工具启动器。
3. 不调用本地或远程终端启动 API。
4. 新任务和历史任务遵循同一流程。

### 从启动器启动终端

1. 用户点击 Terminal 卡片。
2. 当前标签进入终端加载状态。
3. 组件根据现有能力判断启动本地终端、项目远程终端或设备工作区终端。
4. 成功后当前标签显示命令行，并使用现有终端标题更新标签名称。
5. 关闭再打开面板或切换任务再返回时，保留并恢复该终端。

### 使用添加菜单

- **Terminal**：创建一个新标签，在该标签中显式启动终端；已有终端标签继续保留。
- **IDE**：复用当前项目或工作区的 IDE 启动动作，通过系统默认浏览器打开；不创建或
  替换底部标签，不关闭当前终端或底部面板。
- **桌面**：仅在内网桌面扩展和目标设备支持时出现，复用桌面扩展动作并在 Wework
  内嵌浏览器中打开；不创建或替换底部标签，不关闭当前终端或底部面板。

菜单项的可用、禁用和隐藏状态必须与工具启动器一致。外网构建没有桌面扩展时，启动器
和添加菜单均不显示桌面动作。

## 组件边界

### `WorkspacePanelCards`

- 移除底部面板依赖的自动终端启动路径。
- 保留终端会话、活动终端、工具可用性、加载和错误状态的所有权。
- 提供稳定的 Terminal、IDE 和桌面动作描述，使启动器和外部菜单可以复用。
- 区分动作完成后的关闭策略：启动器原有行为可以继续使用其面板关闭回调，添加菜单的
  IDE 和桌面动作明确使用“保留面板”策略。

### `BottomWorkspacePanel`

- 管理底部标签的创建、选择、关闭和保留。
- 第一次打开时只创建空标签，不隐式启动终端。
- 仅使用活动标签提供的工具动作构造添加菜单。
- 选择 Terminal 时先创建新标签，再把显式启动请求交给该标签。

### 内网桌面扩展边界

桌面扩展需要为卡片和菜单提供相同的工作区打开能力，但仍由内网扩展负责连接信息、
内嵌浏览器地址和错误处理。外网回退扩展保持不可用，不引入虚假的兼容路径。

## 错误处理

- 第一次打开面板不发起终端请求，因此不会产生启动失败状态。
- 从启动器或新终端标签启动失败时，保留工具启动器并显示现有的明确错误状态。
- 添加菜单中新终端启动失败时，原有终端会话不受影响；失败的新标签保留启动器，允许
  用户选择其他工具或关闭标签。
- IDE 或桌面启动失败时，保留当前终端和底部面板，并通过对应工具动作的错误反馈告知
  用户，不把失败转换为成功状态。
- 项目或工作区变化时，继续使用现有项目键隔离可用性、错误和终端会话。

## 测试与验证

### 组件测试

- 底部面板首次打开时显示工具启动器，并确认没有调用终端启动 API。
- 新任务和历史任务使用相同的首次打开行为。
- 点击 Terminal 卡片后创建并显示终端。
- 关闭并重新打开面板、切换任务再返回时恢复已经创建的终端。
- 添加菜单按能力显示 Terminal、IDE 和桌面。
- 添加菜单的 Terminal 创建新终端标签并保留原终端。
- 添加菜单的 IDE 使用系统默认浏览器，且保留当前终端和底部面板。
- 添加菜单的桌面调用内网扩展的内嵌浏览器动作，且保留当前终端和底部面板。
- 外网桌面扩展不可用时，启动器和菜单均不显示桌面。
- 各动作失败时保留已有终端并显示错误状态。

### 核心流程与真实桌面验证

- 在桌面 E2E 云端项目流程中覆盖新对话和历史任务首次打开底部面板的启动器状态。
- 在隔离的真实 Tauri 会话中确认：首次打开没有终端请求；点击 Terminal 后出现命令行；
  重新打开可恢复；添加菜单的 IDE 走默认浏览器；可用时桌面走 Wework 内嵌浏览器。
- 保留关键状态截图和 `data-testid` 断言，并在验证结束后停止隔离会话。

## English Summary

The bottom workspace panel must stop auto-launching a terminal. A new or historical task shows the
tool launcher until the user explicitly selects Terminal. Once created, terminal sessions remain
scoped to their task and restore when the panel is reopened or the user returns to the task.

The add menu exposes the available Terminal, IDE, and internal Desktop actions. Terminal creates a
new terminal tab. IDE opens in the operating system's default browser. Internal Desktop opens in
Wework's embedded browser. IDE and Desktop preserve the active terminal and the bottom panel. The
launcher and menu share one capability and action source; external builds without the internal
Desktop extension do not display a fake Desktop action.
