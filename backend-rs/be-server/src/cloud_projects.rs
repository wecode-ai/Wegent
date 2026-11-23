// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Cloud-project reads and migration candidates.
//!
//! The selected project list, detail and execution-environment APIs use
//! `collaboration_access` to enforce the approved CP contract. A single query
//! resolves explicit and inherited grants, a unique active parent, provenance,
//! and read-only public discovery. Historical creators receive no implicit grant.
//!
//! Unselected route bodies remain migration candidates. Route ownership is
//! defined by config/routes.toml.
pub(crate) use collaboration_access::access_sql as project_access_statement;
pub(crate) use wegent_project_coordination::cloud_projects::{
    LOOP_ITEMS_COLUMNS, ProjectAccessRow, authorized_project, collaboration_access, members,
    role_for_priority,
};

pub(crate) use wegent_project_coordination::cloud_projects::{
    internal_error, parse_project_id, project_access,
};

/// Project assistant roster and one-transaction Issue fan-out.
mod assistant_roster;
#[cfg(test)]
mod collaboration_metrics;

pub(crate) use wegent_project_coordination::cloud_projects::metadata_board_statuses;
