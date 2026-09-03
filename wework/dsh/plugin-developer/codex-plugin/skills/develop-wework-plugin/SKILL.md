---
name: develop-wework-plugin
description: Create, extend, and debug Wework Core DSH plugins and their optional nested Codex plugins. Use when the user asks to develop a Wework plugin, add a Wework UI extension, create a Skill inside that plugin, or diagnose it in the isolated plugin-development instance.
---

# Develop a Wework plugin

Treat the Wework package as the outer delivery unit. It may declare a nested
Codex plugin through `wework.codexPlugin`; the Codex plugin must never own or
gate the Wework plugin.

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

## Build the requested capability

- Register Wework UI through `ctx.wework.ui.register` and a documented slot.
- Before choosing a UI slot, read
  [references/extension-points.md](references/extension-points.md). It is the
  public extension-point contract shipped with this plugin.
- When implementing a contribution, inspect the runnable
  [assets/ui-extension-demo](assets/ui-extension-demo) plugin. Copy it to a
  writable project directory and remove every contribution the requested
  plugin does not need.
- Keep contribution ids stable and provide `data-testid` values for interactive
  controls.
- When creating or changing a Skill, keep it inside the declared nested Codex
  plugin and keep its description discriminating.
- Keep browser code and Node code in their declared entries; do not rely on
  accidental startup order.

## Debug

Use the current project's right-side **插件调试** tab. Validate before launch,
then start the isolated Wework instance. Source edits should use HMR. Restart
Core DSH only after dependency, manifest, bundle-patch, or process-state
changes that cannot be hot reloaded.

Read the actual structured failure and logs before modifying code. Confirm the
changed behavior in the development instance; a file-write event alone is not
evidence that HMR succeeded.

The development instance has separate login state, data, executor home, Core
DSH profile, cache, and logs. Never copy authentication data from the main
instance.

## Verify

- Validate the outer Wework package, its declared patch, and the nested Codex
  plugin when present.
- Run focused tests for the changed host, browser, and Skill behavior.
- Exercise both Node and browser halves when both exist.
- Verify one source edit through HMR.
- Stop the development instance when debugging is complete.
