---
sidebar_position: 11
---

# Wework Mobile

Use Wework Mobile on iPhone or Android to view and control projects and conversations on the selected device. iPhone builds containing the local runtime can also run the Executor and official Codex directly on the phone. To access a computer's tasks, enable remote access as described in [Devices and cloud work](./devices.md) and keep that computer online.

## Managing projects and conversations

Choose **Wework ▾ → New project** on the home screen, select an online execution device, and enter an existing absolute project directory on that device and a project name. This supports the phone-local environment, cloud devices, and computers with remote task access enabled. The project and name are saved together through the PC interface. Computer paths are validated on that computer.

The **…** menu beside a project offers **Pin / Unpin, Rename, Archive all project chats, and Remove project**. Removal requires confirmation and removes only the Wework listing, preserving files and conversations. A multi-root project keeps one identity; same-name projects on different computers remain independent.

Swipe a conversation row left to reveal the red **Archive** button. Archival requires tapping that button; a full swipe does not archive. Only one row stays revealed, and scrolling, searching, or changing devices closes it. Long-press a conversation row to open the native menu with **Pin / Unpin, Rename, Copy thread ID, and Archive**. Open **Wework ▾ → Archived conversations** to search, restore, or permanently delete archives on the selected device. Permanent deletion requires confirmation and cannot be undone; ordinary project files remain. Archiving delegates managed-worktree snapshot cleanup to the owning executor. Worktrees shared by unarchived conversations remain; restoring a conversation restores its saved worktree.

Remote computer operations require the same account and current consent on the target installation. Revocation blocks subsequent requests. Failed operations preserve content and show native errors. If an accepted write is followed by a failed list read, retry the list read through its error entry without repeating the mutation.

## Run on this phone

The app opens directly into the task list without Backend login. Builds with the runtime prepare
local execution automatically; view status or retry in **Settings → Local execution (本机执行)**.
Before login, **All / This phone** filters are hidden and new conversations use the phone by default.
Projects, Git, conversations, attachments and processes belong to a persistent phone environment.
Wegent login, logout and account changes preserve local work and its filesystem.

Open **Settings → Models and accounts (模型与账号) → OpenAI account (OpenAI 账号)** and tap
**Sign in with OpenAI (使用 OpenAI 账号登录)** for official browser authorization. The explicit
**Use device code (使用设备码登录)** option is also available; some accounts must enable it in ChatGPT
settings. The account and model catalog refresh only after Codex confirms success.

Use **Settings → Models and accounts → Add model (添加模型)** to configure API Base URL, model ID,
API Key (optional for unauthenticated services), and an optional display name. Only **Responses API**
is supported. **Test connection (测试连接)** sends a real tool-call probe; **Save model (保存模型)** makes
the model selectable in chat. Keys remain in device secure storage.

Saving a model or starting OpenAI login first asks for explicit task-data sharing confirmation.
Only **Agree and continue (同意并继续)** starts the operation; cancellation preserves the input.
Read the [privacy policy](./mobile-privacy.md) through the model-page link or **Settings → Privacy
(隐私) → Privacy policy (隐私政策)**. The complete notice is bundled for offline reading in Chinese
and English; only **View public version** opens an external website. Messages, attachments, required file contents and tool output
may be sent to the selected model provider. Local tool execution does not mean local model inference.

For Backend models and cloud devices, use **Settings → Sign in to Wegent (登录 Wegent)** to configure
the Backend address and authorize. Device filters appear after login. Settings is a full-screen page
with a top-right **×** close button; the existing new-chat layout remains unchanged.

Upgrades adopt existing local data. If multiple legacy environments exist, select one in
**Settings → Local execution**. An explicit switch stops current execution first, without merging or
deleting either environment's files or conversations.

Local execution currently requires an iPhone device build with the runtime resources. Android continues to support remote devices. The embedded Linux environment does not implement read-only or workspace sandboxes. Select **Full access (完整访问)** explicitly; access remains inside the iOS app sandbox. An existing restricted permission selection is never silently elevated.

iOS uses the system's limited background execution allowance to let foreground-started tasks continue briefly after backgrounding. The system determines the allowance; long Codex tasks are not guaranteed to finish in the background or while locked. Keep the app in the foreground for long tasks. Exhausting the allowance interrupts background work with a visible indication, but does not cancel a task that is still running in the foreground. Force-quitting stops execution. Returning to the foreground restores conversations from the executor's persisted transcript. Old approval requests must not be treated as live after process termination.

## Home screen

The app opens directly to **Pinned / Projects / Tasks**, with **Ask Wework** at the bottom.
The current mobile interface uses the Chinese labels shown below.

| Entry                                    | Action                                                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-left menu                            | Open the sidebar; tap **Wework** to return home, settings beside the account to configure connections, or the avatar failure badge to retry                                                          |
| **Wework ▾** at the top                  | Open **New project (新建项目)**, **Archived conversations (已归档会话)**, **Settings (设置)**, or **Show all devices (显示全部设备)**; project creation depends on the current device's capabilities |
| Top-right search icon                    | Filter conversations in the current scope by conversation title, project name, or device name; the close button exits search and clears the query                                                    |
| Device strip                             | Appears after Wegent login; tap **All (全部)** for online devices' conversations, or a device name to narrow the scope                                                                               |
| **Pinned (置顶)**                        | Expand or collapse pinned conversations, using the pinned state and order saved on desktop                                                                                                           |
| **Projects (项目)** and **Tasks (任务)** | Expand or collapse a section; tap a conversation title to open it, or pull down to refresh the list                                                                                                  |

