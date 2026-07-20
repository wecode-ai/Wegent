---
sidebar_position: 21
---

# Wework VNC 测试与桌面 E2E 归属设计

## 背景

Wecode VNC 的 API、页面、noVNC 资源、会话编排和主要 E2E 场景已经迁入
`wework/wecode/`，但公共 Wework 目录仍保留了若干由 VNC 功能引入的测试 mock、桌面控制
action 和 E2E fixture 接线。这些代码没有直接实现 RFB 协议，但会让公共测试和自动化入口了解
Wecode 产品能力，削弱可选扩展边界。

本次调整继续执行“VNC 相关代码尽可能归入 `wework/wecode/`”的约束，同时避免复制公共
组件测试或完整桌面 E2E runner。公共代码允许保留协议无关、产品无关的扩展插槽。

## 目标

- 将项目工作区和连接设置中的云桌面专项测试迁入 `wework/wecode/`。
- 将 Wecode 桌面 E2E 使用的嵌入式浏览器控制 action 实现迁入 `wework/wecode/`。
- 将 Wecode 云设备 fixture、VNC 场景生命周期和专用运行入口迁入 `wework/wecode/`。
- 公共 Wework 只保留通用组件插槽、通用桌面控制委托和通用 E2E 场景加载钩子。
- 保持现有用户行为、URL、IPC 命令、`data-testid`、失败恢复和安全边界不变。
- 默认公共测试和默认桌面 E2E 不依赖 Wecode VNC 实现。

## 非目标

- 不复制 `DesktopWorkbenchLayout.test.tsx` 或 `task-flow.e2e.mjs` 的完整内容到 Wecode。
- 不修改 VNC 后端接口、WebSocket 代理、RFB 握手或 Tauri 凭据交接协议。
- 不改变桌面按钮的设备能力判断或 UI 布局。
- 不把公共 Wework 的普通浏览器自动化、任务流 E2E 或组件契约迁入 Wecode。
- 不通过运行时 fallback 同时保留新旧 VNC 路径。

## 方案比较

### 方案 A：通用扩展钩子加 Wecode 专项实现（选定）

公共宿主定义小型、协议无关的接口，Wecode 提供组件、桌面控制和 E2E 场景实现。公共测试只验证
宿主契约，Wecode 测试验证具体云桌面行为。

优点是边界清晰、没有大型文件复制、公共 runner 仍可复用；代价是公共宿主仍需保留少量通用
委托代码。

### 方案 B：复制完整测试和 E2E runner 到 Wecode

可以让公共文件没有新增接线，但会复制数千行测试基础设施，后续每次公共任务流变化都需要双份
维护，因此不采用。

### 方案 C：保持当前结构，只禁止出现 VNC 字面量

改动最少，但公共自动化仍拥有只被 Wecode 使用的 action，公共组件大测试仍承担产品专项断言，
不能真正解决职责归属问题，因此不采用。

## 组件与测试边界

### 云桌面工作区插槽

`CloudDesktopExtension` 增加协议无关的工作区 action 组件。公共
`WorkspacePanelCards` 只负责：

- 根据通用设备能力和扩展可用性决定是否挂载插槽；
- 传入设备 ID、设备状态、宿主禁用状态和成功回调；
- 为扩展组件提供稳定的网格位置。

Wecode 工作区 action 组件负责：

- 读取当前云连接；
- 管理加载、失败、重试和连接上下文变化；
- 调用 Wecode `openCloudDesktop`；
- 渲染现有 `workspace-desktop-card` 并保持原有样式与文案；
- 成功后调用宿主关闭回调。

这样，`WorkspacePanelCards.test.tsx` 中有关打开桌面、重试、项目切换、断线重连和离线禁用的
专项测试可以迁入 Wecode 的聚焦测试。公共测试只保留扩展插槽是否按契约挂载的最小断言。

### 连接设置插槽

现有 `DeviceAction` 扩展组件继续由 Wecode 持有。连接设置公共测试只验证通用设备 action 插槽，
Wecode 测试负责实际“桌面”按钮、请求状态和打开结果。`DesktopWorkbenchLayout.test.tsx` 不再设置
Wecode 云桌面 mock 或断言具体“桌面”文案；设置页到内置浏览器的产品组合行为由 Wecode 聚焦
集成测试和真实桌面 E2E 覆盖。

建议的 Wecode 测试位置：

- `wework/wecode/features/vnc/WorkspaceDesktopAction.test.tsx`
- `wework/wecode/features/vnc/host-integration.test.tsx`

测试应复用公共组件和契约，不复制公共大测试文件。

## 桌面控制扩展边界

新增协议无关的桌面控制扩展契约，默认公共实现不处理任何附加 action。公共
`src/e2e/automation.ts` 在内建 action 未命中时，把命令委托给扩展并使用明确的
“handled/result”返回值区分未处理命令和空字符串结果。

Wecode 实现持有以下当前只服务于 VNC 场景的 action：

- 关闭指定嵌入式浏览器；
- 在指定嵌入式浏览器中执行 JSON 表达式；
- 准备浏览器 ownership relabel 回归状态。

