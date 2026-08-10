---
sidebar_position: 9
---

# Settings and data

Settings cover language and startup behavior, appearance, local Codex and compatible models, cloud models configured in Wegent and synchronized to Wework, proxies, context and default principles for the experimental personal supervisor, quick phrases, keybindings, worktrees, browser data, and archived conversations.

The context indicator beside the task composer shows the current model's context usage. Its used
arc and remaining track automatically adapt their contrast for light and dark themes. When usage
reaches the compaction threshold, the indicator switches to a warning color and, when compaction
is available, offers the compact action.

## View app information

Open the account menu in the lower-left corner of Wework and select **About** to view the app name, version, update channel, and project links.
The version shown in the About page is read from the running Tauri application package metadata,
so it matches the version shown by the macOS **About Wework** system menu. Release builds that
inject a version through the Tauri configuration use that value in both places.
When an update is downloading from the same menu, its progress appears directly below **Check for updates**, separate from **About**.

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

## Friendly titles

Under **Settings → General → Task runtime**, enable **Use friendly titles** and select an available model. Wework
then generates a concise title asynchronously for each new task. Creation never waits for that
model: the task starts with the original user-provided title, and its display name is replaced
when generation finishes with a brief shimmer.

Title generation uses a separate lightweight model call. It does not add a message to the task
conversation or change the main task's running, completed, or failed state. A manually renamed
task is not overwritten later. If generation fails, the original title remains and the task still
starts normally.

Ordinary new tasks are standalone by default. Opening a project task earlier does not
automatically add a new task to a remote project or board. Wework synchronizes only tasks that
were explicitly linked to a project space; after friendly-title generation, those local or cloud
board items receive the updated title.

## Custom Codex models

In **Settings → Models**, click **Add model** and choose a provider first. Wework includes profiles for Kimi Coding, the Kimi API Platform, DeepSeek, GLM, and MiniMax. After entering the corresponding platform API key, Wework discovers available models through the provider's model-list endpoint. Each profile supplies its connection URL, API protocol, tool mode, and known model context windows; the Kimi API Platform profile uses the China-region `api.moonshot.cn` endpoint. MiniMax has separate **China mainland** and **Global** entries, and the selected region must match the platform that issued the Token Plan key. Both entries use the recommended Anthropic-compatible API and the `X-Api-Key` header for model discovery. Kimi Coding K3 automatically uses the built-in Codex Catalog profile with a 256K context window and `low` default reasoning effort.

The DeepSeek profile uses the native Responses API and exposes `deepseek-v4-flash` and `deepseek-v4-pro`, the models currently available for Codex. Both use a 1,048,576-token context window, `high` default reasoning effort, live Web Search, and freeform `apply_patch`. The connection test also requires a real `apply_patch` custom-tool call. Existing Wework-managed DeepSeek Chat Completions configurations are migrated to the Responses API. The current catalog declares text input and disables image generation, so image generation and image understanding are not presented as supported capabilities for this profile.

A text-only model can reference another model that explicitly declares image input as its vision proxy. Local-model references are maintained in Wework's local model settings. Cloud-model references must be configured in the Wegent web administration UI; Wework only consumes the `visionSidecarModel` reference returned by the Backend and does not provide cloud-model editing. Before the primary request, Wework asks the vision model to describe each image and replaces `input_image` with the description text. Every text model with a configured vision proxy uses the internal generic `wework-vision-sidecar` capability catalog entry, allowing Codex to accept images while sending the original media only to the vision model and never to the text-only primary model. Vision proxies support OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages endpoints. Each turn describes at most eight distinct images, accepts images up to 20 MB, and injects an explicit error message when description fails. Remote vision endpoints must use HTTPS; only `localhost` and loopback IP addresses may use HTTP, and vision requests do not follow redirects so credentials cannot be forwarded to an unauthorized destination.

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
