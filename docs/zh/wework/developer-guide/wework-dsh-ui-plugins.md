---
sidebar_position: 34
---

# Wework DSH UI 插件

Wework 的桌面 UI 以 Core DSH 为唯一插件运行时。`@wegent/dsh-app-wework`
负责挂载工作台并声明扩展点；应用、路由、设置页和工作区面板都由独立 DSH
client 插件通过 slot 注入。不要再创建 Wework 私有 manifest、动态模块加载器或
第二个 Cordis `Context`。

## 扩展点

| Slot                           | 用途                     | 必要元数据                        |
| ------------------------------ | ------------------------ | --------------------------------- |
| `wework.app`                   | 产品切换器与应用 surface | `id`、`label`、`mode`             |
| `wework.route`                 | 顶层辅助页面             | `id`、`path`、`telemetryFeature`  |
| `wework.settings.page`         | 设置导航与设置内容       | `id`、`path`、`label`、`category` |
| `wework.workspace.tab`         | 顶部可关闭工作区 Tab     | `id`、`label`                     |
| `wework.workspace.sidebar.tab` | 右侧工作区面板 Tab       | `id`、`label`                     |
| `wework.shell.before`          | 工作台根节点之前         | `id`                              |
| `wework.shell.after`           | 工作台根节点之后         | `id`                              |
| `wework.shell.overlay`         | 全局浮层                 | `id`                              |

`wework.app` 的 `mode` 可以是：

- `native`：导航到 `path`，由 Wework 原生工作区处理。
- `iframe`：在 Wework 应用 WebView 中打开 `url`。
- `surface`：在 `/app/<id>` 中直接渲染插件注册的 React 组件。

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

不要直接调用 `ctx.slots.register` 注册到尚未存活的 Wework slot，也不要把
Wework 描述直接塞进 DSH options。DSH 会在宿主 slot 挂载、卸载或重建时重新执行
`slots.inject` 回调，并自动收敛插件生命周期。

## Wework 内置插件

Wework 当前随 Core DSH 打包以下 UI 插件：

- `@wegent/dsh-ui-core-apps`
- `@wegent/dsh-ui-core-settings`
- `@wegent/dsh-ui-plugin-center`
- `@wegent/dsh-ui-applications`
- `@wegent/dsh-ui-automations`
- `@wegent/dsh-ui-cloud-work`

这些包与第三方插件使用相同的 slot 协议。内置插件可以在 contribution 描述中
声明 Wework 私有的 `component` id，由 Wework React 树渲染已有页面实现，以继承
Auth、Cloud、Workbench 等宿主 Context。第三方插件不应使用该字段，应把自己的
React 组件传给 `ctx.wework.ui.register` 的第四个参数。

## 打包与验证

新增随 Wework 发布的 DSH 插件时：

1. 在 `wework/dsh/<package>` 创建标准 DSH 包、client 入口和 `cordis.patch.yml`。
2. 将目录加入 `wework/scripts/prepare-harness-runtime.mjs` 的 `dshPlugins`。
3. 为 slot 元数据与注册行为增加 Node 单测。
4. 运行 Wework typecheck、聚焦 Vitest、DSH client 单测和桌面真实插件验证。
