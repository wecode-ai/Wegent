---
sidebar_position: 9
---

# Settings and data

Open **bottom-left account menu → Settings**, then select a page from the grouped navigation. See [Interface navigation and feature locations](./interface-navigation.md) for all entries, visibility conditions and missing-entry checks.

Settings cover language and startup behavior, the top-level tab activated when the main workspace opens, appearance, local Codex and compatible models, cloud models configured in Wegent and synchronized to Wework, proxies, local coding harnesses, context and default principles for the personal supervisor, quick phrases, keybindings, worktrees, browser data, and archived conversations.

The startup choice in Fixed tabs applies only when the main workspace starts at its home route. After opening an explicit address or restoring the pending interactions page, choosing **New task** opens the task composer without reapplying that startup preference.

The context indicator beside the task composer shows the current model's context usage. The ratio
is measured against the context available to the input, which is the model's maximum context minus
its configured maximum output; upstream providers charge the completion budget against the same
window as the input, so the context cannot grow any further once the ratio reaches 100%. Its used
arc and remaining track automatically adapt their contrast for light and dark themes. When usage
reaches the compaction threshold, the indicator switches to a warning color and, when compaction
is available, offers the compact action.

The permission-mode control appears as the current mode's icon in the left composer toolbar,
immediately after quick phrases. Hover to see the active mode, or click to choose **Read only**, **Workspace**, or
**Full access**. After selecting a project space, the composer chip shows only the board name;
its hover text still explains that sending creates a task on that board.

Under **Settings → General → General**, choose the Wework feature mode:

- **Focus mode** hides the Code hosting and Worktrees entries and disables Wework's built-in Git
  plugin. Use it when local code-development features are not needed.
- **Developer mode** enables Wework's built-in Git plugin and shows the complete coding navigation.
  This is the default mode.

The preference stays on the current device. Switching modes automatically restarts the managed
Core DSH runtime so the plugin state takes effect immediately. Mode controls the Git plugin, so it
cannot be enabled or disabled separately from the plugin management page.

## General controls

<a id="settings-controls"></a>

<!-- ui-source: src/components/settings/GeneralSettingsPage.tsx -->
<!-- ui-source: src/components/settings/RuntimeConcurrencySettings.tsx -->

Open **bottom-left account menu → Settings → Personal → General**. The page groups basic preferences, runtime, AI assistance, privacy and the popout window. Most switches save immediately; check the page for save errors.

