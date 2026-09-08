# Wework Core DSH extension points

This catalog is the public UI contract exposed by `@wegent/dsh-app-wework`.
Register only the extension points a plugin actually needs.

Wework does not flatten every extension into one generic registry. Public
composition has two explicit layers:

- `ctx.wework.contributions` stores host-readable descriptors such as labels,
  icons, paths, ordering, and module names.
- `ctx.slots.register` contributes a native DSH component with the slot's
  declared `kind`, `scope`, child ownership, store, and inject semantics.

Descriptor-only contributions need only the first layer. A visual contribution
uses both under the same Cordis lifecycle:

```js
ctx.slots.inject('wework.workspace.tab', function* () {
  yield ctx.wework.contributions.register(ctx, 'wework.workspace.tab', descriptor)
  yield ctx.slots.register(
    {
      name: 'wework.workspace.tab',
      id: descriptor.id,
      label: descriptor.label,
      order: descriptor.order,
    },
    Component
  )
})
```

`id` must be stable and unique within its slot. `label` and `order` are common
descriptor fields. When `descriptor.module` names a browser module supplied by
the plugin, only the descriptor registration is needed.

The host declares three internal branches instead of placing every public slot
directly under `root`:

```text
root
├── wework.internal.catalog
│   └── apps, routes, navigation, settings, project creation
├── wework.internal.workspace
│   └── Composer, workspace, environment, task and board occurrences
└── wework.internal.shell
    └── before, after and overlay surfaces
```

Workspace and Composer occurrence slots use `session-maybe`; global catalogs
and shell slots use `root`. Plugins must not register the internal branch slots.

## Core extension services

UI slots are only one part of the public contract. `ctx.wework` also exposes
typed desktop capabilities, lifecycle-scoped plugin backends, and registries for commands, context, menus,
keybindings, configuration, storage, and secrets. Every registration takes
the plugin's Cordis `ctx` as its owner and is removed automatically when that
context is disposed.

| Service                    | Purpose                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ctx.wework.host`          | Use typed desktop dialogs, notifications, background browser pages, shell actions, and app/window state. |
| `ctx.wework.backend`       | Call methods registered by the plugin's lifecycle-scoped Node backend.                                   |
| `ctx.wework.commands`      | Register, inspect, execute, and subscribe to named commands. Commands may declare an `enablement` rule.  |
| `ctx.wework.composer`      | Edit the active draft and add searchable, context-aware references to the Composer `@` menu.             |
| `ctx.wework.contributions` | Register host-readable descriptors separately from native DSH component composition.                     |
| `ctx.wework.chat`          | Register repository/context providers used by AI and Composer integrations.                              |
| `ctx.wework.testing`       | Register test discovery, run, cancellation, status, and output providers.                                |
| `ctx.wework.environments`  | Register development-environment inspection, preparation, and switching providers.                       |
| `ctx.wework.context`       | Publish scoped context keys and evaluate `all`, `any`, `not`, equality, inequality, and membership.      |
| `ctx.wework.menus`         | Place command-backed actions in public menu locations with `when`, `enablement`, grouping, and ordering. |
| `ctx.wework.keybindings`   | Add platform-specific default shortcuts gated by context expressions.                                    |
| `ctx.wework.localization`  | Resolve visible plugin copy against the current Wework locale without importing private React hooks.     |
| `ctx.wework.configuration` | Declare plugin settings, merge defaults with persisted values, validate updates, and subscribe.          |
| `ctx.wework.storage`       | Read and write JSON-serializable plugin state under an isolated namespace.                               |
| `ctx.wework.secrets`       | Read and write plugin secrets through Wework secure storage under an isolated namespace.                 |

The public command-backed menu locations are currently:

| Menu location       | Host surface              |
| ------------------- | ------------------------- |
| `composer.toolbar`  | Composer context toolbar  |
| `composer.slash`    | Composer `/` command menu |
| `workspace.toolbar` | Active workspace toolbar  |

A minimal command contribution is:

```js
const state = ctx.wework.storage.scope('example')

