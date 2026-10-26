// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/cloud-projects/{project_id}/board-snapshot` — the
//! authoritative first-screen project-board read snapshot.
//!
//! Mirrors `app.api.endpoints.cloud_projects.get_project_board_snapshot`:
//! `project_board_snapshot_service.get(db, project_id, current_user.id)`
//! returns `ProjectBoardSnapshotResponse { items, task_bindings, members,
//! agents }`. The snapshot is built from `list_item_views` (the project
//! access check plus the provider-aware loop-item list), the project's
//! active task bindings, the project's approved members, and the project's
//! visible chat agents.
//!
//! Source pipeline (`app.services.project_board_snapshot`):
//! 1. `security.get_current_user` — JWT session decode plus the labeled
//!    `users` lookup (the full twelve-column `users_<column>` projection);
//! 2. `list_item_views` — `cloud_project_service.get` runs
//!    `require_cloud_project_role` (re-read the project row plus the
//!    approved membership row for non-creators). For external providers
//!    (github/gitlab) the external loop-item provider lists issues from the
//!    provider API; for local projects `loop_item_service.list` reads
//!    `loop_items` rows for the project.
//! 3. `loop_item_service.list_project_task_bindings` — active
//!    `loop_items` execution rows whose `loop_item_id` is in the item list;
//! 4. `cloud_project_service.list_members` — the effective project roster
//!    (`project_participant_ids`: approved direct members plus the parent
//!    workspace owner/members), each row's permission provenance
//!    (`collaboration_permission_service.project_sources`), the direct grant
//!    id, and the metadata capability descriptions;
//! 5. `project_chat_service.list_agents` — active `loop_items` chat-agent
//!    rows for the project, filtered by visibility against the caller.
//!
//! The recorded cases are local projects; the external-provider branch keeps
//! the source's provider list call and its
//! `HTTPException(502, "Provider request failed: {e}")` mapping.

pub mod agents;
pub mod external_provider;
pub mod handler;
pub mod members;
pub mod permissions;
pub mod repository;
