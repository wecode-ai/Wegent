---
sidebar_position: 1
---

# Wework Project Workspace Selection

## Context

Wework's new task composer still behaves like the old single-device Project
model. The current project work dropdown can show a Project and a standalone
device, but it does not represent the runtime local work model:

```text
Project
  Device Workspace
    LocalTask
```

This creates two product problems:

- Users cannot reliably choose the new multi-device Project entries.
- A Project can map to different local directories on different devices, but
  the composer does not show which Device Workspace will run the new task.

It also creates a security boundary issue. A task creation request must not
trust a path submitted by the frontend. The UI may display a path as context,
but Backend must resolve the actual `deviceId + workspacePath` from a
server-owned Device Workspace mapping.

## Goals

- Keep the composer as a single compact "project work" entry point.
- Let users choose the exact Project Device Workspace before starting a runtime
  LocalTask.
- Avoid showing an unnecessary device sublevel for Projects that only have one
  mapped Device Workspace.
- Require explicit workspace confirmation whenever a Project has multiple
  mapped Device Workspaces, even if only one is currently online.
- Prevent task creation from accepting arbitrary frontend `workspacePath`
  values.
- Reuse the runtime local work API model instead of reviving legacy
  `project.config.device_id` behavior.

## Non-Goals

- Do not redesign the whole composer.
- Do not change LocalTask identity. Runtime tasks are still identified by
  `deviceId + localTaskId`.
- Do not introduce a new visible sidebar level for every Device Workspace.
- Do not implement cross-device task fork behavior here.
- Do not allow frontend-provided filesystem paths to select execution
  directories.

## Interaction Model

The existing `ProjectWorkBar` remains a single button under the composer. The
button opens a searchable menu whose options are Project-oriented:

- A Project with exactly one mapped Device Workspace appears as one selectable
  row.
- A Project with more than one mapped Device Workspace appears as an expandable
  row.
- Expanding a multi-workspace Project reveals its Device Workspace rows.
- The user must choose one Device Workspace row before the composer can start a
  task for that Project.

The workbar label reflects the current state:

- No selection: `进入项目工作`
- Single-workspace Project selected: `<Project> · <Device>`
- Multi-workspace Project expanded but not confirmed:
  `<Project> · 选择工作区`
- Device Workspace selected: `<Project> · <Device>`
- Standalone non-project workspace selected: existing "不使用项目" behavior,
  but it should still be backed by a server-known runtime workspace when a task
  starts.

If the user tries to send while a multi-workspace Project is selected but no
Device Workspace has been confirmed, Wework blocks sending and shows a concise
error: `请选择任务运行位置`.

## Workspace List Behavior

Project rows are built from `RuntimeWorkListResponse.projects[].deviceWorkspaces`.
Frontend should not infer project availability from `project.config.device_id`
when runtime work data is available.

For each Project:

- If `deviceWorkspaces.length === 0`, show the Project as unavailable with an
  action to bind a workspace.
- If `deviceWorkspaces.length === 1`, show one selectable Project row. Selecting
  it selects that Device Workspace.
- If `deviceWorkspaces.length > 1`, show an expandable Project row. Selecting
  the Project row opens the workspace list instead of selecting a default.

Device Workspace rows show:

- Device display name.
- Online, busy, offline, or upgrade-required status.
- A short path label for orientation only.
- Optional workspace kind, such as current workspace or worktree.

Disabled workspaces remain visible when offline, incompatible, or requiring an
executor upgrade. They are not selectable, but they explain why a Project has
more than one mapped location.

## Default Selection Rules

The design intentionally avoids implicit selection for multi-workspace Projects:

- A Project with one mapped Device Workspace can be selected directly.
- A Project with multiple mapped Device Workspaces never auto-selects one.
- This remains true when only one of the mapped workspaces is currently online.

This avoids silently running work on the wrong machine or wrong checkout after
users add more than one Project mapping.

## Trusted API Boundary

Task creation must use a server-owned mapping identifier.

Add `deviceWorkspaceId` to `RuntimeTaskCreateRequest`:

```ts
interface RuntimeTaskCreateRequest {
  projectId?: number
  deviceWorkspaceId?: number
  teamId: number
  runtime: RuntimeName
  message: string
  title?: string
  modelId?: string
  modelType?: ModelType | null
  modelOptions?: Record<string, string>
  additionalSkills?: SkillRef[]
  attachmentIds?: number[]
  execution?: ChatSendPayload['execution']
}
```

