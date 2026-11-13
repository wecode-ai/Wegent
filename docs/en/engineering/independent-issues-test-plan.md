---
sidebar_position: 42
---

# Independent Issues and collaboration navigation acceptance

## Environment and data

Use the unified desktop runner's isolated Electron, real Executor, Rust/Python hybrid backend, temporary MySQL and Redis. Only model services may use existing mocks. Every checkpoint creates its prerequisites independently and avoids personal projects and production tenants.

Arrange creator, invited participant and unrelated accounts. Only the creator has access to the target project. Read the real project catalog before and after independent Issue creation to prove no hidden project is created. The shared cloud fixture destroys test data; screenshots, logs and authentication state remain uncommitted test output.

## User stories

| Story                                                 | Steps                                                                                   | Expected and negative paths                                                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An employee starts a company-wide work item           | Collaboration → New Issue; enter title and description without selecting a project      | The Issue persists, project count is unchanged, invitations are initially empty, and other accounts receive 404 for details and comments                                                |
| A creator invites a colleague to help                 | Edit → search colleagues → invite → assign → save                                       | The participant can read/comment and finds the Issue under assigned/participating, not created; deletion and new invitations remain creator-only                                        |
| A creator revokes sharing                             | Remove the participant and save                                                         | Their assignment is cleared; subsequent reads/comments/mutations are denied while historical comments remain                                                                            |
| A user finds relevant work                            | Open Assigned to me, Created by me and Participating                                    | Server filters before pagination, local identity aliases work, scope changes hide previous data, and late responses cannot overwrite the new scope                                      |
| A user archives and restores work                     | Archive → close → show archived independent Issues → open → restore                     | The archived record is discoverable and restoration returns it to active work; failures never appear as empty success                                                                   |
| A creator organizes work into a project               | Associate project → review permission warning → select → confirm                        | One transaction preserves the Issue/comments and allocates the project sequence; existing project detail opens; no automatic memberships are granted; target edit authority is required |
| A creator deletes unused work                         | Delete → confirm                                                                        | Participant deletion is denied; confirmed creator deletion prevents subsequent reads; cancellation leaves data unchanged                                                                |
| An existing user continues Home and project workflows | Open Home, its assistant workspace, and local/remote project trees                      | Reuse main's composer, assistant and detail tabs; projects are not duplicated and default/business space grouping retains main's behavior                                               |
| An administrator finds existing configuration         | Expand/collapse Collaboration management and open the four catalogs                     | Execution devices, Templates, Agents and Teams retain existing catalog permissions; no duplicate personal assistant sidebar entry is added                                              |
| Concurrent collaborators avoid lost updates           | Submit two writes with the same version; reuse a cursor across account/query boundaries | One write commits and the other conflicts; pagination has no duplicates/gaps; account, scope, order and archive changes reject the cursor                                               |

## Verification entry points

- Desktop stories: `pnpm --filter wework e2e:desktop --segment collaboration-personal-issues`.
- Existing project navigation: `collaboration-space-project-tree`; existing Home request/state isolation: `collaboration-home-preload`.
- Rust API: `cargo test --manifest-path backend-rs/Cargo.toml -p wegent-backend-rs --lib personal_issues`. The existing Backend Rust CI job explicitly invokes the real MySQL suite with `--ignored` against its shared MySQL service.
- Local pagination: `cargo test --manifest-path executor/Cargo.toml -p wegent-local-task-store my_work --lib`.
- Python cloud query: `cd backend && uv run pytest tests/services/test_my_work_pagination.py tests/test_collaboration_permission_guard.py`.
- Focused frontend coverage protects navigation, Home, created-scope pagination, request isolation, late responses and refresh-failure retention.

Actual command results and CI in the PR are the execution record. This plan does not itself prove desktop verification. Preserve original failure logs, establish the cause, and fix it without reruns for a pass, general timeout increases or weaker assertions.

## Parallel test performance evidence

Renderer and Electron tests remain parallel. Electron reuses `run-with-resource-logging.mjs` for runner CPU, memory and I/O pressure, with Node filesystem tracing and `node-async-resource-diagnostics.mjs` recording pending filesystem requests, slow requests, event-loop delay and CPU time inside each test worker. Immediate JSONL writes retain evidence before Vitest terminates workers; file paths, arguments and contents are omitted. Evidence uses the existing `wework-test-evidence` CI artifact. Test outputs are not committed, and larger timeouts or retries do not replace root-cause analysis.