action 名称、参数校验和嵌入式浏览器调用全部位于 `wework/wecode/e2e/`。公共自动化文件不再
导入这些嵌入式浏览器函数，也不再枚举 Wecode action 名称。

## 桌面 E2E 场景边界

公共 `task-flow.e2e.mjs` 保持唯一的应用构建、进程隔离、控制服务、日志、清理和基础任务流
runner。它增加一个通用、可选的场景模块协议：

- 创建场景并取得可选认证信息；
- 在 HTTP/control server 上注册额外路由；
- 在基础任务流之前执行聚焦验证；
- 在退出时清理场景资源；
- 在失败诊断中追加场景自己的结构化字段。

公共 runner 不导入 Wecode 路径、不定义 Wecode 设备、不识别 VNC/RFB，也不提供
`--wecode-only`。Wecode 新增自己的薄入口，在导入公共 runner 前配置场景模块和“仅运行扩展
场景”标记：

`wework/wecode/e2e/desktop/task-flow.e2e.mjs`

`e2e:desktop:wecode` 脚本改为运行该入口。设备 fixture、认证 token、VNC HTTP/WebSocket 路由、
RFB 服务、验证步骤和诊断字段继续由 `wework/wecode/e2e/desktop/` 统一持有。

## 数据流

1. 产品构建通过现有 `@extensions` alias 取得 Wecode 云桌面组件和桌面控制扩展。
2. 公共宿主仅传递通用上下文，不读取 VNC 配置或了解 VNC 页面。
3. Wecode 组件完成云桌面打开流程，并通过宿主回调改变公共工作台状态。
4. Wecode E2E 薄入口向公共 runner 提供场景模块。
5. 公共 runner 在生命周期边界调用场景钩子；具体请求、浏览器检查和 RFB 断言留在 Wecode。

## 错误与清理

- 扩展未提供或返回“未处理”时，公共自动化保持现有未知 action 错误，不静默成功。
- 场景模块加载失败时，聚焦 E2E 立即失败，不回退到无场景运行。
- Wecode 场景必须在公共 server 关闭前解除监听并关闭所有 VNC socket。
- 云桌面打开失败继续显示当前错误并允许重试；迁移不得改变错误语义。
- 失败诊断只记录计数和协议状态，不记录 token、签名或认证 WebSocket URL。

## 验证计划

### 单元和组件测试

- 公共 cloud desktop contract 的不可用默认实现测试。
- 公共宿主对可用和不可用扩展插槽的最小测试。
- Wecode 设置页 action 成功、失败、离线和重试测试。
- Wecode 工作区 action 成功、失败、项目变化、断线重连和离线测试。
- 桌面控制扩展的 handled、unhandled、参数缺失和空结果测试。
- E2E 场景模块加载与诊断契约测试。
- 归属测试确认指定公共文件不含 VNC/RFB/Wecode action 或 fixture 名称。

### 静态和构建验证

- Prettier、ESLint、TypeScript 和完整 Wework Vitest。
- Vite build，确认 VNC 页面和 noVNC 资源仍进入产品构建。
- Rust format 和现有 VNC session 测试。

### 真实桌面验证

- 运行 `e2e:desktop:wecode`，确认设置页桌面入口、内置浏览器、配置请求、WebSocket upgrade、
  RFB 握手、连接标记和清理全部通过。
- 运行默认桌面 E2E 的基础阶段，确认没有配置 Wecode 场景时公共 runner 正常工作。
- 保留隔离会话的日志与截图证据，不操作个人 Wework 窗口。

---

# Wework VNC Test and Desktop E2E Ownership Design

## Summary

Concrete cloud-desktop component tests, embedded-browser control actions, device fixtures, and VNC
scenario lifecycle belong under `wework/wecode/`. Public Wework retains only protocol-neutral
extension slots, command delegation, and an optional E2E scenario-module contract.

The selected design avoids copying the large public component tests or the desktop task-flow
runner. Wecode supplies focused tests and a thin E2E entry point that configures the reusable public
runner.

## Boundaries

- A Wecode workspace action component owns cloud connection state, launch, retry, stale-request
  rejection, and the existing Desktop card UI.
- Public workspace and settings components mount generic extension slots and know nothing about VNC.
- A desktop-control extension handles Wecode-only browser actions. The public automation dispatcher
  delegates unknown commands through a handled/result contract.
- A generic optional scenario-module contract lets the public desktop runner call setup, verification,
  diagnostics, and cleanup hooks.
- The Wecode E2E entry point selects the scenario; the public runner contains no Wecode device,
  token, VNC route, RFB state, or product-specific CLI flag.

## Compatibility and verification

The refactor must preserve URLs, IPC command names, credential handling, `data-testid` values, UI
behavior, failure recovery, and RFB behavior. Verification includes focused public contract tests,
Wecode component and ownership tests, the complete Wework test suite, lint, type checking, Vite and
Rust checks, the focused real-Tauri Wecode scenario, and a default runner smoke path without a Wecode
scenario.
