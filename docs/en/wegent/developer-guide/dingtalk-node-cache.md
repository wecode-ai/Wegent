---
sidebar_position: 13
---

# DingTalk Directory Node Cache

`dingtalk_synced_nodes` caches the directory synchronized through a user's MCP services, not document bodies.

- Existing identity, source, name, parent and classification columns remain available for queries and tree rendering.
- `raw_metadata` contains one original node JSON object, including unknown upstream fields, captured before ID normalization, parent injection or synthetic knowledge-base root construction. It does not aggregate every API response for that ID.
- Each successful sync replaces the complete JSON snapshot. Fields removed upstream disappear locally as well.
- The API projects a lowercase `extension` from JSON without returning the raw object. Import authorization and format checks are unchanged.
- Legacy rows may have empty metadata. A manual directory refresh fills it; no format inference from `node_type` or automatic repair task is added.

## Unpublished Migration

The unpublished `d6e7f8a9b0c1` migration now adds nullable `raw_metadata JSON` instead of a separate `extension` column. Its predecessor remains `c5d6e7f8a9b0`.

Databases that have not applied this revision can run `uv run alembic upgrade head`. Development databases already using the old revision must first downgrade to `c5d6e7f8a9b0` using the old migration code, then switch to the updated code and upgrade. Do not merely stamp the revision or run the updated downgrade against the old schema. Downgrading removes the corresponding cached field; a directory refresh restores metadata.

Tests exercise actual Alembic upgrades, JSON round trips and rollback with node rows retained. Sync coverage includes personal documents and knowledge bases, original IDs and parent boundaries, removed fields and API projection.
