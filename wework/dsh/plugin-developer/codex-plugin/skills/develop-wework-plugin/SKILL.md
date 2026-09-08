---
name: develop-wework-plugin
description: Create, extend, and debug Wework Core DSH plugins and their optional nested Codex plugins. Use when the user asks to develop a Wework plugin, add a Wework UI extension, create a Skill inside that plugin, or diagnose it in the isolated plugin-development instance.
---

# Develop a Wework plugin

Treat the Wework package as the outer delivery unit. It may declare a nested
Codex plugin through `wework.codexPlugin`; the Codex plugin must never own or
gate the Wework plugin.

## Use the bundled development kit

This Skill includes the complete public Wework extension catalog, one
exhaustive smoke-test plugin, three focused API references, and three
product-oriented showcase plugins:

- Read [references/extension-points.md](references/extension-points.md) before
  choosing a UI surface. It documents descriptor fields, component props, and
  the browser-module boundary.
- Inspect [assets/ui-extension-demo](assets/ui-extension-demo) before writing a
  low-level UI contribution.
- Inspect [assets/reference-plugins](assets/reference-plugins) for runnable,
  independently installable examples of Composer augmentation, persistent
  workflow UI, website navigation, and typed desktop-host integration. For a
  left-navigation button that opens a website in the Wework built-in browser,
  start from `sidebar-browser-panel-demo`. Copy only the closest example into
  the user's writable project, then delete every contribution the plugin does
  not need.
- Start with [assets/showcase-plugins](assets/showcase-plugins) when the user
  wants a product-quality example. Workspace Copilot, Test Explorer, and Dev
  Environments represent popular AI-assistant, testing, and
  development-environment categories with deliberately different interaction
  models.
- Never edit files inside an installed plugin cache. Resolve these resources
  relative to this Skill, and copy examples to the active project first.

The catalog covers all public host slots:

- Navigation and apps: `wework.action`, `wework.app`, `wework.route`,
  `wework.sidebar.navigation`, `wework.settings.page`, and
  `wework.settings.section`.
- Project and workspace: `wework.plugins.action`,
  `wework.project.create.section`, `wework.project.work.section`,
  `wework.workspace.menu.section`, `wework.workspace.tab`,
  `wework.workspace.sidebar.tab`, `wework.workspace.toolbar.action`,
  `wework.workspace.bottom-panel.tab`, and
  `wework.runtime-profile.workspace-policy`.
- Composer: `wework.composer.action`.
- Context: `wework.task.status`, `wework.environment.section`, and
  `wework.board.card.status`.
- Shell: `wework.shell.before`, `wework.shell.after`, and
  `wework.shell.overlay`.

It also documents the public `ctx.wework.host`, `backend`, `commands`,
`composer`, `contributions`, `chat`, `testing`, `environments`, `context`,
`menus`, `keybindings`, `localization`, `configuration`, `storage`, and
`secrets` services. Prefer a command-backed menu contribution when the host
already owns the button surface; use a raw UI slot when the plugin needs custom
rendering.

## Understand the package boundaries

A Wework Core DSH plugin normally contains:

```text
plugin-root/
├── package.json
├── cordis.patch.yml
├── index.js
├── client.js
└── codex-plugin/                  # optional nested official Codex plugin
    ├── .codex-plugin/plugin.json
    └── skills/<skill-name>/SKILL.md
```

Wework creates `.wework/plugin-development.json` beside the project files to
classify the local project and enable the **插件调试** tab. Treat that file as
Wework project metadata, not as part of the distributable Codex plugin.

The boundaries are strict:

- `package.json`, `cordis.patch.yml`, `index.js`, and `client.js` belong to the
  outer Wework package.
- New projects contain only the outer Wework package by default. Add
  `wework.codexPlugin` and a nested Codex plugin only when the requested product
  capability actually includes Codex Skills, MCP servers, agents, or other
  official Codex plugin resources.
- A nested Codex plugin uses the official `.codex-plugin/plugin.json` format
  and official Codex folders only. Do not add Wework-only keys or files to its
  manifest.
- `index.js` runs in the Core DSH Node host. `client.js` runs in the browser
  client. Share data through declared services or messages, not accidental
  module state or startup order.
- Third-party plugins consume public Wework DSH slots and services. Never
  import private Wework application modules.

