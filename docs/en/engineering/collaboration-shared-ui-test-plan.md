---
sidebar_position: 25
---

# Collaboration shared UI cross-host E2E and acceptance plan

Audit date: 2026-09-10

## Objective

This plan must prove more than “both hosts appear to work”:

1. Wegent Web and Wework mount the same collaboration root component exported by
   `@wegent/collaboration`.
2. Both hosts expose the same page structure, interaction flows, state semantics, and backend
   capabilities for cloud project spaces.
3. Host differences exist only through explicit host adapters or capabilities. Cloud business
   logic, state management, and views must not be reimplemented under host directories.
4. Wework may retain desktop-only adapters for local projects, terminals, and native file
   selection, but those adapters must not replace or alter the shared cloud primary flow.
5. My Work and its default board must remain available through the same shared implementation on
   both hosts.

This document plans additive tests and merge gates only. Existing E2E coverage must not be edited,
weakened, or replaced.

## Current-state audit

### Mount structure

The current code does not prove shared UI:

- `frontend/src/features/collaboration/CollaborationPage.tsx` mounts `CollaborationApp` from
  `@wegent/collaboration`.
- `wework/src/features/todo/CollaborationWorkspace.tsx` mounts the local `CloudTodoWorkspace`.
- The hosts therefore use different UI roots. Sharing a backend does not satisfy the shared UI
  requirement.

### Web Playwright

`frontend/e2e/tests/collaboration/collaboration.spec.ts` currently contains two serial scenarios:

- Open Collaboration from the task sidebar and verify that the legacy `/inbox` route redirects to
  `/collaboration`.
- Through the real backend, create a project and Issue, update the title, add a comment, move the
  Issue with a button, and verify persistence after reload.

Missing coverage:

- My Work and its default board.
- The complete project home.
- Real pointer drag and drop.
- Complete Issue CRUD, attachments, assignee, due date, and tags.
- End-to-end member, file, automation, and settings operations.
- Role permissions, optimistic-lock conflicts, and cross-host updates.
- Deep links, back/forward navigation, invalid routes, and the full reload matrix.
- Structural proof that Web and Wework mount the same component.

### Wework desktop checkpoints

Existing Wework scenarios provide broad desktop regression coverage, but primarily bind to private
`cloud-*`, `cloud-todo-*`, and other desktop-specific test IDs:

| Existing checkpoint or flow        | Existing evidence                                                                                                    | What it does not prove                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `workspace-tabs`                   | Fixed project-space tab, default association, My Work context, no duplicate tab                                      | Web routing or a shared component mount                     |
| My Work flow in `task-status-sync` | Completed task appears in My Work; stale runtime state does not revive it                                            | Web My Work or complete view/filter parity                  |
| `offline-local-project-space`      | Local project creation, empty-board guide, Issue create/update/drag, and entry points for files, members, automation | Cloud parity or CRUD in those secondary views               |
| `board-focus-view`                 | Running state, grouping, focus view, column width, and state restoration                                             | Web parity or shared DOM structure                          |
| `project-automation`               | Extensive real-backend automation, workflow, execution, agent, settings, and conflict desktop flows                  | Web using the same automation UI or full base-module parity |
| `task-attachments`                 | Cloud delivery file tree, breadcrumbs, and preview                                                                   | Cross-host shared-file upload, rename, delete, and download |
| `project-assignment-notification`  | Assignment notifications and user isolation                                                                          | Role visibility and action permissions inside Collaboration |

These scenarios remain valuable, but they cannot prove cross-host shared UI because Web does not run
them and their selectors belong to the Wework implementation.

### First executable shared checkpoint

`.github/scripts/classify-wework-desktop-e2e.sh` and the CI shard matrix declare
`collaboration-shared-core`. The checkpoint now has a complete scenario, catalog registration, and
runner mapping, so the existing desktop E2E CI shard can execute it.

