---
sidebar_position: 34
---

# Wework DSH UI Plugins

Core DSH is the only plugin runtime for the Wework desktop UI.
`@wegent/dsh-app-wework` mounts the workbench and declares extension points.
Applications, routes, settings pages, and workspace panels are contributed by
independent DSH client plugins. Do not add a Wework-specific manifest, dynamic
module loader, or second Cordis `Context`.

## Extension layers

Wework DSH extensions have four layers. A plugin should depend only on the
layers it needs:

1. The UI slots documented here inject navigation, pages, applications, and
   workspace surfaces into the desktop workbench.
2. Standard DSH services such as `sessions`, `tools`, and model services remain
   owned by DSH and need no Wework-private event bus.
3. [Executor Session projection](./wework-dsh-executor-sessions.md) projects
   running Wework tasks into standard DSH Sessions and provides generic Backend
   plugin storage.
4. The Electron host boundary is owned by the first-party
   `@wegent/dsh-electron-host` package. It exposes narrow capabilities rather
   than Electron objects, file descriptors, or authentication tokens.
   Third-party plugins must not depend on that host package directly; they may
   use only explicitly public Wework client adapters. Plugins in one Core DSH
   page share a JavaScript trust domain, so install only trusted plugins.

## Core DSH model catalog

Wework exposes its executable model catalog as Core DSH providers and
synchronizes providers and local proxies when models are added, removed, or
reconfigured. This synchronization owns only the catalog. It must not follow
the model selected in the Wework composer: the composer selection is an
execution parameter for the current Wework conversation, while
`agent-default-model` is the deployment default used when Core DSH creates a
new Agent. Neither selection may overwrite the other.

Switching the current Wework model must not register model proxies again or
mutate Core DSH settings. Catalog synchronization preserves an existing Core
DSH default while that provider remains valid and selects the first catalog
entry only after the previous default becomes unavailable. This avoids
`settings/document-updated` and `llm/adapters-updated` events that reload every
resident model directory and keeps the Wework surface stable.

## Extension points

| Slot                            | Purpose                                  | Required metadata                 | Component props                              |
| ------------------------------- | ---------------------------------------- | --------------------------------- | -------------------------------------------- |
| `wework.action`                 | Host-invoked navigation action           | `id`, `path`                      | No component                                 |
| `wework.app`                    | Product switcher and app surface         | `id`, `label`, `mode`             | `visible`, `tab`                             |
| `wework.task.status`            | Left task-row status                     | `id`                              | `task`, `workspace`, layout hints            |
| `wework.environment.section`    | Additional environment-panel section     | `id`                              | `info`, `onClose`                            |
| `wework.board.card.status`      | Board task-card status                   | `id`                              | Board item, task binding, layout hints       |
| `wework.workspace.menu.section` | Additional workspace-menu section        | `id`                              | Generic workspace context, close action      |
| `wework.project.work.section`   | Additional project-work-bar section      | `id`                              | Generic project context                      |
| `wework.project.create.section` | Additional project-create-menu section   | `id`                              | Generic project-create context, close action |
| `wework.route`                  | Top-level auxiliary page                 | `id`, `path`, `telemetryFeature`  | `search`, `onNavigate`                       |
| `wework.sidebar.navigation`     | Left-sidebar navigation entry            | `id`, `path`, `label`             | Usually metadata-only                        |
| `wework.settings.page`          | Settings navigation and content          | `id`, `path`, `label`, `category` | Settings context, `onBack`                   |
| `wework.workspace.tab`          | Closable top workspace tab               | `id`, `label`                     | `visible`, `tab`                             |
| `wework.workspace.sidebar.tab`  | Right workspace-panel tab type           | `id`, `label`                     | `visible`, `scope`, `tab`                    |
| `wework.shell.before`           | Before the workbench root                | `id`                              | Empty object                                 |
| `wework.shell.after`            | After the workbench root                 | `id`                              | Empty object                                 |
| `wework.shell.overlay`          | Global pointer-transparent overlay layer | `id`                              | Empty object                                 |

`wework.app` supports three modes:

- `native`: navigate to `path` and let the native Wework workspace handle it.
- `iframe`: open `url` in a Wework application WebView.
- `surface`: render the registered plugin component at `/app/<id>`.

`wework.action` is a stable path-action descriptor, not an arbitrary callback
channel. Register `{ id, path }` so existing host entry points can resolve the
action by id and navigate. Do not put functions, tokens, or non-serializable
state in a descriptor.

Status and section slots are repeatable positional interfaces. They do not
assume Git, SVN, branches, or any source-control semantics. A plugin can pass a React
component as the fourth argument to `ctx.wework.ui.register`; the host renders
contributions in slot order and provides only the generic context for that
position. Multiple plugins may contribute to the same slot. The host neither
reads plugin ids nor infers implementation capabilities from a contribution.

Third-party `wework.settings.page` and `wework.route` contributions must not set
the Wework-internal `module` or `component` fields. Pass the React component as
the fourth argument to `ctx.wework.ui.register`. `telemetryFeature` must use an
existing low-cardinality Wework value; generic third-party pages use `apps`.

## Registration contract

The plugin package must declare the Wework host as a DSH client dependency:

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

Every UI registration must follow the slot lifetime:

```js
export const inject = ["slots", "wework"];

export function apply(ctx) {
  ctx.slots.inject("wework.workspace.tab", () =>
    ctx.wework.ui.register(
      ctx,
      "wework.workspace.tab",
      {
        id: "quality-dashboard",
        label: "Quality dashboard",
        order: 20,
      },
      ({ visible, tab }) =>
        React.createElement("section", { hidden: !visible }, tab.title),
    ),
  );
}
```