ctx.wework.context.set(ctx, 'example.ready', true)
ctx.wework.commands.register(
  ctx,
  {
    id: 'example.run',
    title: 'Run example',
    icon: 'play',
    enablement: ['wework.desktop', 'example.ready'],
  },
  () => {
    const count = state.get('count', 0) + 1
    state.set('count', count)
    return count
  }
)
ctx.wework.menus.register(ctx, 'composer.toolbar', {
  id: 'example.run.composer',
  command: 'example.run',
  order: 100,
})
ctx.wework.keybindings.register(ctx, {
  id: 'example.run.keybinding',
  command: 'example.run',
  key: 'Ctrl+Shift+E',
  mac: 'Command+Shift+E',
  when: 'example.ready',
})
ctx.wework.composer.references.register(ctx, {
  id: 'example.reference',
  title: 'Example resource',
  reference: '[$Example](example://resource)',
  searchAliases: ['resource'],
  when: 'example.ready',
})
```

A command selected from `composer.slash` receives a scoped Composer controller
on `invocation.composer`:

```js
ctx.wework.commands.register(
  ctx,
  {
    id: 'example.insert-review',
    title: 'Insert review prompt',
  },
  (_args, invocation) => {
    invocation.composer?.insertText('Review this change for correctness and missing tests.\n')
    invocation.composer?.focus()
  }
)
```

The controller exposes `getValue()`, `setValue(value, selectionOffset?)`,
`insertText(text)`, and `focus()`. It is valid only for the active command
invocation. Store data, not the controller itself.

Composer-adjacent components may use the same operations through
`ctx.wework.composer`. They fail loudly when no Composer is active.

Standalone browser plugins cannot import Wework's private localization hooks.
Resolve user-visible copy through the public locale service:

```js
const label = ctx.wework.localization.translate({
  en: 'Refresh workspace context',
  'zh-CN': '刷新工作区上下文',
})
```

`translate(messages, fallback?)` accepts either a string or a locale map. It
tries the active locale, its base language, a matching regional variant, then
English and Simplified Chinese. Use `getLocale()` only when formatting logic
needs the active locale code.

## Domain providers

Use a provider when the host or several surfaces need to consume one plugin's
business capability. Do not hide testing, chat context, or environment
operations inside a generic panel component.

```js
ctx.wework.testing.providers.register(ctx, {
  id: 'example-tests',
  label: 'Example tests',
  discover: request => backend.request('discover', { cwd: request.workspacePath }),
  run: request =>
    backend.request('run', {
      cwd: request.workspacePath,
      testIds: request.testIds ?? [],
    }),
})
```

The equivalent registries are:

- `ctx.wework.chat.providers`: requires `prepareContext(request)`.
- `ctx.wework.testing.providers`: requires `discover(request)` and
  `run(request)`; `cancel(runId)` is optional.
- `ctx.wework.environments.providers`: requires `inspect(request)` and
  `prepare(request)`; `switchTo(request)` is optional.

Use reverse-domain or package-prefixed IDs and namespaces. A duplicate ID is
rejected rather than silently replacing another plugin's contribution.
Use `ctx.wework.host` instead of calling the Electron HTTP bridge directly.
Its methods belong to the current renderer generation and reject calls after
that generation is disposed.

## Node backend methods

Plugins that need filesystem inspection, Git, local tools, or other privileged
Node work should inject `weworkPluginRuntime` in their bundle patch and register
named methods from `index.js`:

```js
export const inject = ['weworkPluginRuntime']

