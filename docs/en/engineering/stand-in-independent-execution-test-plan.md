---
sidebar_position: 27
---

# Independent stand-in verification

## User story and acceptance

As a Wework user, I want a stand-in to be a special agent with its own responsibilities, without choosing another agent during creation or editing. Existing stand-ins remove old references while preserving their own configuration, identity, history and effective grants.

- Creation, editing and project summaries show no agent picker or reference and request no personal/project agent catalogs.
- Execution uses the stand-in’s instructions, explicit model and options, device, workspace and connections. It inherits no external agent prompt, skills, plugins or policies. Missing models use the established independent default.
- Migration intersects old project restrictions with selected projects, preserves exclusions, switches, confirmation policies, versions and cutoffs, then removes references. A primary without project intake gains none and does not block other accounts from loading. Reads and saves are idempotent and never expand grants.
- Keep default cloud-device selection, explicit device choices, confirmed local-to-cloud migration, draft recovery and conversation identity.

## E2E cases

### Single-instance binding, stopping and rebinding stories

As a user, I want each Wework instance bound to one local or cloud stand-in. Rebinding requires stopping the entire current stand-in and cancelling its running and queued tasks. Failed cancellation must not unlock rebinding. The primary identity and scenario roles share this lifecycle without affecting ordinary tasks or other accounts.

| Story                         | Preconditions and actions                                                                             | Acceptance and coverage                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First project entry           | An unbound instance has online cloud devices; open a project link to a local stand-in                 | The explicit link determines the first binding, but never replaces an existing one; component tests and `stand-in-cloud`                                                |
| No direct switch              | A local or cloud stand-in is bound; inspect the header, role settings and onboarding                  | No device switch; role creation stays on the bound Executor; `stand-in-cloud-device`, `stand-in-workspace`                                                              |
| Stop before rebind            | A real cloud Codex conversation waits on the model; confirm Stop in the header                        | The real model stream is cancelled, native state projects cancelled, and choices appear only after whole-profile stop; `stand-in-cloud-device`                          |
| Fail closed and recover       | Disconnect the bound cloud device; stop, reload, reconnect and retry                                  | Persist stopping without silently choosing another device; rebind only after confirmed stop; `stand-in-cloud-device`                                                    |
| Retain history                | Create local roles, a conversation and memory; stop, bind cloud, then bind the original local profile | No cross-device role copy; original history and memory remain; `stand-in-cloud-device`                                                                                  |
| Preserve execution boundaries | Explicitly rebind before configuring models, workspaces, Git sources and project intake               | Retain existing permission, native-denial, reception-receipt and concurrent cross-device deduplication assertions; existing model, Git, workspace and cloud checkpoints |

Focused Rust contracts also cover all queued inputs plus the active turn of one task, real stop acknowledgement after timeout, cancellation cleanup without holding the processing gate, rejection of edits and restart during stopping, and stale binding versions. Component tests cover binding changes while confirmation is open, unsaved-edit decisions, and late reads from inactive pages. The shared helper maps to existing CI checkpoints without adding jobs or retries.

Reuse the desktop checkpoint runner. Only model responses are synthetic; Electron, Executor, Codex, SQLite, projects and native confirmation paths are real.

| Story                         | Preconditions and actions                                                                                         | Expected result and checkpoint                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create independently          | Use an isolated local project; create, cancel, reopen and save instructions                                       | No agent picker; cancel persists nothing; only the current project is connected; `stand-in`                                                              |
| Migrate old references        | Seed a historical project reference with all-project selection in isolated SQLite; read twice and reopen settings | Identity, versions, instructions and confirmation remain; scope becomes the former owning project; persisted data equals repeated reads; `stand-in`      |
| Execute after migration       | Give the old agent a unique prompt; assign a new Issue and create tagged roles using the old input format         | Real requests contain role instructions without the old agent prompt; every matching role executes exactly once; `stand-in`                              |
| Execute remotely              | Authorize a real remote Executor; configure an independent cloud stand-in and assign an Issue                     | No picker or reference fields; execution belongs to the remote device; no local configuration leak or project-agent prompt inheritance; `stand-in-cloud` |
| Configure model and workspace | Select a local model and code directory, then receive source work                                                 | Model/workspace configuration and existing source-read, network, approval, rejection and escalation assertions hold; `stand-in-workspace`                |
| Recover from errors           | Change settings concurrently before saving; cancel or retry; disconnect the selected device                       | Conflicts never overwrite edits; drafts remain; an offline device does not silently switch execution; existing desktop flows and focused component tests |

All three checkpoints are registered in the existing core CI inventory and distributed by the shared Linux shard planner. Use the actual CI plan and checkpoint logs to identify their executing shards; no new jobs are introduced. Preserve main’s default-cloud-device component coverage and `stand-in-cloud-device` checkpoint. Rust persistence contracts cover same-name projects across stores, exclusions, paused sources, personal/primary references, malformed references and atomic rejection.

## Execution and cleanup

The shared project-view helper chooses the currently available tab or select in one renderer operation. CI milestone control history and failure snapshots showed that separate layout inspection and clicking could wait for an unmounted tab after a responsive change. The fix preserves scenario assertions and timeouts, with focused tests for control replacement and a single activation.

Related CI regressions retain their existing scenarios and assertions. `streaming-conversation-switching` keeps all 520 progress items and its original deadlines: structural blocks use the shared conversation cache's batched publication, preserve every transition in order and flush before terminal events. `plugin-legacy-upgrade` keeps the delivered historical installers: Backend confirms a legacy acknowledgement only when its dispatched plugin snapshot still matches current desired state, preventing a late acknowledgement from falsely marking a newer version installed. Snapshots remain server-side and never enter the legacy wire protocol or public responses.

Focused acknowledgement regressions also verify that a single-plugin merge preserves unrelated pending removals and that dispatch and recording apply the same device release override. Stream tests verify that a failing subscriber cannot interrupt other subscribers or completion, and preserve status transitions around snapshot content updates.

Run `pnpm --filter wework e2e:desktop --parallel-segments stand-in,stand-in-workspace`; use the same runner with `--segment stand-in-cloud` for the remote case. Default to one checkpoint at a time and reuse the build.

Use runner-owned directories, identities and processes and existing `finally` cleanup. Keep results, complete failure logs and screenshots locally under `wework/test-results/`, outside commits. Record actual results in the PR. If the remote environment is unavailable, disclose that limitation rather than treating component tests as cloud E2E evidence.
