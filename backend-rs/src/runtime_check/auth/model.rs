// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared repository types mirroring `Wegent/backend/app/services/readers/users.py`
//! and the users-table column shape.
use brz_mysql::FromMysqlRow;
use brz_mysql::Json;
use chrono::NaiveDateTime;

/// Application-level user record used by authentication.
#[derive(Debug, Clone)]
pub(crate) struct AuthUser {
    pub id: i64,
    #[allow(dead_code)] // documents the authenticated identity
    pub user_name: String,
    pub is_active: bool,
}

/// A `users` row selected with the source SQLAlchemy projection: every
/// mapped column, labeled `users_<column>`. Only `id` and `user_name` are
/// consumed; the remaining columns are decoded so the statement matches the
/// recorded source query byte-for-byte (modulo the bound parameter).
#[derive(Debug, FromMysqlRow)]
pub(crate) struct UserRow {
    pub users_id: i32,
    pub users_user_name: String,
    #[allow(dead_code)] // selected to match the source column list
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    #[allow(dead_code)] // selected to match the source column list
    pub users_email: Option<String>,
    #[allow(dead_code)] // selected to match the source column list
    pub users_git_info: Json<crate::json_compat::OpaqueJson>,
    pub users_is_active: i8,
    #[allow(dead_code)] // selected to match the source column list
    pub users_role: String,
    #[allow(dead_code)] // selected to match the source column list
    pub users_auth_source: String,
    #[allow(dead_code)] // selected to match the source column list
    pub users_preferences: String,
    #[allow(dead_code)] // selected to match the source column list
    pub users_created_at: NaiveDateTime,
    #[allow(dead_code)] // selected to match the source column list
    pub users_updated_at: NaiveDateTime,
}

impl From<UserRow> for AuthUser {
    fn from(row: UserRow) -> Self {
        Self {
            id: i64::from(row.users_id),
            user_name: row.users_user_name,
            is_active: row.users_is_active != 0,
        }
    }
}
