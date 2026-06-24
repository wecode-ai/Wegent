---
sidebar_position: 33
---

# System Plugin Management

System plugin management lets administrators maintain plugins shown to all users. Each logical plugin has separate ClaudeCode and Codex runtime ZIP packages. Users see one combined plugin in Wework, and installing or updating it deploys both runtime variants.

## Data Model

System plugins reuse the existing CRD storage model:

- Admin-managed plugins use `Kind.kind = "Plugin"` with `user_id = 0` as system catalog entries.
- Variants of the same logical plugin are grouped by `spec.source.pluginKey`, with `spec.runtime = "claudecode"` or `"codex"` identifying the runtime package.
- User installations still use `Kind.kind = "InstalledPlugin"` and belong to the current user.
- ZIP package bytes reuse `SkillBinary` with `type = "plugin"`.

System catalog entries and user installations are linked through `spec.source.systemPluginId`. Installing a system plugin copies the manifest, component inventory, and package reference into a user-owned installation instead of sharing user-editable runtime state. The user catalog only shows logical plugins whose ClaudeCode and Codex variants both exist and are enabled.

## Administrator Capabilities

The admin entry point is in the main frontend:

```text
System Administration -> Plugins
```

Supported operations:

- Upload a ZIP to create or replace a system plugin catalog entry and choose the runtime version.
- Edit display name and description.
- Enable or disable a catalog entry. If either runtime variant is disabled, the combined plugin is hidden from the user catalog.
- Re-upload a ZIP to replace the plugin package version.
- Delete a system plugin catalog entry.

When replacing the ZIP, the new package must keep the same plugin name as the original package. This prevents updating user installations to a different plugin by mistake.

## User Installation And Updates

The Wework plugin management page only shows the system plugin catalog. It no longer provides a user upload entry for plugin ZIP packages. Users can:

- Install system plugins. One install creates both ClaudeCode and Codex `InstalledPlugin` records.
- Enable or disable their own installed plugins.
- See an update-available state after an administrator replaces the system plugin package.
- Manually update both installed runtime variants to the new system plugin package version.

Updates use a manual confirmation policy. Replacing a system package does not automatically modify user installations; it only makes the catalog API return `installState = "update_available"`. Install and update APIs return an `items` array containing both runtime installation results.

## API

Administrator APIs:

```text
GET    /api/admin/plugins
POST   /api/admin/plugins
PUT    /api/admin/plugins/{system_plugin_id}
PUT    /api/admin/plugins/{system_plugin_id}/package
DELETE /api/admin/plugins/{system_plugin_id}
```

User APIs:

```text
GET  /api/plugins/catalog
POST /api/plugins/catalog/{system_plugin_id}/install
POST /api/plugins/catalog/{system_plugin_id}/update
```

Installing or updating a plugin triggers global capability sync so online devices receive the plugin changes.

## Frontend Responsibilities

The main frontend (`frontend/`) owns system plugin catalog administration. Wework consumes the catalog for users. Wework still supports skill upload and custom MCP creation, but user upload of Claude Code plugin ZIP packages has been removed.
