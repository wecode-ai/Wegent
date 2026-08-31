---
sidebar_position: 4
---

# Working with AI

## Write a useful request

Include the goal, scope, constraints, and acceptance criteria. For complex work, ask AI to investigate and propose a plan before editing.

Add files, images, code locations, or an Appshot to the composer when they clarify the task. Type `/` to select an available Skill.

After you send a local image, Wework keeps its preview in the message. The image remains available when you reopen Wework or return to the conversation after switching away. If the original local file is deleted, the preview cannot be restored.

## Add a conversation to a project-space board

After enabling Experimental features, open the composer's **+** menu and select **Project space**. The selected destination appears as **Add to board · Project space name** below the composer so you can confirm it before sending. Sending the first message creates the corresponding board task and links the conversation. A project space inherited from the local-project automatic-join setting appears through the same control.

For an existing task, open the right-side **Environment** panel and select **Link project space**. You can link the current project or task to a local or cloud project space, or quickly create a task in that space. Local-space operations remain on the current device; cloud-space operations use shared cloud data.

After a task is linked to a board, select **Change board link** from the task summary above the composer, then choose the destination project space. Wework offers two choices:

- **Create board task** creates and links a card using the current task title and execution status.
- **Link an existing board task** searches editable cards in the destination board by task ID or title and links the current task to the selected card without changing that card's status.

When the destination differs from the current board, Wework asks you to confirm the move. After confirmation, the runtime task keeps only one user-selected board link. The original board card remains in place but is no longer linked to the runtime task. A newly created card enters the column that matches the current task state; for example, a settled task awaiting confirmation enters **In review**.

### Review board-task progress

The linked-task progress area does not repeat the runtime task title. While a task is running, the first row shows the latest AI text or thinking state, and a second indented row with a short vertical guide shows the most recent tool or edit action. PR/MR status remains a trailing action. After execution stops, the card shows only the last non-empty line from the final response of the latest turn and never falls back to an older turn. Unread cards use a subtle background in addition to the unread indicator.

Hover anywhere on a card to open a lightweight task workspace. It initially shows the latest user message and AI response, reusing the Task conversation's thinking, tool-call, and file-edit rendering. Longer conversations scroll inside the transcript area, and **Load earlier history** fetches older turns. The composer stays on one line until clicked, then expands with the same quick phrases and actions available in Task conversations. While the composer is active, the preview stays pinned until its top-right close button is clicked. When one board task has several tasks running, the preview initially lists a summary for each one. Hovering an individual task narrows the preview to that task's progress.

## Manage project-space automation

Project spaces provide an **Automation** entry that manages robot members and their execution queue in one place. A robot can be assigned as the owner of a project task: it claims the task, executes it on the local or a selected device, and writes the result or failure back into the task comment thread for human acceptance.

The execution queue shows each robot task's state (pending, queued, claimed, running, failed for retry) and supports keyword search. Completed automation runs remain as comments in the task detail, where a human can accept the result or ask the robot to continue.

Robots in a local project space can only bind to the local executor or a companion App device; cloud devices are reserved for cloud project spaces. The local App claims the queue every 3 seconds, keeps running tasks leased, and automatically requeues runs that were interrupted after their lease expired, so a run can never stay stuck in "running".

### Run a cloud device on this machine (for development testing)

Robots in a cloud project space can execute on cloud devices. During local
development you can register this machine's executor as a `device_type=cloud`
device with the repo script, so the cloud-device dispatch path can be verified
locally:

```bash
bash executor/scripts/dev-cloud-device.sh start    # start and keep online (idempotent)
bash executor/scripts/dev-cloud-device.sh status   # show running/online state
bash executor/scripts/dev-cloud-device.sh restart  # restart manually
bash executor/scripts/dev-cloud-device.sh stop     # stop
```

- The default device id is `cloud-device-dev` (override with `DEVICE_ID`); it
  appears under "cloud devices" in the device list after registration.
- The script builds the latest executor and watches `executor/src`,
  `Cargo.toml`, and `Cargo.lock`; source changes trigger an incremental build
  and dynamic executor restart. It also mints a 30-day token from the
  `backend/.env` secret and uses an isolated executor home and Codex home (it
  never reads personal Codex credentials).
