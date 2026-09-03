---
sidebar_position: 34
---

# Wework DSH UI 插件

Wework 的桌面 UI 以 Core DSH 为唯一插件运行时。`@wegent/dsh-app-wework`
负责挂载工作台并声明扩展点；应用、路由、设置页和工作区面板都由独立 DSH
client 插件通过 slot 注入。不要再创建 Wework 私有 manifest、动态模块加载器或
第二个 Cordis `Context`。

## 扩展层次

Wework 的 DSH 扩展分为四层，插件应只依赖实际需要的层：

1. 本文描述的 UI slot：向桌面工作台注入导航、页面、应用和工作区 surface。
2. 标准 DSH service：例如 `sessions`、`tools` 和模型相关 service，由 DSH
   本身管理，不需要 Wework 私有事件总线。
3. [Executor Session 投影](./wework-dsh-executor-sessions.md)：把运行中的 Wework
   任务投影为标准 DSH Session，并提供 Backend 通用插件存储。
4. Electron 宿主边界：由第一方 `@wegent/dsh-electron-host` 管理，只暴露窄
   capability，不暴露 Electron 对象、文件描述符或鉴权 token。第三方插件不应直接
   依赖这个 host 包，只能使用 Wework 明确公开的 client adapter；同一 Core DSH
   页面中的插件共享 JavaScript 信任域，因此只应安装可信插件。

## Core DSH 模型目录

Wework 会把当前可执行的模型目录暴露为 Core DSH provider，并在目录新增、删除或
模型配置变化时同步 provider 与本地代理。该同步只管理模型目录，不跟随 Wework
输入区的当前模型选择：输入区选择是当前 Wework 会话的执行参数，而
`agent-default-model` 是 Core DSH 创建新 Agent 时使用的部署默认值，两者不能互相
覆盖。

只切换 Wework 当前模型时，不得重新注册模型代理，也不得写入 Core DSH settings。
Core DSH 中仍有效的现有默认模型应在目录同步后保留；只有该默认模型已经不可用时，
才选择目录中的第一个模型。这样可以避免 `settings/document-updated` 和
`llm/adapters-updated` 事件让所有常驻模型目录重载，并保持 Wework 工作台界面稳定。

## 扩展点

| Slot                            | 用途                         | 必要元数据                        | 组件 props                    |
| ------------------------------- | ---------------------------- | --------------------------------- | ----------------------------- |
| `wework.action`                 | 可由宿主入口调用的导航动作   | `id`、`path`                      | 无组件                        |
| `wework.app`                    | 产品切换器与应用 surface     | `id`、`label`、`mode`             | `visible`、`tab`              |
| `wework.task.status`            | 左侧任务行状态               | `id`                              | `task`、`workspace`、布局提示 |
| `wework.environment.section`    | 环境面板附加区域             | `id`                              | `info`、`onClose`             |
| `wework.board.card.status`      | 看板任务卡状态               | `id`                              | 看板项、任务绑定与布局提示    |
| `wework.workspace.menu.section` | 工作区弹出菜单附加区域       | `id`                              | 通用工作区上下文、关闭回调    |
| `wework.project.work.section`   | 项目工作栏附加区域           | `id`                              | 通用项目上下文                |
| `wework.project.create.section` | 项目创建菜单附加区域         | `id`                              | 通用项目创建上下文、关闭回调  |
| `wework.route`                  | 顶层辅助页面                 | `id`、`path`、`telemetryFeature`  | `search`、`onNavigate`        |
| `wework.sidebar.navigation`     | 左侧边栏导航入口             | `id`、`path`、`label`             | 元数据入口通常无组件          |
| `wework.settings.page`          | 设置导航与设置内容           | `id`、`path`、`label`、`category` | 设置上下文与 `onBack`         |
| `wework.workspace.tab`          | 顶部可关闭工作区 Tab         | `id`、`label`                     | `visible`、`tab`              |
| `wework.workspace.sidebar.tab`  | 右侧工作区面板 Tab 类型      | `id`、`label`                     | `visible`、`scope`、`tab`     |
| `wework.shell.before`           | 工作台根节点之前             | `id`                              | 空对象                        |
| `wework.shell.after`            | 工作台根节点之后             | `id`                              | 空对象                        |
| `wework.shell.overlay`          | 全局浮层，容器不接收指针事件 | `id`                              | 空对象                        |

