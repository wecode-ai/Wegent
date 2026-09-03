# Wework DSH App

`@wegent/dsh-app-wework` is Wework's DSH UI host. Wework no longer runs a
separate frontend plugin runtime; Core DSH owns plugin discovery, dependencies,
lifecycle, and UI registration.

The host declares these standard extension points:

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

Wework itself runs as a composition of DSH plugins including `ui-core-apps`,
`ui-core-settings`, `ui-plugin-center`, `ui-applications`, `ui-automations`,
and `ui-cloud-work`. Third-party plugins inject the same extension points with
`ctx.slots.inject(...)` and the host-provided `wework` service:

```js
const inject = ['slots', 'wework']

ctx.slots.inject('wework.workspace.tab', () =>
  ctx.wework.ui.register(
    ctx,
    'wework.workspace.tab',
    {
      id: 'quality-dashboard',
      label: 'Quality dashboard',
      order: 20,
    },
    QualityDashboard
  )
)
```

`wework` is the Wework host service, with UI extension APIs under
`ctx.wework.ui`. DSH slots retain only generic identity and ordering options.
The API attaches the Wework descriptor to the standard DSH component and calls
`ctx.slots.register(...)`; discovery, rendering, and disposal remain owned by
DSH, with no secondary registry.

Electron hosts one primary DSH `WebContentsView`. Host features such as the
Wework built-in browser, file pickers, native windows, and system menus remain
implemented by Electron and will be reached through restricted desktop
capabilities.

The package must explicitly export `./package.json`. The DSH client module
registry resolves that subpath to read the `dsh.client` declaration; without
the export, the plugin is omitted from the browser boot graph.

The installable third-party example at
[`../examples/ui-extension-demo`](../examples/ui-extension-demo) covers every
extension point above.