The device strip shows online devices by default and scrolls horizontally on its own. When you scroll the home list upward, the strip moves off screen with the list. Use **Wework ▾ → Show all devices (显示全部设备)** to inspect offline device status. Offline devices cannot execute a new conversation.

Projects with the same name remain separate for each device and workspace. Gray text beside a project comes from its actual workspace label or directory name. Tap the project name to expand its conversations, or the compose icon on the right to start a conversation in that workspace.

## Start or continue a conversation

Tap **Ask Wework (向 Wework 提问)** at the bottom of the home screen to open a new conversation. Once the page transition finishes and the composer is available, it receives focus and opens the keyboard so you can type immediately. Choose a device and project above the composer. After selecting a workspace, you can use the existing workspace or create a Git worktree. Starting a conversation requires an online device in the current scope that supports task creation.

After selecting a project, tap **Work locally → New worktree (在本地工作 → 新建工作树)**, then tap the branch row to open **Starting branch (启动分支)** and search existing branches. The current branch is the default. Sending the first message creates an independent worktree without checking out another branch in the original directory. Follow-up messages continue in that worktree. Selecting another project or device, or starting a new conversation, resets the launch mode and branch selection.

The workspace-owning device checks worktree capabilities, the repository, and write access using the same rules as PC Wework. An unavailable **New worktree** option displays the reason. Failed reads can be explicitly retried, and current-workspace execution remains available. Phone-local execution and authorized remote devices use the same worktree protocol.

Tap the composer to expand its toolbar, enter a message, and tap the up arrow to send. Use **Follow up (跟进)** to continue an existing conversation. While it runs, the square stop button cancels the current response. The top-left back button returns to the list; the compose icon at the top right of a conversation starts another conversation.

## Voice input

Tap the microphone in the composer to start local voice input. While recognizing, the composer becomes a voice bar with live volume, cancel, stop, and send actions. Stop writes the final text into the composer for review before sending; send stops recognition and submits the recognized text; cancel discards the result. Starting voice input while the keyboard is closed does not reopen it.

iOS uses the system's on-device speech recognition and does not require a separate recognition model download inside the app. The first use requires microphone and speech-recognition permission and depends on a supported system language pack. Android uses the system on-device recognizer and requires Android 13 or later. When the Chinese offline language pack is missing, the app starts the system download flow. Missing local recognition support or denied permission produces a retryable error in the composer.

## Answer questions

When a question card appears, tap **Answer question (回答问题)**, select an option or enter a custom answer, and tap **Send (发送)**. Answers to blocking questions are delivered to the waiting question in the original task. Asynchronous questions let the task keep running: an answer submitted while it runs is delivered as guidance; an answer submitted after it stops continues the original conversation.

**Skip (跳过)** depends on the question type. For ordinary questions, it cancels the current task response and ends its pending questions. For an MCP form, it submits an empty answer to the tool and ends that form request. The close button at the top right only collapses the panel; the question remains pending.

The card shows **Answered (已回答)** or **Skipped (已跳过)** only after the execution device accepts the operation. A failed submission preserves the question and your answers and displays an error with a retry action. Refreshing the conversation does not reopen an accepted answer. Authorization requests that require an external page direct you to complete them on the computer.

## Models, permissions, and attachments

- **Models:** Expand the composer and tap the blue model icon. The panel title shows the complete model name, current reasoning level, and an advanced-settings arrow. Models with reasoning controls use a slider with one segment per supported level, so a three-level model shows three segments and a five-level model shows five. Dragging the slider does not trigger the conversation back gesture. Tap the title to open **Advanced (高级)**, then tap **Model (模型)**, **Intelligence (智能)**, or **Speed (速度)** to choose from a pop-up menu. Intelligence lists only the current model's supported reasoning levels. Models that support speed settings offer **Standard (标准)** and **Fast (快速)**. Selecting an option closes the menu and displays the current value. These settings apply to new conversations and subsequent messages; switching models adjusts the options to the new model's capabilities. If the model catalog fails to load, use the refresh button in this panel.
- **Permissions:** Expand the composer and tap the permission icon to select **Read only (只读)**, **Workspace (工作区)**, or **Full access (完整访问)**. These modes control what the task may do on its execution device.
- **Attachments and modes:** Tap **+** on the left of the composer to add photos or files, or choose available device Skills, planning, or goal mode.

Opening model controls preserves your unsent draft. Device, project, and conversation ownership follows the desktop app. Changing a list filter does not move an existing task to another device.

## File and change previews

The top-right folder icon, **Browse workspace files (浏览工作空间文件)**, opens the current directory;
it is disabled until an accessible workspace is known. Tap file links, tool-detail paths, attachments,
or expanded changed files for a read-only preview with search, navigation, and system sharing.
**Recent (最近)** keeps files and reading positions only for the current authenticated app session.
Closing a preview preserves the chat draft. See [Mobile file previews](./mobile-file-preview.md)
for entry points, truncated text, and format limitations.
Backend account changes clear remote preview caches and recent entries while preserving phone
previews and reading positions.

## iOS and Android

Supported iOS versions use native Liquid Glass buttons and panels. Enabling the system's Reduce Transparency setting replaces them with opaque surfaces. Android uses native panels, rounded corners, borders, and touch feedback. Both platforms retain the same feature entries and accommodate safe areas and the keyboard.
