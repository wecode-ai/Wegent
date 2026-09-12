---
sidebar_position: 26
---

# Complete Collaboration Execution E2E Test Plan

Audit date: 2026-09-12

## Goals

This plan verifies the complete collaboration path from resource creation through real execution completion. It does not merely verify that a page is visible, configuration is saved, or a model returns text claiming that work is complete.

The suite must prove that:

1. Users can create or use collaboration resources from both Wegent Web and Wework.
2. A real Executor can register, report capabilities, be scheduled, and execute work.
3. Relationships among Workspace, Project, Issue, members, agents, and execution environments are persisted.
4. After an Issue is assigned to a Wegent Chat agent, its Skill and MCP are loaded, invoked, and produce a verifiable result.
5. After an Issue is assigned to a Wegent ClaudeCode agent, its Skill and MCP are loaded, invoked, and produce a verifiable result.
6. After an Issue is assigned to a Codex agent, its Skill, MCP, and Plugin are loaded, invoked, and produce a verifiable result.
7. After an Issue is assigned to a person, Wework receives a notification, the user creates a Task from the Issue, a real runtime executes it, an artifact is delivered, and the Issue status advances.
8. Execution failures, Executor outages, page refreshes, process restarts, and duplicate events neither fabricate success nor break eventual consistency.
9. Every critical step has structured assertions, backend evidence, and screenshot evidence.

## Audited Runtime Models

The three agent runtimes do not currently share one configuration model. E2E fixtures must not fabricate a unified abstraction that does not exist in the product.

### Wegent Chat and ClaudeCode

Chat and ClaudeCode use the Wegent CRD resource chain:

```text
Team
  -> Bot
    -> Ghost
      -> Skill references
      -> MCP servers
    -> Shell: Chat | ClaudeCode
    -> optional Model
```

- `Ghost` stores the prompt, Skill references, and MCP configuration.
- `Bot` combines a Ghost, a Shell, and an optional model.
- `Team` combines one or more Bots and defines their collaboration mode.
- After Task creation, the backend resolves Team, Bot, Ghost, Skill, and MCP data to build the real execution request.
- Chat Shell enters Chat Runtime.
- ClaudeCode Shell is scheduled through Executor Manager to a real Executor that starts Claude Code CLI.

### Codex

Codex is not currently a Wegent public Shell type and is not created through the Team → Bot → Ghost chain above.

Codex uses the Wework project-agent and local-runtime chain:

```text
ProjectChatAgent
  -> Wework Runtime
    -> Codex app-server / Codex CLI
      -> Skill
      -> MCP
      -> Codex Plugin
```

- A project agent is represented by `ProjectChatAgent`.
- Codex Skills, MCPs, and Plugins are materialized into an isolated Codex Home.
- A Plugin may provide a Skill, MCP, and other Codex extensions.
- E2E must verify the Wegent agent chain and the Wework Codex chain separately. It must not describe Codex as a nonexistent Wegent `Codex` Shell.

### Human

Assignment to a person does not immediately start an AI runtime:

```text
Issue assignment
  -> Wework notification
    -> User opens Issue
      -> User creates Task
        -> Wework Runtime executes Task
          -> Artifact / delivery
            -> Issue status projection
```

Assignment to a person first creates a notification and collaboration context. The user may enter the Issue from that notification, or proactively enter an unassigned Issue and create a Task.

## Test Boundary and Authenticity Rules

### Components that must be real

- Real Backend, database, and Redis.
- Real Wegent Web pages.
- Real Wework Electron application.
- Real Executor registration and heartbeat.
- Real Chat Shell, Claude Code CLI, and Codex Runtime.
- Real Workspace, Project, Issue, Task, message, activity, notification, and status projection data.
- Real Skill resolution, MCP tool calls, tool-output round trips, and Plugin materialization.

### Deterministic substitutes allowed at external boundaries

The upstream model and third-party MCP services may use deterministic test servers, but substitution must stop at the system boundary:

