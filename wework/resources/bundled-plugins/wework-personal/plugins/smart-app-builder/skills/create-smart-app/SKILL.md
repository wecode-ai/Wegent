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

## Workflow

1. Establish the app purpose, input/output, workspace directory, and target DSH
   version. Default to the DSH version bundled by the current Wework build. If the
   directory already contains `plugin-manifest.json`, read the existing package,
   dependencies, source, and `cordis.patch.yml` before proposing changes.
2. Run the bundled helper's `doctor` command. Fix missing Node 22+ or Corepack/pnpm
   before creating files.
3. Search the DSH ecosystem with the helper's `search` command and, when visual
   inspection helps, use the Wework built-in browser to inspect the `dsh-plugin`
   GitHub topic and candidate repositories. Record chosen package names and exact
   versions.
4. Create the external package workspace only when it does not already exist.
   Wework's blank Web preset is already a valid profile bundle. Reuse compatible
   DSH plugins where possible; add them incrementally to the package declarations
   and `cordis.patch.yml`, and write only the capability-specific Host/Web code
   that is still missing.
5. Build and test the package. Use the DSH CLI to install the local profile bundle,
   inspect `--dump-config`, and launch the profile on an available loopback port.
6. Open that loopback URL in the Wework built-in browser. Verify the primary flow,
   one invalid-input path, and recovery. Save screenshots when the user requests
   evidence.
7. Run the helper's `validate` command after every change. Use `pack` only when the
   user needs a distributable ZIP. Never package `node_modules`, credentials,
   `.env`, test output, or VCS metadata.
8. For a Wework-linked directory, return to **应用 → 智能工作台 → 我的** and
   refresh; the same workbench remains linked to the edited folder. For a ZIP-only
   workflow, use the native preview and model-selection confirmation before install.

## Commands

Resolve this plugin root from the selected skill path, then run:

```bash
node <plugin-root>/scripts/smart-app-tool.mjs doctor
node <plugin-root>/scripts/smart-app-tool.mjs search "<keywords>"
node <plugin-root>/scripts/smart-app-tool.mjs validate <smart-app-directory>
node <plugin-root>/scripts/smart-app-tool.mjs pack <smart-app-directory> [output.zip]
```

For a local bundle:

```bash
corepack pnpm dlx @deepseek-ai/dsh@<version> plugin --profile <profile> add file:<bundle-directory>
corepack pnpm dlx @deepseek-ai/dsh@<version> --profile <profile> --dump-config
corepack pnpm dlx @deepseek-ai/dsh@<version> --profile <profile> --port <port>
```

If the DSH package or a selected plugin changed its compatibility contract, stop and
show the exact version conflict. Do not silently widen version ranges or copy code
from the DSH source tree.