| Feature                                    | Steps and result                                                                                             | Conditions or limitations                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Mode                                       | Select Focus or Developer mode and confirm                                                                   | Restarts the managed plugin runtime; Focus mode hides Git entries                                               |
| Interface language                         | Select system language, Chinese or English                                                                   | Changes this device's UI, not task content                                                                      |
| Message send shortcut                      | Select Enter or Command/Ctrl+Enter                                                                           | Check the option's newline behavior; composition input should not submit prematurely                            |
| Follow-up behavior                         | Select queue or guide                                                                                        | Queue waits for the current turn; guide sends instructions to it. See [Task controls](./tasks.md#task-controls) |
| Fixed tabs                                 | Add Tasks, Collaboration or Agent tabs, reorder with up/down, choose the startup item or remove a fixed item | Explicit page links override startup; this replaces the older Default page dropdown                             |
| Show main window after launch              | Toggle whether startup displays the main window                                                              | Separate from closing the window to the background                                                              |
| Experimental features                      | Enable, then look for experiment-marked entries                                                              | Does not authorize external accounts or remove OS restrictions                                                  |
| Import work from other AI apps             | Open import, select a supported source and content, then confirm                                             | Do not share imported credential or session files in chat                                                       |
| Task, stand-in and agent concurrency       | Select each concurrency limit in the runtime group                                                           | Controls scheduling, not reasoning effort; high limits increase device load                                     |
| Keep running after closing the main window | Enable to retain background work when closing the window                                                     | Quitting the application stops managed local execution processes                                                |
| Prevent sleep while tasks are running      | Enable the running-task sleep prevention preference                                                          | Does not allow execution through shutdown or loss of connectivity                                               |
| Record performance data                    | Enable, reproduce the slowdown, then export diagnostics through Feedback                                     | See sampling and retention rules below                                                                          |
| Tray display content                       | Select Unread tasks, running tasks, Codex quota and cloud quota separately                                   | Codex quota requires the local subscription; cloud quota labels can be server-defined                           |
| Use friendly titles                        | Enable and select the task model or a specific model                                                         | Generates titles asynchronously; manual renames are preserved                                                   |
| Help improve Wework                        | Change the privacy preference and read the collection notice                                                 | Separate from explicitly exporting diagnostic logs                                                              |
| Popout Window shortcut                     | Record a new key combination or clear the binding                                                            | Opens the Wework popout, not the message-send action                                                            |
| System drag panel                          | Toggle in the popout group                                                                                   | Availability depends on device and system capabilities                                                          |

Refusing data collection on first use or in privacy settings takes effect immediately. Enabling collection requires a successfully saved global preference, and a refusal saved by another window also applies. A failed save does not block the workbench; the next launch uses the saved preference or asks again. A later explicit choice takes precedence, so an older request completing late cannot re-enable collection after refusal.

Saving a UI preference, changing scheduler limits and replacing an executable have different activation rules. Follow restart prompts for Node.js and coding tools; saved preferences do not imply that existing processes have already changed.

### System drag panel and stash

<a id="system-drag-controls"></a>

1. Enable **Settings → Personal → General → Popout Window → System drag panel**.
2. Start dragging selected text inside Wework or a file location supporting workspace-path transfer. Drop onto the desired zone when the panel appears; arbitrary external-application drags are not guaranteed to open it.
3. **Create new chat** fills a new draft; **Follow up** appends to the current conversation and appears only when one exists. Review the composer and send explicitly: neither action auto-submits.
4. **Temporary stash** stores text and attachment paths as a quick-phrase stash item. In the composer's quick-phrase menu, open **Stash**, hover to preview, select to insert, delete one item or clear the stash. Clearing items does not delete source files; moving/deleting a source can invalidate its attachment path.
5. Close the panel or press Esc to abandon the drag. Inspect failed-add feedback rather than treating a dismissed panel as a sent message.

## Record performance data

Enable **Record performance data** under **Settings → General → Runtime** to retain resource
measurements for investigating computer slowdowns. The switch is off by default. Enabling it starts
sampling immediately, then starts another sample about five seconds after each sample completes.
Records include system CPU, memory, swap, and resource usage by Wework, the executor, and child
processes. The preference stays on this device and remains active after restarting Wework. Turning
it off stops recording and preserves existing logs.

Performance logs stay on the device. Each file is limited to 5 MiB, with the current file and three
rotated files retained for a total limit of 20 MiB. The log retention policy under
[Automatic storage cleanup](#automatic-storage-cleanup) also applies. After a slowdown, note its
time and open **Feedback**. Select standard diagnostics including **Runtime logs**, preview the
bundle, and choose **Confirm export**. The exported performance logs help compare system pressure
and per-process resource changes around that time.

## Archived conversations and worktree cleanup

<!-- ui-source: src/components/settings/ArchivedConversationsSettingsPage.tsx -->
<!-- ui-source: src/components/settings/WorktreesSettingsPage.tsx -->

1. Open **Settings → Archived → Archived tasks** and search for a conversation by title.
2. Restore it to continue, or delete it after reviewing the confirmation. Deletion, unlike archival, starts device-side cleanup.
3. Open **Settings → Coding → Worktrees**, select the device and inspect each repository's worktrees and linked tasks.

| Worktree feature                   | Steps and effect                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| Worktree root                      | Edit the managed root and blur the field to save; this does not move the source repository        |
| Automatically delete old worktrees | Enable cleanup; read the confirmation when disabling it                                           |
| Automatic deletion limit           | Set retention count and press Enter or blur to save; only eligible worktrees are reclaimed        |
| Refresh, delete and restore        | Refresh device data; use the record's action after reviewing linked tasks and uncommitted changes |

Deleting a conversation under **Settings → Archived → Archived tasks** first accepts the request.
The owning device then removes its files and any managed worktree that no other task references
in the background. A task disappearing from the list does not mean disk cleanup has finished.

If background cleanup fails, the workbench shows an error and the archived page retains the reason
and restores the task so you can retry after fixing the problem. Worktree management records are
retained on failure. After restarting, the app resumes accepted cleanup that has not finished.
**Settings → Worktrees** also shows failed records and their errors.

A valid worktree is independent of the source directory used to create it. Removing that source
directory does not prevent cleanup. If Git metadata is damaged or repository identity cannot be
verified, cleanup preserves the directory and reports the reason so you can repair it and retry.

## Local device proxy

<!-- ui-source: src/components/settings/ProxySettingsPage.tsx -->

Open **Settings → Personal → Proxy**, distinguish the local card from cloud-device cards, select a mode or edit the URL, and save that card. Saving local configuration does not update cloud devices. Cloud operations require a connection and corresponding permissions.

Under **Settings → Proxy**, the local device proxy has three modes:

- **Use system proxy** follows the system proxy or PAC configuration. When the system does not use
  a proxy for the current address, the page shows **Direct (system proxy not used)**.
- **Force direct** ignores the system proxy and connects directly to the target service.
- **Custom proxy** uses the HTTP, HTTPS, or SOCKS5 proxy URL entered by the user.

The status badge shows the saved mode, while **Current connection** shows the connection produced by
that mode. After saving a change, restart Codex when prompted. Running tasks are not interrupted
immediately; new chats use the new network settings. Local device proxy settings stay on the current
device and are not synced to cloud.

## Node.js execution environment

<!-- ui-source: src/components/settings/ExecutionEnvironmentsSettingsPage.tsx -->

Open **Settings → Coding → Execution environments** and inspect each environment card's version, executable and readiness. On the Node.js card choose a custom executable or restore the built-in one; refresh Python detection on its card. Read card errors before retrying. This global preparation is distinct from initializing a project's repositories.

By default, the Wework desktop app uses the Node.js runtime included in Electron Helper for DSH,
Skills, MCP, and local executor child processes. It does not ship a second standalone Node.js
runtime. On macOS, these background processes reuse the Helper application identity, so creating a
conversation or running a Skill does not add another Node or Wework icon to the Dock.

Open **Settings → Execution environments** to inspect the active Node.js version and path. The
default is labeled **Built into Electron**. To use a specific version, select an existing Node.js
executable on the device; Wework labels it **Custom**. Restart Wework after selecting a custom
executable or restoring the built-in runtime so new DSH, Skill, MCP, and task processes receive the
updated environment.

## View app information

### Post-upgrade notice and release notes

If a version-notice card appears in the sidebar after an upgrade, open its version/new-features action to read **Wework release notes** and links. Close the dialog, press Esc or click its outside overlay to return. Dismissing the card neither uninstalls/rolls back the update nor performs an update check.

### Account-menu quota details

Open the **bottom-left account menu** and expand **Codex remaining usage** or the cloud quota row to inspect periods and usage. Inspect loading errors before retrying. The Codex row is hidden when the local subscription is off; the cloud quota name can be server-defined. This differs from model selection and tray display preferences.

<!-- ui-source: src/components/settings/AboutSettingsPage.tsx -->

Under **Settings → Personal → About**, toggle **Automatic updates** and **Receive Beta updates**. The latter opts into prerelease updates; it does not immediately replace the running version. Check About for the actual version. Update, restart and diagnostic export retain their own confirmation flows.

Open the account menu in the lower-left corner of Wework and select **About** to view the app name, version, update channel, and project links.
The version shown in the About page is read from the running Electron application package metadata,
so it matches the version shown by the macOS **About Wework** system menu. Release builds that
inject a version through the Electron configuration use that value in both places.
When an update is downloading from the same menu, its progress appears directly below **Check for updates**, separate from **About**.
Wework finishes downloading the update package before it asks to restart. No restart confirmation
appears while the download is in progress; the **Update and restart** confirmation appears only
when the update is ready to install. Canceling keeps the downloaded update available, so selecting
the update action again reopens the confirmation without downloading it again. When automatic
updates have already finished the download in the background, selecting the update action enters
the same restart-confirmation flow immediately.

<!-- ui-source: src/components/settings/KeyboardShortcutsSettingsPage.tsx -->

In **Settings → Personal → Shortcuts**, search for an action and click its binding or unset value. Press a new combination to save automatically; Esc cancels recording. Clear removes the binding; Reset restores its default. A duplicate combination may replace another action's binding, so inspect related actions after editing.

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

<!-- ui-source: src/components/settings/HarnessSettingsPage.tsx -->

| Field             | Steps and effect                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Executable        | Leave blank for detection or select a local executable; restore automatic detection if needed                     |
| Permission mode   | For Claude Code, choose default, plan or the explicit permission-bypass option only after understanding its risks |
| Default arguments | Enter one argument per line; the application does not parse these through a shell                                 |
| Environment       | Enter one NAME=VALUE per line; saved on this device, not in chat                                                  |

The desktop app can launch an installed OpenCode, Claude Code, or Kimi Code executable as a local coding
harness. Under **Settings → Coding → Coding tools** (experimental), you can:

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

See [Model settings](./user-guide/model-settings.md#model-controls) for individual add, edit, test, vision-sidecar and Catalog controls.

**My Codex** shows official Codex models only when the current device has a configured
`auth.json`. Without that file, the group is omitted from the model picker; provider models,
local custom models, and cloud models remain available according to their own configuration. If
no source provides a model, the picker displays **No models available**.

## Editing a Codex model Catalog

Under **Settings → Models → Codex models**, expand a provider and select **Edit Catalog** for a
GPT/Codex model in the current list. The structured editor covers the context window, description,
reasoning levels, default reasoning level, parallel tool calls, input modalities, base
instructions, and advanced model capabilities. The model identifier and provider are read-only,
and this editor does not add, remove, or reorder models.

Changes stay in the current device's Executor Home. The executor stores only fields that differ
from the current base Catalog and builds the effective Catalog in this order: upstream Catalog,
Wework built-in configuration, user overrides, then vision-proxy derivation. Fields the user did
not override therefore continue to follow later Codex or Wework updates.

After saving, the model is marked **Customized**. Wework silently restarts the Codex app-server
when no task is active. If tasks are running, Wework asks whether to restart immediately; choosing
to restart later marks the model as **Waiting for executor restart** until the restart completes.
Selecting **Restore defaults** removes the complete user override for that model and returns to the
base Catalog supplied by the current version.

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

One provider configuration can contain multiple models. Each model item has its own model selection, display name, vision proxy, enabled state, and connection test, while all items share the provider-level API key, group, and technical configuration. Clicking **Add model** automatically refreshes the provider catalog and adds an item, so **Load models** is needed only for a manual refresh. A model item's **Test** action tests only that selected model. After saving, every item appears as an independent choice in the model picker.

Local custom APIs and cloud Responses models default to ordinary function-tool conversion, independently of provider profile IDs or model names. Existing configurations without tool capability fields use the same defaults. Native custom tools, namespaces/tool search, or full passthrough require explicit selection.

Responses connection tests also validate tool-call arguments. Missing arguments, invalid JSON, or arguments that do not satisfy the probe fail the test; retry from the same editor after correcting the problem.

The DeepSeek profile uses the native Responses API and exposes `deepseek-v4-flash` and `deepseek-v4-pro`, the models currently available for Codex. Both use a 1,048,576-token context window, `high` default reasoning effort, and live Web Search. DeepSeek accepts only `apply_patch` as a custom tool, so Wework retains Code Mode while translating `exec` and freeform tools into function tools at the API boundary and restoring native tool calls from responses. The connection test verifies function-tool calling. Existing configurations without an explicit native-tool selection use the same portable adaptation without re-adding models; legacy Wework-managed Chat Completions configurations still migrate to the Responses API. The current catalog declares text input and disables image generation, so image generation and image understanding are not presented as supported capabilities for this profile.

A text-only model can explicitly reference another model that declares image input as its vision proxy. Local-model references are maintained in Wework's local model settings. Cloud-model references must be configured in the Wegent web administration UI; Wework only consumes the `visionSidecarModel` reference returned by the Backend, does not provide cloud-model editing, and never selects a default vision model automatically. Before the primary request, Wework asks the vision model to describe each image and replaces `input_image` with the description text. With a configured proxy, executor generically derives a vision catalog from the current base catalog, so any text model preserves its reasoning, tool, context, and compaction capabilities. Without an explicit reference, the model remains text-only and makes no additional model call. Original media reaches only the vision model and never the text-only primary model. Vision proxies support OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages endpoints. Each turn describes at most eight distinct images, accepts images up to 20 MB, and injects an explicit error message when description fails. Remote vision endpoints must use HTTPS; only `localhost` and loopback IP addresses may use HTTP, and vision requests do not follow redirects so credentials cannot be forwarded to an unauthorized destination.

Each custom model has an optional **Group** field that controls how it appears in the model picker. Kimi Coding defaults this field to **Kimi**, but users can edit or clear it. Models without a group appear under **Custom models**.

Choose **Custom** to configure an OpenAI Responses, Chat Completions, or Anthropic Messages-compatible endpoint. Model capabilities use structured controls instead of raw Catalog JSON:

- One context-window field drives both runtime and Catalog configuration.
- Reasoning levels, input modalities, and boolean capabilities use presets or checkboxes.
- Base instructions start from the Codex GPT profile and can be edited in a dedicated section.
- Less common fields are grouped under **Advanced model capabilities** into **Responses and tools**, **Catalog metadata**, and **Prompt templates**.

The same Codex app-server reads the custom Catalog for the current device. When no task is running, saving a model silently restarts that app-server. When tasks are active, Wework asks whether to restart immediately. Choosing to restart later marks the model as **Waiting for executor restart** and keeps it out of the model picker until the restart completes.

Local project files remain in their project folders. Local preferences, model configurations, and conversations stay on the current device. Cloud requests and configuration are sent to the connected service only when you use cloud capabilities.

Codex credentials participate in cloud synchronization only after an explicit upload or import. Protect remote-device commands, Git tokens, and model API keys as credentials.

## Appearance controls

<!-- ui-source: src/features/appearance/AppearanceSettingsPage.tsx -->

Open **Settings → Personal → Appearance**. Changes stay on this device. **Reset** at the top restores appearance defaults; consider whether you want to keep custom values first.

| Feature                                  | Steps and result                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Theme                                    | Select light, dark or system                                                                                                                                                                                       |
| Light theme, Dark theme                  | Defaults to the original Wework palette, alongside all 29 names from the installed ChatGPT Desktop, including Tokyo Night: 30 names and 46 light/dark variants in total; system mode uses the corresponding choice |
| Accent, Contrast                         | Choose a color or move the slider to adjust emphasis and contrast                                                                                                                                                  |
| Restore theme accent                     | After customizing the accent, click Restore to use the current light/dark theme's accent again; fonts and background images remain unchanged                                                                       |
| Translucent sidebar                      | Toggle transparency; system and window background affect the result                                                                                                                                                |
| Use different light and dark backgrounds | Enable to configure each mode separately; disable for a shared background                                                                                                                                          |
| Background image                         | Select or remove an image on the relevant mode card; adjust visibility and blur and choose main, sidebar or top-bar regions                                                                                        |
| UI font, UI font size                    | Enter the interface font and adjust its size                                                                                                                                                                       |
| Code font, Code font size                | Set the font and size for code/monospace content separately                                                                                                                                                        |

The original Wework palette uses a white light background, a `#181818` dark background and a `#2563eb` blue accent.
New preferences, migration from legacy default palettes and Reset select Wework. Changing the default does not overwrite saved named themes or custom color edits.

Named themes cover application interfaces, menus, detached windows, code, terminals and visualizations.
Startup flow and startup colors follow upstream, and remote Wegent Agent content retains its own theme.
Reselecting a palette resets its color overrides; the light and dark choices remain independent.

## Context and default instructions

<!-- ui-source: src/components/settings/ContextSettingsPage.tsx -->
<!-- ui-source: src/components/settings/CodexPersonalitySettings.tsx -->

Open **Settings → Personal → Context**:

| Feature                                 | Steps and scope                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Inject Terminal information             | Toggle terminal context inclusion; does not itself authorize command execution                                                 |
| Context compaction threshold            | Enter a percentage and blur the field or press Enter; controls the manual-compaction indicator, not automatic model compaction |
| Codex personality                       | Open the selector and choose a reply style                                                                                     |
| Default stand-in supervision principles | With experimental features enabled, edit and save; not a project permission policy                                             |
| Wework instructions                     | Edit the text and save; unsaved text is not applied and instructions cannot override application permissions or security rules |

## Quick phrases, Runtime and Hooks

<!-- ui-source: src/components/settings/QuickPhrasesSettingsPage.tsx -->
<!-- ui-source: src/components/settings/RuntimeSettingsPage.tsx -->
<!-- ui-source: src/features/hooks/HooksSettingsPage.tsx -->

| Entry                                | Features and steps                                                                                                              | Limits                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Settings → Personal → Quick phrases  | Create, edit, reorder or delete phrases; select one in the task composer, review and send                                       | Inserting a phrase does not execute a task                                  |
| Settings → Personal → Runtime        | Create a named configuration with device and model; choose an existing Runtime for project defaults; delete with the row action | A reusable execution configuration, not a Node.js version                   |
| Settings → Coding → Hooks → Add Hook | Set plugin ID, name, version, tool matcher, command, Windows command, timeout, asynchronous execution and status message; save  | Runs external commands; only configure trusted commands                     |
| Settings → Coding → Hooks → Import   | Select a local Hook directory and inspect health after import                                                                   | Fix invalid configuration or missing commands first                         |
| Hook row                             | Enable/disable, edit, delete, reveal its folder or test and inspect the last result                                             | Testing actually executes the command, rather than merely validating syntax |

## Appshots and computer use

<!-- ui-source: src/components/settings/AppshotsSettingsPage.tsx -->
<!-- ui-source: src/components/settings/ComputerUseSettingsPage.tsx -->

| Entry and feature                                             | Steps and result                                                                    | Conditions or risks                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Settings → Integrations → Appshots → Shortcut                 | Record or clear a snapshot binding; invoke it to capture the foreground application | Separate from browser screenshots                                       |
| Appshots → Screen recording access / Accessibility access     | Inspect status, open OS settings, grant access and return                           | Users complete OS authorization; accessibility reads window information |
| Appshots → Appshot destination                                | Inspect the automatic destination: the current Wework composer                      | A status display, not an arbitrary folder picker                        |
| Appshots → Play sound                                         | Toggle the successful-capture sound                                                 | Disabled while unsupported, loading or saving                           |
| Settings → Integrations → Computer use → Enable computer use  | Enable and prepare the OS permissions requested by the page                         | Support depends on the platform status shown                            |
| Computer use → Accessibility access / Screen recording access | Open the matching OS settings, authorize and return                                 | Changing chat permission mode cannot replace OS authorization           |
| Computer use → Action approval                                | Read the confirmation policy for write operations                                   | A policy display, not a bypass switch                                   |

## Narrow-window settings

<!-- ui-source: src/components/settings/MobileSettingsPage.tsx -->

Use the settings list to enter General, Appearance, Models or another page, then return to choose a different item. Desktop-only entries still depend on the actual platform. Do not locate narrow-window controls by desktop-sidebar coordinates.

## Automatic storage cleanup

Wework maintains regenerable data that it owns in the background, without requiring a manual cleanup action:

- Managed worktrees are stored under `workspace/worktrees` in Executor Home by default. When **Automatically delete old worktrees** is enabled, Wework keeps the configured newest count and selects only older worktrees linked exclusively to archived tasks. It creates a Git snapshot before removal so the worktree remains restorable.
- Running tasks do not pause cleanup globally. Wework processes one worktree per batch with a 30-second delay between batches, while protecting the worktree used by a running task, recently updated worktrees, and worktrees from the same Git repository as a running task.
- Feedback staging files and embedded-browser screenshots become eligible after 24 hours. Wework logs become eligible after 14 days. The desktop app starts checking five minutes after launch, repeats every 30 minutes, and removes at most 20 files from each directory per pass.
- Isolated development runtime directories become eligible after 14 days. Each running instance protects its directory with a file lock; maintenance removes only stopped instances and deletes at most two instance directories per pass.

Temporary-file and log maintenance processes only direct regular-file children of known Wework directories. Isolated-runtime maintenance processes only stopped, validly named direct instance directories under `app-runtime`. Every deletion target must be an expanded absolute path. Paths containing environment-variable placeholders, starting with `~`, containing parent-directory traversal, or traversing symbolic links are rejected, and current-process logs and all active instances are protected. A validation or deletion failure for one target is skipped without blocking tasks or maintenance of other directories.