- The model server must record every request round and return real tool calls as required by the scenario.
- The MCP test server must record tool names, arguments, call order, and return values.
- Tests must not bypass Chat Shell, Claude Code CLI, Codex Runtime, Executor, or the backend state machine.
- Tests must not write directly to the database to manufacture execution success.
- Tests must not intercept frontend requests and fabricate successful responses.
- Tests must not pass solely because model text contains “completed.”

### Every checkpoint is self-contained

Each checkpoint must establish its own minimal prerequisites and support:

- isolated checkpoint execution;
- execution starting from that checkpoint;
- full-suite execution;
- isolated reproduction after failure.

A checkpoint must not depend on data created only by an earlier checkpoint that may be skipped.

## Test Resource Model

Every run uses a unique namespace or name suffix to prevent parallel shards from contaminating each other:

```text
Workspace: collaboration-e2e-<run-id>
Project: execution-project-<run-id>
Chat Team: chat-agent-<run-id>
Claude Team: claude-agent-<run-id>
Codex ProjectChatAgent: codex-agent-<run-id>
Executor: collaboration-executor-<run-id>
Issues:
  - CHAT-<run-id>
  - CLAUDE-<run-id>
  - CODEX-<run-id>
  - HUMAN-<run-id>
```

Each runtime uses distinct probe values so a result from one runtime cannot accidentally satisfy another runtime's assertions:

| Agent      | Skill probe             | MCP probe             | Plugin probe            |
| ---------- | ----------------------- | --------------------- | ----------------------- |
| Chat       | `CHAT_SKILL_<run-id>`   | `CHAT_MCP_<run-id>`   | Not applicable          |
| ClaudeCode | `CLAUDE_SKILL_<run-id>` | `CLAUDE_MCP_<run-id>` | Not applicable          |
| Codex      | `CODEX_SKILL_<run-id>`  | `CODEX_MCP_<run-id>`  | `CODEX_PLUGIN_<run-id>` |

The final artifact must contain the correct probe values and be proven through a file, backend activity, MCP call record, or delivery API.

## Complete Scenario Matrix

### E2E-01: Create collaboration resources in Wegent

Goal: prove that Wegent Web can create collaboration-domain resources and that they are persisted.

Steps:

1. Sign in to Wegent Web.
2. Open Collaboration.
3. Create a Workspace.
4. Create a Project in the Workspace.
5. Create or import a Chat Team:
   - select `Chat` as the Bot Shell;
   - configure a Skill on the Ghost;
   - configure MCP on the Ghost.
6. Create or import a ClaudeCode Team:
   - select `ClaudeCode` as the Bot Shell;
   - configure a Skill on the Ghost;
   - configure MCP on the Ghost.
7. Add both Teams to the available agent scope of the Workspace or Project.
8. Refresh and re-enter the pages to verify the resources remain present.
9. Read the Workspace, Project, Team, Bot, and Ghost through APIs and compare the persisted data.

Core assertions:

- Kind resources are read using the complete `namespace + name + user_id` identity.
- Each Bot references the expected Ghost and Shell.
- Each Team references the expected Bot.
- Each Ghost contains the expected Skill references and MCP configuration.
- The Workspace-to-Project relationship exists and both resources are active.
- UI state after refresh matches API state.

### E2E-02: Create and browse collaboration resources in Wework

Goal: prove that Wework creates and browses collaboration resources through Collaboration rather than the legacy My Tasks page or local mock data.

Steps:

1. Start an isolated Wework Electron application.
2. Sign in with the same test account.
3. Open the Collaboration tab.
4. Create a Workspace from All Workspaces.
5. Enter the Workspace and create a Project.
6. Browse members, agents, and execution environments on the Workspace resource page.
7. Open the Issue table and board in the Project.
8. Refresh the Wework page or restart its renderer.
9. Open the same Workspace and Project in Wegent Web.

Core assertions:

- Resources created in Wework are readable in Wegent Web.
- Resources created in Wegent are readable in Wework.
- Both hosts show the same resource IDs, names, statuses, and membership relationships.
- The Wework Collaboration tab mounts Collaboration; My Tasks remains a task view in the Tasks module.

