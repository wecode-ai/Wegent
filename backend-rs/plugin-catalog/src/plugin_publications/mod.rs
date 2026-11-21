// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared implementation of the plugin-publication request listing.
//!
//! Both the admin route (`GET /api/admin/plugins/publication-requests`,
//! `app/api/endpoints/admin/plugin_publications.py`) and the submitter route
//! (`GET /api/plugins/publication-requests`,
//! `app/api/endpoints/plugin_publications.py`) call
//! `PluginPublicationService.list_requests`
//! (`app/services/plugin_publication_service.py:563`) and project each row
//! through `_summary` (`:2100`). The two route variants differ only in
//! authentication and the `is_admin` filter; the shared row projections,
//! per-row lookups, and `_summary` projection live here.
//!
//! The recorded exchanges show the source's SQLAlchemy renderings: the
//! `count(*)` subquery wrapping the filtered labeled projection, the ordered
//! page query with the terminal-rank ordering, and per-row `plugins`, current
//! revision, submitter, and revision-check reads in `_summary` order. Two
//! trailing `ROLLBACK` session cleanups close the source request session;
//! Replay classifies them as optional, so no rollback is issued.

mod admin;
mod sql;
mod summary;
mod user;

/// `TERMINAL_PUBLICATION_STATUSES` (`plugin_publication_service.py:104`).
pub(super) const TERMINAL_PUBLICATION_STATUSES: [&str; 3] = ["published", "withdrawn", "closed"];
/// `ADMIN_REVIEW_STATUSES` (`:119`).
pub(super) const ADMIN_REVIEW_STATUSES: [&str; 2] = ["awaiting_admin", "admin_review"];
/// `CODE_REVIEW_STATUSES` (`:120`).
pub(super) const CODE_REVIEW_STATUSES: [&str; 7] = [
    "admin_accepted",
    "materializing",
    "draft_mr_open",
    "ci_running",
    "code_changes_requested",
    "merge_ready",
    "merged",
];
/// Source `EPOCH_TIME` (`app/models/plugin_marketplace.py`): the 1970-01-01
/// sentinel `submitted_at` that `_summary` maps to `created_at`.
pub(super) const EPOCH_TIME: chrono::NaiveDateTime = chrono::NaiveDateTime::new(
    chrono::NaiveDate::from_ymd_opt(1970, 1, 1).expect("valid epoch date"),
    chrono::NaiveTime::from_hms_opt(0, 0, 0).expect("valid epoch time"),
);
