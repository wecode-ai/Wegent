---
sidebar_position: 42
---

# Wework Stand-in

The AI Stand-in button beside New Issue opens quick project configuration. My Stand-ins in the sidebar provides a project-based list. Stand-in is off by default with the current device selected. The compact disabled entry expands into an editor when enabled. Saving enables handling of future assignments to yourself. Cancel, outside clicks, and Escape discard unsaved edits.

Settings belong to each Executor and live in its local SQLite store. For cloud projects, select an owned connected cloud device to read and edit that device's configuration. Device switches load the selected device's version. Settings on other devices remain independent. Configuring another device does not require contacting an offline old device or transferring ownership. An offline device's settings become editable after reconnection.

Configure Agent → Device → Local project → Workspace → Model. Choose an existing project Agent to retain its instructions, skills, plugins, and MCP configuration, or use the general assistant. Fixed Agent models remain locked; otherwise the device's default model is selected. Only available local projects on the selected device are offered. Use the current workspace or create a Git worktree from a selected branch. Without an explicit local project, execution inherits the project environment.

Optional instructions reuse the ordinary composer without saving placeholder text. Goal mode is available in its plus menu. The model belongs to the configuration list outside the composer; Save and Cancel share a footer. Manual Issue creation can explicitly delegate to a Stand-in while automatic handling is disabled. Attachments finish uploading before assignment and execution start.

The storage model supports multiple independent configurations per project, user, and device, with `id`, `name`, `tags`, `agentId`, instructions, enabled state, and individual versions. The panel can reference existing configurations from the same project. Reusing another project copies its settings; an Agent unavailable in the target project must be reselected. Any exact Issue tag match selects a tagged configuration ahead of an unfiltered default. Unmatched Issues use the default. Multiple matching tag rules prevent automatic execution and produce an Executor conflict log instead of an arbitrary selection.

The selected Executor checks assignments periodically and calls the ordinary `runtime.tasks.create` entry point used for manual creation. Task bindings, runtime scheduling, conversations, and results use existing flows. There is no Stand-in backend API, dedicated execution queue, global device binding, or automatic failover. Cloud projects use existing project APIs for assignment data; local projects work without a cloud connection. Checking stops with the Executor and resumes after restart for assignments made since enablement.

Each poll checks the ordinary assignment identity and existing task bindings to avoid creating the same assignment again. Ordinary task creation has no atomic cross-device deduplication: two devices reading an unbound assignment simultaneously may each create a task. Stand-in adds no server lock or queue. Users review and submit results through existing flows; Stand-in adds no delivery or review lifecycle. A failed creation RPC rolls back the Issue binding just like manual creation. Recorded failed tasks remain available through existing task recovery and are not repeatedly started by subsequent polls.

Focused tests cover durable versioned settings, independent tag rules, assignment age, existing binding filtering, device switching, and sidebar configuration merging and updates. The `stand-in`, `stand-in-workspace`, and `stand-in-cloud` desktop checkpoints run in existing CI. Only model responses are replaced; storage, task execution, cloud APIs, and device connections use real implementations.

## Verification plan

Use isolated Electron instances, projects, accounts, and Executor data. Cloud cases also start a real backend, database, and remote Executor. Each checkpoint establishes its own prerequisites and disables configurations before environment teardown. Actual results and failure evidence belong in the PR.

| Case                   | Steps                                                           | Expected result                                                |
| ---------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| Defaults and cancel    | Open settings, edit instructions, cancel                        | Disabled on the current device; edits discarded                |
| Enable and reload      | Save, then reload                                               | Open eyes, sidebar mask, and selection bar persist             |
| Automatic execution    | Assign new work after enabling; leave board                     | Ordinary Runtime task completes and remains linked             |
| Exclusions and disable | Check historical, other-user, unassigned, and post-disable work | No execution; assignee unchanged                               |
| Version recovery       | Save a stale draft after an external update, reopen             | Conflict retains draft; reopen loads current version           |
| Agent                  | Select a project Agent and assign work                          | Existing instructions and model reach native execution         |
| Tag routing            | Configure review/docs rules and assign tagged work              | Each uses its own instructions; ambiguous work is skipped      |
| Repeated polling       | Edit processed work and wait multiple polls                     | One linked task and model request per assignment               |
| Cloud device           | Select remote Executor, save, reopen                            | Configuration belongs to remote device; local remains disabled |
| Existing binding       | Enable matching rules on another device and wait multiple polls | Already-linked assignments are not recreated                   |
