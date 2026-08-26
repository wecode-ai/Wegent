---
sidebar_position: 8
---

# Plugins and Skills

A Skill gives AI task-specific instructions and resources. A plugin can package Skills, commands, tools, and application entries.

Open **Plugins** to inspect installed plugins and manage their capabilities. Review a plugin's tools and permissions before enabling it for a workspace.

## Import a personal plugin

On the **Plugins** page, choose **Create → Import plugin** to import a standard ZIP package that follows the `wework-plugins` format. The ZIP root must contain `.codex-plugin/plugin.json`, and any Skills or MCP servers must be included in the same plugin package. Encrypted or password-protected ZIP files are not supported.

If you do not have a package yet, choose **Download example plugin** in the import dialog and use it as the starting point for the manifest, Skills, and MCP configuration. After selecting a ZIP, Wework previews its name, version, and included capabilities. Packages with executable capabilities require an explicit trust confirmation before import and installation. When a package is invalid, the dialog identifies the missing file or unsupported ZIP type.

## Install a Smart app

Smart apps are currently experimental. First enable **Settings → General → Experimental features**. The top-tab **+ → Smart apps** entry and the **Smart apps** tab beside **Sites** and **Mini Programs** in **Applications** then become available. Disabling the toggle hides those entries, closes Smart app tabs, and stops running Smart apps.

Open **+ → Smart apps** from the top tab bar to go directly to **Applications → Smart apps**, or open **Applications** first and switch among **Sites / Mini Programs / Smart apps**. Smart apps have three sections: **Marketplace** discovers and installs official apps and apps shared directly with you; **Installed** binds models and manages local app execution and removal; **My creations** creates, imports, and publishes apps.

Choose **Create Smart app** from **My creations**, enter a name and save location, and Wework creates a valid DSH Web-preset directory, links it directly into the local list, and opens a new chat with the bundled Smart App Builder plugin. Creation and continued development use the local device and directory and do not require a cloud connection. A dedicated development-preview tab opens in the right workspace by default. Its single toolbar row shows the workbench name, runtime status, **Add plugins**, **Refresh page**, and **Reload DSH**. Startup and reload use a DSH-specific progress view instead of the regular built-in browser's empty URL state. Refresh the current page after frontend-only changes, or reload the DSH runtime after dependency or Harness configuration changes.

A workbench is not a one-time generation. Whether it is stopped or running, choose **Add DSH plugins** from the preview toolbar or the workbench menu and enter an npm package, Git URL, archive URL, or local plugin directory. Wework stops the workbench when necessary, updates the manifest and plugin contents, and reloads it automatically. Local directories are copied into the workbench's `plugins/` directory, so exported ZIP packages include them. Choose **Develop workbench** to let Smart App Builder read the same manifest, dependencies, source, and `cordis.patch.yml` and continue applying incremental changes. **Show in file manager** opens the editable directory, and Wework validates linked contents again when listing or starting the app.

Choose **Link folder** to use an existing source directory without packaging it first. When distribution is needed, **Export installation package** creates a deterministic ZIP from the current directory. **Import app** remains available for existing ZIP files, and the managed imported directory can also be developed further. Marketplace or shared installations cannot be edited in place; choose **Copy to My workbenches** and assign the copy a new name and directory. Removing a linked workbench unregisters it without deleting its external folder. Use **Publish** to add marketplace details and select members or departments; marketplace downloads still use the native preview to confirm version compatibility and bind a model.

Wework currently manages DeepSeek Harness Runtime `0.1.0-rc.7` and `0.1.0-rc.8`. A Smart app package must declare a compatible `requirements.dsh` value in `plugin-manifest.json`. A bare version such as `"dsh": "0.1.0-rc.7"` is exact; SemVer ranges are also supported. At launch, Wework selects the highest supported matching version and downloads and caches only that Runtime. Dependency trees for different DSH versions remain isolated.

Wework manages the DeepSeek Harness runtime and shared Node.js runtime separately, and prevents Harness from handing the page off to the system default browser when a Smart app starts. The app page is loaded only in Wework's built-in native WebView. Newly created or linked blank workbenches use the available Wework model proxy directly and do not ask for another API key inside DSH. If no model was explicitly bound, startup uses the first available Wework model. Resident Smart apps wait until model restoration has completed before starting automatically, avoiding missed restoration while the model list is still loading after a Wework reload.

