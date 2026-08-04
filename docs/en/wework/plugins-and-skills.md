---
sidebar_position: 8
---

# Plugins and Skills

A Skill gives AI task-specific instructions and resources. A plugin can package Skills, commands, tools, and application entries.

Open **Plugins** to inspect installed plugins and manage their capabilities. Review a plugin's tools and permissions before enabling it for a workspace.

## Use the built-in application plugins

The Wegent cloud marketplace publishes `wegent-sites` and `wegent-mini-program` in advance, but does not preinstall them for every user. Open **Applications** to view the **Sites** and **Mini Programs** tabs. When you click **Create** and choose an application type, Wework idempotently installs the matching plugin, inserts its reference into a new task composer, and syncs it to the selected online device. Sites use `wegent-sites`; Mini Programs use `wegent-mini-program`, which also supplies its creation prompt. Repeated clicks do not create duplicate installation records.

Wegent marketplace publication and upload accept packages containing either `.codex-plugin/plugin.json` or `.claude-plugin/plugin.json`. Backend adds the missing runtime manifest before storing the package, so every installed plugin is synchronized into both the Codex and Claude Code plugin directories on each device.

Local mode must be connected to Wegent cloud first. Click a plugin badge in the composer to open its matching detail page in the Wegent cloud marketplace.

Type `/` in the composer to choose a Skill, or name the Skill in your request. Wework supplies its instructions to AI for that task.

Use **Settings → Coding → Skills** to manage local Skills. Unified management places Codex and Claude Code Skills under `~/.agents/skills`; name collisions are preserved with source suffixes.
