---
sidebar_position: 9
---

# Settings and data

Settings cover language and startup behavior, the top-level tab activated when the main workspace opens, appearance, local Codex and compatible models, cloud models configured in Wegent and synchronized to Wework, proxies, local coding harnesses, context and default principles for the experimental personal supervisor, quick phrases, keybindings, worktrees, browser data, and archived conversations.

The context indicator beside the task composer shows the current model's context usage. Its used
arc and remaining track automatically adapt their contrast for light and dark themes. When usage
reaches the compaction threshold, the indicator switches to a warning color and, when compaction
is available, offers the compact action.

The permission-mode control appears as the current mode's icon immediately before the context
indicator. Hover to see the active mode, or click to choose **Read only**, **Workspace**, or
**Full access**. After selecting a project space, the composer chip shows only the board name;
its hover text still explains that sending creates a task on that board.

Under **Settings → General → Basic**, set **Default page** to **Tasks**, **Project spaces**, or
**Agent**. This device-local preference activates the matching top-level tab when the Wework main
window opens or reloads at the root page. If every tab of that type has been closed, Wework creates
one again. Explicit links to Settings, Plugins, or a specific workspace route take precedence and
are not replaced by the default tab.

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

## Local harnesses

The desktop app can launch an installed OpenCode, Claude Code, or Kimi Code executable as a local coding
harness. Under **Settings → Connections → Harnesses**, you can:

- Enable or hide each harness. Only enabled harnesses that are detected successfully appear in
  the new-conversation runtime selector.
- Leave the executable field empty to search the desktop process `PATH` and the tool's common
  install locations, or provide an absolute path.
- Enter default arguments one per line. Wework passes them without shell parsing and appends the
  current prompt according to the selected harness protocol.
- Enter launch environment variables as one `NAME=VALUE` per line. These settings remain on the
  current device.
- Choose Claude Code's default, plan, or bypass permission mode. Bypass mode passes
  `--dangerously-skip-permissions` and should be used only in a controlled environment where its
  risks are understood.

After entering a task in a local project or development worktree, open the runtime selector in
the composer to launch a harness. Wework passes the complete prompt according to the selected
tool's CLI protocol and runs the process in the current workspace through a local PTY. The
interactive terminal appears in the center while the title bar, right workspace, and bottom panel
remain available. The right and bottom panels can create additional harness sessions for the same
workspace through a picker instead of exposing every installed tool inline. The primary session
can be switched but not closed from a panel; additional sessions can be closed explicitly. A
session created from the right workspace opens directly as a right-side tab without replacing the
central primary session. A session created from the bottom panel keeps the central additional-session
behavior. The creation dialog selects both the harness and the model for that session and starts it
only after **Create session** is confirmed.

Kimi Code starts as an interactive TUI. When the terminal attaches, Wework injects the first task
through bracketed paste instead of using the one-shot `--prompt` mode, so the same terminal remains
available for follow-up messages after the first turn completes.

Session metadata, selected model, plugin sources, workspace, and native harness session identity
remain on the current device. Reloading the main WebView or restarting Wework keeps sessions under
their project. Reopening one uses the native continue or resume mechanism of OpenCode, Claude Code,
or Kimi Code and restores bounded terminal scrollback. Explicitly closing a session terminates its
process and removes the persisted record.

Wework resumes a session only in the original workspace recorded when it was created. If that
directory or temporary worktree has been removed, Wework reports that the original workspace is
missing instead of launching the session in another directory. Restore the original workspace or
create a new harness session in the current workspace.

After selecting OpenCode, Claude Code, or Kimi Code, the ordinary Codex model picker is replaced by
the harness model picker. Its default is **Don't specify a model**: Wework does not pass a
`--model` argument, model proxy endpoint, or model credential, so the tool reads its own native
configuration. You can instead explicitly select a local model interface from
**Settings → Models** or a public, personal, or group model available through the connected Wegent
account. That choice is persisted for the harness and replaces any `--model` or `-m` value from its
default arguments. When an additional session is created from the right or bottom panel, the dialog
starts with that persisted default, but changing the model there applies only to the new session and
does not overwrite the harness default.

Only an explicitly selected Wework model connects the harness to the Anthropic
Messages-compatible loopback route exposed by the executor. The child process then receives a
fixed local model alias and non-privileged placeholder credentials. Provider keys, cloud login
tokens, model resource identity, and the configured local HTTP/SOCKS proxy remain inside the
executor. The executor converts Messages requests as peer adapters to Anthropic Messages, OpenAI
Responses, or OpenAI Chat Completions according to the selected model. Native Anthropic upstream
requests and responses preserve their original fields. Closing or exiting a harness unregisters
its route; abandoned routes expire after an idle timeout.

Harnesses are experimental; Codex itself is not marked experimental. OpenCode, Claude Code, and
Kimi Code load Agent Plugins-standard Skills and MCP servers from the Wework plugins selected for
the task. They also connect automatically to the `wework_browser` MCP server so they can operate
the Wework built-in browser through controlled tools. Plugin data is isolated by plugin and reused
when a session resumes. Codex-only side-conversation flows are not exposed in harness sessions.

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
