---
sidebar_position: 57
---

# Project administration MCP

Project maintainers can read, preview, and update configuration through `wework_space`.
MCP and the page share `CloudProjectService` and existing authorization services.
The executor's native MCP forwards the same configuration API without requiring a desktop window.

## Discover capabilities

Call `get_project_admin_capabilities` with the target `space_id`. The catalog publishes callable
operations with their `inputSchema`, `outputSchema`, permission, `supportsDryRun`, and availability.
Unavailable operations appear in `unavailableCapabilities` with a stable `reason_code`.

Coverage includes project details, tags, board views, statuses, collaboration policy, workflow,
automation, members, and the assistant roster. `get_project_config` returns safe configuration,
`projectVersion`, and the current `revision`. Membership permission roles and functional
responsibilities are separate. Assistant responses contain visible public roster fields and
resource bindings, without private prompts, memory, or credentials.

## Preview and update

Submit configuration through a typed tool from the catalog, including the `version` returned by
the read. Supply `operation_id` or `idempotency_key` for reliable retries. `dry_run: true` returns
the expected difference and rolls back the complete transaction without advancing versions,
creating audit records, or requesting execution cancellations.

A write returns `before`, `after`, `diff`, `projectVersion`, `revision`, `actor`, `operationId`,
`appliedAt`, and `auditId`. Retrying the same operation identifier and request returns the first
result. Reusing an identifier for a different request returns `idempotency_conflict`. A stale
version returns HTTP 409 with `version_conflict`. Read the configuration again to verify persistence.

Retries restore the first public write result's configuration, version, and timestamps even after
another write; reads return current state. Each retry checks current authorization. Effective access,
capability availability, provider settings, and execution configuration always use current values;
the audit journal never caches historical authority, credentials, or private execution configuration.

Board views use the page's `BoardViews` object: `schema_version`, `default_view_id`, and `views`.
Columns use `type: status | tag | unmatched` and `value`; filters use `filter`, and per-column
sorting uses `sorts`. Undeclared arbitrary configuration fields are rejected. The catalog's schema
defines the exact supported constraints.

Rename or delete tags with `tag_change: {source, target}`; `target: null` deletes the tag.
One transaction updates the project catalog, Issue references, saved columns, filters, and sorts.
References that cannot be changed safely reject the entire operation. Running Issues retain their
policy and workflow snapshots. Policy changes report their effect scope and snapshot rule.

## Authorization, errors, and rollback

Reads require project Viewer access, while writes require Maintainer or higher. Existing member,
assistant, and resource-binding authorization continues to apply. Common reason codes include
`permission_denied`, `version_conflict`, `invalid_config`, `unsupported_field`,
`unsupported_capability`, and `partial_reference_conflict`. Missing capabilities and denied
operations never fall back to desktop automation or permission bypasses.

`WEWORK_PROJECT_ADMIN_TOOLS_V1` controls `wework.projectAdminTools.v1`. Disabling it hides the new
write capabilities from the catalog while preserving reads and page management. Persisted
configuration remains readable; rollback does not remove project configuration.
The generic `update_space` entry point also rejects expanded configuration fields with
`feature_disabled`. Existing name, description, and tag updates retain version checks,
idempotency, and dry runs independently of the new capability flag.
