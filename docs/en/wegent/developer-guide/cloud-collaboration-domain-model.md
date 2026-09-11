---
sidebar_position: 33
---

# Cloud Collaboration Domain Model

This document defines the cloud collaboration concepts shared by Wework and
Wegent. The product exposes one Workspace, Project, Member, Agent, Issue, and
Run model while continuing to reuse the existing Wegent Team, Bot, Ghost,
Shell, Model, and Task execution facilities.

This is a target domain model. It does not replace the established sources of
truth and execution wiring in
[Cloud Project Collaboration Architecture](./cloud-project-collaboration.md).

## Core terminology

| Product concept | Definition |
| --- | --- |
| `Workspace` | The long-lived tenant boundary for members, permissions, agents, devices, integrations, and shared resources |
| `Project` | A container inside a Workspace that organizes work around a product, business objective, or delivery |
| `Member` | A human or agent that can receive notifications, collaborate, or initiate execution |
| `Agent` | A machine member that can receive an Issue and produce a Run |
| `Issue` | A durable unit of work that can be discussed, advanced, reviewed, and accepted |
| `Run` | One bounded attempt by an Agent to execute an Issue |
| `Runtime` | An environment on a device that can execute a required Shell and capability set |
| `Deliverable` | A verifiable result submitted for an Issue by a human or Agent |
| `View` | A board, list, table, or other presentation of the same Issues in a Project |

The product path is fixed:

```text
Workspace
└── Project
    └── Issue
        ├── Assignments: Human | Agent
        └── Runs
            ├── Agent
            ├── Initiator
            ├── Runtime
            ├── Execution Workspace
            └── Deliverables
```

Workflow and Automation may create, assign, organize, or trigger Issues and
Runs. They must not form an independent task and execution model.

## Workspace and Project

`Workspace` owns shared people and capabilities:

- members, roles, and permissions;
- Agents, Teams, and capability definitions;
- Devices, Runtimes, and execution access;
- GitHub, GitLab, IM, and other integrations;
- repository registries, workflow templates, and automation templates;
- cross-Project search, analytics, quotas, and audit.

`Project` organizes a concrete body of work:

- Issues, comments, attachments, and deliveries;
- the Project member scope and enabled Agents;
- statuses, fields, and Views;
- Project resources, Workflows, and Automations;
- Project-level execution-policy overrides.

The existing `CloudProject` directly implements `Project` and should no longer
be presented as a collaboration Workspace. A real `Workspace` must be added
above it. The current board is only the default Project `View`:

```text
Workspace
└── Project (CloudProject)
    ├── View: Board
    ├── View: List
    ├── View: Table
    └── Issues (LoopItem)
```

## Member, Assignment, and Execution

`Member` is the common collaboration actor:

```text
Member
├── Human
└── Agent
```

Issues, Workflow nodes, and dispatchers use the same `MemberRef`:

```ts
type MemberRef =
  | { type: 'human'; id: string }
  | { type: 'agent'; id: string }
```

Assignment means directed notification, attention, and a request for action. It
does not grant exclusive execution rights and is not required to start work:

```text
Issue
├── Assignments: 0..N MemberRef
└── Runs: 0..N
```

- An Issue may be assigned to multiple Humans or Agents.
- Assigning a Human adds the Issue to that person's notifications and work list.
- Assigning an Agent may trigger a Run according to Project policy or may only
  notify it until an explicit start.
- An unassigned Member with Project execution permission may still start work,
  comment, or submit Deliverables for the Issue.
- Assignment neither grants Issue access nor blocks other Members from working.

A machine Run independently records who initiated it and which Agent executes
it:

```text
Run
├── initiated_by: Human | Agent | Automation
├── agent_id
├── runtime_id
└── trigger: manual | assignment | mention | workflow | automation
```

A Human may open any accessible Issue in Wework, select a local workspace, and
start a Codex Run without first being assigned. Fully manual work records
activity and Deliverables without fabricating a machine Run.

