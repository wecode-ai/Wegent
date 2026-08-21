---
name: create-smart-app
description: Create or update a Wework Smart app based on DeepSeek Harness, including environment preparation, DSH plugin discovery, composition, built-in-browser verification, packaging, and local installation handoff.
---

# Create a Wework Smart app

Use this workflow when the user wants to build, modify, test, or package a Wework
Smart app. A Smart app is an external DeepSeek Harness plugin bundle; never modify
the DeepSeek Harness source tree to add the app.

## Contract

- Keep the Smart app in the user's workspace or a directory they explicitly chose.
- Pin the DSH version in `plugin-manifest.json` and package dependencies.
- Treat Wework's selected model as the runtime model. Do not bake model credentials
  into the package.
- Build against the DSH plugin model, not the Codex plugin model. Use
  `@deepseek-ai/cordis` for Host-side services and
  `@deepseek-ai/dsh-client-ui-slots` for Web UI slots when the app needs an
  embedded interface.
- Keep Host/Web boundaries JSON-safe. Web Remotes must return explicit success
  and error branches instead of throwing transport-shaped data into the UI.
- A distributable ZIP must contain `plugin-manifest.json`, `PLUGIN.md`,
  `INSTALL.zh-CN.md`, the profile bundle `cordis.patch.yml`, source, and built output.
- Installation into Wework always ends with the native preview and model-selection
  confirmation. Do not bypass that confirmation by editing Wework data files.
- Smart app verification must render in a Wework Smart app tab or the Wework
  built-in browser. Do not open or depend on the user's external system browser.

## Workflow

1. Establish the app purpose, input/output, workspace directory, and target DSH
   version. Default to the DSH version bundled by the current Wework build. Choose
   the shape up front: tool-only bundle, Host service, or Host plus Web Remote UI.
2. Run the bundled helper's `doctor` command. Fix missing Node 22+ or Corepack/pnpm
   before creating files.
3. Search the DSH ecosystem with the helper's `search` command and, when visual
   inspection helps, use the Wework built-in browser to inspect the `dsh-plugin`
   GitHub topic and candidate repositories. Record chosen package names and exact
   versions.
4. Create the external package workspace. Reuse compatible DSH plugins where
   possible; write only the capability-specific Host/Web plugin and a small profile
   bundle that composes them through `cordis.patch.yml`.
5. Build and test the package. Run typecheck, unit tests, and the DSH release-train
   checks for the chosen shape. For Web Remote UI, exercise one real browser Remote
   call, including success and error rendering.
6. Use a fresh temporary `DSH_HOME` for install and launch checks so the user's
   normal DSH profile is not polluted. Install the local profile bundle, inspect
   `--dump-config`, and launch the profile on an available loopback port with
   `--no-open`.
7. Open that loopback URL in the Wework built-in browser. Verify the primary flow,
   one invalid-input path, and recovery. Save screenshots when the user requests
   evidence.
8. Run the helper's `validate` and `pack` commands. Inspect the packed ZIP contents
   before installation. Never package `node_modules`, credentials, `.env`, test
   output, or VCS metadata.
9. Open Wework **应用 → 智能工作台 → 已安装 → 导入安装包**, select the generated
   ZIP, review its manifest and compatibility result, choose a Wework model, and ask
   the user to confirm the native install action. Refresh the installed list and
   verify the new app appears before reporting completion.

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
corepack pnpm dlx @deepseek-ai/dsh@<version> --profile <profile> --port <port> --no-open
```

If the DSH package or a selected plugin changed its compatibility contract, stop and
show the exact version conflict. Do not silently widen version ranges or copy code
from the DSH source tree.
