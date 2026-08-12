---
sidebar_position: 8
---

# Plugins and Skills

A Skill gives AI task-specific instructions and resources. A plugin can package Skills, commands, tools, and application entries.

Open **Plugins** to inspect installed plugins and manage their capabilities. Review a plugin's tools and permissions before enabling it for a workspace.

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