Devices, Executors, and Runtimes are not Members. They do not have durable
collaboration identities and cannot be Assignment targets or Agents.

## Unified Agent model

Wework Agent and Wegent Agent must not become separate definitions. Product
`Agent` uses the existing Wegent Team, Bot, Ghost, Shell, and Model structure:

```text
Agent
└── Team
    └── Bot
        ├── Ghost
        │   ├── Prompt
        │   ├── Skills
        │   ├── MCP Servers
        │   └── Plugins
        ├── Shell
        └── Model
```

- A single-agent Agent is a Team with one Bot.
- A multi-agent Agent is a Team with multiple Bots and a collaboration mode.
- The product always assigns an Agent and does not ask users to choose between
  Bot and Team.
- A local Wework coding Agent is the same Agent running a Codex Shell with
  Wework Plugins through a Wework Executor, not another Agent type.

The existing `ProjectChatAgent` becomes a binding from a Project to a Workspace
Agent:

```text
ProjectAgentBinding
├── project_id
├── agent_id / team_id
├── project_role
├── instruction_override
├── runtime_policy_override
└── enabled
```

Agent identity, Team, capabilities, and default execution policy belong to the
Workspace. A Project stores only enablement and Project-specific differences.

### Workspace Agents and Project-private Agents

An Agent always belongs to a Workspace tenant, but its usage scope may be
Workspace-shared or private to one Project. Both use the same Agent entity and
Team/Bot/Ghost model:

```text
Agent
├── workspace_id
├── scope: workspace | project
└── home_project_id: null | project_id
```

- `scope = workspace` allows bindings to multiple Projects in the Workspace.
- `scope = project` allows a binding only to `home_project_id` and is visible
  only to members of that Project by default.
- Creating an Agent inside a Project still creates a Workspace Agent, sets
  `scope = project`, and creates its ProjectAgentBinding.
- Promoting a Project-private Agent to Workspace-shared changes only its scope;
  it does not copy Team, Bot, or Ghost.
- Archiving a Project archives its private Agent only when no active Run,
  Automation, or other valid reference remains. Historical Runs retain their
  immutable snapshots.

If the same Agent only needs different repository context, extra instructions,
or Runtime preferences in different Projects, use ProjectAgentBinding
overrides instead of creating a Project-private Agent. Use `scope = project`
only when its role, capabilities, permissions, or lifecycle truly belong to
that Project.

## Ghost Plugin

Ghost adds `plugins` alongside `skills` and `mcp_servers`:

```yaml
spec:
  prompt: ...
  skills:
    - ref: skill/code-review
  mcp_servers:
    - ref: mcp/project-space
  plugins:
    - ref: plugin/wework-browser
      version: 1.2.0
      required: true
      config: {}
```

The reference model should contain at least:

```ts
type GhostPluginRef = {
  ref: string
  version?: string
  required: boolean
  config?: Record<string, unknown>
  permissions?: string[]
}
```

A Plugin is a capability package that may expand into Skills, MCP servers,
Hooks, Tools, and Runtime Requirements. Compiling a Ghost into an effective
capability manifest must deduplicate entries and validate conflicts.

Only Plugins that affect Agent execution belong to Ghost. UI-only Plugins that
extend Wework menus, pages, or components remain Wework host extensions.

## Shell, Runtime, Device, and Executor

Their responsibilities are fixed:

| Concept | Responsibility |
| --- | --- |
| `Shell` | Defines how to execute, such as Codex, ClaudeCode, Agno, Dify, or Chat |
| `Runtime` | Represents an available Shell instance and capability set on a Device |
| `Device` | Provides the machine, filesystem, network, and local credentials |
| `Executor` | Claims Runs, prepares environments, starts Shells, reports events, and handles cancellation and recovery |

The relationship is:

```text
Agent requires capabilities
    ↓ scheduler match
Runtime provides capabilities
├── Device
├── Executor
└── Shell
```

