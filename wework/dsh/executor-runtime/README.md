# Wework DSH Executor Runtime

This plugin is the unified execution plane for Wework DSH apps. Browser code
only accesses versioned same-origin endpoints and never receives Electron IPC,
executor stdio, or bearer credentials.

The physical transport currently uses the migration-only Electron loopback
relay. The logical client, structured errors, event sequencing, bounded ring
buffer, and resume contract are stable so local sockets and the cloud runtime
relay can replace it without changing product apps.

## Relationship to Agents

This plugin exposes Executor capabilities and projects executions into DSH
Sessions, but it does not register a second global `AgentFactory`. The DSH base
bundle's `agent-loop` already owns the single factory slot; registering another
factory would prevent the default workbench from starting.

Executor is a separate process and one Wework process can address local and
remote execution targets at the same time. Codex and Claude Code are runtimes
launched by Executor, not code bundled into this plugin. A selected Wegent
Agent (Team) is materialized into the existing Executor `executionRequest` when
the task is created, and later turns retain that task binding without changing
the legacy Executor wire protocol.

The Backend's canonical task builder is the only component that materializes a
Team configuration. Wework no longer maintains a second conversion path for
Bots, models, Skills, or collaboration modes. For a local execution target,
Wework calls `/runtime-work/materialize` for an Executor V2-compatible payload
and then sends that payload directly to the local Executor; the Backend does
not proxy local execution. For a remote target, the existing
`/runtime-work/create` path uses the same builder before Backend dispatch.

The local default-assistant path is unchanged when no Team is selected.
Existing V1/V2 cloud task requests retain their original semantics. Only new
clients that select a Team send the V3 intent field `wegentTeamId`, while the
materialized Executor payload remains V2.
