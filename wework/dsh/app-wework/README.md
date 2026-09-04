# Wework DSH App

`@wegent/dsh-app-wework` 是 Wework 的 DSH UI 宿主插件。Wework 不再运行独立的
前端插件系统；插件发现、依赖、生命周期和 UI 注册统一由 Core DSH 管理。

宿主声明以下标准扩展点：

- `wework.action`
- `wework.app`
- `wework.plugins.action`
- `wework.task.status`
- `wework.environment.section`
- `wework.board.card.status`
- `wework.workspace.menu.section`
- `wework.project.work.section`
- `wework.project.create.section`
- `wework.runtime-profile.workspace-policy`
- `wework.route`
- `wework.sidebar.navigation`
- `wework.settings.page`
- `wework.shell.before` / `wework.shell.after` / `wework.shell.overlay`
- `wework.workspace.tab`
- `wework.workspace.sidebar.tab`

Wework 自身按 `ui-core-apps`、`ui-core-settings`、`ui-plugin-center`、
`ui-applications`、`ui-automations` 和 `ui-cloud-work` 等 DSH 插件组合运行。
扩展点不是全部平铺在 `root` 下，而是分为 catalog、workspace 和 shell 三个
DSH 子树。工作区和 Composer 扩展使用 `session-maybe` scope；全局目录和 shell
使用 `root` scope。第三方插件通过 `ctx.slots.inject(...)` 注入扩展点：

```js
const inject = ['slots', 'wework']

ctx.slots.inject('wework.workspace.tab', function* () {
  const descriptor = {
    id: 'quality-dashboard',
    label: '质量看板',
    order: 20,
  }
  yield ctx.wework.contributions.register(ctx, 'wework.workspace.tab', descriptor)
  yield ctx.slots.register(
    {
      name: 'wework.workspace.tab',
      id: descriptor.id,
      label: descriptor.label,
      order: descriptor.order,
    },
    QualityDashboard
  )
})
```

`ctx.wework.contributions` 只保存宿主需要读取的 label、icon、path、module 等描述；
组件本身直接通过原生 `ctx.slots.register(...)` 注册，因此 DSH 的 kind、scope、
子 slot、store 和 inject 语义不会被抹平。`ctx.wework.chat`、`testing` 和
`environments` 提供对应领域的 Provider 注册点。

Electron 只承载一个主 DSH `WebContentsView`。Wework 内置浏览器、文件选择器、
原生窗口和系统菜单等宿主能力继续由 Electron 实现；本插件后续只通过受限
desktop capability 调用这些能力。

该包必须显式导出 `./package.json`。DSH client module registry 通过这个子路径读取
`dsh.client` 声明；缺少导出会导致插件不进入 browser boot graph。

“Wework 插件开发”Skill 携带的可安装示例位于
[`../plugin-developer/codex-plugin/skills/develop-wework-plugin/assets/ui-extension-demo`](../plugin-developer/codex-plugin/skills/develop-wework-plugin/assets/ui-extension-demo)，
覆盖以上全部扩展点。