### E2E-03: Register and recover a real Executor

Goal: prove that an execution environment is not static configuration but a schedulable, real Executor.

Steps:

1. Create an execution environment or generate a deployment command from the product UI.
2. Start a real Executor using the one-time registration credential from the command.
3. Wait for the Executor to register with the backend.
4. Verify heartbeat, version, platform, and capability reporting.
5. Add the execution environment to the test Workspace's available scope.
6. Stop the Executor and verify that it becomes offline.
7. Restart it with the same valid identity.
8. Verify that it returns online with consistent capability information.

Core assertions:

- The Executor ID matches the backend registration record.
- Online status comes from a real heartbeat, not local frontend state.
- Reported capabilities include those required by the target Shell or Runtime.
- An offline Executor must not receive new executions.
- The recovered Executor can receive subsequent work.

Daily CI may use registration data from the deployment command to launch the repository's real Executor binary directly. Container-image and full Docker-command validation may run as a lower-frequency deployment smoke test, but an in-memory fake Executor must never replace the execution chain.

### E2E-04: Assign an Issue to a Wegent Chat agent

Goal: prove that a Chat agent executes from Issue assignment through completion and actually loads its Skill and invokes its MCP.

Steps:

1. Create a Chat Issue in the Project.
2. Require the Issue to:
   - read a specified Skill;
   - call a specified MCP tool;
   - write the MCP result and Skill probe into its result.
3. Assign the work to the Chat Team from Issue activity.
4. Verify that the assignment event is persisted.
5. Wait for the backend Task and execution record.
6. Start a real execution through Chat Shell.
7. Have the deterministic model request the MCP tool.
8. Have MCP return `CHAT_MCP_<run-id>`.
9. Have the model apply the Skill instruction to produce the final result.
10. Wait for the Task, execution record, project message, and Issue AI state to become terminal.

Required proof:

- Scheduling uses the expected Team, Bot, Ghost, and Chat Shell.
- The initial model request contains the expected Skill content or locator.
- The model emits the expected MCP tool call.
- The MCP service receives the correct tool name and arguments.
- Non-empty tool output is included in the next model request.
- The final result contains `CHAT_SKILL_<run-id>` and `CHAT_MCP_<run-id>`.
- The backend Task is `COMPLETED`.
- Issue activity contains a completion message and AI state is completed.

### E2E-05: Assign an Issue to a Wegent ClaudeCode agent

Goal: prove that the ClaudeCode agent is scheduled to a real Executor and that Claude Code CLI loads a Skill, invokes MCP, and produces a file artifact.

Steps:

1. Create a Claude Issue in the Project.
2. Require the Issue to read a Skill, call MCP, and generate a result file in the workspace.
3. Assign the Issue to the ClaudeCode Team.
4. Verify that the backend selects an online Executor with ClaudeCode capability.
5. Start the real Claude Code CLI.
6. Have Claude Code read the Skill.
7. Have Claude Code invoke the MCP tool.
8. Have MCP return `CLAUDE_MCP_<run-id>`.
9. Have Claude Code write `claude-result.txt`.
10. Wait for Task, Runtime, and Issue projections to become terminal.

Required proof:

- Scheduling identity contains the expected Team, Bot, Ghost, Executor, and runtime task.
- Executor logs prove that a real Claude Code process started.
- Skill content enters the execution context.
- MCP tool call, input, output, and subsequent model context form a complete chain.
- `claude-result.txt` exists and contains both
  `CLAUDE_SKILL_<run-id>` and `CLAUDE_MCP_<run-id>`.
- Task and Runtime are completed.
- Issue status becomes in review or completed and does not remain running.

### E2E-06: Assign an Issue to a Codex project agent

Goal: prove that Codex loads a Skill, MCP, and Plugin through ProjectChatAgent and Wework Runtime.

Steps:

