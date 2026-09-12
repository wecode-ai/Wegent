---
sidebar_position: 34
---

# Wework Local Agent Execution Model

Building on the
[Cloud Collaboration Domain Model](./cloud-collaboration-domain-model.md), this
document defines the relationship between local Wework, Codex, Plugins,
Executors, LocalTask, and cloud Issue/Run.

The goal is not to force every local conversation into the cloud. It is to make
local execution that participates in a collaboration Project use the same Agent
definition, Run protocol, and capability snapshot as Wegent cloud execution.

## Product hosting boundary

The collaboration management UI has one implementation owned by Wegent Web.
Like the fixed Agent tab, the fixed Collaboration tab in Wework opens Wegent
Web in the built-in browser:

```text
Wework fixed Collaboration tab
→ Wegent Web /collaboration
→ Workspace / Project / Issue / Member / Agent / Execution Environment
```

Wework no longer implements the all-workspaces or workspace-resource
management pages. Its local surface retains only execution-domain capabilities:

- the My Work aggregate view;
- notifications and Issue deep links;
- the local execution entry for a concrete Issue;
- LocalTask creation, Issue/Run binding, execution, and deliverable sync.

The fixed Collaboration tab therefore uses the cloud page, while a concrete
project task opened from My Work or a notification can still use the Wework
local execution surface. Both paths use the same cloud data and
`packages/collaboration` domain components rather than duplicating Workspace
management state.

## Current execution path

The current local board-robot path is approximately:

```text
ProjectChatAgent
→ WeworkExecutionProfile
→ RuntimeTaskCreateRequest V2
→ LoopItemExecution.execution_payload
→ Wework Executor claim
→ LocalTask
→ Codex app-server thread/turn
```

This path already provides reusable foundations:

- `LoopItemExecution` stores execution state, device,
  `runtime_instance_id`, local `runtime_task_id`, and immutable execution
  intent.
- `RuntimeTaskCreateRequest V2` carries model, Plugin, Skill, workspace,
  attachment, and goal configuration.
- Wework Executor supports local claims, Codex app-server, Plugin
  materialization, Skill deployment, event reporting, and device capability
  synchronization.
- `LocalTask` has the stable identity `deviceId + localTaskId`.
- Codex transcript data is sourced from thread, turn, and item APIs.

The primary break is that `WeworkExecutionProfile` synthesizes a Bot with
`shell_type = Codex` from `ProjectChatAgent` configuration and separately reads
Project Plugins instead of consuming the unified
Team → Bot → Ghost → Shell definition. Local and Wegent execution therefore
have separate Agent configuration sources.

## Target relationship

```text
Workspace Agent
└── Team
    └── Bot
        ├── Ghost
        │   ├── Prompt
        │   ├── Skills
        │   ├── MCP Servers
        │   └── Plugins
        ├── Shell = Codex
        └── Model

Project
└── Issue
    └── Run
        ├── Agent Snapshot
        ├── Runtime Selection
        ├── Execution Workspace
        └── Backend Binding
            └── LocalTask
                └── Codex Thread
```

Local Wework and cloud Wegent no longer represent different Agent types. They
represent different Runtimes and Executors:

```text
The same Agent
├── Wework Local Runtime
└── Wegent Cloud Runtime
```

## Agent definition and execution snapshot

Before a Run is queued, Backend resolves Team, Bot, Ghost, Shell, Model, and
Plugin into an immutable `AgentExecutionSnapshot`:

```text
AgentExecutionSnapshot
├── agent_id / team_id
├── agent_revision
├── bots
│   ├── bot_id
│   ├── ghost_revision
│   ├── effective_prompt
│   ├── shell_type
│   ├── model_selection
│   └── effective_capabilities
│       ├── skills
│       ├── mcp_servers
│       └── plugins
└── collaboration_mode
```

The snapshot enters `LoopItemExecution.execution_payload`. Changes to Team,
Ghost, Plugin, or model defaults after enqueue must not affect an existing Run.

The current `WeworkExecutionProfile` should become only an execution-snapshot
compiler or be removed:

- Bot name and Shell no longer come from a synthesized `ProjectChatAgent`.
- Model defaults come from Bot/Model; Project or Workflow may override them
  explicitly.
