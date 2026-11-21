// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Full ORM user projections for uncached display-name lookups.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use wegent_backend_persistence::sql_support::placeholders;

use crate::user_reader::{USER_BY_ID_QUERY, users_projection};

/// `users` row for team-owner summaries. The full column list matches the
/// source `db.query(User)` rendering; `users.git_info` is a JSON column and
/// decodes as JSON. Fields the endpoint does not read carry
/// `#[allow(dead_code)]`.
#[derive(Debug, FromMysqlRow)]
pub struct UserSummaryRow {
    pub users_id: i64,
    pub users_user_name: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    #[allow(dead_code)]
    pub users_email: Option<String>,
    #[allow(dead_code)]
    pub users_git_info: brz_mysql::Json<brz_json::OpaqueJson>,
    #[allow(dead_code)]
    pub users_is_active: i8,
    #[allow(dead_code)]
    #[mysql(rename = "users_role")]
    pub users_role: String,
    #[allow(dead_code)]
    pub users_auth_source: String,
    #[allow(dead_code)]
    pub users_preferences: String,
    #[allow(dead_code)]
    pub users_created_at: Option<chrono::NaiveDateTime>,
    #[allow(dead_code)]
    pub users_updated_at: Option<chrono::NaiveDateTime>,
}

/// Team-owner user summaries. `ids` must be in the source's Python-set
/// order; the SQL renders the same full column
/// list `db.query(User)` produces.
pub async fn users_by_ids<M>(mysql: &M, ids: &[i64]) -> MysqlResult<Vec<UserSummaryRow>>
where
    M: Mysql,
{
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {} \
         FROM users \
         WHERE users.id IN ({})",
        users_projection(),
        placeholders(ids.len()),
    );
    mysql.fetch_all(sql.as_str(), ids.to_vec()).await
}

/// One user by id (`db.query(User).filter(User.id == user_id).first()`),
/// used by the public-model `allowedUsers` check. The source statement uses
/// `.first()`, so the rendering carries `LIMIT 1`.
pub async fn user_by_id<M>(mysql: &M, id: i64) -> MysqlResult<Option<UserSummaryRow>>
where
    M: Mysql,
{
    mysql.fetch_optional(USER_BY_ID_QUERY, (id,)).await
}