export function apply(ctx) {
  ctx.weworkPluginRuntime.register(ctx, {
    id: 'example-quality',
    methods: {
      async scan({ cwd }) {
        return { cwd, issues: [] }
      },
    },
  })
}
```

The browser client calls the same namespace with the path supplied by its slot
props or another explicit host context:

```js
function QualityAction({ workspaceTarget }) {
  const workspacePath = workspaceTarget?.path
  if (!workspacePath) return null

  const backend = ctx.wework.backend.scope('example-quality')
  return backend.request('scan', { cwd: workspacePath })
}
```

Registrations reject duplicate IDs and invalid methods. Requests are bounded,
same-origin loopback calls, and backend methods are removed automatically when
the owning plugin context is disabled, reloaded, or uninstalled. Backend
methods must validate workspace paths and should expose narrow product
operations instead of arbitrary command execution.

## Navigation and application surfaces

| Extension point             | Purpose                                                                                                                                                                                               | Required or important descriptor fields                                                                                                | Component props                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `wework.action`             | Named navigation action used by Wework features.                                                                                                                                                      | `id`, `path`                                                                                                                           | None; descriptor-only.                                                                                        |
| `wework.app`                | App-switcher application and its surface.                                                                                                                                                             | `id`, `label`, `mode`; optionally `description`, `module`, `path`, `url`, auth/cloud requirements and workspace kinds.                 | Inline component: `{ tab, visible }`. Module component: `{ active, app, tab }`.                               |
| `wework.route`              | Full-content route for an existing workspace tab. Matching `contentRoute` replaces that tab's whole surface; this slot does not create a tab.                                                         | `id`, `path`, `telemetryFeature`; optionally `title`, `icon`, `module`, `restorePolicy`.                                               | `{ onNavigate, search }`.                                                                                     |
| `wework.sidebar.navigation` | Left-sidebar navigation item or custom navigation module. A plain `path` replaces the active tab route; `workspaceSidebarTab` opens a registered right-sidebar tab without changing the active route. | `id`, `label`, and either `path` or `workspaceSidebarTab`; optionally `activeItem`, `icon`, `module`, `prefetch`, `surface`, `testId`. | A module receives navigation state and callbacks; descriptor-only items use the standard navigation renderer. |
| `wework.settings.page`      | Settings navigation entry and standalone page surface.                                                                                                                                                | `id`, `path`, `label`, `category`, `categoryLabel`; optionally `aliases`, `icon`, `module`, `desktopOnly`, `experimental`.             | Includes `onBack`, devices, workbench services and optional runtime-task callbacks.                           |
| `wework.settings.section`   | Section rendered inside an existing settings page without adding another navigation item.                                                                                                             | `id`, `page`; optionally `label`, `module`, `order`. The current built-in page IDs include `general`, `connections`, and `appearance`. | No host-specific props. The component owns only its section and should match the surrounding settings layout. |

## Project and workspace surfaces

| Extension point                           | Purpose                                                                     | Required or important descriptor fields                                                                 | Component props                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `wework.project.create.section`           | Adds controls to the create-project state of the composer work bar.         | `id`; optionally `module`, `order`.                                                                     | Project work-bar state and actions supplied by the host.                                                   |
| `wework.project.work.section`             | Adds controls when a project is already selected.                           | `id`; optionally `module`, `order`.                                                                     | Project work-bar state and actions supplied by the host.                                                   |
| `wework.workspace.menu.section`           | Adds a section to the workspace popout menu.                                | `id`; optionally `label`, `module`, `order`.                                                            | Current workspace/menu state and host actions.                                                             |
| `wework.workspace.toolbar.action`         | Adds compact actions to the active workspace toolbar.                       | `id`; optionally `module`, `order`.                                                                     | Current project, workspace target and environment information.                                             |
| `wework.workspace.bottom-panel.tab`       | Adds a selectable tool tab to the bottom workspace panel.                   | `id`, `label`; optionally `icon`, `module`, `order`.                                                    | Current project, workspace target, devices, visibility and active state.                                   |
| `wework.workspace.tab`                    | Creates a selectable top-level workspace tab and owns its full tab content. | `id`, `label`; optionally `order`.                                                                      | `{ tab, visible }`.                                                                                        |
| `wework.workspace.sidebar.tab`            | Adds a tab to the right workspace sidebar.                                  | `id`, `label`; optionally `order`, `when.projectKinds`, or descriptor-only `mode: 'iframe'` with `url`. | Component tabs receive `{ scope, tab, visible }`. Iframe tabs are rendered by the Wework built-in browser. |
| `wework.runtime-profile.workspace-policy` | Adds a workspace policy option to runtime settings.                         | `id`, `label`; optionally `labelKey`, `order`.                                                          | None; descriptor-only.                                                                                     |

## Contextual contribution surfaces

| Extension point              | Purpose                                              | Required or important descriptor fields        | Component props                                                                      |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `wework.composer.action`     | Adds an action beside the composer context controls. | `id`; optionally `module`, `order`.            | `{ compact, disabled }`.                                                             |
| `wework.plugins.action`      | Adds an action to Wework plugin management.          | `id`, `label`; optionally `labelKey`, `order`. | Host plugin-management callbacks, including `onCreate` for create actions, plus `t`. |
| `wework.task.status`         | Adds status UI beside a task.                        | `id`; optionally `module`, `order`.            | `{ task }`.                                                                          |
| `wework.environment.section` | Adds content to environment details.                 | `id`; optionally `module`, `order`.            | `{ info }`.                                                                          |
| `wework.board.card.status`   | Adds status UI to a board card.                      | `id`; optionally `module`, `order`.            | Board item identifiers and card context, including `itemId`.                         |

## Shell surfaces

| Extension point        | Purpose                                             | Required or important descriptor fields | Component props                                                                |
| ---------------------- | --------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `wework.shell.before`  | Mounts UI immediately before the main Wework shell. | `id`; optionally `order`.               | Host shell context.                                                            |
| `wework.shell.after`   | Mounts UI immediately after the main Wework shell.  | `id`; optionally `order`.               | Host shell context.                                                            |
| `wework.shell.overlay` | Mounts an overlay above the Wework shell.           | `id`; optionally `order`.               | Host shell context. Keep overlays non-blocking unless interaction is required. |

## Browser module boundary

An inline component is created in the Core DSH client module and registered
with native `ctx.slots.register`. Larger first-party surfaces may instead
declare `descriptor.module`; that module must be part of the plugin's browser
bundle and default-export a React component matching the props above.

Do not import Wework application source files from a third-party plugin. Use
the descriptor and component props supplied by the public slot.

## Workspace-tab navigation protocol

Wework navigation paths support two public query parameters:

| Parameter           | Meaning                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `workspaceTab`      | Select this top-level tab ID. If the ID does not exist, Wework creates a tab for the target route without replacing the current tab. |
| `workspaceTabTitle` | Initial title for a newly created tab.                                                                                               |

For example, a sidebar contribution that opens `/dsh-extension-demo` in a
dedicated tab can declare:

```js
function workspaceTabPath(path, id, title) {
  const separator = path.includes('?') ? '&' : '?'
  const params = new URLSearchParams({
    workspaceTab: id,
    workspaceTabTitle: title,
  })
  return `${path}${separator}${params}`
}

const navigation = {
  id: 'dsh-extension-demo.navigation',
  label: 'DSH Demo',
  path: workspaceTabPath('/dsh-extension-demo', 'auxiliary-dsh-extension-demo', 'DSH Demo'),
}
```

Use a stable ID to make repeated clicks select the same tab. Generate a fresh
ID only when duplicate tabs are the intended product behavior. Components
rendered by `wework.route` receive `onNavigate(path)` for navigation inside
their existing tab; that callback does not create another tab.