The initial scenario uses an isolated real Backend, creates its own project and multi-status Issues
through REST APIs, and verifies:

- entry into Collaboration from the Wework workspace tabs;
- the project home with real project data;
- the default grouped board in My Work;
- the original project header, view switcher, board, column, and card `data-testid` contract;
- fixture archival with the project's latest version after acceptance.

This checkpoint is the first regression skeleton for the Wework shared extraction. By itself it
does not prove that Web mounts the same root component and does not replace later cross-host
capability-parity or concurrency scenarios.

### `data-testid` audit

The shared package contains both the existing `collaboration-*` IDs and the `cloud-*`,
`cloud-todo-*`, project-home, and My Work IDs extracted from the original Wework interface. The
first `collaboration-shared-core` checkpoint intentionally asserts those stable existing IDs to
prove that extraction did not rewrite or remove the original interface.

The unified cross-host `collaboration-*` contract still lacks IDs for:

- shared-root identity, host identity, and route readiness;
- the same project-home and My Work nodes in Web;
- drag sources, drop zones, quick create, delete, and archive;
- member role controls and search submission;
- file rows, folders, preview, download, rename, and delete;
- automation list, editor, toggle, run-now, and run detail;
- individual settings fields, save, archive, and conflict messaging;
- permission explanations, read-only state, and error recovery;
- route restoration readiness;
- shared component identity and host capabilities.

## Acceptance principles

### Real backend

- Every capability scenario must make real REST requests and assert persisted server state.
- APIs may establish minimal prerequisites, but the user action under test must originate in the UI.
- Tests must not intercept a request and fabricate a successful response.
- Missing capabilities must fail instead of being skipped or accepted through graceful degradation.
- Playwright and the desktop runner retain zero retries; intermittent failures are defects.

### One semantic scenario

Web and Wework must consume the same scenario definitions, fixture builders, and semantic
assertions. A host driver may only:

- open the Collaboration entry;
- read the current URL or Wework tab location;
- perform host-level reload, back, forward, or tab reopen;
- invoke an explicitly host-only capability.

Project creation, project home, Issue drag, member management, files, automation, settings, and My
Work steps must not be copied into two business-flow implementations.

### Self-contained setup and cleanup

- Every new desktop checkpoint creates its own users, projects, members, Issues, files, and
  automation prerequisites.
- Single-checkpoint and from-checkpoint execution must both work.
- Projects, files, automations, and memberships are cleaned up with current versions in `finally`
  blocks or runner teardown.
- Cleanup failure fails the test.

## Proposed test layers

### Layer 1: shared component contract

Add shared-package tests such as:

- `packages/collaboration/src/__tests__/shared-ui-structure.test.tsx`
- `packages/collaboration/src/__tests__/cloud-capability-contract.test.ts`

They must verify:

1. The package exports one production collaboration root, for example `CollaborationWorkspace`.
2. Its root contains:
   - `data-testid="collaboration-root"`;
   - `data-collaboration-component="CollaborationWorkspace"`;
   - `data-collaboration-contract-version="<fixed version>"`;
   - `data-collaboration-host="web|wework"`.
3. Host identity only affects adapter slots and capabilities, not the shared cloud view tree.
4. Given identical API fixtures, locale, location, and cloud capabilities, both hosts render the
   same normalized semantic tree.
5. Normalization compares element tags, roles, `data-testid`, `aria-*`, and enabled state while
   excluding host chrome, generated IDs, and platform fonts.
6. Cloud capabilities are identical. Only explicit desktop capabilities such as local projects,
   terminals, or native file selection may differ.

### Layer 2: static host-boundary gate

Add an architecture test or script, for example:

- `packages/collaboration/scripts/verify-host-boundaries.mjs`

It must assert:

1. Both host integrations import the same root export from `@wegent/collaboration`.
2. Host files may create API, route, notification, and platform-capability adapters only. They may
   not define board, Issue, member, file, automation, settings, or My Work views.
