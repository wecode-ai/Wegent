# Wework Core DSH extension points

This catalog is the public UI contract exposed by `@wegent/dsh-app-wework`.
Register only the extension points a plugin actually needs.

Every contribution uses the same lifecycle:

```js
ctx.slots.inject('wework.workspace.tab', () =>
  ctx.wework.ui.register(ctx, 'wework.workspace.tab', descriptor, Component)
)
```

`id` must be stable and unique within its slot. `label` and `order` are common
descriptor fields. A registration without a component is valid for
descriptor-only extension points or when `descriptor.module` names a browser
module supplied by the plugin.

## Navigation and application surfaces

| Extension point             | Purpose                                                   | Required or important descriptor fields                                                                                    | Component props                                                                                               |
| --------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `wework.action`             | Named navigation action used by Wework features.          | `id`, `path`                                                                                                               | None; descriptor-only.                                                                                        |
| `wework.app`                | App-switcher application and its surface.                 | `id`, `label`, `mode`; optionally `description`, `module`, `path`, `url`, auth/cloud requirements and workspace kinds.     | Inline component: `{ tab, visible }`. Module component: `{ active, app, tab }`.                               |
| `wework.route`              | Route rendered inside a workspace content tab.            | `id`, `path`, `telemetryFeature`; optionally `title`, `icon`, `module`, `restorePolicy`.                                   | `{ onNavigate, search }`.                                                                                     |
| `wework.sidebar.navigation` | Left-sidebar navigation item or custom navigation module. | `id`, `label`, `path`; optionally `activeItem`, `icon`, `module`, `prefetch`, `surface`, `testId`.                         | A module receives navigation state and callbacks; descriptor-only items use the standard navigation renderer. |
| `wework.settings.page`      | Settings navigation entry and page surface.               | `id`, `path`, `label`, `category`, `categoryLabel`; optionally `aliases`, `icon`, `module`, `desktopOnly`, `experimental`. | Includes `onBack`, devices, workbench services and optional runtime-task callbacks.                           |

## Project and workspace surfaces

| Extension point                           | Purpose                                                             | Required or important descriptor fields                    | Component props                                                         |
| ----------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `wework.project.create.section`           | Adds controls to the create-project state of the composer work bar. | `id`; optionally `module`, `order`.                        | Project work-bar state and actions supplied by the host.                |
| `wework.project.work.section`             | Adds controls when a project is already selected.                   | `id`; optionally `module`, `order`.                        | Project work-bar state and actions supplied by the host.                |
| `wework.workspace.menu.section`           | Adds a section to the workspace popout menu.                        | `id`; optionally `label`, `module`, `order`.               | Current workspace/menu state and host actions.                          |
| `wework.workspace.tab`                    | Adds a selectable workspace content tab.                            | `id`, `label`; optionally `order`.                         | `{ tab, visible }`.                                                     |
| `wework.workspace.sidebar.tab`            | Adds a tab to the right workspace sidebar.                          | `id`, `label`; optionally `order` and `when.projectKinds`. | `{ scope, tab, visible }`. `scope.cwd` is the active project directory. |
| `wework.runtime-profile.workspace-policy` | Adds a workspace policy option to runtime settings.                 | `id`, `label`; optionally `labelKey`, `order`.             | None; descriptor-only.                                                  |

## Contextual contribution surfaces

| Extension point              | Purpose                                     | Required or important descriptor fields        | Component props                                                                      |
| ---------------------------- | ------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `wework.plugins.action`      | Adds an action to Wework plugin management. | `id`, `label`; optionally `labelKey`, `order`. | Host plugin-management callbacks, including `onCreate` for create actions, plus `t`. |
| `wework.task.status`         | Adds status UI beside a task.               | `id`; optionally `module`, `order`.            | `{ task }`.                                                                          |
| `wework.environment.section` | Adds content to environment details.        | `id`; optionally `module`, `order`.            | `{ info }`.                                                                          |
| `wework.board.card.status`   | Adds status UI to a board card.             | `id`; optionally `module`, `order`.            | Board item identifiers and card context, including `itemId`.                         |

## Shell surfaces

| Extension point        | Purpose                                             | Required or important descriptor fields | Component props                                                                |
| ---------------------- | --------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `wework.shell.before`  | Mounts UI immediately before the main Wework shell. | `id`; optionally `order`.               | Host shell context.                                                            |
| `wework.shell.after`   | Mounts UI immediately after the main Wework shell.  | `id`; optionally `order`.               | Host shell context.                                                            |
| `wework.shell.overlay` | Mounts an overlay above the Wework shell.           | `id`; optionally `order`.               | Host shell context. Keep overlays non-blocking unless interaction is required. |

## Browser module boundary

An inline component is created in the Core DSH client module and registered as
the fourth argument to `ctx.wework.ui.register`. Larger first-party surfaces
may instead declare `descriptor.module`; that module must be part of the
plugin's browser bundle and default-export a React component matching the
props above.

Do not import Wework application source files from a third-party plugin. Use
the descriptor and component props supplied by the public slot.
