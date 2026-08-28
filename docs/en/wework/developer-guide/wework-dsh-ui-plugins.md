---
sidebar_position: 34
---

# Wework DSH UI Plugins

Core DSH is the only plugin runtime for the Wework desktop UI.
`@wegent/dsh-app-wework` mounts the workbench and declares extension points.
Applications, routes, settings pages, and workspace panels are contributed by
independent DSH client plugins. Do not add a Wework-specific manifest, dynamic
module loader, or second Cordis `Context`.

## Extension points

| Slot                           | Purpose                           | Required metadata                 |
| ------------------------------ | --------------------------------- | --------------------------------- |
| `wework.app`                   | Product switcher and app surfaces | `id`, `label`, `mode`             |
| `wework.route`                 | Top-level auxiliary pages         | `id`, `path`, `telemetryFeature`  |
| `wework.sidebar.navigation`    | Left sidebar navigation entries   | `id`, `path`, `label`             |
| `wework.settings.page`         | Settings navigation and content   | `id`, `path`, `label`, `category` |
| `wework.workspace.tab`         | Closable top workspace tabs       | `id`, `label`                     |
| `wework.workspace.sidebar.tab` | Right workspace panel tabs        | `id`, `label`                     |
| `wework.shell.before`          | Content before the workbench root | `id`                              |
| `wework.shell.after`           | Content after the workbench root  | `id`                              |
| `wework.shell.overlay`         | Global overlays                   | `id`                              |

`wework.app` supports three modes:

- `native`: navigate to `path` and let the native Wework workspace handle it.
- `iframe`: open `url` in a Wework application WebView.
- `surface`: render the registered plugin component at `/app/<id>`.

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

## First-party Wework plugins

Wework bundles these UI plugins with Core DSH:

- `@wegent/dsh-ui-core-apps`
- `@wegent/dsh-ui-core-settings`
- `@wegent/dsh-ui-plugin-center`
- `@wegent/dsh-ui-applications`
- `@wegent/dsh-ui-automations`
- `@wegent/dsh-ui-cloud-work`

They use the same slot protocol as third-party plugins. A first-party plugin
may declare a private Wework `component` id in its contribution descriptor so
the existing page implementation is rendered inside the Wework React tree and
inherits Auth, Cloud, and Workbench contexts. Third-party plugins must not use
this field; they should pass their own React component as the fourth argument
to `ctx.wework.ui.register`.

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
