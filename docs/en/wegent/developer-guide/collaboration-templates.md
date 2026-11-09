---
sidebar_position: 36
---

# Collaboration templates

Wework exposes discovery under Collaboration → Templates. Wegent exposes the same
discovery UI in its capability marketplace. Both use
`packages/collaboration/src/templates` and the same Backend data.

## Use a marketplace template

Open a template under Capabilities → Templates and choose “Use template” to select an
existing project or create a new one. Built-ins need no additional account installation;
public templates use the existing installation protocol when their configuration is downloaded.
The picker lists active projects managed by the account. Selecting one rechecks current
management access before role and group-name confirmation. Successful application opens
the project board while preserving existing tasks, groups and views.

New projects inherit the template name, description, roles and workflow, using the existing
space picker and space creation flow. New Web projects containing template Agents use the account’s
designated default executor and its unique default model for each required runtime;
they never choose an arbitrary device or model. The default executor must be online;
APP devices are supported when the Backend can access their model catalogs. New-project forms require
explicit execution-environment selection and explain that selected environments are shared
with the chosen space and authorized for the project. Missing consent, devices or models
preserves the form for correction before project creation. Existing-project confirmation lists
online devices already authorized for the project, regardless of the account default. A sole
device is selected automatically; users choose between multiple devices without changing their
account default. Listing reads device inventory only; submission rechecks online status,
authorization and runtime default models. When devices are unavailable or inventory loading
fails, users can open project device settings in a new tab, return and refresh to continue with
their group names and role edits preserved. Import does not grant space or project device access.
Saving, collecting and previewing templates
does not perform these operations.
Local projects use their local execution environment without calling cloud space-sharing
or project device-grant APIs.

## Storage and access

Templates are `kinds` rows with `kind: Template` and `spec.category: collaboration`.
Their complete identity is `user_id + namespace + name`. Official definitions use
owner `0` and namespace `system`; personal definitions use the authenticated owner
and namespace `default`. Legacy inbox-template APIs cannot read, update, or
instantiate collaboration templates.

Publication reuses the resource-library protocol with `resource_type=template`,
`spec.capability`, and the existing `marketplace_resources` discovery index.
Installation creates a `resource_members` reference with `resource_type=Template`,
without copying the source Kind. Personal references and accessible namespace
references grant access. Every download checks current authorization. Saving a
personal template does not publish it.
Downloads reuse an existing account or namespace reference rather than installing
again. Withdrawing publication preserves access for users who retain a reference.

## Configuration API

New routes are Rust-owned and selected in `backend-rs/config/routes.toml`:

| Method and path                              | Purpose                                       |
| -------------------------------------------- | --------------------------------------------- |
| `GET /api/v1/collaboration-templates`        | Available metadata, without full definitions  |
| `GET /api/v1/collaboration-templates/{id}`   | Authorized portable definition                |
| `PUT /api/v1/collaboration-templates/{name}` | Save in the current owner's default namespace |

Saves contain `document` and `expectedRevision`. Creation uses `null`; an update
requires the current revision and a new `spec.version`. Stale revisions return 409.
Identical repeated saves return the same Kind. The server owns
`spec.configurationRevision`, which is excluded from YAML. Marketplace template
versions always come from `spec.version`. Published updates affect subsequent
downloads, while existing projects retain independent group configurations.

## Portable configuration

The document is an `agent.wecode.io/v1` `Template` whose
`spec.resources.collaboration` contains `project`, `groups` and optional `agents`.
Agent definitions contain a logical `key`, name, `codex` / `claude_code` runtime,
`systemPrompt`, `capabilityDescription` and optional approval, workspace and concurrency policies. Roles reference definitions through
`agentKey`. Applying creates each referenced Agent once in the destination project
or workspace and replaces coordinator, member and stage references with new IDs.
The coordinator cannot also execute member roles.

Built-ins include all Agent definitions. The default form shows a compact roster;
"Customize members (optional)" allows existing members to replace them.
Templates allow removing unwanted roles with the adjacent “×” before
creating a group or project. Removing a role also removes all workflow stages owned
by that role. The coordinator is required and cannot be removed. Unassigned stages
and stages owned by retained roles stay unchanged. These changes affect only this
creation, preserving the source template. Agents referenced exclusively by removed
roles are not created; definitions still referenced by retained roles remain in use. Legacy
templates without definitions still allow manual assignment. Saving YAML into the
template library alone does not create project Agents; applying it does.

Models, devices, workspaces and tools follow the recipient's execution environment.
Before creating agents, all required runtimes are checked against the selected device's unique default models. Missing defaults or revoked project authorization preserve the confirmation dialog so users can configure the device and continue before any agent is created; import never grants device access.
When creating a project from a template, device and default-model readiness is checked before project creation. A failed preflight preserves the form without creating an empty project, allowing users to switch templates or complete configuration and retry. Project-specific device authorization is still checked after creation. Later persistence failures retain the created project and direct users to inspect its configuration, preventing duplicate creation.
Source account model, plugin and device IDs and credentials are excluded. Project
and group exports load real Agent definitions, preserving prompts with portable
references that can be imported by another account. Multi-Bot resources that cannot be represented are rejected explicitly. Cloud workspaces cannot represent manual approval, explicit workspace policies or concurrency limits. Import rejects these settings before creating resources and directs users to apply the template to a project. Local workspaces and direct project imports preserve them.

YAML validation rejects unknown fields, duplicate keys, aliases, invalid
references, and files larger than 1 MB. Exports include current configuration,
without account identities, tasks, comments, execution history, or credentials.
Export actions belong to project configuration sharing and group management.

