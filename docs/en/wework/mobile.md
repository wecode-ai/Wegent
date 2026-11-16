---
sidebar_position: 11
---

# Wework Mobile

Use Wework Mobile on iPhone or Android to view and control projects and conversations on connected devices. Tasks run on the selected device; the phone does not run an executor. To access a computer's tasks, enable remote access as described in [Devices and cloud work](./devices.md) and keep that computer online.

## Home screen

The app opens directly to Wework's devices, projects, and conversations. The current mobile interface uses the Chinese labels shown below.

| Entry                                    | Action                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-left menu                            | Open the sidebar; tap its single **Wework** entry to return home, or the account row at the bottom to open connection settings                              |
| **Wework ▾** at the top                  | Open **New project (新建项目)**, **Settings (设置)**, or **Show all devices (显示全部设备)**; project creation depends on the current device's capabilities |
| Top-right search icon                    | Filter conversations in the current scope by conversation title, project name, or device name; the close button exits search and clears the query           |
| Device strip                             | Tap **All (全部)** for online devices' conversations, or a device name to narrow the scope; swipe horizontally to see more devices                          |
| **Pinned (置顶)**                        | Expand or collapse pinned conversations, using the pinned state and order saved on desktop                                                                  |
| **Projects (项目)** and **Tasks (任务)** | Expand or collapse a section; tap a conversation title to open it, or pull down to refresh the list                                                         |

The device strip shows online devices by default and scrolls horizontally on its own. When you scroll the home list upward, the strip moves off screen with the list. Use **Wework ▾ → Show all devices (显示全部设备)** to inspect offline device status. Offline devices cannot execute a new conversation.

Projects with the same name remain separate for each device and workspace. Gray text beside a project comes from its actual workspace label or directory name. Tap the project name to expand its conversations, or the compose icon on the right to start a conversation in that workspace.

## Start or continue a conversation

Tap **Ask Wework (向 Wework 提问)** at the bottom of the home screen to open a new conversation. Once the page transition finishes and the composer is available, it receives focus and opens the keyboard so you can type immediately. Choose a device and project above the composer. After selecting a workspace, you can use the existing workspace or create a Git worktree. Starting a conversation requires an online device in the current scope that supports task creation.

Tap the composer to expand its toolbar, enter a message, and tap the up arrow to send. Use **Follow up (跟进)** to continue an existing conversation. While it runs, the square stop button cancels the current response. The top-left back button returns to the list; the compose icon at the top right of a conversation starts another conversation.

## Answer questions

When a question card appears, tap **Answer question (回答问题)**, select an option or enter a custom answer, and tap **Send (发送)**. Answers to blocking questions are delivered to the waiting question in the original task. Asynchronous questions let the task keep running: an answer submitted while it runs is delivered as guidance; an answer submitted after it stops continues the original conversation.

**Skip (跳过)** depends on the question type. For ordinary questions, it cancels the current task response and ends its pending questions. For an MCP form, it submits an empty answer to the tool and ends that form request. The close button at the top right only collapses the panel; the question remains pending.

The card shows **Answered (已回答)** or **Skipped (已跳过)** only after the execution device accepts the operation. A failed submission preserves the question and your answers and displays an error with a retry action. Refreshing the conversation does not reopen an accepted answer. Authorization requests that require an external page direct you to complete them on the computer.

## Models, permissions, and attachments

- **Models:** Expand the composer and tap the blue gauge icon. Use the slider to change reasoning effort when the model supports it. Tap the model name to open **Advanced (高级)**, then tap **Model (模型)**, **Intelligence (智能)**, or **Speed (速度)** to choose from a pop-up menu. Intelligence lists only the current model's supported reasoning levels. Models that support speed settings offer **Standard (标准)** and **Fast (快速)**. Selecting an option closes the menu and displays the current value. These settings apply to new conversations and subsequent messages; switching models adjusts the options to the new model's capabilities. If the model catalog fails to load, use the refresh button in this panel.
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

## iOS and Android

Supported iOS versions use native Liquid Glass buttons and panels. Enabling the system's Reduce Transparency setting replaces them with opaque surfaces. Android uses native panels, rounded corners, borders, and touch feedback. Both platforms retain the same feature entries and accommodate safe areas and the keyboard.
