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

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/collaboration-templates` | Available metadata, without full definitions |
| `GET /api/v1/collaboration-templates/{id}` | Authorized portable definition |
| `PUT /api/v1/collaboration-templates/{name}` | Save in the current owner's default namespace |

Saves contain `document` and `expectedRevision`. Creation uses `null`; an update
requires the current revision and a new `spec.version`. Stale revisions return 409.
Identical repeated saves return the same Kind. The server owns
`spec.configurationRevision`, which is excluded from YAML. Marketplace template
versions always come from `spec.version`. Published updates affect subsequent
downloads, while existing projects retain independent group configurations.

## Portable configuration

The document is an `agent.wecode.io/v1` `Template` whose
`spec.resources.collaboration` contains `project` and `groups`. Groups define
logical roles, a coordinator role, workflow stages, deliverables, acceptance
criteria, and execution tags. Users explicitly bind roles to members or agents;
the coordinator cannot also execute stages.

YAML validation rejects unknown fields, duplicate keys, aliases, invalid
references, and files larger than 1 MB. Exports include current configuration,
without account identities, tasks, comments, execution history, or credentials.
Export actions belong to project configuration sharing and group management.

Applying to an existing project adds groups and preserves existing groups and
tasks. Name conflicts require renaming. Partial creation failures require users
to inspect added groups before continuing, preventing duplicate writes.

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