3. There is no second cloud collaboration root under `frontend/src/features/collaboration/**` or
   `wework/src/features/todo/**`.
4. Hosts do not duplicate shared API paths, state transitions, optimistic updates, conflict
   handling, or permission rules.
5. Shared cloud `data-testid` values are defined only by the shared package. Hosts may define shell
   IDs only.
6. Both manifests resolve the same workspace instance of `@wegent/collaboration`.

Static checks and runtime DOM identity must both pass. Matching test IDs alone are insufficient
because duplicated implementations can forge them.

### Layer 3: cross-host cloud parity E2E

Create one host-independent scenario definition, for example:

- `packages/collaboration/e2e/cloud-parity-scenarios.ts`

Execute it through thin drivers:

- Web: `frontend/e2e/tests/collaboration/shared-cloud-parity.spec.ts`
- Wework: `wework/e2e/desktop/scenarios/collaboration-cloud-parity.scenario.mjs`

Add a standalone Wework checkpoint named `collaboration-cloud-parity` and register it in:

- `wework/e2e/desktop/checkpoints.mjs`;
- `wework/e2e/desktop/run-checkpoints.mjs`;
- desktop E2E CI classification and sharding;
- classification-script tests.

Do not modify existing `workspace-tabs`, `offline-local-project-space`, `board-focus-view`,
`project-automation`, or any other existing E2E.

### Layer 4: cross-host consistency and concurrency

Add a scenario that uses one real backend and operates Web and Wework against the same fixture. If
CI cannot run both hosts concurrently, use two ordered phases with one uniquely identified fixture:

1. Web creates or edits data and records the server version.
2. Wework opens the same project and verifies it.
3. Wework edits the data.
4. Web reloads or receives an event and verifies the edit.
5. Both hosts submit a stale version and verify `409` recovery.

Two independent suites with the same name do not prove cross-host consistency. At least one
scenario must operate on the same project and Issue from both hosts.

## Unified `data-testid` contract

After migration, cloud flows use `collaboration-*` on both hosts. Minimum recommended IDs:

| Area                    | Required IDs                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root                    | `collaboration-root`, `collaboration-project-home`, `collaboration-route-ready`                                                                                                                                                                         |
| My Work                 | `collaboration-my-work`, `collaboration-my-work-board`, `collaboration-my-work-filter`, `collaboration-my-work-item-{id}`                                                                                                                               |
| Project home            | `collaboration-project-list`, `collaboration-project-create`, `collaboration-project-{id}`, `collaboration-home-my-work`, `collaboration-home-manage`                                                                                                   |
| Board                   | `collaboration-board`, `collaboration-board-search`, `collaboration-board-group-by`, `collaboration-column-{status}`, `collaboration-column-dropzone-{status}`, `collaboration-issue-{id}`                                                              |
| Issue                   | `collaboration-issue-create`, `collaboration-issue-detail`, `collaboration-issue-save`, `collaboration-issue-archive`, `collaboration-issue-delete`, `collaboration-issue-close`                                                                        |
| Members                 | `collaboration-members`, `collaboration-member-search`, `collaboration-member-search-submit`, `collaboration-member-add-{id}`, `collaboration-member-role-{id}`, `collaboration-member-remove-{id}`                                                     |
| Files                   | `collaboration-files`, `collaboration-file-upload`, `collaboration-folder-create`, `collaboration-file-{id}`, `collaboration-file-preview-{id}`, `collaboration-file-download-{id}`, `collaboration-file-rename-{id}`, `collaboration-file-delete-{id}` |
| Automation              | `collaboration-automation`, `collaboration-automation-create`, `collaboration-automation-{id}`, `collaboration-automation-save`, `collaboration-automation-toggle-{id}`, `collaboration-automation-run-{id}`, `collaboration-automation-run-detail`     |
| Settings                | `collaboration-project-settings`, `collaboration-settings-name`, `collaboration-settings-visibility`, `collaboration-settings-statuses`, `collaboration-settings-save`, `collaboration-project-archive`                                                 |
| Permission and conflict | `collaboration-readonly-reason`, `collaboration-forbidden`, `collaboration-conflict`, `collaboration-reload-latest`                                                                                                                                     |