- Plugin defaults come from Ghost; Project and Run may append permitted
  overrides.
- `ProjectChatAgent` provides only a Project Agent Binding and runtime-policy
  overrides.

## Codex Shell

Codex becomes an official Shell type instead of a hard-coded string in a
Wework-only branch:

```text
Shell
├── Chat
├── ClaudeCode
├── Codex
├── Agno
├── Dify
└── ...
```

Codex Shell defines its protocol and requirements:

```text
Codex Shell
├── provider protocol: app-server
├── required capabilities
├── supported models
├── supported Plugin format
├── cancellation capability
├── continuation capability
└── transcript capability
```

Wework Executor is one local implementation of Codex Shell. A cloud Executor
may implement the same Shell later without changing the Agent definition.

## Plugin resolution and materialization

Ghost stores desired capabilities, while device installation state stores
actual capabilities:

```text
Ghost Plugin refs
→ AgentExecutionSnapshot
→ Runtime capability match
→ PluginDeviceInstallation
→ Executor materialization
→ Codex plugin cache
```

Responsibilities are:

| Layer | Responsibility |
| --- | --- |
| Ghost | Declares required Plugins, versions, configuration, and permissions |
| Workspace/Account | Stores Plugin installation grants and sharing policy |
| Project | Selects allowed Plugins and non-secret Project overrides |
| Runtime | Reports supported and materialized Plugin capabilities |
| Executor | Downloads, verifies, installs, and activates Plugins for a Run |
| Codex Shell | Loads Run Plugins through the Codex Plugin protocol |

Skills and MCP servers discovered inside a Plugin enter the common effective
capability manifest. Duplicate declarations are deduplicated by stable identity.
Version or configuration conflicts fail explicitly during enqueue or Runtime
matching.

Device-only authorization and secrets do not enter Ghost and are not persisted
in Run. Run stores references and permission requirements; the selected Device
materializes them at startup.

## Runtime and device selection

The existing `runtime_instance_id` remains the Runtime instance identity. A
Runtime exposes at least:

```text
Runtime
├── runtime_instance_id
├── device_id
├── executor_kind
├── supported_shells
├── capabilities
├── online_status
├── capacity
├── owner
└── access_policy
```

Scheduling inputs separate requirements from preferences:

```text
requirements
├── shell = Codex
├── required_plugins
├── required_skills
├── workspace_access
└── platform constraints

preferences
├── preferred_runtime_id
├── preferred_device_id
└── local | cloud preference
```

Only a local directory, private credentials, or device-specific capability
creates a hard binding. Normal Git repository work should allow the scheduler
to choose from matching Runtimes.

## Execution Workspace

Long-lived Project resources and the directory used by one Run are separate:

```text
Project Resource
├── Git Repository
└── Device Local Directory Binding

Run Execution Workspace
├── local_directory
├── git_checkout
├── git_worktree
└── standalone
```

- `local_directory` is pinned to the Device that owns the directory.
- `git_checkout` lets the Runtime prepare an isolated checkout.
- `git_worktree` lets the Runtime create an isolated worktree from a repository.
- `standalone` is a local Codex conversation directory outside a collaboration
  Project.

The existing local `Project` display group does not become a cloud Project
identity. It remains derived from `deviceId + workspacePath`, but its product
name should become local workspace to avoid confusion with collaboration
Project.

## Run, LocalTask, and Codex Thread

They must not share one identifier:

| Entity | Identity | Source of truth |
| --- | --- | --- |
| Run | `run_id` / `LoopItemExecution.id` | Backend |
| LocalTask | `deviceId + localTaskId` | Wework Executor |
| Codex Thread | opaque `threadId` | Codex app-server |
| Turn | provider turn ID / subtask ID | Codex and Executor |

Their relationship is:

```text
Run 1 ── 1 BackendBinding
                 N ── 1 LocalTask ── 1 Codex Thread
                                         └── N Turns
```

