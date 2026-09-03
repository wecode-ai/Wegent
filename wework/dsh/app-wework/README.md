# Wework DSH App

`@wegent/dsh-app-wework` 是 Wework 的 DSH UI 宿主插件。Wework 不再运行独立的
前端插件系统；插件发现、依赖、生命周期和 UI 注册统一由 Core DSH 管理。

宿主声明以下标准扩展点：

- `wework.action`
- `wework.app`
- `wework.task.status`
- `wework.environment.section`
- `wework.board.card.status`
- `wework.workspace.menu.section`
- `wework.project.work.section`
- `wework.project.create.section`
- `wework.route`
- `wework.sidebar.navigation`
- `wework.settings.page`
- `wework.shell.before` / `wework.shell.after` / `wework.shell.overlay`
- `wework.workspace.tab`
- `wework.workspace.sidebar.tab`

Wework 自身按 `ui-core-apps`、`ui-core-settings`、`ui-plugin-center`、
`ui-applications`、`ui-automations` 和 `ui-cloud-work` 等 DSH 插件组合运行。
第三方插件通过 `ctx.slots.inject(...)` 与宿主提供的 `wework` service
注入同一批扩展点：

```js
const inject = ['slots', 'wework']

ctx.slots.inject('wework.workspace.tab', () =>
  ctx.wework.ui.register(
    ctx,
    'wework.workspace.tab',
    {
      id: 'quality-dashboard',
      label: '质量看板',
      order: 20,
    },
    QualityDashboard
  )
)
```

`wework` 是 Wework 的宿主 service，UI 扩展 API 位于 `ctx.wework.ui`。DSH Slot
只保留通用的身份与排序 options；该 API 将 Wework 描述附着到
标准 DSH component，再调用 `ctx.slots.register(...)`；插件发现、渲染与释放仍完全
由 DSH 管理，不存在第二套注册表。

Electron 只承载一个主 DSH `WebContentsView`。Wework 内置浏览器、文件选择器、
原生窗口和系统菜单等宿主能力继续由 Electron 实现；本插件后续只通过受限
desktop capability 调用这些能力。

该包必须显式导出 `./package.json`。DSH client module registry 通过这个子路径读取
`dsh.client` 声明；缺少导出会导致插件不进入 browser boot graph。

可安装的第三方示例位于
[`../examples/ui-extension-demo`](../examples/ui-extension-demo)，覆盖以上全部扩展点。