`wework.app` 的 `mode` 可以是：

- `native`：导航到 `path`，由 Wework 原生工作区处理。
- `iframe`：在 Wework 应用 WebView 中打开 `url`。
- `surface`：在 `/app/<id>` 中直接渲染插件注册的 React 组件。

`wework.action` 当前是稳定的路径动作描述，不是任意回调通道。插件注册
`{ id, path }` 后，宿主内已有入口可以通过 action id 查找并执行导航；不要把函数、
token 或不可序列化状态写入 descriptor。

状态和区域 slot 都是可重复贡献的位置接口，不预设 Git、SVN、分支或版本管理语义。插件可以直接把
React 组件作为 `ctx.wework.ui.register` 的第四个参数注册；宿主按 contribution
顺序渲染，并只传递该位置的通用上下文。同一个 slot 可以由多个插件同时扩展；
宿主不读取插件 id，也不根据贡献推断任何具体实现能力。

第三方 `wework.settings.page` 和 `wework.route` 不应设置 Wework 内部使用的
`module` 或 `component` 字段。直接把 React 组件作为
`ctx.wework.ui.register` 的第四个参数传入即可。`telemetryFeature` 应使用 Wework
现有的低基数字段；通用第三方页面使用 `apps`。

## 注册规则

插件包的 `package.json` 必须声明 DSH client 依赖：

```json
{
  "dsh": {
    "client": {
      "inject": ["@deepseek-ai/dsh-client-runtime", "@wegent/dsh-app-wework"],
      "platform": "web"
    }
  }
}
```

所有 UI 注册必须依赖 slot 的存活范围：

```js
export const inject = ["slots", "wework"];

export function apply(ctx) {
  ctx.slots.inject("wework.workspace.tab", () =>
    ctx.wework.ui.register(
      ctx,
      "wework.workspace.tab",
      {
        id: "quality-dashboard",
        label: "质量看板",
        order: 20,
      },
      ({ visible, tab }) =>
        React.createElement("section", { hidden: !visible }, tab.title),
    ),
  );
}
```

`wework` 是 `@wegent/dsh-app-wework` 提供的宿主 service，UI 扩展 API 位于
`ctx.wework.ui`。DSH SlotCore 只保留 `id`、`label`、`order`、`priority`
等通用 options；该 API 将
`path`、`category`、`mode` 等 Wework 描述冻结到标准 DSH component 的
`wework` 静态属性，再调用 `ctx.slots.register`。因此发现、依赖、渲染与释放仍由
DSH 管理，没有第二套 Wework 注册表。