Rules:

- Dynamic IDs use stable backend IDs, never array indexes or translated text.
- The same cloud control uses the same ID on both hosts.
- Host shell IDs use `web-collaboration-host-*` or `wework-collaboration-host-*` and cannot impersonate
  shared controls.
- Legacy `cloud-*` IDs may temporarily coexist on the same shared node while historical E2E remains
  intact. Compatibility must not render a second node or view. Their final removal requires a
  separate, evidence-backed migration of historical tests.

## Feature scenario matrix

Every section below runs the same business steps in the Web and Wework shared cloud parity suites.

### 1. My Work and the default board

Prerequisites:

- The user can access at least two projects.
- Assigned Issues exist in pending, in-progress, in-review, and completed states.
- Unassigned, unrelated, and inaccessible Issues also exist.

Steps and assertions:

1. Open My Work from Collaboration home.
2. The default board is visible; the UI must not fall back to an empty project list or create
   prompt.
3. Only accessible Issues relevant to the current user appear.
4. Status grouping, project filter, search, and view switching behave identically.
5. Open an Issue and return; preserve filters, scroll position, and selected view.
6. Complete an Issue and reload; it moves to completed and stale runtime state cannot revive it.
7. Open the host location for My Work directly and reload into the same view.

### 2. Project home

1. Show the project list, My Work shortcut, create-project action, and manage entry.
2. Create a cloud project and assert name, description, key, access role, and backend store.
3. The new project appears on both hosts without a second login or duplicate project.
4. A project card opens the same shared project home or board.
5. Search, ordering, or management filters restore correctly after reload.
6. Verify both empty and populated states; neither a Wework-only blank sidebar nor a Web-only
   reduced home is acceptable.

### 3. Board

1. A project opens on the shared board by default.
2. Assert columns, Issue counts, title, priority, assignee, tags, date, and permission state.
3. Search and clear the search to restore all cards.
4. Switch status, priority, assignee, and tag grouping; the other host reads the persisted config.
5. Use a real pointer/drag action to move a card to a target drop zone.
6. Assert optimistic placement, server status/sort order, and post-reload placement.
7. On server failure, roll back the card and show an error instead of retaining false success.
8. Long-list scrolling, empty-column quick create, and narrow layouts keep primary actions usable.

### 4. Issue CRUD, detail, and drag

1. Create an Issue with title, description, status, priority, assignee, due date, and tags.
2. The deep link opens the new Issue detail.
3. Edit all fields, assert a version increment, and read the same result from the other host.
4. Add a comment and attachment; both survive reload.
5. Delete the attachment and verify its removal from the server and both hosts.
6. Close and reopen detail from the card.
7. Change status and order through drag and drop.
8. Archive or delete the Issue; remove it from board, My Work, and valid deep links.
9. Cancelling delete confirmation sends no delete request.
10. A read-only user cannot activate mutation controls.

### 5. Members

Use Owner, Maintainer, Developer, Reporter, and non-member users.

1. Owner searches for and adds a user.
2. Change the member role and read the same role from the other host.
3. Remove the member and verify that project access is lost.
4. A regular role cannot demote or remove the Owner.
5. Maintainer behavior matches the backend contract.
6. Developer and Reporter cannot access member-management controls.
7. Backend rejection preserves the original list and shows an explicit error.

### 6. Files

This suite covers cloud shared files. Wework reveal/local-path actions remain separate host tests.

