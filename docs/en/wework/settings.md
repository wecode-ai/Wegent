---
sidebar_position: 9
---

# Settings and data

Settings cover language and startup behavior, appearance, Codex and local models, proxies, context, quick phrases, keybindings, worktrees, browser data, and archived conversations.

Common macOS shortcuts include:

| Action                 | Shortcut                  |
| ---------------------- | ------------------------- |
| Open Settings          | `Command+,`               |
| Toggle left sidebar    | `Command+B`               |
| Toggle right workspace | `Option+Command+B`        |
| Toggle bottom panel    | `Command+J`               |
| Back / Forward         | `Command+[` / `Command+]` |
| Select model           | `Control+Shift+M`         |
| Appshot                | `Command+Shift+2`         |

## Custom Codex models

In **Settings → Models**, click **Add model** and choose a provider first. For Kimi Coding, Wework discovers the provider's models. K3 automatically uses the built-in Codex Catalog profile with a 256K context window and `low` default reasoning effort.

Each custom model has an optional **Group** field that controls how it appears in the model picker. Kimi Coding defaults this field to **Kimi**, but users can edit or clear it. Models without a group appear under **Custom models**.

Choose **Custom** to configure an OpenAI Responses, Chat Completions, or Anthropic Messages-compatible endpoint. Model capabilities use structured controls instead of raw Catalog JSON:

- One context-window field drives both runtime and Catalog configuration.
- Reasoning levels, input modalities, and boolean capabilities use presets or checkboxes.
- Base instructions start from the Codex GPT profile and can be edited in a dedicated section.
- Less common fields are grouped under **Advanced model capabilities** into **Responses and tools**, **Catalog metadata**, and **Prompt templates**.

The same Codex app-server reads the custom Catalog for the current device. When no task is running, saving a model silently restarts that app-server. When tasks are active, Wework asks whether to restart immediately. Choosing to restart later marks the model as **Waiting for executor restart** and keeps it out of the model picker until the restart completes.

Local project files remain in their project folders. Local preferences, model configurations, and conversations stay on the current device. Cloud requests and configuration are sent to the connected service only when you use cloud capabilities.

Codex credentials participate in cloud synchronization only after an explicit upload or import. Protect remote-device commands, Git tokens, and model API keys as credentials.
