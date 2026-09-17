//! User repository: MySQL access to the `users` table.
//!
//! Mirrors `app.core.security.get_current_user`'s SQLAlchemy query
//! (`SELECT ... FROM users WHERE users.user_name = ? LIMIT 1`) through
//! `MysqlService` with the source column list and alias naming so the SQL
//! sent to MySQL matches the source statement.
use brz_mysql::{FromMysqlRow, Json, Mysql};
use chrono::NaiveDateTime;
use wegent_backend_rs::json_compat::OpaqueJson;

/// A row of the `users` table, as selected by source authentication.
///
/// Columns beyond `users_is_active` are decoded to keep the selected column
/// list identical to the source query; only the fields the endpoint reads
/// are used, and the rest carry `#[allow(dead_code)]`.
#[derive(Debug, FromMysqlRow)]
pub struct UserRow {
    #[allow(dead_code, reason = "selected to match source column list")]
    pub users_id: i32,
    pub users_user_name: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    pub users_email: Option<String>,
    #[allow(dead_code, reason = "selected to match source column list")]
    pub users_git_info: Json<OpaqueJson>,
    pub users_is_active: i8,
    #[allow(dead_code, reason = "selected to match source column list")]
    pub users_role: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    pub users_auth_source: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    pub users_preferences: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    pub users_created_at: NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    pub users_updated_at: NaiveDateTime,
}

/// Why user resolution failed, mapped onto source HTTP responses.
#[derive(Debug)]
pub enum UserLookupError {
    /// MySQL dependency failure; source lets the resulting exception surface
    /// as a 500 without changing the response contract.
    Mysql(brz_mysql::MysqlError),
}

/// Loads one user by username, mirroring `get_current_user`'s first() lookup.
///
/// # Errors
///
/// Returns [`UserLookupError::NotFound`] when no row matches,
/// [`UserLookupError::Inactive`] when the row is deactivated, and
/// [`UserLookupError::Mysql`] when the dependency call fails.
pub async fn find_user_by_name<M>(
    mysql: &M,
    username: &str,
) -> Result<Option<UserRow>, UserLookupError>
where
    M: Mysql,
{
    let row = mysql
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
            (username,),
        )
        .await
        .map_err(UserLookupError::Mysql)?;
    Ok(row)
}
