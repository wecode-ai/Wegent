---
name: develop-wework-plugin
description: Create, extend, and debug Wework Core DSH plugins and their bundled Codex Skills. Use when the user asks to develop a Wework plugin, add a Wework UI extension, create a Skill inside that plugin, or diagnose it in the isolated plugin-development instance.
---

# Develop a Wework plugin

Treat the current local project as one composite plugin when it contains both
Core DSH code and Codex capabilities. Keep `.codex-plugin/plugin.json`,
`skills/`, `package.json`, and `cordis.patch.yml` coherent.

## Inspect before editing

1. Read `.wework/plugin-development.json`, `.codex-plugin/plugin.json`,
   `package.json`, and the declared `dsh.bundle.patch`.
2. Read every declared host, browser, Skill, MCP, or sidecar entry that the
   requested change affects.
3. Reuse public Wework DSH slots and services. Do not import private Wework
   application modules from a user plugin.
4. Remove duplicate loaders, watchers, compatibility paths, and generated
   examples that no longer serve the plugin.

## Build the requested capability

- Register Wework UI through `ctx.wework.ui.register` and a documented slot.
- Keep contribution ids stable and provide `data-testid` values for interactive
  controls.
- When creating or changing a Skill, keep its description discriminating and
  its instructions focused on decisions Codex would not reliably infer.
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

- Validate both plugin manifests and the declared patch.
- Run focused tests for the changed host, browser, and Skill behavior.
- Exercise both Node and browser halves when both exist.
- Verify one source edit through HMR.
- Stop the development instance when debugging is complete.