1. Create a Codex ProjectChatAgent in the current Workspace.
2. Create an isolated Codex Plugin containing:
   - `.codex-plugin/plugin.json`;
   - a Plugin Skill;
   - Plugin MCP configuration;
   - a unique Plugin probe.
3. Install or bind the Plugin to the isolated Codex Home used by that ProjectChatAgent.
4. Configure an additional Skill and MCP for the Codex agent.
5. Create a Codex Issue in the Project.
6. Assign the Issue to the Codex ProjectChatAgent.
7. Start a real Codex app-server or Codex CLI through Wework Runtime.
8. Have Codex discover the Plugin.
9. Have Codex read the Skill supplied by the Plugin.
10. Have Codex discover the Plugin MCP through the actual advertised-tool path: receive the namespaced tool directly below the deferred-loading threshold, or use tool search when tools are deferred.
11. Have Codex invoke the Plugin MCP and use its output in subsequent reasoning.
12. Have Codex generate `codex-result.txt` or an equivalent delivery.
13. Wait for the runtime Task and Issue status to become terminal.

Required proof:

- The scheduled object is a ProjectChatAgent, not a fabricated Wegent `Codex` Shell.
- The target Plugin files are materialized in Codex Home.
- The correct Skill locator appears in an initial request or tool output.
- Codex actually reads the target `SKILL.md`.
- Codex tool discovery matches the advertised-tool mode used by the run; corresponding E2E coverage exists for both direct advertisement and tool search.
- Codex invokes the namespaced Plugin MCP tool.
- MCP output appears in a subsequent model request.
- The artifact contains `CODEX_SKILL_<run-id>`,
  `CODEX_MCP_<run-id>`, and `CODEX_PLUGIN_<run-id>`.
- The Wework Task completes and Issue activity and status projections complete.

### E2E-07: Assign an Issue to a person and execute it in Wework

Goal: prove that human assignment creates a notification, execution, artifact, and status loop rather than merely writing an owner field.

Steps:

1. Have an assigner assign the Human Issue to the target user.
2. Verify creation of the backend notification and inbox record.
3. Verify that Wework shows a system notification and in-app unread indicator.
4. Click the notification and deep-link to the correct Workspace, Project, and Issue.
5. Click Create Task in the Issue.
6. Verify that the new Task retains Workspace, Project, and Issue context.
7. Submit execution instructions.
8. Execute the Task through a real local or cloud Wework Runtime.
9. Generate `human-result.txt` or an equivalent delivery.
10. Synchronize the artifact back to the Issue.
11. Complete the Task.
12. Move the Issue to in review or completed.

Required proof:

- Notification recipient, assignment event, and Issue ID are correct.
- Duplicate assignment events do not create duplicate notifications.
- Clicking the notification opens the exact Issue, not just the Collaboration home page.
- The new Task is bound to the correct Workspace, Project, Issue, and user.
- A real Runtime completes the execution.
- The artifact exists and can be read from Issue activity or the delivery area.
- Task terminal state and Issue status projection agree.

Additional scenario:

- A user who is not assigned may still proactively enter an Issue and create a Task.
- Proactive participation must not fabricate an “assigned to me” notification or assignment event.

### E2E-08: Cross-host consistency

Steps:

1. Create a Workspace, Project, and Issue in Wegent.
2. Open the same Issue in Wework and perform assignment.
3. Observe running status and activity in Wegent.
4. Let the agent or person complete the Task.
5. Refresh both hosts and read the final state.

Required proof:

- Resource IDs do not change.
- Activity ordering is consistent.
- Task, execution record, and Issue status agree.
- Either host can recover the current state after refresh or restart.
- A single completion event is not projected twice.

## Failure and Recovery Scenarios

### Executor offline

- Offline before assignment: the Task remains in an explainable waiting state and is never marked completed.
- Offline during execution: the execution record becomes failed, disconnected, or recoverable and preserves diagnostic information.
- Executor recovery: only eligible execution is resumed; two valid executions must not be created for the same work.

### Skill loading failure

