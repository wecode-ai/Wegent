# Wework DSH App

`@wegent/dsh-app-wework` is Wework's DSH UI host. Wework no longer runs a
separate frontend plugin runtime; Core DSH owns plugin discovery, dependencies,
lifecycle, and UI registration.

The host declares these standard extension points:

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

The extension tree is split into catalog, workspace, and shell branches rather
than flattening every slot under `root`. Workspace and Composer occurrences use
`session-maybe`; global catalogs and shell surfaces use `root`.

Wework itself runs as a composition of DSH plugins including `ui-core-apps`,
`ui-core-settings`, `ui-plugin-center`, `ui-applications`, `ui-automations`,
and `ui-cloud-work`. Third-party plugins inject the same extension points with
`ctx.slots.inject(...)` and the host-provided `wework` service:

```js
const inject = ['slots', 'wework']

ctx.slots.inject('wework.workspace.tab', function* () {
  const descriptor = {
    id: 'quality-dashboard',
    label: 'Quality dashboard',
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

`ctx.wework.contributions` stores host-readable labels, icons, paths, and module
metadata. Components register directly with native `ctx.slots.register`, so
DSH kind, scope, child-slot, store, and inject semantics remain intact. The
host also exposes dedicated chat, testing, and environment provider registries.

Electron hosts one primary DSH `WebContentsView`. Host features such as the
Wework built-in browser, file pickers, native windows, and system menus remain
implemented by Electron and will be reached through restricted desktop
capabilities.

The package must explicitly export `./package.json`. The DSH client module
registry resolves that subpath to read the `dsh.client` declaration; without
the export, the plugin is omitted from the browser boot graph.

Standalone plugins cannot import private Wework React hooks. Localize visible
copy with `ctx.wework.localization.translate({ en: '...', 'zh-CN': '...' })`;
`getLocale()` is available when formatting logic needs the active locale code.

The installable example shipped by the **Wework Plugin Developer** Skill at
[`../plugin-developer/codex-plugin/skills/develop-wework-plugin/assets/ui-extension-demo`](../plugin-developer/codex-plugin/skills/develop-wework-plugin/assets/ui-extension-demo)
covers every extension point above.
