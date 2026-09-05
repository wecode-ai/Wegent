# Workspace Copilot

An AI-assistant showcase inspired by Copilot-class plugins. It inspects the
active repository through a lifecycle-scoped Node backend, identifies languages,
frameworks, scripts, and important files, then opens a Composer-adjacent
suggestion popover that inserts grounded intents directly into the active draft.

Public contracts demonstrated:

- `weworkPluginRuntime`
- `ctx.wework.backend`
- `ctx.wework.chat.providers`
- `ctx.wework.commands`
- `ctx.wework.composer`
- `composer.slash`
- `wework.composer.action`

The scanner uses breadth-first sampling so a large first package cannot consume
the whole scan budget and hide the rest of a monorepo.