An Agent does not own a Device. It stores a default Runtime policy and access
rules. A Run records the Runtime and Device selected for that attempt. Local
directories may require a pinned Device, while cloneable Git repositories
should normally allow dynamic selection from a Runtime pool.

## Issue and Run

`LoopItem` remains the cloud source of truth for Issue.
`loop_item_executions` becomes the single product-level Run envelope for both
Wework-local and Wegent execution:

```text
Run
├── workspace_id
├── project_id
├── issue_id
├── agent_id
├── trigger
├── backend_type
├── backend_execution_id
├── runtime_id
├── execution_workspace_id
├── status
└── result
```

Backend mappings are:

```text
Run backend = wework_local
└── LocalTask / Codex thread

Run backend = wegent
└── Task / Subtask / Team execution
```

LocalTask, Task, and Subtask are execution-backend entities, not product tasks
alongside Issue. Common Run status, logs, cancellation, recovery, and delivery
interfaces must be backend independent. Backend-specific states are diagnostic
details only.

A successful Run means only that the attempt ended normally. It does not imply
that the Issue has been accepted.

## Existing facility mapping

| Target concept | Existing facility | Evolution |
| --- | --- | --- |
| Workspace | No complete equivalent | Add a tenant aggregate root |
| Project | `CloudProject` | Reuse directly and unify product terminology |
| Issue | `LoopItem` | Reuse directly |
| Agent | `Kind(kind=Team)` | Use as the only Agent definition |
| Bot/Ghost/Shell/Model | Wegent CRDs | Keep as internal Agent definitions |
| Project Agent | `ProjectChatAgent` | Reduce to ProjectAgentBinding |
| Run | `LoopItemExecution` | Promote to the only product execution record |
| Wegent backend | `Task` / `Subtask` | Use as backend execution records for Run |
| Wework backend | `LocalTask` / runtime RPC | Use as the local execution backend for Run |
| Runtime | Device, Executor, and Shell capabilities | Add a unified Runtime projection and scheduling interface |
| View | Current board and filters | Make board the default View and add server-backed saved Views |
| Workflow | Issue Workflow | Restrict to organizing Issues and Runs |
| Automation | Project Automation and local schedules | Merge definitions and trigger protocols |

## Required domain invariants

1. Workspace is the only tenant boundary for members, permissions, and shared
   capabilities.
2. Every Project belongs to one Workspace.
3. Every Issue belongs to one Project and inherits its Workspace.
4. A Member is either a Human or an Agent; Devices and Executors cannot be
   Assignment targets.
5. Team is the only cloud Agent definition; a single Bot is exposed through a
   single-Bot Team.
6. A Project-private Agent still belongs to Workspace and is restricted only
   through scope and Project Binding.
7. Assignment produces notification and a request for action, not execution
   permission or an exclusive lock.
8. Any Project Member with execution permission may start a Run without being
   assigned.
9. ProjectChatAgent must not duplicate Agent identity, capabilities, or complete
   runtime configuration.
10. Every machine execution creates a Run before creating a backend execution
   record.
11. A Run binds to one execution backend but may contain multiple backend turns
   or subtasks.
12. Run, Project, and Issue `workspace_id` values must agree and be enforced by
   the database or service layer.
13. A Workflow Node cannot become a third task type independent of Issue and
    Run.
14. Plugin permissions, versions, and configuration must enter an immutable
    execution snapshot.
15. An Executor may run an Agent only when the Agent requirements match the
    Runtime capabilities.

## Evolution order

1. Add Workspace and migrate existing CloudProjects into default Workspaces.
2. Standardize CloudProject as Project in product terminology and make the
   board its default View.
3. Extend Workspace Member into a common Human/Agent assignable actor.
4. Use Team as the only Agent definition and reduce ProjectChatAgent to a
   Project binding.
5. Add Plugin references and effective capability manifests to Ghost.
6. Converge LoopItemExecution into the only Run envelope.
7. Unify Runtime capability discovery and execution-backend protocols.
8. Migrate local Wework Codex execution afterward so it does not introduce a
   second Agent or Run model.
