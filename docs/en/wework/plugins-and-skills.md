---
sidebar_position: 8
---

# Plugins and Skills

A Skill gives AI task-specific instructions and resources. A plugin can package Skills, commands, tools, and application entries.

Open **Plugins** to inspect installed plugins and manage their capabilities. Review a plugin's tools and permissions before enabling it for a workspace.

## Use the built-in Sites plugin

The Wegent cloud marketplace publishes `wegent-sites` in advance, but does not preinstall it for every user. When you open **Sites** and click **Create**, Wework idempotently installs the plugin for the current account, inserts its reference into a new task composer, and syncs it to that account's online local and cloud devices. Repeated clicks do not create duplicate installation records.

Wegent marketplace publication and upload accept packages containing either `.codex-plugin/plugin.json` or `.claude-plugin/plugin.json`. Backend adds the missing runtime manifest before storing the package, so every installed plugin is synchronized into both the Codex and Claude Code plugin directories on each device.

Local mode must be connected to Wegent cloud first. Click the **Sites** plugin badge in the composer to open its detail page in the Wegent cloud marketplace.

Type `/` in the composer to choose a Skill, or name the Skill in your request. Wework supplies its instructions to AI for that task.

Use **Settings → Coding → Skills** to manage local Skills. Unified management places Codex and Claude Code Skills under `~/.agents/skills`; name collisions are preserved with source suffixes.
