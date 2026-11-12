---
name: create-smart-app
description: Create or update a Wework Smart app based on DeepSeek Harness, including environment preparation, DSH plugin discovery, composition, built-in-browser verification, packaging, and local installation handoff.
---

# Create an extended Wework workbench

Use this workflow when the user wants to build, modify, test, add plugins to, or
package a Wework Smart app. A Smart app is an external DeepSeek Harness plugin
bundle; never modify the DeepSeek Harness source tree to add the app.

Smart apps and lightweight apps share the Workbenches product and the DSH
installation/runtime system. Read the bundled `wework-runtime/workbenches` skill
for creation, installation and presentation. This skill covers extended DSH
development and verification. Lightweight workbenches use the managed sandbox
scaffold rather than arbitrary Host/Client plugin code.

## Contract

- Keep the Smart app in the user's workspace or a directory they explicitly chose.
- When Wework supplies an existing Smart app directory, treat it as the durable
  project. Inspect and edit it in place; never replace it with a new scaffold.
- Pin the DSH version in `plugin-manifest.json` and package dependencies.
- Treat Wework's selected model as the runtime model. Do not bake model credentials
  into the package.
- A distributable ZIP must contain `plugin-manifest.json`, `PLUGIN.md`,
  `INSTALL.zh-CN.md`, the profile bundle `cordis.patch.yml`, source, and built output.
- Installation into Wework requires native package and capability confirmation.
  Model binding is optional and independent of window/tab presentation. Do not
  bypass confirmation by editing Wework data files.
- For a Wework-linked project, Wework Host is the only authority for Smart app
  inspection, verification, and distributable ZIP creation. Do not replace it with
  local manifest checks, ad-hoc DSH commands, or a fallback packer.

## Workflow

Use this state machine: **inspect → contract → doctor → verify → preview → pack**.

1. Run `inspect` first. If it returns `stale`, `failed`, or no report, read the
   structured error code and fix that exact boundary; do not guess from UI text.
2. Read `plugin-manifest.json`, `smart-app.verify.json`, the package declarations,
   source, built output, and `cordis.patch.yml`. Keep capabilities minimal and
   declare each new Host, Client, or Remote capability in the contract.
3. Run `doctor`, then use `search` only when an additional DSH plugin is needed.
   Record chosen package names and exact compatible versions.
4. Implement the smallest capability-specific change. Do not inject `harness`,
   `llm`, filesystem, or network services unless the app declares and uses them.
5. Run `verify` after every meaningful edit. It performs the managed project checks,
   artifact checks, isolated DSH cold start, ready-selector probe, and Remote probe
   when declared. Fix the structured error code, then verify again until `passed`.
6. Use the Wework built-in preview for the primary path, one invalid-input path,
   and recovery. Save screenshots only when the user requests evidence.
7. Run `pack` only after the current report passes. It creates and re-verifies the
   ZIP; it excludes credentials, `.env`, `node_modules`, VCS metadata, test output,
   and the development verification contract.
8. For a linked directory, refresh **应用 → 工作台 → 我的**. For ZIP-only
   delivery, use the native preview and model-selection confirmation before install.

## Commands

Resolve this plugin root from the selected skill path, then run. Verification
commands require Wework's absolute `WEWORK_CLI_PATH` binding; the helper never
falls back to a different launcher found in PATH.

```bash
node <plugin-root>/scripts/smart-app-tool.mjs doctor
node <plugin-root>/scripts/smart-app-tool.mjs search "<keywords>"
node <plugin-root>/scripts/smart-app-tool.mjs inspect <smart-app-directory>
node <plugin-root>/scripts/smart-app-tool.mjs verify <smart-app-directory>
node <plugin-root>/scripts/smart-app-tool.mjs pack <smart-app-directory> [output.zip]
```

If the Host returns a DSH or plugin compatibility error, show its exact structured
error code. Do not silently widen version ranges, bypass verification, or copy code
from the DSH source tree.

## Native application services

Extended workbenches use the same installation-scoped storage and
native capabilities as lightweight workbenches. Declare required native grants in
`plugin-manifest.json` under `capabilities.native`; installation confirmation owns
authorization. A trusted DSH Client can call the existing Host bridge:

```js
const response = await fetch('/wework/electron-host/v1/invoke', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    capability: 'workbench.invoke',
    params: { method: 'storage.get', params: {} },
  }),
})
const body = await response.json()
if (!response.ok || body.ok === false)
  throw new Error(body.error?.message || 'Workbench call failed')
const state = body.result
```

The Host derives identity from the authenticated DSH connection. Never add an
installation ID, expose a Host token to page content, or use the main application
principal. Use the methods and capability requirements in the workbenches skill.
Read ordinary state through `storage.get` and await `storage.set` when saving it.
