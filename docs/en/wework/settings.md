---
sidebar_position: 9
---

# Settings and data

Settings cover language and startup behavior, appearance, Codex and local models, proxies, context and default principles for the experimental personal supervisor, quick phrases, keybindings, worktrees, browser data, and archived conversations.

## View app information

Open the account menu in the lower-left corner of Wework and select **About** to view the app name, version, update channel, and project links.
The version shown in the About page is read from the running Tauri application package metadata,
so it matches the version shown by the macOS **About Wework** system menu. Release builds that
inject a version through the Tauri configuration use that value in both places.

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

## Model availability

**My Codex** shows official Codex models only when the current device has a configured
`auth.json`. Without that file, the group is omitted from the model picker; provider models,
local custom models, and cloud models remain available according to their own configuration. If
no source provides a model, the picker displays **No models available**.

## Custom Codex models

In **Settings → Models**, click **Add model** and choose a provider first. Wework includes profiles for Kimi Coding, the Kimi API Platform, DeepSeek, and GLM. After entering the corresponding platform API key, Wework discovers available models through the provider's `/models` endpoint. Each profile supplies its connection URL, API protocol, tool mode, and known model context windows; the Kimi API Platform profile uses the China-region `api.moonshot.cn` endpoint. Kimi Coding K3 automatically uses the built-in Codex Catalog profile with a 256K context window and `low` default reasoning effort.

The DeepSeek profile uses the native Responses API and exposes only `deepseek-v4-flash`, the model currently available for Codex. It uses a 1,048,576-token context window, `high` default reasoning effort, live Web Search, and freeform `apply_patch`. The connection test also requires a real `apply_patch` custom-tool call. Existing Wework-managed DeepSeek V4-Flash configurations that use Chat Completions are migrated to the Responses API. The current catalog declares text input and disables image generation, so image generation and image understanding are not presented as supported capabilities for this profile.

Each custom model has an optional **Group** field that controls how it appears in the model picker. Kimi Coding defaults this field to **Kimi**, but users can edit or clear it. Models without a group appear under **Custom models**.

Choose **Custom** to configure an OpenAI Responses, Chat Completions, or Anthropic Messages-compatible endpoint. Model capabilities use structured controls instead of raw Catalog JSON:

- One context-window field drives both runtime and Catalog configuration.
- Reasoning levels, input modalities, and boolean capabilities use presets or checkboxes.
- Base instructions start from the Codex GPT profile and can be edited in a dedicated section.
- Less common fields are grouped under **Advanced model capabilities** into **Responses and tools**, **Catalog metadata**, and **Prompt templates**.

The same Codex app-server reads the custom Catalog for the current device. When no task is running, saving a model silently restarts that app-server. When tasks are active, Wework asks whether to restart immediately. Choosing to restart later marks the model as **Waiting for executor restart** and keeps it out of the model picker until the restart completes.

Local project files remain in their project folders. Local preferences, model configurations, and conversations stay on the current device. Cloud requests and configuration are sent to the connected service only when you use cloud capabilities.

Codex credentials participate in cloud synchronization only after an explicit upload or import. Protect remote-device commands, Git tokens, and model API keys as credentials.

## Automatic storage cleanup

Wework maintains regenerable data that it owns in the background, without requiring a manual cleanup action:

- Managed worktrees are stored under `workspace/worktrees` in Executor Home by default. When **Automatically delete old worktrees** is enabled, Wework keeps the configured newest count and selects only older worktrees linked exclusively to archived tasks. It creates a Git snapshot before removal so the worktree remains restorable.
- Running tasks do not pause cleanup globally. Wework processes one worktree per batch with a 30-second delay between batches, while protecting the worktree used by a running task, recently updated worktrees, and worktrees from the same Git repository as a running task.
- Feedback staging files and embedded-browser screenshots become eligible after 24 hours. Wework logs become eligible after 14 days. The desktop app starts checking five minutes after launch, repeats every 30 minutes, and removes at most 20 files from each directory per pass.
- Isolated development runtime directories become eligible after 14 days. Each running instance protects its directory with a file lock; maintenance removes only stopped instances and deletes at most two instance directories per pass.

Temporary-file and log maintenance processes only direct regular-file children of known Wework directories. Isolated-runtime maintenance processes only stopped, validly named direct instance directories under `app-runtime`. Every deletion target must be an expanded absolute path. Paths containing environment-variable placeholders, starting with `~`, containing parent-directory traversal, or traversing symbolic links are rejected, and current-process logs and all active instances are protected. A validation or deletion failure for one target is skipped without blocking tasks or maintenance of other directories.
