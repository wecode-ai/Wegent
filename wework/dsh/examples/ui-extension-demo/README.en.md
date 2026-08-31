# Wework DSH Extension Demo

This is an installable third-party Core DSH plugin example covering every public
Wework UI extension point. It is not a built-in Wework plugin and is not enabled
in desktop distributions.

Enter the absolute directory in **Plugins → Manage → Wework plugins**, or use:

```text
file:/absolute/path/to/Wegent/wework/dsh/examples/ui-extension-demo
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

Production plugins should replace the package name, IDs, copy, and styles, and
register only the extension points they need.