A retry creates a new Run by default. Continuing the previous LocalTask or
Codex Thread requires an explicit recovery policy and a
`resumed_from_run_id`; paths, titles, or recent-thread heuristics cannot select
the session. A resumed Run always creates its own BackendBinding; it may point
to the previous LocalTask and Codex Thread, so one LocalTask may have multiple
BackendBindings over time. Events emitted after the resume belong to the new
Run and its BackendBinding, use that binding's monotonic event sequence, and
update only the new Run. The previous Run, its binding, and its events remain
immutable history.

## Two forms of local work

Local tasks distinguish collaboration execution from personal conversations.

### Collaboration execution

```text
Issue
→ any Project Member with execution permission selects “Run locally”
→ Run
→ Wework Runtime
→ LocalTask
→ Codex Thread
```

Backend Run is the lifecycle source of truth. LocalTask and Codex Thread provide
device-side execution details. Status, logs, cancellation, deliverables, and
recovery project back to Run.

Whether the Issue is assigned to the current user does not affect this entry
point. Assignment controls notifications and work lists, not who may start
local execution. Run creation records:

```text
initiated_by = current Member
agent_id = selected Codex Agent
trigger = manual
```

A Project may supply a default Agent, Runtime, and local workspace binding, but
an authorized user may explicitly override them. When another active Run
already exists, Wework shows the concurrent-work warning and links to existing
Runs instead of blocking execution because the user is unassigned.

### Standalone local conversation

```text
LocalTask
→ Codex Thread
```

A standalone conversation may remain device-only and does not require a
Workspace, Project, Issue, or Run. An Issue/Run relationship is created only
when the user explicitly adds it to a collaboration Project or the system
creates an explicit binding. Historical local conversations must not be
silently uploaded.

## Unified creation and execution protocol

Collaboration execution uses:

```text
Create Run
→ persist immutable intent
→ select Runtime
→ executor claim
→ materialize Agent snapshot
→ prepare Execution Workspace
→ create/link LocalTask
→ start/resume Codex Thread
→ stream normalized events
→ persist terminal state and Deliverables
```

The existing `RuntimeTaskCreateRequest V2` can evolve into the common execution
request, but it must:

1. use `run_id` as the top-level collaboration identity;
2. source Bot, Ghost, Shell, Model, and Plugin from the Agent snapshot;
3. materialize secrets only in local or cloud compilers;
4. expose the same canonical fields to Wework and Wegent Executors;
5. place backend-specific data in explicit extensions without changing common
   status and event protocols.

## Status and events

Run uses common states:

```text
pending_approval
→ waiting_runtime
→ queued
→ claimed
→ running
→ completed | failed

claimed | running
→ cancel_requested
→ cancelled

pending_approval | waiting_runtime | queued
→ cancelled
```

LocalTask, Codex thread, and turn states update Run through a projector and
cannot be inferred by the frontend. Every event contains at least:

```text
run_id
runtime_instance_id
device_id
local_task_id
provider_thread_id
turn_id
event_sequence
event_type
timestamp
```

Backend accepts only events that match the current Run, Runtime, and
BackendBinding and whose sequence increases monotonically.

## Duplicate local paths to remove

Convergence removes:

- duplicate Agent Prompt, Model, Plugin, and complete execution identity from
  `ProjectChatAgent`;
- synthesized Bot construction in `WeworkExecutionProfile`;
- separate local and Wegent Skill, MCP, and Plugin resolution paths;
- execution identity inferred from `workspacePath`, title, or recent tasks;
- frontend logic that infers collaboration Run terminal state from LocalTask or
  transcript;
- any model that exposes an Executor or Plugin-equipped Device as a
  collaboration Member.

## Evolution order

1. Add Plugin references and a common effective capability manifest to Ghost.
2. Add an official Codex Shell and generate existing local Codex requests from
   that Shell definition.
3. Compile an immutable `AgentExecutionSnapshot` from Team/Bot/Ghost.
4. Store `run_id`, Agent snapshot, and a common BackendBinding in
   LoopItemExecution.
5. Make Wework Executor consume the common snapshot and execution request
   directly.
6. Reduce ProjectChatAgent to ProjectAgentBinding.
7. Unify local and cloud event, cancellation, recovery, and Deliverable
   protocols.
8. Preserve standalone LocalTask mode and provide an explicit “add to
   collaboration Project” action.
