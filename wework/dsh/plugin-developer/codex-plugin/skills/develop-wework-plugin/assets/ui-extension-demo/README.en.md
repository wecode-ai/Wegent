# Wework DSH Extension Demo

This runnable Core DSH plugin example is shipped as an asset of the **Wework
Plugin Developer** Skill and covers every public Wework UI extension point.
Codex can copy this directory as an implementation reference. Desktop
distributions do not enable it automatically.

Copy the directory to a writable project location, then enter that absolute
directory in **Plugins → Manage → Wework plugins**, for example:

```text
file:/absolute/path/to/ui-extension-demo
```

Restart Core DSH after installation. The plugin adds a `DSH Demo` sidebar item,
surface app, settings page, workspace tab, and global overlay. Disabling or
uninstalling the package and restarting removes every contribution through the
same DSH lifecycle.

Key files:

- `package.json` declares the DSH bundle, client dependencies, and web platform.
- `cordis.patch.yml` inserts the plugin into the DSH Loader tree.
- `index.js` is the host entry; a UI-only plugin can keep it empty.
- `client.js` registers UI through `slots.inject` and
  `ctx.wework.ui.register`.
- The `DSH Demo` sidebar entry uses the public `workspaceTab` route parameter
  to create a dedicated tab once and select it on later clicks without
  replacing the user's current tab.

Production plugins should replace the package name, IDs, copy, and styles, and
register only the extension points they need.