- If the Skill is missing, its hash does not match, or its content is unreadable, execution must fail with an accurate reason.
- The runtime must not silently ignore the Skill and report success.

### MCP failure

- Verify unreachable MCP, missing tool, invalid arguments, and timeout separately.
- A tool-call failure must enter the model or Runtime error chain.
- Without valid tool output, the runtime must not produce an artifact that satisfies passing assertions.

### Plugin failure

- If the Plugin is not installed, its manifest is invalid, its Skill is missing, or its MCP is not registered, the Codex scenario must fail.
- After repair and reinstall, verify recovery with a new runtime Task.
- Do not reuse artifacts left by the failed run.

### UI and process recovery

- Wegent page refresh restores the Issue and execution state.
- Wework renderer reload restores the tab, Issue, and Task binding.
- Wework application restart restores unfinished Tasks without reviving stale runtime state as a new execution.
- Duplicate notifications, webhooks, or polling results remain idempotent.

### Permissions and isolation

- Non-Workspace members cannot read the Workspace.
- Non-Project members cannot perform restricted Project operations.
- One user's assignment notification cannot appear in another user's Wework.
- Plugin, Skill, MCP, and Codex Home data from one run cannot contaminate another run.

## Unified Execution Evidence

Every agent execution scenario must collect the following four layers of evidence.

### 1. Scheduling identity

Record and assert all applicable fields:

```text
workspaceId
projectId
issueId
assignmentId or assignment event id
teamId
botId
ghostId
projectChatAgentId
backendTaskId
runtimeTaskId
executorId
executorType
runtimeDeviceId
```

Identity fields must come from backend APIs, execution records, or Runtime logs, not be inferred from UI text.

### 2. Backend and runtime terminal states

Assert at least:

```text
Task status == COMPLETED
Runtime execution status == completed
Project message status == completed
Project message metadata.run_status == completed
Issue ai_state.status == completed
Issue status == in_review | completed
```

If a runtime does not have one of these fields, document the mapping and assert that runtime's authoritative terminal field.

### 3. Tool call and output

The complete chain must be present:

```text
Skill locator or content enters runtime
  -> model emits expected tool_call
    -> MCP receives expected tool name and input
      -> MCP returns non-empty tool_output
        -> next model request contains the tool_output
```

Seeing only a tool inventory, a button, saved MCP configuration, or model text that mentions a tool is not sufficient.

### 4. Non-forgeable side effect

Every execution must verify at least one side effect that cannot be fabricated by model text:

- a real file in the workspace with exact content;
- an exact call record received by the MCP test server;
- persisted Issue activity, comment, or delivery in the backend;
- persisted Wework Task binding and completion state;
- a notification-service record for the target user.

Verifying both a file and a backend record is recommended to avoid a single-source false positive.

## Screenshot Evidence Chain

Screenshots are saved under test-result directories or CI artifacts and are never committed to the repository. Filenames must include sequence, host, scenario, and state.

### Shared resources and Executor

1. `01-wegent-workspace-created.png`: newly created Workspace in Wegent.
2. `02-wegent-project-created.png`: newly created Project in Wegent.
3. `03-wegent-agents-configured.png`: Chat and ClaudeCode agents with configuration summaries.
4. `04-wework-workspace-visible.png`: the same Workspace visible in Wework.
5. `05-wework-project-visible.png`: the same Project visible in Wework.
6. `06-executor-deploy-command.png`: execution-environment deployment entry and generated command, with credentials redacted.
7. `07-executor-online.png`: real Executor online with reported capabilities.

### Chat execution

8. `08-chat-issue-created.png`: Chat Issue detail.
9. `09-chat-assigned.png`: Chat assignment event in Issue activity.
10. `10-chat-running.png`: Chat execution in progress.
11. `11-chat-completed.png`: completion activity, probe result, and Issue terminal state.

### ClaudeCode execution

