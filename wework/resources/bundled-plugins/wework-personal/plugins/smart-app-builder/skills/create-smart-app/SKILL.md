---
name: create-smart-app
description: Create or update a Wework Smart app based on DeepSeek Harness, including environment preparation, DSH plugin discovery, composition, built-in-browser verification, packaging, and local installation handoff.
---

# Create a Wework Smart app

Use this workflow when the user wants to build, modify, test, add plugins to, or
package a Wework Smart app. A Smart app is an external DeepSeek Harness plugin
bundle; never modify the DeepSeek Harness source tree to add the app.

## Contract

- Keep the Smart app in the user's workspace or a directory they explicitly chose.
- When Wework supplies an existing Smart app directory, treat it as the durable
  project. Inspect and edit it in place; never replace it with a new scaffold.
- Pin the DSH version in `plugin-manifest.json` and package dependencies.
- Treat Wework's selected model as the runtime model. Do not bake model credentials
  into the package.
- A distributable ZIP must contain `plugin-manifest.json`, `PLUGIN.md`,
  `INSTALL.zh-CN.md`, the profile bundle `cordis.patch.yml`, source, and built output.
- Installation into Wework always ends with the native preview and model-selection
  confirmation. Do not bypass that confirmation by editing Wework data files.
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
8. For a linked directory, refresh **应用 → 智能工作台 → 我的**. For ZIP-only
   delivery, use the native preview and model-selection confirmation before install.

## Commands

Resolve this plugin root from the selected skill path, then run:

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