Applying to an existing project adds groups and preserves existing groups and
tasks. Name conflicts require renaming. Partial Agent or group creation prevents
direct reapplication and asks users to inspect persisted configuration first.

## Local availability

`shared/data/collaboration-templates.json` is the canonical built-in data.
Generate Backend initialization YAML with
`pnpm --filter @wegent/collaboration exec node ../../scripts/generate-collaboration-templates.mjs`.
Built-ins are available on first launch without a Backend connection.

Downloads and drafts are cached by Backend and account. Signed-out local identity
has a separate scope; switching accounts does not transfer drafts. Drafts created
while a known account is offline synchronize privately after that account
reconnects. Conflicts preserve drafts; synchronization neither overwrites a
conflicting source nor publishes it.

## Verification

Existing-project user story: users can apply a template through their project's configured
device and recover from missing devices without re-entering group names or role assignments.

| Precondition | Action | Expected result | Coverage |
| --- | --- | --- | --- |
| One online authorized project APP device | Open template, edit group name, refresh, apply and reload | Project device selected automatically; name preserved; six Agents bound to that device; group persisted | `authorized` template case in `issue-dispatch-executor.spec.ts` |
| No authorized project device | Edit name, open device settings in a new tab, add and initialize device, return, refresh and apply | Confirmation and name preserved; refreshed device selected; Agents and group created | `configure` template case in the same suite |
| Multiple online project devices | Choose a device in confirmation and apply | Uses the explicit selection without changing the account default; unavailable and offline devices excluded | `ProjectTemplateApplyDialog.test.tsx`, `templateAgentRouting.test.ts` |
| Inventory failure or authorization revoked before submission | Refresh or choose another device | Input preserved; submission revalidates access; invalid device creates no Agents | Same component and routing tests |

Both real-device cases reuse the existing Executor CI project with real Backend, devices and
storage. Wegent internal APIs are not mocked.

Shared-package tests cover validation, YAML round trips, cache isolation, source
updates, and partial failures. Backend tests cover inbox isolation and reference
installation. The `collaboration-templates` desktop checkpoint covers real
Rust/Python/MySQL APIs, access rules, revision conflicts, project creation,
save/publication, additive import, and reload persistence.
`frontend/e2e/tests/collaboration/templates.spec.ts` covers marketplace discovery
and YAML import. Both run through existing CI runners. Evidence screenshots are
test artifacts and are never committed.

`frontend/e2e/tests/collaboration/template-use.spec.ts` uses isolated accounts to verify
marketplace application to existing projects, new-project creation, stage and automation
persistence, and zero project creation without a default device. Positive cases use the built-in
product lifecycle template with explicitly selected human coordinators and executors, verifying all six stage bindings without a real model. Shared-component and Web-routing
tests separately cover Agent creation, default-model resolution, explicit device authorization,
revoked management access and request recovery.

## Execution defaults

Roles may set `defaultKind`; built-in coordinators default to an agent and cannot also execute member roles. `project.taskAssignment` stores `enabled` and a logical `groupKey`. Import resolves it to the newly persisted group and creates an issue-created automation rule. An enabled existing issue-created rule blocks import before groups are added.

`project.board` defines a view name and stage tags. Import appends a default tag view while preserving existing views and business tags. The coordinator updates stage tags as work progresses and submits the result for human acceptance; defining columns alone does not advance an issue. Project snapshots export these settings with portable group references instead of live group IDs.

The CI-registered `collaboration-template-lifecycle` desktop checkpoint covers import, automatic group assignment, six workflow rounds, tag columns, shell deliverables and human acceptance. Electron, Executor, MCP and persistence are real; only the model service uses deterministic responses.

The CI-registered `collaboration-template-agents` checkpoint covers cross-account application, prompt preservation, role and stage bindings, saving and reuse, and zero project creation when a default model is missing followed by recovery with a configured template. Shared tests additionally cover device preflight and partial persistence. Executor tests verify the actual initial and resumed execution requests contain both the leader prompt and manager constraints.

### Role removal user story and cases

As a user creating a collaboration group from a template, I want to remove unwanted
roles and their stages while retaining the coordinator, so the group fits my work.

| Preconditions | Action | Expected result | Automated coverage |
| --- | --- | --- | --- |
| A built-in template is selected | Remove one executor role | Remove the role and all its stages; preserve other stages and the source | `TemplateBindings.test.tsx` |
| A legacy template has an unbound role | Remove that role | The removed unbound role no longer blocks creation | `TemplateBindings.test.tsx` |
| Saving or configuration is disabled | Attempt removal | Roles and stages remain unchanged | `TemplateBindings.test.tsx` |
| A template includes coordinator and executor roles | Remove every executor role and create a project | Coordinator removal stays disabled; persist only the coordinator; create no removed Agents or stages | `collaboration-template-agents` |
| Creating a project from a template | Remove a role | Both the template and group drafts passed to creation contain the reduced roles and stages | `TemplateBindings.test.tsx` |
| Roles were removed before selecting a template again | Reselect the source or another template with the same name and version | Reset role configuration without retaining the previous selection's removed roles | `TemplateBindings.test.tsx`, `collaboration-template-agents` |

The desktop case reuses the checkpoint's isolated accounts, local projects, real
Electron, Executor and persistence. Only the model service uses deterministic responses.
Run `pnpm --filter wework e2e:desktop --segment collaboration-template-agents`;
the shared runner cleans up the isolated environment.