`wework` is the host service provided by `@wegent/dsh-app-wework`, with UI
extension APIs under `ctx.wework.ui`. DSH SlotCore retains only generic
options such as `id`, `label`, `order`, and `priority`. The API freezes Wework fields such
as `path`, `category`, and `mode` on the standard DSH component's static
`wework` property, then calls `ctx.slots.register`. Discovery, dependency
management, rendering, and disposal therefore remain owned by DSH, with no
second Wework registry.

The `icon` field on `wework.route` and `wework.sidebar.navigation` accepts any
valid [Lucide icon name](https://lucide.dev/icons/) in kebab-case, such as
`shield`, `rocket`, or `gamepad-2`. Wework loads the icon dynamically and
falls back to the default grid icon when the name is missing or invalid. The
legacy `applications` value remains an alias for the default application icon,
so icon names do not need to be registered individually in Wework core.

Do not register directly into a Wework slot that is not live, and do not put
Wework descriptors directly in DSH options. DSH re-runs the `slots.inject`
callback when the host slot mounts, unmounts, or is rebuilt and keeps the
plugin lifecycle scoped to that declaration.

## Runnable plugin demo

The repository's
[`wework/dsh/examples/ui-extension-demo`](https://github.com/wecode-ai/Wegent/tree/main/wework/dsh/examples/ui-extension-demo)
is a complete third-party plugin with no imports from Wework-private React
modules. It contains a standard `package.json`, `cordis.patch.yml`, host entry,
client entry, and Node regression tests, and covers every slot in the table.

In development, install the Demo's absolute directory from **Plugins → Manage
→ Wework plugins**, or use:

```text
file:/absolute/path/to/Wegent/wework/dsh/examples/ui-extension-demo
```

Installation, update, enablement, and removal mutate the managed `wework-core`
profile. Restart Core DSH after configuration changes. The install flow
snapshots the profile, runs the package manager, validates `dsh.bundle.patch`,
and preflights `dsh --profile wework-core --dump-config`; it restores the
snapshot on failure. Plugins must not depend on immediate hot activation after
installation.

When copying the Demo:

1. Replace the npm package name, Loader entry id, and every contribution id.
2. Keep only the slots you need and give each interactive element a stable
   `data-testid`.
3. Do not import Wework source pages or Contexts. Communicate through component
   props, standard DSH services, and public capabilities.
4. Run the Demo Node tests before installing the absolute local directory into
   an isolated Wework environment.

## First-party Wework plugins

Wework bundles these UI plugins with Core DSH:

- `@wegent/dsh-ui-core-apps`
- `@wegent/dsh-ui-core-settings`
- `@wegent/dsh-ui-plugin-center`
- `@wegent/dsh-ui-applications`
- `@wegent/dsh-ui-automations`
- `@wegent/dsh-ui-cloud-work`
- `@wegent/dsh-ui-git`

They use the same slot protocol as third-party plugins. A first-party plugin
may declare a private Wework `component` id in its contribution descriptor so
the existing page implementation is rendered inside the Wework React tree and
inherits Auth, Cloud, and Workbench contexts. Third-party plugins must not use
this field; they should pass their own React component as the fourth argument
to `ctx.wework.ui.register`.

`@wegent/dsh-ui-git` is one implementation of these generic positional
contracts. It contributes components to the workspace menu, project work bar,
project-create menu, task status, environment panel, and board card, plus the
Git hosting and Worktrees settings pages. Branches, commits, pushes, cloning,
PR/MR behavior, and execution payloads are interpreted by plugin components.
The host contracts contain no Git command names, Git plugin id, branch
capability checks, or source-control section. When the plugin is disabled or
absent, those positions are empty and the related controls, polling, and
settings pages disappear.

## Plugin sync and fingerprint-based reload

The managed Core DSH plugins (the `weworkCorePlugins` component, including the
first-party plugins listed above and host plugins such as
`@wegent/dsh-app-wework`) are copied into the profile's `node_modules` on every
profile prepare. The profile writes a `.wework-runtime.json` stamp recording
`dshVersion`, `sourceFingerprint` (host), `managedUiPlugins`, and
`corePluginsFingerprint` (plugin content fingerprint).

The DSH process always reloads plugin JS on startup; the stamp only decides
whether the profile must be re-prepared:

- Host fingerprint change (version or `sourceFingerprint`) → full re-prepare:
  rewrite `package.json` dependency paths and re-sync the managed plugin copies.
- Plugin fingerprint change → delete and re-copy the managed plugin copies,
  removing residual files that no longer exist in the source.
- Neither changed → fast path: leave files untouched and only repair node-pty
  permissions.

The plugin fingerprint comes from `WEWORK_CORE_PLUGINS_SHA256` (the active
component's `contentSha256`, zero cost in production). When it is not provided,
the plugin root is hashed deterministically with the same algorithm used for
component content fingerprints, so the dev fallback and the production
environment value match for identical content. A legacy stamp without
`corePluginsFingerprint` is treated as mismatched and refreshed once on the
first upgrade. Manually installed plugins remain preserved through
`recoverInstalledDshDependencies` and are not affected by the refresh.

## Packaging and verification

When adding a DSH plugin shipped with Wework:

1. Create a standard package, client entry, and `cordis.patch.yml` under
   `wework/dsh/<package>`.
2. Add the directory to `dshPlugins` in
   `wework/scripts/prepare-harness-runtime.mjs`.
3. Add Node tests for slot metadata and registration behavior.
4. Run Wework typecheck, focused Vitest coverage, DSH client tests, and a real
   desktop plugin verification.

Ordinary third-party plugins must not be added to
`prepare-harness-runtime.mjs`; that path is only for first-party managed
components shipped and updated with Wework.
