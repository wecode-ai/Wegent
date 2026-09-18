// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed rows and queries against the source `task_manager` MySQL schema.
//!
//! Each query preserves the source SQLAlchemy statement shape: filters,
//! ordering, and connection settings mirror `app/services` and
//! `shared/models/db`. Sessions use `pool_pre_ping`, `utf8mb4`, and a
//! `+08:00` session timezone, matching `app/db/session.py`.
use brz_mysql::FromMysqlRow;
use chrono::NaiveDateTime;

/// One row of the `users` table.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct UserRow {
    pub id: i32,
    pub user_name: String,
    pub email: Option<String>,
    pub git_info: Option<brz_mysql::Json<crate::json_compat::OpaqueJson>>,
    pub is_active: bool,
    pub role: String,
    pub auth_source: String,
    pub preferences: Option<String>,
}

/// One row of the `kinds` table.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct KindRow {
    pub id: i32,
    pub user_id: i32,
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub json: brz_mysql::Json<serde_json::Value>,
    pub is_active: bool,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

/// One row of the `namespace` table.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct NamespaceRow {
    pub id: i32,
    pub name: String,
    pub display_name: Option<String>,
    pub owner_user_id: i32,
    pub visibility: String,
    pub level: Option<String>,
    pub is_active: bool,
}

/// Selected columns of `resource_members`.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct MemberRow {
    pub resource_type: String,
    pub resource_id: i64,
    pub entity_type: String,
    pub entity_id: String,
    pub role: String,
    pub status: String,
}

#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct ResourceIdRow {
    pub resource_id: i64,
}

#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct EntityIdRow {
    pub entity_id: String,
}

#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct NameRow {
    pub name: String,
}

#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct IdRow {
    pub id: i32,
}
