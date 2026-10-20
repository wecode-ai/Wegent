---
sidebar_position: 42
---

# Wework Stand-in

The face-mask button beside the board search opens personal Stand-in settings. It is off by default and uses the current device. Enable it to handle new assignments to yourself and optionally add instructions. Saving shows the same icon beside the sidebar project name; disabling removes it. Cancel, close, and Escape discard unsaved edits.

Settings belong to each Executor and live in its local SQLite store. For cloud projects, select an owned connected cloud device to read and edit that device's configuration. Device switches load the selected device's version. Settings on other devices remain independent. Configuring another device does not require contacting an offline old device or transferring ownership. An offline device's settings become editable after reconnection.

Choose an existing project Agent to retain its model, instructions, skills, plugins, and MCP configuration, or use the general assistant by default. Execution reuses the project's existing workspace, repositories, and preparation flow.

The storage model supports multiple independent configurations per project, user, and device, with `id`, `name`, `tags`, `agentId`, instructions, enabled state, and individual versions. The current panel edits `default`; managing multiple configurations is reserved for a future UI. Any exact Issue tag match selects a tagged configuration ahead of an unfiltered default. Unmatched Issues use the default. Multiple matching tag rules prevent automatic execution and produce an Executor conflict log instead of an arbitrary selection.

The selected Executor checks assignments periodically and calls the ordinary `runtime.tasks.create` entry point used for manual creation. Task bindings, runtime scheduling, conversations, and results use existing flows. There is no Stand-in backend API, dedicated execution queue, global device binding, or automatic failover. Cloud projects use existing project APIs for assignment data; local projects work without a cloud connection. Checking stops with the Executor and resumes after restart for assignments made since enablement.

Each poll checks the ordinary assignment identity and existing task bindings to avoid creating the same assignment again. Ordinary task creation has no atomic cross-device deduplication: two devices reading an unbound assignment simultaneously may each create a task. Stand-in adds no server lock or queue. Users review and submit results through existing flows; Stand-in adds no delivery or review lifecycle. Creation failures use existing task recovery.

Focused tests cover durable versioned settings, independent tag rules, assignment age, existing binding filtering, device switching, and sidebar configuration merging and updates. Both `stand-in` and `stand-in-cloud` desktop checkpoints run in existing CI. Only model responses are replaced; storage, task execution, cloud APIs, and device connections use real implementations.

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
