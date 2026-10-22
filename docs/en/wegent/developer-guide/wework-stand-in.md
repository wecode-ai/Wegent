---
sidebar_position: 42
---

# Wework Stand-in

The AI Stand-in button beside New Issue opens quick project configuration. My Stand-ins in the sidebar provides a project-based list. The panel separates the automatic handling switch from Stand-in settings. Automatic handling is off by default with the current device selected. Settings remain editable and can be saved for manual delegation while automatic handling is off.

For an existing configuration without pending edits, the switch persists immediately. It is locked during persistence, and a failed request retains the confirmed state and displays an error. First activation or pending edits keep the switch off and change the primary action to Save and enable automatic handling. Cancel leaves it off. The ordinary Save settings action preserves the current automatic handling state. Turning automatic handling off stops new assignments while retaining settings and running tasks; it does not save the configuration draft.

Cancel, outside clicks, and Escape discard unsaved edits without undoing a persisted switch. Switch updates preserve draft edits and refresh their version for subsequent saves. Executor metadata such as timestamps does not count as a configuration edit.

Settings belong to each Executor and live in its local SQLite store. For cloud projects, select an owned connected cloud device to read and edit that device's configuration. Device switches load the selected device's version. Settings on other devices remain independent. Configuring another device does not require contacting an offline old device or transferring ownership. An offline device's settings become editable after reconnection.

Configure Agent → Device → Local project → Workspace → Model. Choose an existing project Agent to retain its instructions, skills, plugins, and MCP configuration, or use the general assistant. Fixed Agent models remain locked; otherwise the device's default model is selected. Only available local projects on the selected device are offered. Use the current workspace or create a Git worktree from a selected branch. Without an explicit local project, execution inherits the project environment.

While the model catalog loads, keep the model selector mounted and disable saving settings. Once ready, save the default model with the configuration so reopening does not treat default selection as an unsaved edit. Enabling an existing configuration waits for environment and model validation, preventing loading state from being mistaken for pending edits. Disabling an enabled Stand-in does not wait for validation.

Optional instructions reuse the ordinary composer without saving placeholder text. Goal mode is available in its plus menu. The model belongs to the configuration list outside the composer; Save and Cancel share a footer. Manual Issue creation can explicitly delegate to a Stand-in while automatic handling is disabled. Attachments finish uploading before assignment and execution start.

Model selection reuses the shared catalog conversion and source groups for the local ChatGPT account, cloud models, and custom providers. Identically named models retain separate execution identities. Slash commands use the same plugin and Skill catalog as task composers, scoped to the selected device and workspace. Without a workspace, the device's default catalog is read without creating a temporary task. Plugin marketplace and detail routes open in a task tab, preserving the collaboration tab and its draft.

The storage model supports multiple independent configurations per project, user, and device, with `id`, `name`, `tags`, `agentId`, instructions, enabled state, and individual versions. The panel can reference existing configurations from the same project. Reusing another project copies its settings; an Agent unavailable in the target project must be reselected. Any exact Issue tag match selects a tagged configuration ahead of an unfiltered default. Unmatched Issues use the default. Multiple matching tag rules prevent automatic execution and produce an Executor conflict log instead of an arbitrary selection.

The selected Executor checks assignments periodically and calls the ordinary `runtime.tasks.create` entry point used for manual creation. Task bindings, runtime scheduling, conversations, and results use existing flows. There is no Stand-in backend API, dedicated execution queue, global device binding, or automatic failover. Cloud projects use existing project APIs for assignment data; local projects work without a cloud connection. Checking stops with the Executor and resumes after restart for assignments made since enablement.

Each poll checks the ordinary assignment identity and existing task bindings to avoid creating the same assignment again. Ordinary task creation has no atomic cross-device deduplication: two devices reading an unbound assignment simultaneously may each create a task. Stand-in adds no server lock or queue. Users review and submit results through existing flows; Stand-in adds no delivery or review lifecycle. A failed creation RPC rolls back the Issue binding just like manual creation. Recorded failed tasks remain available through existing task recovery and are not repeatedly started by subsequent polls.

