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

## Packaging and verification

When adding a DSH plugin shipped with Wework:

1. Create a standard package, client entry, and `cordis.patch.yml` under
   `wework/dsh/<package>`.
2. Add the directory to `dshPlugins` in
   `wework/scripts/prepare-harness-runtime.mjs`.
3. Add Node tests for slot metadata and registration behavior.
4. Run Wework typecheck, focused Vitest coverage, DSH client tests, and a real
   desktop plugin verification.