- When creating a robot, choose the "cloud" execution environment and
  `cloud-device-dev` as the device; assigned tasks then execute locally through
  the cloud-device protocol and write back comments and execution records.
- Runtime data and logs live in `~/.wegent-executor-cloud-device/`.

## Models and devices

The model provides the AI capability; the device determines where files and commands run. Local models run on the local device. Cloud models and devices require a Wegent connection.

When the composer has only one model group, the model selector displays all models in that group directly. When multiple groups are available, choose a group first, then select a model from its expanded submenu.

After a conversation starts, you can still switch between official GPT/Codex models and third-party models. Wework asks for confirmation when the selected model changes, and the new model applies to the next message.

If the existing context contains encrypted reasoning or compaction state produced by the previous provider, the executor removes those non-portable fields from the switch request so the target model does not return `invalid_encrypted_content`. Portable messages, tool results, and other context remain available.

## Control a running task

| Action                  | Shortcut                       | Use it when                             |
| ----------------------- | ------------------------------ | --------------------------------------- |
| Send after the response | `Enter`                        | Queue the next instruction              |
| Steer the response      | `Command/Ctrl + Enter`         | Adjust the current direction            |
| Interrupt and send      | `Command/Ctrl + Shift + Enter` | Stop an incorrect direction immediately |

Interrupting stops the current response but does not roll back completed file edits or commands.

## Use the personal supervisor

Open the composer's **+** menu in a new Codex conversation or an existing Codex task and select **Personal supervisor**. While the main AI is working, the executor periodically reads its recent progress in the background and evaluates goal drift, missed constraints, destructive actions, and obvious blocked loops with a lightweight read-only call. Supervision is a regular feature and does not require **Experimental features**. It does not fork the original task, and checks continue without keeping the task view open.

- **Suggest** shows a correction above the composer for you to approve or dismiss.
- **Auto-correct** steers an active response when a clear deviation is found, or starts a normal follow-up just as if you had sent the instruction from the composer.

Supervision settings belong to the current task. Select an independent review model and a review frequency of 10 seconds, 30 seconds, 1 minute, or 5 minutes. Wework remembers the most recently saved review model and frequency on the current device and restores them when supervision is configured for a new task. Set default supervisor principles under **Settings → Context**; they are prefilled when supervision is first enabled and can then be customized for that task.

After supervision starts, the right-side **Environment** panel shows its status and the next scheduled review time. Select **Review now** to inspect the current progress immediately. The action is temporarily disabled while a review is already running so the task cannot start concurrent supervisor checks.

## Review the processing timeline

The **Processed** section in an AI response displays tool calls from top to bottom by their actual creation time. Even when executor events arrive out of order, commands, file operations, and other tools created earlier remain above later activity so the timeline reflects the real execution sequence.

Completed processing activity is summarized by type. Terminal commands and Node.js REPL JavaScript calls count as commands, MCP and other capabilities count as tools, and file reads or edits use their own categories. Expand the processing area, then select a row or its chevron to inspect the details. The collapsed row uses a readable short name; the detail view shows the full tool name, invocation input, and returned output. Status-only activity without input or output does not show an empty disclosure control.

A plan generated in Plan mode remains part of the visible response instead of being placed inside the completed **Processed** disclosure. It stays directly visible after restoring a background task or reopening the conversation. Ordinary commands, file operations, and tool calls continue to use the summary and disclosure behavior described above.

Conversations can be continued, renamed, copied to another device, or archived. Project conversations stay under their project; standalone conversations appear in the conversation list.

To branch from a completed AI response, move the pointer to its message actions and choose **Continue in new task**. The new task keeps the conversation context through that response and uses the same workspace. The source task and later messages remain unchanged. The action is hidden for streaming, cancelled, or unmappable Codex turns.

When you switch away while viewing the bottom of a conversation, Wework preserves its follow-latest state. Returning to a conversation that continued streaming in the background shows its newest content. If you scrolled upward before switching, Wework restores that reading position instead.