For Project-backed runtime task creation, the frontend sends
`projectId + deviceWorkspaceId`. Backend validates that:

- The Project belongs to the current user and has `client_origin = wework`.
- The Device Workspace belongs to the current user.
- The Device Workspace belongs to the requested Project.
- The target device belongs to the current user.
- The target device is online or otherwise allowed by runtime execution rules.
- The mapping's stored `workspacePath` is non-empty and normalized.

Only after these checks does Backend resolve the trusted `deviceId` and
`workspacePath` and call executor RPC `runtime.tasks.create`.

Frontend may display `workspacePath` from the list response as read-only UI
context, but it does not submit the path as authority for Project task creation.

## Legacy Project Config Handling

Some existing Projects may still carry a single-device workspace in
`project.config.execution.deviceId` and `project.config.workspace`.

Runtime work list generation should normalize this into the same Device
Workspace shape by materializing a real Device Workspace mapping. This can
happen when runtime work is listed, when the Project is edited, or through a
small migration path.

The composer should only allow selecting legacy-configured Projects after
Backend can return a real `deviceWorkspaceId`. If Backend cannot materialize the
mapping, the Project should be shown as requiring workspace binding instead of
falling back to frontend-submitted path data.

After this normalization, composer selection logic should not branch on legacy
Project config.

## Data Flow

1. Wework loads `GET /api/runtime-work?client_origin=wework`.
2. Backend returns Projects with mapped Device Workspaces.
3. The composer menu renders Project rows and Device Workspace rows.
4. User selects a Device Workspace, either directly through a single-workspace
   Project row or explicitly under a multi-workspace Project.
5. Wework stores the selected Project and `deviceWorkspaceId` in composer state.
6. On send, Wework calls `POST /api/runtime-work/create` with
   `projectId + deviceWorkspaceId` and the message/model payload.
7. Backend validates the mapping and resolves the trusted device directory.
8. Backend calls device RPC `runtime.tasks.create` with `workspacePath` from the
   mapping.
9. The returned LocalTask opens by `deviceId + localTaskId`; URL and IM
   notification identity do not include `workspacePath`.

## Component Changes

`ProjectWorkBar` should evolve from project/device selection into a Project
Workspace selector:

- Accept `runtimeWork` or a precomputed Project Workspace view model.
- Track pending expanded Project separately from confirmed selected workspace.
- Render single-workspace Projects as direct choices.
- Render multi-workspace Projects as expandable groups.
- Preserve existing actions for adding a Project and not using a Project.
- Add a bind-workspace action for Projects with no mapped workspaces or when the
  user wants to add another device directory.

`WorkbenchProvider` should track the selected Project Workspace target for new
runtime tasks:

- `currentProject` still represents Project context.
- A new selection field should store `deviceWorkspaceId` for the composer.
- Sending a new runtime task uses `deviceWorkspaceId` instead of passing a
  frontend path.
- Opening an existing LocalTask continues to use `RuntimeTaskAddress`.

`ProjectCreateDialog` and Project edit flows already prepare Device Workspace
mappings. The composer should reuse that flow when the user chooses to bind a
new workspace from the dropdown.

## Error Handling

- No mapped workspace: disable task start and offer `绑定设备工作区`.
- Multiple workspaces but none selected: block send with `请选择任务运行位置`.
- Selected mapping disappears after refresh: clear the workspace selection and
  keep the Project expanded.
- Selected mapping becomes offline: keep it visible but disable send until a
  selectable workspace is chosen.
- Backend rejects mapping ownership or Project mismatch: show the backend error
  and refresh runtime work lists.
- Backend cannot resolve a legacy Project mapping: show the Project as requiring
  workspace binding.

## Testing

Focused coverage should include:

- `ProjectWorkBar` renders single-workspace Projects as one row.
- Multi-workspace Projects expand and require choosing a Device Workspace.
- A multi-workspace Project with one online workspace and one offline workspace
  still requires explicit selection.
- Disabled workspace rows are visible but not selectable.
- Sending without a confirmed workspace is blocked.
- Runtime task creation sends `projectId + deviceWorkspaceId`, not
  `workspacePath`, for Project-backed tasks.
- Backend rejects a `deviceWorkspaceId` that belongs to another user or another
  Project.
- Backend resolves the trusted `workspacePath` from the stored mapping before
  calling `runtime.tasks.create`.
- Legacy single-device Projects are surfaced as Device Workspace entries before
  they can be selected in the composer.
