// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/marketplace-resources` — the administrator marketplace
//! resource listing.
//!
//! Port of `app.api.endpoints.admin.marketplace.list_marketplace_resources`
//! (the admin router is mounted under `/admin`, so the public path is
//! `/api/admin/marketplace-resources`). The endpoint requires an admin session
//! (`app.core.security.get_admin_user`), loads the system rows
//! (`kinds.user_id = 0`) and the publisher rows (`marketplace_resources`
//! joined to `kinds` and `users`), projects each row through `_to_response`,
//! orders the merged list by `(recommendation_score, updated_at, id)`
//! descending, and paginates.
//!
//! Recorded source evidence (`api-admin-marketplace-resources/c0bbefb8`): the
//! authenticated `users` lookup, the two `kinds`/`marketplace_resources`
//! scans, then two `ROLLBACK` session cleanups at request end.

mod handler;
mod models;
mod repository;
mod service;