1. Create a folder and upload one text and one binary file.
2. Assert path, size, type, creator, and update time.
3. Navigate into the folder and back through breadcrumbs.
4. Preview previewable content; binary content exposes correct download or unsupported-preview UI.
5. Downloaded content matches the upload hash.
6. Rename files and folders; the other host reads the new path.
7. Delete a file; non-empty-folder behavior matches the backend contract.
8. Duplicate names, invalid paths, oversized files, and unauthorized uploads show deterministic
   errors.
9. Delivery assets and ordinary shared files remain distinct with the same cloud semantics on both
   hosts.

### 7. Automation and run history

The current shared `CollaborationApp` automation page is a capability placeholder. That is a P0
capability gap and cannot pass because an entry point exists.

1. Open the automation list and create a rule.
2. Configure trigger, conditions, execution nodes, agent/team, model, and workspace binding.
3. Save and assert the real backend definition.
4. Edit, enable, disable, and archive the rule.
5. Run now and assert the resulting run and related Issue/Task.
6. Open run detail and verify state, start/end time, and errors.
7. Reload and open the same rule and run from the other host.
8. Unsaved draft, leave confirmation, and version-conflict behavior are identical.
9. Non-managers see only permitted read-only information.

Existing `project-automation` coverage can continue to own complex editor details, but the shared
parity suite must cover the complete primary lifecycle.

### 8. Project settings

1. Edit name, description, visibility, and tags.
2. Add, rename, reorder, and remove statuses; select the processing status.
3. Change card-display fields.
4. Apply permitted cloud updates to GitHub, GitLab, and DingTalk AI Table provider settings.
5. Save, assert the server version, and read the result from the other host.
6. Archive the project and return to project home; neither host lists it as active.
7. Restricted roles cannot access or mutate protected fields.

### 9. Permissions and optimistic-lock conflicts

Minimum permission matrix:

| Role                          | Read project | Create/edit Issue    | Manage members       | Change settings | Manage automation |
| ----------------------------- | ------------ | -------------------- | -------------------- | --------------- | ----------------- |
| Owner                         | Yes          | Yes                  | Yes                  | Yes             | Yes               |
| Maintainer                    | Yes          | Yes                  | Per backend contract | Yes             | Yes               |
| Developer                     | Yes          | Yes                  | No                   | No              | No                |
| Reporter                      | Yes          | Per backend contract | No                   | No              | No                |
| Non-member of private project | No           | No                   | No                   | No              | No                |

Conflict scenarios:

1. Both hosts read the same project or Issue version.
2. Web saves first; Wework submits the stale version.
3. Wework receives `409`, shows the shared conflict message, and loads the latest server version.
4. Local fields must not silently overwrite server data. If product behavior preserves a draft, it
   must be explicit.
5. Repeat for project settings, Issue editing, and board reorder.
6. `403` or hidden projects expose no stale sensitive fields; `404` versus unauthorized behavior
   follows the backend anti-enumeration contract.

### 10. Routing and restoration

Web:

- `/collaboration`
- `/collaboration/{projectId}`
- `/collaboration/{projectId}?view=files|members|automation|runs|manage`
- `/collaboration/{projectId}/issues/{itemId}`
- reload, back, and forward;
- invalid project ID, invalid item ID, and unauthorized deep links;
- legacy `/inbox`.

Wework:

- open the top-level Collaboration tab;
- fixed project-space tab and project selection;
- close and reopen Collaboration;
- restore project, view, and Issue detail after app reload;
- open an Issue from a notification, task association, or project context;
- do not create duplicate project-space tabs;
- restore the My Work default board.

Common assertions:

- Both hosts provide the same `CollaborationLocation` to the shared component.
- Before location restoration finishes, show explicit loading rather than the wrong home.
- Exactly one `collaboration-root` exists after restoration.
- Back returns to the expected shared parent view, not a host default page.

## Structural parity assertions

At the start of every shared cloud parity run:

1. Exactly one `collaboration-root` exists.
2. Component name and contract version match.
3. Serialized cloud capabilities match between Web and Wework.
4. Capture a normalized semantic snapshot for project home, My Work, board, Issue detail, members,
   files, automation, and settings.
