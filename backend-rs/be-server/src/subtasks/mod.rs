// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The subtask endpoints of `app/api/endpoints/subtasks.py`.
//!
//! `GET /api/subtasks` — the task's message list (`list_subtasks`):
//!
//! Source pipeline:
//! 1. `security.get_current_user` — the JWT session plus the `users` row;
//! 2. `subtask_service.get_by_task` -> `subtask_store.list_by_task` —
//!    `access_store.is_member` (an active-task read plus the approved-member
//!    probe), then one `subtasks.id` page ordered `message_id, created_at`
//!    (filtered by `user_id` for a non-member), then `_load_ordered` (the
//!    id-scoped full-row load and its context batch) and
//!    `_attach_sender_user_names`;
//! 3. `subtask_store.count_by_task_for_user` — a second `is_member`, then
//!    `count(*)` over the full subtask projection;
//! 4. the `SubtaskListResponse` `{"total", "items"}` envelope, whose items are
//!    the `SubtaskInDB` projection.
//!
//! `POST /api/subtasks/{subtask_id}/edit` — delete an edited user message and
//! everything after it (`edit_user_message`); see [`edit`].

pub mod edit;
pub mod handler;
pub mod item;
