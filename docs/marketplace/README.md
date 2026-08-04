---
sidebar_position: 1
---

# Plugin Marketplace

Wegent provides a managed marketplace for discovering, publishing, sharing, and
installing Codex-compatible plugins. The backend owns catalog metadata,
immutable releases, review state, access control, and device installation state.
Wework provides the desktop catalog and local runtime integration.

## Documentation

- [Architecture](./ARCHITECTURE.md): components, data model, and lifecycle.
- [Publishing](./PUBLISHING.md): package requirements and release workflows.
- [Operations](./OPERATIONS.md): configuration, verification, and troubleshooting.
- [UI guidelines](./UI_GUIDELINES.md): marketplace-specific interaction rules.

## Repository locations

| Area                         | Path                                                 |
| ---------------------------- | ---------------------------------------------------- |
| Marketplace API              | `backend/app/api/endpoints/installed_plugins.py`     |
| Admin API                    | `backend/app/api/endpoints/admin/plugins.py`         |
| Business logic               | `backend/app/services/plugin_marketplace_service.py` |
| Package parsing and scanning | `backend/app/services/plugin_package_parser.py`      |
| Package storage              | `backend/app/services/plugin_package_storage.py`     |
| Database models              | `backend/app/models/plugin_marketplace.py`           |
| Desktop marketplace          | `wework/src/components/plugins/PluginsWorkspace.tsx` |
| Local Codex integration      | `wework/src/api/local/codexPlugins.ts`               |

## Supported workflows

- Publish a first-party plugin from a reviewed source directory.
- Submit a user-created plugin for scanning and review.
- Mirror an explicitly configured HTTPS upstream.
- Share a personal plugin with selected users or departments.
- Install, update, enable, disable, and remove plugins per account and device.
- Browse local Codex marketplaces alongside the Wegent cloud catalog.

## Contributor expectations

- Treat releases as immutable. Publish a new semantic version for every content
  change.
- Never insert release rows or upload package objects manually.
- Never include credentials, session files, private keys, or local environment
  files in a package.
- Keep cloud catalog identity separate from local marketplace identity.
- Add focused backend and Wework tests for every lifecycle change.
- Follow the repository `AGENTS.md` and `wework/AGENTS.md` instructions.
