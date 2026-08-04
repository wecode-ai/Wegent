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

Enable **Experimental features** under **Settings → General**, then use **Personal supervisor** above the composer in a Codex task. While the main AI is working, the executor periodically reads its recent progress in the background and evaluates goal drift, missed constraints, destructive actions, and obvious blocked loops with a lightweight read-only call. It does not fork the original task, and checks continue without keeping the task view open.

- **Suggest** shows a correction above the composer for you to approve or dismiss.
- **Auto-correct** steers an active response when a clear deviation is found, or starts a normal follow-up just as if you had sent the instruction from the composer.

Supervision settings belong to the current task. The review model can follow the current task or be selected independently, and the review frequency can be 10 seconds, 30 seconds, 1 minute, or 5 minutes. Set default supervisor principles under **Settings → Context**; they are prefilled when supervision is first enabled and can then be customized for that task.

## Review the processing timeline

The **Processed** section in an AI response displays tool calls from top to bottom by their actual creation time. Even when executor events arrive out of order, commands, file operations, and other tools created earlier remain above later activity so the timeline reflects the real execution sequence.

Completed processing activity is summarized by type. Terminal commands and Node.js REPL JavaScript calls count as commands, MCP and other capabilities count as tools, and file reads or edits use their own categories. Expand the processing area, then select a row or its chevron to inspect the details. The collapsed row uses a readable short name; the detail view shows the full tool name, invocation input, and returned output. Status-only activity without input or output does not show an empty disclosure control.

Conversations can be continued, renamed, copied to another device, or archived. Project conversations stay under their project; standalone conversations appear in the conversation list.

To branch from a completed AI response, move the pointer to its message actions and choose **Continue in new task**. The new task keeps the conversation context through that response and uses the same workspace. The source task and later messages remain unchanged. The action is hidden for streaming, cancelled, or unmappable Codex turns.

When you switch away while viewing the bottom of a conversation, Wework preserves its follow-latest state. Returning to a conversation that continued streaming in the background shows its newest content. If you scrolled upward before switching, Wework restores that reading position instead.