5. Shared regions must be identical. Differences are allowed only in predeclared host slots:
   - Wework local-project creation;
   - Wework terminal or local execution entry;
   - Wework native file/reveal actions;
   - Web URL/browser chrome;
   - Wework tab chrome.
6. Any new difference fails; tests must not auto-update the allowlist.
7. Screenshots are failure diagnostics only and cannot replace structural or server assertions.

Recommended read-only root metadata:

```html
<section
  data-testid="collaboration-root"
  data-collaboration-component="CollaborationWorkspace"
  data-collaboration-contract-version="1"
  data-collaboration-host="web"
></section>
```

Only `data-collaboration-host` may differ.

## Fixtures and data

Each suite creates a unique prefix such as `collab-parity-{runId}` and provisions:

- Owner A;
- Maintainer B;
- Developer C;
- Reporter D;
- non-member E;
- one private and one public cloud project;
- at least five statuses;
- Issues spanning every priority, assignee, and tag condition;
- one parent and one child Issue;
- one text file, one binary file, and one folder;
- one disabled and one runnable automation;
- at least one successful and one failed run.

The fixture builder returns IDs and current versions for projects, Issues, members, files, and
automations. Tests must not infer dynamic IDs from visible text.

## CI execution

### Web

The existing Chromium CI project must discover the new spec. A long cross-host scenario may use a
dedicated tag, but a CI job must invoke it explicitly.

Focused local command:

```bash
pnpm --dir frontend exec playwright test \
  e2e/tests/collaboration/shared-cloud-parity.spec.ts \
  --project=chromium
```

### Wework

Focused local command after checkpoint registration:

```bash
pnpm --dir wework e2e:desktop -- --segment collaboration-cloud-parity
```

CI must verify:

- checkpoint catalog, scenario map, and CI shard are consistent;
- changes to the shared package, Web host, Wework host, or shared scenario select both Web
  collaboration E2E and the Wework parity checkpoint;
- the checkpoint runs independently;
- failure evidence includes runner logs, DOM snapshots, request summaries, and failure screenshots.

### Shared-package change classification

Every `packages/collaboration/**` change triggers at least:

- shared package unit tests and typecheck;
- Web shared cloud parity;
- Wework `collaboration-cloud-parity`;
- static host-boundary verification.

Triggering only one host is not an acceptable merge gate.

## Implementation order

1. Add the static host-boundary test so the current two-root state fails explicitly.
2. Define the root identity, capability schema, and unified test-ID contract.
3. Add the shared scenario DSL and fixture builder, starting with project home, My Work, and board.
4. Add thin Web and Wework drivers and fix incomplete CI checkpoint registration.
5. Extend coverage through Issues, members, files, settings, and automation.
6. Add same-project cross-host writes and `409` conflicts.
7. Add normalized semantic-tree comparison and an explicit host-difference allowlist.
8. Keep all historical E2E. Evaluate legacy-selector migration in a separate, evidence-backed
   change after the shared flow is stable.

## Merge gate

The implementation may be called fully shared and cloud-capability-equivalent only when all of the
following are proven:

- Static boundary checks show both hosts importing one shared root and no second host-side cloud
  implementation.
- Runtime identity, contract version, and normalized shared semantic trees match.
- All ten feature areas pass from the same scenario definitions on Web and Wework.
- At least one cross-host scenario completes bidirectional writes and all three `409` recovery
  cases on the same project.
- Both hosts use the real backend and pass server persistence assertions.
- My Work default board, project home, files, and automation are present.
- Existing Wework desktop checkpoints and the existing Web collaboration spec remain green.
- `collaboration-cloud-parity` is registered in the catalog, runner, and CI with no ghost
  checkpoint.
- There are no silent skips, fallbacks, retry-to-green behavior, or automatically expanding
  structural-difference allowlists.

If any item is missing, the work remains a migration and cannot be declared complete.
