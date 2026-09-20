// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! User lookups for `get_current_user` (`app.core.security.get_current_user`)
//! and `get_task_detail` (`userReader.get_by_id`).
//!
//! Source `get_current_user` queries the `users` table directly with
//! SQLAlchemy's full labeled column list
//! (`SELECT users.<col> AS users_<col>, ... FROM users WHERE users.user_name =
//! ? LIMIT 1`); the public implementation performs no Redis lookup for the
//! name query.
use brz_mysql::{FromMysqlRow, Json, Mysql};
use chrono::NaiveDateTime;
use serde::Deserialize;

use super::app_state::AppState;

pub struct UserStore;

/// One `users.git_info` entry: the `GitInfo` schema from
/// `app.schemas.user` (each stored entry is a `model_dump()` of it, with the
/// fields the token-validation flow fills in). Key order follows the
/// recorded payload's insertion order, which Python's dict preserves.
// Migrated from the Python source; not yet wired into the gateway.
#[derive(Debug, Deserialize)]
pub struct GitAccount {
    #[allow(dead_code)]
    pub id: Option<String>,
    #[allow(dead_code)]
    #[serde(rename = "type")]
    pub account_type: String,
    #[allow(dead_code)]
    pub git_id: Option<String>,
    #[allow(dead_code)]
    pub auth_type: Option<String>,
    #[allow(dead_code)]
    pub git_email: Option<String>,
    #[allow(dead_code)]
    pub git_login: Option<String>,
    #[allow(dead_code)]
    pub git_token: Option<String>,
    #[allow(dead_code)]
    pub user_name: Option<String>,
    #[allow(dead_code)]
    pub git_domain: Option<String>,
}

/// A `users` row selected with the source SQLAlchemy projection: every mapped
/// column, labeled `users_<column>`. Only `id`, `user_name`, and `is_active`
/// are consumed; the remaining columns are decoded so the statement matches
/// the recorded source query byte-for-byte (modulo the bound parameter).
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct UserRow {
    pub users_id: i32,
    pub users_user_name: String,
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    pub users_email: Option<String>,
    pub users_git_info: Json<Option<Vec<GitAccount>>>,
    pub users_is_active: i8,
    pub users_role: String,
    pub users_auth_source: String,
    pub users_preferences: String,
    pub users_created_at: NaiveDateTime,
    pub users_updated_at: NaiveDateTime,
}

/// `get_current_user`'s `db.query(User).filter(User.user_name ==
/// username).first()` statement, rendered exactly as SQLAlchemy labels it.
const USER_BY_NAME_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.user_name = ? \
     LIMIT 1";

pub async fn get_by_name(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    user_name: &str,
) -> anyhow::Result<Option<UserRow>> {
    let row: Option<UserRow> =
        Mysql::fetch_optional(&state.mysql, USER_BY_NAME_QUERY, (user_name,)).await?;
    Ok(row)
}

/// `userReader.get_by_id` as the status task-detail chain performs it. The
/// status response discards the row, so only the read topology is
/// observable: a supplied user-cache client serves the read from the
/// `user:v2:data:{user_id}` document (the deployment's cached reader);
/// without one the read stays on the public direct SQL path.
pub(crate) async fn cached_user_get_by_id(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    user_id: i64,
) -> anyhow::Result<()> {
    let user_cache_key = format!("user:v2:data:{user_id}");
    let cached: Option<brz_redis::RedisBytes> = match state.cache.user_cache() {
        Some(redis) => redis
            .get(user_cache_key.as_str())
            .await
            .map_err(|error| {
                tracing::warn!(%error, key = %user_cache_key, "[user_cache] redis data read failed");
                error
            })
            .ok()
            .flatten(),
        None => None,
    };
    if cached.is_some() {
        return Ok(());
    }
    let _: Option<UserRow> = Mysql::fetch_optional(
        &state.mysql,
        "SELECT users.id AS users_id, users.user_name AS users_user_name, \
         users.password_hash AS users_password_hash, users.email AS users_email, \
         users.git_info AS users_git_info, users.is_active AS users_is_active, \
         users.`role` AS users_role, users.auth_source AS users_auth_source, \
         users.preferences AS users_preferences, users.created_at AS users_created_at, \
         users.updated_at AS users_updated_at \
         FROM users \
         WHERE users.id = ? \
         LIMIT 1",
        (user_id,),
    )
    .await?;
    Ok(())
}
