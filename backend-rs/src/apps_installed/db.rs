// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Database access for the connector-apps projection API.
//!
//! Row structs and queries mirror the SQLAlchemy models and query shapes in
//! `shared/models/db/kind.py`, `shared/models/db/user.py`,
//! `app/services/connector_apps.py`, and `app/core/security.py` of the source
//! service. The column lists and alias naming follow the source ORM so the
//! statements sent to MySQL match the source query shapes.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;

/// One `users` row as selected by source authentication
/// (`app/core/security.py::get_current_user`).
///
/// Columns beyond `users_is_active` are decoded to keep the selected column
/// list identical to the source query; only the fields the endpoint reads are
/// used, and the rest carry `#[allow(dead_code)]`.
#[derive(Debug, FromMysqlRow)]
pub struct UserRow {
    #[allow(dead_code)]
    pub users_id: i64,
    #[allow(dead_code)]
    pub users_user_name: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    #[allow(dead_code)]
    pub users_email: Option<String>,
    #[allow(dead_code)]
    pub users_git_info: Json<crate::json_compat::OpaqueJson>,
    pub users_is_active: bool,
    pub users_role: String,
    #[allow(dead_code)]
    pub users_auth_source: String,
    #[allow(dead_code)]
    pub users_preferences: String,
    #[allow(dead_code)]
    pub users_created_at: NaiveDateTime,
    #[allow(dead_code)]
    pub users_updated_at: NaiveDateTime,
}

/// One active `kinds` row (`shared/models/db/kind.py`).
#[derive(Debug, FromMysqlRow)]
pub struct KindRow {
    pub kinds_id: i64,
    #[allow(dead_code)]
    pub kinds_user_id: i64,
    #[allow(dead_code)]
    pub kinds_kind: String,
    pub kinds_name: String,
    #[allow(dead_code)]
    pub kinds_namespace: String,
    pub kinds_json: Json<crate::json_compat::OpaqueJson>,
    #[allow(dead_code)]
    pub kinds_is_active: bool,
    #[allow(dead_code)]
    pub kinds_created_at: NaiveDateTime,
    #[allow(dead_code)]
    pub kinds_updated_at: NaiveDateTime,
}

/// Load one user by username, mirroring `get_current_user`'s `first()` lookup.
pub async fn find_user_by_name<M>(mysql: &M, user_name: &str) -> MysqlResult<Option<UserRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            "SELECT users.id AS users_id, users.user_name AS users_user_name, \
             users.password_hash AS users_password_hash, users.email AS users_email, \
             users.git_info AS users_git_info, users.is_active AS users_is_active, \
             users.`role` AS users_role, users.auth_source AS users_auth_source, \
             users.preferences AS users_preferences, users.created_at AS users_created_at, \
             users.updated_at AS users_updated_at \
             FROM users \
             WHERE users.user_name = ? \
             LIMIT 1",
            (user_name,),
        )
        .await
}

/// Load one user by id and username, mirroring the connector-runtime
/// dependency's
/// `db.query(User).filter(User.id == user_id, User.user_name == claims["sub"])`
/// lookup.
pub async fn find_user_by_id_and_name<M>(
    mysql: &M,
    user_id: i64,
    user_name: &str,
) -> MysqlResult<Option<UserRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            "SELECT users.id AS users_id, users.user_name AS users_user_name, \
             users.password_hash AS users_password_hash, users.email AS users_email, \
             users.git_info AS users_git_info, users.is_active AS users_is_active, \
             users.`role` AS users_role, users.auth_source AS users_auth_source, \
             users.preferences AS users_preferences, users.created_at AS users_created_at, \
             users.updated_at AS users_updated_at \
             FROM users \
             WHERE users.id = ? AND users.user_name = ? \
             LIMIT 1",
            (user_id, user_name),
        )
        .await
}

/// List all active `ConnectorApp` kinds rows ordered by name then id,
/// mirroring `ConnectorAppService.list_all_apps`.
pub async fn list_connector_app_kinds<M>(mysql: &M) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at \
             FROM kinds \
             WHERE kinds.kind = 'ConnectorApp' AND kinds.namespace = 'system' \
             AND kinds.is_active = 1 ORDER BY kinds.name, kinds.id",
            (),
        )
        .await
}