12. `12-claude-issue-created.png`: Claude Issue detail.
13. `13-claude-assigned.png`: ClaudeCode assignment event.
14. `14-claude-running.png`: ClaudeCode running on the Executor.
15. `15-claude-artifact.png`: real file artifact preview.
16. `16-claude-completed.png`: Issue terminal state.

### Codex execution

17. `17-codex-agent-plugin.png`: ProjectChatAgent, Skill, MCP, and Plugin configuration.
18. `18-codex-issue-created.png`: Codex Issue detail.
19. `19-codex-assigned.png`: Codex assignment event.
20. `20-codex-plugin-loaded.png`: Plugin, Skill, and MCP loading evidence in runtime detail.
21. `21-codex-artifact.png`: real artifact containing all three probes.
22. `22-codex-completed.png`: Task and Issue terminal states.

### Human execution

23. `23-human-assignment-notification.png`: assignment notification received in Wework.
24. `24-human-notification-center.png`: target Issue in Notification Center.
25. `25-human-issue-opened.png`: correct Issue opened after clicking the notification.
26. `26-human-task-created.png`: Task created and bound from the Issue.
27. `27-human-task-running.png`: real Runtime executing the Task.
28. `28-human-artifact.png`: artifact generated and synchronized.
29. `29-human-issue-completed.png`: final Task and Issue states.

### Recovery and cross-host state

30. `30-executor-offline.png`: Executor offline state.
31. `31-executor-recovered.png`: Executor restored online.
32. `32-wegent-final-state.png`: final state in Wegent.
33. `33-wework-final-state.png`: final state in Wework.

Screenshot review must verify:

- The sequence is continuous and no later screenshot substitutes for an earlier step.
- Workspace, Project, and Issue names or IDs connect the images into one chain.
- No credentials, tokens, private user data, or sensitive local paths are visible.
- Screenshot states agree with structured logs.
- Static demos, legacy pages, and stub pages are not used as product evidence.

## CI Checkpoint Mapping

Prefer extending and reusing existing checkpoints instead of duplicating deployment, Plugin, or runtime frameworks.

| Capability                                 | Existing checkpoint / suite                      | Target change                                                                                                       |
| ------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Wegent collaboration resource creation     | Frontend collaboration Playwright                | Add Workspace, Project, Chat/Claude resource creation and cross-host persistence assertions                         |
| Wework collaboration creation and browsing | `collaboration-shared-core`                      | Cover Wework resource creation, cross-host reads, and the shared collaboration primary flow                         |
| Executor registration                      | `remote-device-onboarding`                       | Reuse deployment command, real Executor startup, registration, and capability reporting                             |
| Executor lifecycle                         | `cloud-device-lifecycle`                         | Reuse offline, recovery, upgrade, and reconnect assertions                                                          |
| Chat Issue assignment and execution        | `project-automation` + provider-native Chat E2E  | Extract shared fixtures and close the loop from Ghost Skill/MCP configuration through project assignment completion |
| ClaudeCode Skill/MCP execution             | provider-native ClaudeCode E2E                   | Connect Workspace/Project/Issue assignment while preserving real CLI and file-artifact assertions                   |
| Codex Skill/MCP/Plugin                     | Wework Plugin E2E + project automation           | Connect ProjectChatAgent assignment and reuse real Plugin materialization and multi-turn tool-call evidence         |
| Human assignment and notification          | `project-assignment-notification`                | Extend through notification deep link, Task creation, real execution, artifact, and Issue terminal state            |
| Wework Task and Issue status sync          | `task-status-sync` + `collaboration-shared-core` | Reuse Task binding and status-projection assertions                                                                 |
| Wework Claude Runtime regression           | `claude-runtime`                                 | Keep as an independent real local/cloud Claude CLI regression; it does not replace the project-assignment scenario  |

CI requirements:

- Every new scenario must be invoked by an existing GitHub CI suite or checkpoint.
- A local-only debug command without CI registration is not acceptable.
- Long desktop flows must expose checkpoints through the shared runner.
- The classifier must map collaboration, assignment, ProjectChatAgent, Plugin, Skill, MCP, Executor, and status-sync changes to the corresponding shards.
- Default retry count is zero. Intermittent failures are defects and must not be hidden by reruns.
- Screenshots, structured logs, model requests, MCP calls, and Runtime logs are uploaded together as diagnostic artifacts.