`wework.route` 与 `wework.sidebar.navigation` 的 `icon` 字段接受任意有效的
[Lucide 图标名称](https://lucide.dev/icons/)，使用 kebab-case，例如
`shield`、`rocket` 或 `gamepad-2`。Wework 会按名称动态加载图标；名称无效或
未填写时回退为默认九宫格图标。旧插件使用的 `applications` 名称会继续映射到
默认应用图标，无需逐个在 Wework 核心中注册图标白名单。

不要直接调用 `ctx.slots.register` 注册到尚未存活的 Wework slot，也不要把
Wework 描述直接塞进 DSH options。DSH 会在宿主 slot 挂载、卸载或重建时重新执行
`slots.inject` 回调，并自动收敛插件生命周期。

## 可运行插件 Demo

仓库中的
[`wework/dsh/examples/ui-extension-demo`](https://github.com/wecode-ai/Wegent/tree/main/wework/dsh/examples/ui-extension-demo)
是一个不依赖 Wework 私有 React 模块的完整第三方插件。它包含标准
`package.json`、`cordis.patch.yml`、host 入口、client 入口和 Node 回归测试，并
覆盖上表全部 slot。

开发环境中可以在“插件 → 管理 → Wework 插件”安装 Demo 目录的绝对路径，或者
使用：

```text
file:/absolute/path/to/Wegent/wework/dsh/examples/ui-extension-demo
```

安装、更新、启停或卸载会修改受管的 `wework-core` profile；配置变更后需要重启
Core DSH。安装流程会先快照 profile，再运行包管理命令、校验
`dsh.bundle.patch`、执行 `dsh --profile wework-core --dump-config` 预检；失败时
恢复快照。插件不能依赖“安装后立即热生效”。

复制 Demo 开发自己的插件时：

1. 更换 npm 包名、Loader entry id 和所有 contribution id。
2. 只保留需要的 slot；每个交互元素提供稳定的 `data-testid`。
3. 不 import Wework 源码中的页面或 Context；通过组件 props、标准 DSH service
   和公开 capability 通信。
4. 先运行 Demo 的 Node 测试，再用绝对本地目录安装到隔离 Wework 环境验证。

## Wework 内置插件

Wework 当前随 Core DSH 打包以下 UI 插件：

- `@wegent/dsh-ui-core-apps`
- `@wegent/dsh-ui-core-settings`
- `@wegent/dsh-ui-plugin-center`
- `@wegent/dsh-ui-applications`
- `@wegent/dsh-ui-automations`
- `@wegent/dsh-ui-cloud-work`
- `@wegent/dsh-ui-git`

这些包与第三方插件使用相同的 slot 协议。内置插件可以在 contribution 描述中
声明 Wework 私有的 `component` id，由 Wework React 树渲染已有页面实现，以继承
Auth、Cloud、Workbench 等宿主 Context。第三方插件不应使用该字段，应把自己的
React 组件传给 `ctx.wework.ui.register` 的第四个参数。

`@wegent/dsh-ui-git` 是上述通用位置接口的一种实现。它向工作区菜单、项目工作栏、
项目创建菜单、任务状态、环境面板和看板卡片贡献自己的组件，并贡献“代码托管”和
“工作树”设置页。分支、提交、推送、克隆、PR / MR 与执行参数均由插件组件解释；
宿主接口不包含 Git 命令名、Git 插件 id、分支能力判断或 source-control section。
禁用或不安装插件时，这些贡献位置为空，相关入口、轮询和设置页同时消失。

## 插件同步与指纹重载

Core DSH 的受管插件（`weworkCorePlugins` 组件，包含上节列出的内置插件以及
`@wegent/dsh-app-wework` 等宿主插件）在 prepare profile 时同步到 profile 的
`node_modules`。profile 写入 `.wework-runtime.json` stamp，记录 `dshVersion`、
`sourceFingerprint`（宿主）、`managedUiPlugins` 与 `corePluginsFingerprint`
（插件内容指纹）。

DSH 进程每次启动都会重新加载插件 JS；stamp 只决定是否需要重刷 profile：

- 宿主指纹（版本或 `sourceFingerprint`）变化 → 完整重刷：重写 `package.json`
  依赖路径并重新同步受管插件副本。
- 插件指纹变化 → 删除并重新复制受管插件副本，清理源中已不存在的残留文件。
- 两者都未变化 → fast path：不动文件，仅修复 node-pty 权限。

插件指纹优先取 `WEWORK_CORE_PLUGINS_SHA256`（来自组件更新激活态的
`contentSha256`，生产零成本）；未提供时对插件根目录做确定性内容哈希兜底，
算法与组件内容指纹一致，因此 dev 兜底值与生产环境变量值对同一内容相同。
旧版 stamp 缺少 `corePluginsFingerprint` 时自动视为不匹配，首次升级重刷一次
后保持稳定。用户手动安装的插件仍通过 `recoverInstalledDshDependencies`
保留，不受重刷影响。

## 打包与验证

新增随 Wework 发布的 DSH 插件时：

1. 在 `wework/dsh/<package>` 创建标准 DSH 包、client 入口和 `cordis.patch.yml`。
2. 将目录加入 `wework/scripts/prepare-harness-runtime.mjs` 的 `dshPlugins`。
3. 为 slot 元数据与注册行为增加 Node 单测。
4. 运行 Wework typecheck、聚焦 Vitest、DSH client 单测和桌面真实插件验证。

普通第三方插件不应加入 `prepare-harness-runtime.mjs`；该步骤只适用于随 Wework
发布和更新的第一方受管组件。
