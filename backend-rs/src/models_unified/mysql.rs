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

/// Only the CRD payload of a `kinds` row, mirroring the source's
/// `db.query(Kind.json).first()` projection used by `find_shell_json`.
#[derive(Debug, FromMysqlRow)]
pub struct KindJsonRow {
    pub json: brz_mysql::Json<serde_json::Value>,
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
pub struct EntityIdRow {
    pub entity_id: String,
}

/// `namespace.id`/`namespace.name` projection used by the referenced
/// capability target lookup (`db.query(Namespace.id, Namespace.name)`).
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct NamespaceRefRow {
    pub id: i32,
    pub name: String,
}

/// One row of the referenced-capability join: the `resource_members` entity
/// that grants visibility plus the referenced `kinds` row.
///
/// The column labels are the source's SQLAlchemy aliases: Replay delivers this
/// statement's original resultset, so the labels are the recorded ones.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct ReferencedKindRow {
    #[mysql(rename = "resource_members_entity_type")]
    pub entity_type: String,
    #[mysql(rename = "resource_members_entity_id")]
    pub entity_id: String,
    #[mysql(rename = "kinds_id")]
    pub id: i32,
    #[mysql(rename = "kinds_user_id")]
    pub user_id: i32,
    #[mysql(rename = "kinds_kind")]
    pub kind: String,
    #[mysql(rename = "kinds_name")]
    pub name: String,
    #[mysql(rename = "kinds_namespace")]
    pub namespace: String,
    #[mysql(rename = "kinds_json")]
    pub json: brz_mysql::Json<serde_json::Value>,
    #[mysql(rename = "kinds_is_active")]
    pub is_active: bool,
    #[mysql(rename = "kinds_created_at")]
    pub created_at: NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    pub updated_at: NaiveDateTime,
}

impl ReferencedKindRow {
    /// Keep only the referenced `kinds` row.
    pub fn into_kind_row(self) -> KindRow {
        KindRow {
            id: self.id,
            user_id: self.user_id,
            kind: self.kind,
            name: self.name,
            namespace: self.namespace,
            json: self.json,
            is_active: self.is_active,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct NameRow {
    pub name: String,
}