## Fixture and Reuse Rules

Before adding tests, extract and reuse the following capabilities so that existing monolithic scenarios do not keep growing:

```text
createWorkspace
createProject
createTeamBotGhost
createProjectChatAgent
registerRealExecutor
createIssue
assignIssue
waitForBackendTask
waitForRuntimeExecution
assertSkillLoaded
assertMcpRoundTrip
assertPluginLoaded
assertExecutionIdentity
assertExecutionTerminalState
assertArtifact
archiveProjectAndWorkspace
```

Fixtures only establish prerequisites. The critical user action under test must still be performed through the relevant product UI.

Chat, ClaudeCode, and Codex may share execution-evidence assertion interfaces, but they must not share a fabricated resource-creation interface:

- Chat and ClaudeCode fixtures create Team, Bot, and Ghost resources.
- Codex fixtures create ProjectChatAgent and an isolated Codex Runtime.
- The shared layer describes execution evidence only and does not erase the different runtime models.

## Cleanup Order

Run idempotent cleanup on both success and failure:

1. Cancel all still-running Tasks and runtime tasks.
2. Wait for execution to become terminal so background processes stop writing data.
3. Stop Executors started by the current run.
4. Delete isolated Codex Homes, Plugin caches, and temporary workspaces.
5. Delete or archive test Issues and their deliveries.
6. Enumerate and archive every active Project in the Workspace.
7. Archive the Workspace.
8. Delete test Teams, Bots, Ghosts, ProjectChatAgents, models, and MCP configurations.
9. Stop Electron, Backend, Redis, model server, and MCP test server.
10. Preserve failure logs and screenshot artifacts without committing them to Git.

All active Projects must be archived before the Workspace is archived. Authorization relationships from historically archived Projects should not block Workspace cleanup.

## Passing Criteria

The complete collaboration execution E2E suite passes only when all criteria below are satisfied.

### Resources

- Workspace, Project, and Issue resources created in Wegent and Wework are mutually readable.
- Team, Bot, Ghost, ProjectChatAgent, and Executor relationships follow their actual respective models.
- Resources persist after page refresh and application restart.

### Executor

- At least one real Executor completes registration, capability reporting, task execution, offline transition, and recovery.
- Runtime logs correlate to concrete backend and runtime Task IDs.

### Chat

- The Chat Team's Ghost Skill is loaded.
- The Chat Team's MCP is actually invoked.
- Tool output enters the next model request.
- Task, project message, and Issue status complete.
- A non-forgeable side effect exists.

### ClaudeCode

- The ClaudeCode Team's Ghost Skill is loaded.
- MCP is invoked by a real Claude Code CLI.
- A real Executor generates the exact file artifact.
- Task, Runtime, and Issue status complete.

### Codex

- The execution target is ProjectChatAgent/Wework Runtime.
- Skill, MCP, and Plugin are all loaded by a real Codex Runtime.
- Plugin MCP is actually invoked and its output enters the next request.
- A real artifact contains all three independent probes.
- Task and Issue status complete.

### Human

- Wework receives a real assignment notification for the target user.
- Clicking the notification opens the correct Issue.
- A Task created from the Issue preserves complete collaboration context.
- A real Runtime completes the Task and generates an artifact.
- The artifact is synchronized to the Issue and Task and Issue states agree.

### Evidence

- Every scenario contains scheduling identity, authoritative terminal state, tool call/output, and a non-forgeable side effect.
- The core-flow screenshot chain is complete and passes manual review.
- Screenshots and diagnostic files are retained only as local or CI artifacts and never enter the repository.
- Every scenario is invoked by GitHub CI and passes with zero retries.

Any scenario that proves only “configuration exists,” “page is visible,” “the model says it completed,” or “the test passed without a real side effect” is considered not passed.
