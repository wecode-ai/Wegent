---
sidebar_position: 8
---

# Plugins and Skills

A Skill gives AI task-specific instructions and resources. A plugin can package Skills, commands, tools, and application entries.

Open **Plugins** to inspect installed plugins and manage their capabilities. Review a plugin's tools and permissions before enabling it for a workspace.

## Manage Codex plugins and Wework plugins

In the Wework desktop app, open **Plugins → Manage plugins** and switch between two management surfaces:

- **Codex plugins** provide Skills, MCP servers, applications, and commands to AI. They are installed through Codex or Wegent plugin marketplaces and are used in tasks and conversations.
- **Wework plugins** are DSH bundles that directly extend the local Wework desktop runtime. They are not regular Codex plugins and do not appear in the task plugin picker.

From **Wework plugins**, install a plugin from an npm package, Git source, or absolute local directory. Wework shows a trust confirmation because the plugin and its installation scripts run with the current user's permissions. User-installed plugins can be updated, enabled, disabled, or uninstalled. Bundled Wework runtime plugins are displayed as read-only and cannot be changed or removed here.

Wework validates the resulting DSH profile after each install, update, enable, disable, or uninstall operation. If validation fails, it restores the previous dependencies and configuration so the runtime is not left unbootable. After successful changes, continue managing plugins and choose **Restart plugin runtime** once when ready. Enabled and disabled states persist across Wework restarts.

## Import a personal plugin

On the **Plugins** page, choose **Create → Import plugin** to import a standard ZIP package that follows the `wework-plugins` format. The ZIP root must contain `.codex-plugin/plugin.json`, and any Skills or MCP servers must be included in the same plugin package. Encrypted or password-protected ZIP files are not supported.

If you do not have a package yet, choose **Download example plugin** in the import dialog and use it as the starting point for the manifest, Skills, and MCP configuration. After selecting a ZIP, Wework previews its name, version, and included capabilities. Packages with executable capabilities require an explicit trust confirmation before import and installation. When a package is invalid, the dialog identifies the missing file or unsupported ZIP type.

## View, share, and request company-wide publishing

> Implementation status (2026-08-29): the interaction below is implemented on the current feature branch and has local verification. Production publication is not enabled: HTTPS, GitLab protection rules, native Windows/macOS Runners, and a new Release credential remain external P0 gates. This section is therefore not a production-availability claim.

The detail page for a personally created or imported plugin retains its complete usage and management surface. The header
provides **Share**, **…**, and **Chat now**. The page shows its description, trial tasks, available scope, version
information, automatic update settings, app authorizations, and included capabilities. Choosing a trial task puts the
example into the composer without sending it automatically. A personal-plugin owner can also choose **Continue editing**,
**Uninstall**, or **Delete plugin** from **…** when the current installation state and permissions allow it.

**Share** contains only two choices:

- **Selected members or departments**: select people and departments from the address book. The organization itself is
  the root department; there is no separate “Organization visibility” option. The current version becomes available as
  soon as its security scan passes, without administrator review, and remains under My creations.
- **Everyone in the company**: request publication to the current company's entire membership. A right-side drawer leads
  through **Confirm version → Permissions and risks → Confirm submission**. Submission does not make the plugin immediately
  visible to everyone.

The client loads the latest member/department ACL and the plugin's complete
publication-request state together and allows editing/submission only after both
are ready. If either load fails, it keeps the actionable dialog closed instead
of letting stale cache overwrite recipients or start a duplicate request.

A company-wide request binds the submitted version and content snapshot. During review, the personal source remains
available for chat, editing, and sharing with selected members or departments. Later edits do not replace the snapshot
under review. For example, a request may remain on v1.2.0 while the personal plugin advances to v1.3.0. To publish changed
content, address the returned feedback and submit a new revision.

The plugin detail page shows five stages:

1. **Submit request**: save an immutable snapshot of the submitted version;
2. **Automated checks**: inspect package structure, sensitive files, and risk declarations;
3. **Administrator review**: an enterprise administrator returns or accepts the request in the Web admin console;
4. **Code review**: acceptance creates a GitLab MR for risk, Windows, and macOS compatibility checks;
5. **Release**: after merge into protected master, the Pipeline publishes the enterprise version.

Administrator acceptance only starts code review; it does not mean the plugin is published. Regular users submit and
track requests entirely in Wework; the Web surface is only for administrator review. After release, the personal source
remains under My creations and a separate enterprise plugin appears under Enterprise. They may have different versions
and do not overwrite each other.

The progress view distinguishes completed, active, and pending stages. Failed automated checks list the issues to fix;
an administrator return shows its reason and risk items and allows a new revision; code-review or release failure does
not affect the existing enterprise version. A request can be withdrawn from the detail page before its MR is merged.
After release begins, administrators own the enterprise version.

The detail page retains every Request and Revision for the personal source. The
owner can switch among submissions to inspect each revision's checks, evidence,
events, and GitLab state; a newer request never hides the link to an earlier
published enterprise edition.

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

If the plugin has a company-wide request that has not been merged into master, deletion first withdraws the request. The
system also closes or marks any generated MR as cancelled before uninstalling and deleting the personal source.
After merge or enterprise release, the personal user cannot withdraw that enterprise version. Deleting the personal
source then affects only that source and its member/department shares; it does not delete the enterprise version under
Enterprise. An administrator owns enterprise deactivation, removal, and rollback.

For a personal plugin shared only with members or departments and not released as an enterprise version, Wework checks
usage before deletion. An unused plugin can be deleted immediately. If it still has users, grants, or device installations,
the confirmation dialog shows the affected scope and changes the action to **Deactivate and delete**. The cloud then blocks
sharing and new installations, revokes existing grants, and asks online devices to remove the plugin; offline devices remove
it the next time they connect. Tasks already running are not forcibly interrupted. If usage changes while the dialog is open,
refresh the impact and confirm again.

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
