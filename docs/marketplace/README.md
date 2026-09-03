---
sidebar_position: 1
---

# Plugin Marketplace

Wegent provides a managed marketplace for discovering, publishing, sharing, and
installing Codex-compatible plugins. The backend owns catalog metadata,
immutable releases, review state, access control, and device installation state.
Wework provides the desktop catalog and local runtime integration.

The product has one **Share** entry on the personal-plugin detail page and two
user intents:

- **Specific members or departments** is a personal share. It becomes available
  after package validation and does not require manual review. The organization
  root is selectable as a department; there is no separate organization scope.
- **Everyone in the enterprise** creates a workspace-publication request. It is
  never an immediate visibility change. The submitted version is frozen, passes
  automatic checks and administrator review, enters GitLab as a MR, and is
  published only from the protected `master` pipeline.

`public` remains a system-owned scope for official public plugins. Ordinary
users can request `workspace` publication only. The GitHub-based Wework official
public catalog is a P1 decision and is not part of the enterprise workflow.

## Documentation

- [Architecture](./ARCHITECTURE.md): components, data model, and lifecycle.
- [Publishing](./PUBLISHING.md): package requirements and release workflows.
- [Operations](./OPERATIONS.md): configuration, verification, and troubleshooting.
- [UI guidelines](./UI_GUIDELINES.md): marketplace-specific interaction rules.

## Repository locations

| Area                          | Path                                                                      |
| ----------------------------- | ------------------------------------------------------------------------- |
| Marketplace API               | `backend/app/api/endpoints/installed_plugins.py`                          |
| Publication request API       | `backend/app/api/endpoints/plugin_publications.py`                        |
| Publication administrator API | `backend/app/api/endpoints/admin/plugin_publications.py`                  |
| Protected release/Webhook API | `backend/app/api/endpoints/internal/plugin_publications.py`               |
| Publication workflow          | `backend/app/services/plugin_publication_service.py`                      |
| Marketplace business logic    | `backend/app/services/plugin_marketplace_service.py`                      |
| Package parsing and scanning  | `backend/app/services/plugin_package_parser.py`                           |
| Package storage               | `backend/app/services/plugin_package_storage.py`                          |
| Publication records           | `backend/app/models/plugin_publication.py`                                |
| Desktop marketplace           | `wework/src/components/plugins/PluginsWorkspace.tsx`                      |
| Web administrator review      | `frontend/src/features/admin/components/PluginPublicationReviewQueue.tsx` |
| Local Codex integration       | `wework/src/api/local/codexPlugins.ts`                                    |

## Supported workflows

- Publish a first-party plugin from a reviewed source directory.
- Share a personal plugin with selected users or departments after scanning.
- Submit an immutable personal-plugin version for enterprise publication.
- Let administrators return an application or accept it into a GitLab MR.
- Converge non-technical submissions and developer-authored changes on the same
  GitLab review, compatibility, and protected release pipeline.
- Mirror an explicitly configured HTTPS upstream.
- Install, update, enable, disable, and remove plugins per account and device.
- Browse local Codex marketplaces alongside the Wegent cloud catalog.

The canonical enterprise progress shown to users has five stages: **Submit request**,
**Automated checks**, **Administrator review**, **Code review**, and
**Release**. A personal source has at most one active Request. An administrator
return or deterministic automated-check failure is resubmitted as a new immutable
revision in that Request; upload, transport, and infrastructure failures retry the
same revision idempotently. After publication, a higher personal version starts a
new Request. Editing the personal source never mutates a revision already under
review, and `code_changes_requested` is fixed by a developer in the same MR.

## Implementation boundary

The implementation includes publication requests and immutable revisions,
separate personal and enterprise identities, the two-scope Wework flow, the Web
administrator queue, MR materialization, and the restricted release
endpoint. Wework waits for both ACL and publication state before opening the
**Share & publish** scope dialog, and retains complete Request/Revision history
rather than collapsing a plugin to one request.

Legacy `PluginSubmission` remains only as the upload transport for
`restricted_share + personal` and for draining historical rows. Its allowlist and
approval-publishes-immediately path do not authorize or serve new enterprise
requests.

This is locally implemented and tested, **not approved or deployed in production**.
There is no application-level publication switch, so before deployment operators
must revoke/rotate the old token, provide HTTPS, configure
protected master/environment and Code Owner approvals, attach project-locked
native Windows/macOS Runners, and provision a new protected Release credential.
The GitHub-based Wework official `public` catalog remains a separate P1.

## Contributor expectations

- Treat releases as immutable. Publish a new semantic version for every content
  change.
- Treat publication-request revisions as immutable even while the personal
  plugin continues to change.
- Never insert release rows or upload package objects manually.
- Never include credentials, session files, private keys, or local environment
  files in a package.
- Keep cloud catalog identity separate from local marketplace identity.
- Keep the personal source plugin separate from the enterprise-owned published
  copy; publication must not transfer or mutate personal ownership.
- Add focused backend and Wework tests for every lifecycle change.
- Follow the repository `AGENTS.md` and `wework/AGENTS.md` instructions.