## Inspect before editing

1. Read `.wework/plugin-development.json`, `package.json`, and the declared
   `dsh.bundle.patch`.
2. When `wework.codexPlugin` is present, read its `.codex-plugin/plugin.json`
   and every affected Skill or MCP entry below that directory.
3. Read every declared host, browser, or sidecar entry affected by the change.
4. Reuse public Wework DSH slots and services. Do not import private Wework
   application modules from a user plugin.
5. Remove duplicate loaders, watchers, compatibility paths, and generated
   examples that no longer serve the plugin.

## Choose the smallest extension surface

Start from the user-visible outcome, then select the narrowest matching slot:

- Add a complete application with `wework.app`.
- Register the full-content route rendered by an existing workspace tab with
  `wework.route`. It does not create a tab; when the tab's `contentRoute`
  matches, the route component replaces that tab's entire content surface.
- Add left navigation with `wework.sidebar.navigation`.
- Create a selectable top-level workspace tab with `wework.workspace.tab`.
- Add project-scoped inspection or controls with
  `wework.workspace.sidebar.tab`.
- Add compact workspace-level actions with
  `wework.workspace.toolbar.action`.
- Add a full bottom-panel tool with `wework.workspace.bottom-panel.tab`.
- Add an input-adjacent action with `wework.composer.action`.
- Add plugin-management actions with `wework.plugins.action`.
- Add a standalone settings page with `wework.settings.page`.
- Add controls to an existing settings page with `wework.settings.section`;
  declare the target page in the contribution descriptor.
- Use contextual and shell slots only when the UI genuinely belongs to that
  lifecycle.

Do not build a parallel navigation, panel, or settings system when a public
slot already owns that surface.

When a left-navigation item should open a website beside the current workspace,
register a descriptor-only `wework.workspace.sidebar.tab` with
`mode: 'iframe'` and `url`, then point the navigation descriptor's
`workspaceSidebarTab` to that tab id. Do not register `wework.app` or create a
top-level workspace tab for this interaction.

## Open a route in its own workspace tab

When a sidebar item must preserve the current tab and open the plugin route in
another top-level tab, put the public workspace-tab parameters in the
navigation descriptor's `path`:

```js
function workspaceTabPath(path, id, title) {
  const separator = path.includes('?') ? '&' : '?'
  const params = new URLSearchParams({
    workspaceTab: id,
    workspaceTabTitle: title,
  })
  return `${path}${separator}${params}`
}

ctx.slots.inject('wework.sidebar.navigation', () =>
  ctx.wework.contributions.register(ctx, 'wework.sidebar.navigation', {
    id: 'example.navigation',
    label: 'Example',
    path: workspaceTabPath('/example', 'auxiliary-example', 'Example'),
  })
)
```

Register the matching `/example` content with `wework.route`. A stable
`workspaceTab` value creates the tab on the first navigation and selects that
same tab later. Omitting `workspaceTab` intentionally replaces the active
tab's route. Use a generated ID only when every action must create another
tab. Do not import `WorkspaceTabsContext`, `navigateTo`, or other private
Wework modules into a plugin.

## Build the capability

- Register reusable behavior once through `ctx.wework.commands`; invoke that
  same command from menus, shortcuts, or plugin UI.
- Register privileged Node behavior through the injected
  `ctx.weworkPluginRuntime`, then call it from browser UI through a namespaced
  `ctx.wework.backend` client. Do not invent plugin-specific loopback servers.
- Use `ctx.wework.host` for typed desktop capabilities; do not call private
  Electron bridge URLs.
- Localize visible copy with `ctx.wework.localization.translate(...)`. Standalone
  plugins must not import Wework's private React localization hooks.
- Publish state used by visibility and enablement rules through
  `ctx.wework.context`.
- Use `ctx.wework.menus` for standard Composer and workspace toolbar actions.
- A command selected from `composer.slash` receives
  `invocation.composer`; use its `getValue`, `setValue`, `insertText`, and
  `focus` methods to edit the active draft without importing Composer internals.
- Use `ctx.wework.composer.references` for resources that users should discover
  and insert through the Composer `@` menu.
- Use `ctx.wework.chat.providers`, `ctx.wework.testing.providers`, or
  `ctx.wework.environments.providers` when the capability must be reusable
  across multiple host or plugin surfaces.
