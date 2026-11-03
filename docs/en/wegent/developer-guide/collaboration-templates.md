---
sidebar_position: 36
---

# Collaboration templates

Wework exposes discovery under Collaboration → Templates. Wegent exposes the same
discovery UI in its capability marketplace. Both use
`packages/collaboration/src/templates` and the same Backend data.

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
"Customize members (optional)" allows existing members to replace them. Legacy
templates without definitions still allow manual assignment. Saving YAML into the
template library alone does not create project Agents; applying it does.

Models, devices, workspaces and tools follow the recipient's execution environment.
Before creating agents, all required runtimes are checked against the current device's unique default models. Missing defaults or a device not authorized for the destination project block import before any agent is created; import never grants device access.
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

Shared-package tests cover validation, YAML round trips, cache isolation, source
updates, and partial failures. Backend tests cover inbox isolation and reference
installation. The `collaboration-templates` desktop checkpoint covers real
Rust/Python/MySQL APIs, access rules, revision conflicts, project creation,
save/publication, additive import, and reload persistence.
`frontend/e2e/tests/collaboration/templates.spec.ts` covers marketplace discovery
and YAML import. Both run through existing CI runners. Evidence screenshots are
test artifacts and are never committed.

## Execution defaults

Roles may set `defaultKind`; built-in coordinators default to an agent and cannot also execute member roles. `project.taskAssignment` stores `enabled` and a logical `groupKey`. Import resolves it to the newly persisted group and creates an issue-created automation rule. An enabled existing issue-created rule blocks import before groups are added.

`project.board` defines a view name and stage tags. Import appends a default tag view while preserving existing views and business tags. The coordinator updates stage tags as work progresses and submits the result for human acceptance; defining columns alone does not advance an issue. Project snapshots export these settings with portable group references instead of live group IDs.

The CI-registered `collaboration-template-lifecycle` desktop checkpoint covers import, automatic group assignment, six workflow rounds, tag columns, shell deliverables and human acceptance. Electron, Executor, MCP and persistence are real; only the model service uses deterministic responses.

The CI-registered `collaboration-template-agents` checkpoint covers cross-account application, prompt preservation, role and stage bindings, saving and reuse, and zero project creation when a default model is missing followed by recovery with a configured template. Shared tests additionally cover device preflight and partial persistence. Executor tests verify the actual initial and resumed execution requests contain both the leader prompt and manager constraints.