## Feedback in collaboration notifications

Collaboration notifications read the existing Runtime execution list and match stand-in tasks by project, Issue, and assignment identity. The original assignment notification shows the mask icon and working, waiting, finished, or failed state. Local and manually started stand-ins without an assignment notification also appear here. Clicking anywhere in the entry, including its icon and padding, opens the associated Issue details for both local and cloud projects without dispatching another task.

Notifications show the source, event and time, task content, and lightweight actions without an extra “New task” heading. New notifications snapshot the actual assigning user or manager agent name at creation; inbox reads do not query related records. Entries without a name omit assigner information and show the task title and time directly, without placeholder copy. Stand-in handling preserves the original assigner avatar, title, and layout, adding a “Handled by stand-in” badge and execution status. Completed entries retain this layout and display the review-ready status and result summary. Inline replies, question answers, and retries continue to operate on the original execution.

The inline handling area accepts follow-up instructions, answers real Runtime questions, and retries failed stand-in tasks. Ordinary follow-up input expands after clicking Reply; pending questions appear directly. Replies continue the same conversation. A rejected send keeps the draft and displays the error. Question options and request identifiers come from the conversation, never from interpreting result text.

Completion, failure, and pending input make the entry unread again and update its position. Desktop alerts respect collaboration notification preferences and are suppressed while that execution is visible. The desktop frontend owns this projection; no backend API or Executor protocol is added.

Stand-in read markers and desktop delivery receipts are account-scoped on the current device and do not sync between devices. Original assignment notifications retain the existing read API. Each auxiliary collection retains at most 1000 entries for 90 days and is pruned on reads and writes. Cleanup never deletes real notifications, tasks, or execution history.

Focused tests cover durable versioned settings, independent tag rules, assignment age, existing binding filtering, device switching, and sidebar configuration merging and updates. The `stand-in`, `stand-in-workspace`, `stand-in-cloud`, `stand-in-controls`, and `stand-in-notifications` desktop checkpoints run in existing CI. Only model responses are replaced; storage, task execution, cloud APIs, and device connections use real implementations.

## Verification plan

Use isolated Electron instances, projects, accounts, and Executor data. Cloud cases also start a real backend, database, and remote Executor. Each checkpoint establishes its own prerequisites and disables configurations before environment teardown. Actual results and failure evidence belong in the PR.

| Case                   | Steps                                                           | Expected result                                                  |
| ---------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| Defaults and cancel    | Open settings, edit instructions, cancel                        | Disabled on the current device; edits discarded                  |
| Independent settings   | Edit and save settings with automatic handling off              | Settings persist without enabling automatic handling             |
| Immediate switch       | Enable a saved configuration, disable it, then cancel           | Switch persists immediately and cancellation does not undo it    |
| Enable pending edits   | Edit settings, enable, then save and enable                     | Remains off until confirmation; activation uses the new settings |
| Disable with a draft   | Edit an enabled configuration, disable, then continue editing   | Only automatic handling changes; draft and new version retained  |
| Enable and reload      | Save, then reload                                               | Open eyes, sidebar mask, and selection bar persist               |
| Automatic execution    | Assign new work after enabling; leave board                     | Ordinary Runtime task completes and remains linked               |
| Exclusions and disable | Check historical, other-user, unassigned, and post-disable work | No execution; assignee unchanged                                 |
| Version recovery       | Save a stale draft after an external update, reopen             | Conflict retains draft; reopen loads current version             |
| Agent                  | Select a project Agent and assign work                          | Existing instructions and model reach native execution           |
| Tag routing            | Configure review/docs rules and assign tagged work              | Each uses its own instructions; ambiguous work is skipped        |
| Repeated polling       | Edit processed work and wait multiple polls                     | One linked task and model request per assignment                 |
| Cloud device           | Select remote Executor, save, reopen                            | Configuration belongs to remote device; local remains disabled   |
| Existing binding       | Enable matching rules on another device and wait multiple polls | Already-linked assignments are not recreated                     |