- Use namespaced `ctx.wework.storage` for JSON state and
  `ctx.wework.secrets` only for sensitive strings.
- Declare settings through `ctx.wework.configuration`; do not invent a second
  configuration store.
- Register host-readable metadata through `ctx.wework.contributions`.
- Register visual components directly through native `ctx.slots.register`.
  Do not attach descriptors to component statics or flatten DSH `kind`, `scope`,
  child slots, stores, and injected business faces into a generic UI API.
- Inject the same slot with `ctx.slots.inject` so both registrations follow the
  Core DSH lifecycle.
- Keep contribution ids stable and provide `data-testid` values for interactive
  controls.
- Use the descriptor fields and component props documented for the selected
  slot. Do not infer undocumented host internals.
- Keep Node and browser dependencies in their declared entries. Browser code
  must not call Node APIs directly.
- When creating or changing a Skill, keep it inside the declared nested Codex
  plugin, use official Codex structure, and keep its description
  discriminating.
- Keep the plugin cohesive: remove unused Demo contributions, generated
  placeholders, duplicate watchers, and obsolete compatibility paths.

A minimal browser registration follows this shape:

```js
ctx.slots.inject('wework.workspace.sidebar.tab', function* () {
  const descriptor = {
    id: 'example.inspector',
    label: 'Inspector',
    when: { projectKinds: ['wework-core-dsh-plugin'] },
  }
  yield ctx.wework.contributions.register(ctx, 'wework.workspace.sidebar.tab', descriptor)
  yield ctx.slots.register(
    {
      name: 'wework.workspace.sidebar.tab',
      id: descriptor.id,
      label: descriptor.label,
    },
    InspectorPanel
  )
})
```

Use the exhaustive Demo for API coverage and the reference plugins for
product-oriented patterns instead of expanding this snippet into guessed APIs.

## Debug

Use the current project's right-side **插件调试** tab:

1. Validate the project and fix the structured errors it reports.
2. Start the isolated Wework development instance.
3. Exercise the exact UI surface contributed by the plugin.
4. Edit browser source and confirm the visible behavior changes through HMR.
5. Read host, browser, or sidecar logs when behavior does not match the source.
6. Restart Core DSH only after dependency, manifest, bundle-patch, host-process,
   or other process-state changes that cannot be hot reloaded.

Operate Wework through the general `wework desktop` CLI. This is the required
control surface for inspecting and interacting with both the main Wework
instance and the isolated plugin-development instance:

```bash
wework desktop instances
wework desktop status --project .
wework desktop inspect --project . --interactive true
wework desktop click --project . --selector '[data-testid="example-action"]'
wework desktop fill --project . --selector '[data-testid="example-input"]' --value 'value'
wework desktop press --project . --selector '[data-testid="example-input"]' --key Enter
wework desktop wait --project . --selector '[data-testid="example-result"]' --text 'ready'
wework desktop screenshot --project . --output test-results/plugin-debug.png
```

`--project .` resolves the running Wework instance registered for the current
project, so commands do not contain cache directories, ports, tokens, process
ids, or other machine-specific values. Use `wework desktop instances` and an
explicit `--instance` only when more than one matching instance exists.

Use `inspect` before selecting a target, prefer stable `data-testid` selectors,
and verify every mutating command with `wait` or another `inspect`. The CLI
intentionally has no arbitrary JavaScript evaluation command. Do not bypass
the CLI with a plugin-owned control implementation.

Read the actual structured failure and logs before modifying code. Confirm the
changed behavior in the development instance; a file-write event alone is not
evidence that HMR succeeded.

The development instance has separate login state, data, executor home, Core
DSH profile, cache, and logs. Never copy authentication data from the main
instance.

## Verify

Before handing off:

1. Validate the outer Wework package and its declared bundle patch.
2. Validate the nested official Codex plugin when present.
3. Run focused tests for changed host, browser, manifest, and Skill behavior.
4. Exercise both Node and browser halves when both exist.
5. Verify one real source edit through HMR.
6. Confirm install, enable, disable, and uninstall lifecycles when UI
   contributions changed.
7. Confirm every interactive control has a stable `data-testid`.
8. Stop the isolated development instance and verify its temporary runtime
   resources are cleaned up.