To support DSH pages that call legacy services across origins, Wework relaxes same-origin enforcement only inside a Smart app's Harness WebView. The Wework product UI and the regular built-in browser retain their default web security policy. On Windows, these WebViews use a separate WebView2 data directory, and clearing browsing data clears both the regular browser and Smart app profiles. Relaxing same-origin enforcement reduces isolation between web origins, so install and run Smart apps only from sources you trust.

Wework supports the standard DSH release ZIP format. Its `plugin-manifest.json` declares each npm package's `name`, `role`, and destination `path` in `packages`, while the ZIP root contains the matching `.tgz` files. The single `profile-bundle` path must match `entry.installPackage`. The `entry` object only needs `installPackage` and `profile`; it does not declare `webUrl`. At launch, Wework assigns the local URL, installs every declared package, and binds the selected Wework model to the profile.

Choose a Wework model while installing from the marketplace. Apps imported from **My creations** can bind a model later from **Installed**. The model is bound only to that Smart app, so other Smart apps can use different models. Each app shows its version, bound model, and **Installed**, **Running**, or **Failed to start** state; you can change the bound model while the app is stopped. Choose **Open** to start an isolated Harness instance, animate it into the top tab strip, and open it in its own workspace tab. Choose **Stop** to close that tab and reclaim the instance. Enable **Resident** to start the app and open its tab automatically whenever the Wework main window starts.

## Delete a personal plugin

You can delete a plugin that you created or imported from the **…** menu in its detail page. If the plugin is installed, Wework uninstalls it before deleting the local plugin source.

For a plugin published to the cloud, Wework checks its usage before deletion. An unused plugin can be deleted immediately. If it still has users, grants, or device installations, the confirmation dialog shows the affected scope and changes the action to **Deactivate and delete**. The cloud then blocks sharing and new installations, revokes existing grants, and asks online devices to remove the plugin; offline devices remove it the next time they connect. Tasks that are already running are not forcibly interrupted. If usage changes while the dialog is open, refresh the impact and confirm again.

## Use the built-in application plugins

The Wegent cloud marketplace publishes `wegent-sites` and `weibo-miniapp-h5-develop-agent` in advance, but does not preinstall them for every user. Open **Applications** to view the **Sites** and **Mini Programs** tabs. When you click **Create** and choose an application type, Wework first checks whether the selected online device already has the matching plugin installed; if it does, Wework inserts the plugin reference into a new task composer immediately. If not, Wework idempotently installs the plugin for the account and syncs it to that device.

Built-in application plugins use `visibility=workspace`, so Sites use `plugin://wegent-sites@wegent`; Mini Programs use `plugin://weibo-miniapp-h5-develop-agent@wegent`, which also supplies its plugin-provided creation prompt. The Applications page shows an installation notice while that preparation is running. Repeated clicks reuse the plugin already installed on the current device instead of creating duplicate installation records or sending another install request.

Wegent marketplace publication and upload accept packages containing either `.codex-plugin/plugin.json` or `.claude-plugin/plugin.json`. Backend adds the missing runtime manifest before storing the package, so every installed plugin is synchronized into both the Codex and Claude Code plugin directories on each device.

Local mode must be connected to Wegent cloud first. Click a plugin badge in the composer to open its matching detail page in the Wegent cloud marketplace.

## Use plugins in local harnesses

The experimental OpenCode, Claude Code, and Kimi Code harnesses consume the Wework plugins selected
for the task. Wework prefers the [Agent Plugins](https://agent-plugins.org/) `plugin.json`,
`skills/`, and `mcp.json` standard while remaining compatible with existing Codex and Claude
plugin manifests. At session launch, Wework creates an isolated adapter for the selected harness
and translates Skills and MCP servers into that harness's native configuration. Persistent plugin
data is isolated by plugin rather than copied separately for every session.

Every local harness session also receives the `wework_browser` MCP server and its companion Skill.
The AI uses those controlled tools to open, inspect, and operate the Wework built-in browser
without launching an external browser. Restored sessions reuse the plugin set recorded when they
were created, so restarting Wework does not remove their plugin capabilities.

Type `/` in the composer to choose a Skill, or name the Skill in your request. Wework supplies its instructions to AI for that task.

Use **Settings → Coding → Skills** to manage local Skills. Unified management places Codex and Claude Code Skills under `~/.agents/skills`; name collisions are preserved with source suffixes.

## Development and migration

If you need to build plugins, migrate open-source plugins into the Wework marketplace, or understand how the cloud catalog relates to local Codex installs, read the [Plugin Marketplace Developer Guide](./developer-guide/wework-plugin-marketplace-dev.md).
