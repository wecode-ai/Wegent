// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Deployment extension point for the `userReader` service
//! (`app/services/readers/users.py`): `userReader.get_by_id` and
//! `userReader.get_by_name`.
//!
//! The public reader (`UserReader.get_by_id` / `get_by_name`) performs
//! direct SQL lookups. An application whose source deployment replaces the
//! reader (for example with the Redis read-through cache behind
//! `SERVICE_EXTENSION`) registers its implementation through
//! `AppState::user_reader` before route construction. The lite task
//! projection does not consume the returned row, so only the call topology
//! and side effects are observable through that endpoint; the responses API
//! authentication consumes the auth fields of both lookups.
use async_trait::async_trait;

use crate::auth::UserRow;

/// The `users` model a `userReader` lookup returns: `UserReader.get_by_id`
/// and `get_by_name` hand back the complete mapped `User`, so the record
/// carries every column of the source's `db.query(User)` projection in table
/// order. A deployment reader that replaces the public one therefore derives
/// the same values the source reader returns; consumers that only need
/// `id`, `user_name`, and `is_active` ignore the rest.
#[derive(Debug, Clone)]
pub struct UserRecord {
    pub id: i64,
    pub user_name: String,
    pub password_hash: String,
    pub email: Option<String>,
    /// `users.git_info`: the decoded JSON document (`JSON` columns restore
    /// Python `None` as JSON `null`).
    pub git_info: serde_json::Value,
    pub is_active: bool,
    pub role: String,
    pub auth_source: String,
    pub preferences: String,
    pub created_at: chrono::NaiveDateTime,
    pub updated_at: chrono::NaiveDateTime,
}

impl UserRecord {
    /// Decode one `users` projection row (columns labeled `users_<column>`)
    /// into the record.
    pub fn from_mysql_row(row: &brz_mysql::MysqlRow) -> brz_mysql::MysqlResult<Self> {
        Ok(Self {
            id: row.get_required::<i64>("users_id")?,
            user_name: row.get_required::<String>("users_user_name")?,
            password_hash: row.get_required::<String>("users_password_hash")?,
            email: row.get::<String>("users_email")?,
            git_info: row
                .get::<serde_json::Value>("users_git_info")?
                .unwrap_or(serde_json::Value::Null),
            is_active: row.get_required::<i8>("users_is_active")? != 0,
            role: row.get_required::<String>("users_role")?,
            auth_source: row.get_required::<String>("users_auth_source")?,
            preferences: row.get_required::<String>("users_preferences")?,
            created_at: row.get_required::<chrono::NaiveDateTime>("users_created_at")?,
            updated_at: row.get_required::<chrono::NaiveDateTime>("users_updated_at")?,
        })
    }
}

/// `userReader.get_by_id(db, user_id)` and `userReader.get_by_name(db,
/// user_name)`: the complete deployment-specific read paths, including any
/// cache. `Err` is an infrastructure failure.
#[async_trait]
pub trait UserByIdReader: Send + Sync {
    /// `userReader.get_by_id` (`db.query(User).filter(User.id == user_id)
    /// .first()`).
    async fn get_by_id(&self, user_id: i64) -> anyhow::Result<Option<UserRecord>>;

    /// `userReader.get_by_name` (`db.query(User).filter(User.user_name ==
    /// user_name).first()`).
    async fn get_by_name(&self, user_name: &str) -> anyhow::Result<Option<UserRecord>>;

    /// `db.get(User, user_id)`: the `Session.get` entity lookup with the
    /// unlabeled column projection and no `LIMIT`. Unlike
    /// [`Self::get_by_id`], this is the ORM identity-map read the item and
    /// agent projections use, and its statement shape must match the
    /// recorded exchange for replay.
    async fn get_entity_by_id(&self, user_id: i64) -> anyhow::Result<Option<UserRecord>>;

    /// Drop any cached copy of the committed `users` row
    /// (`CachedUserReader.on_change`, driven by the source's SQLAlchemy
    /// `after_update` event on the `User` model). The public SQL reader keeps
    /// no cache, so the default is a no-op; a deployment whose reader is a
    /// read-through cache deletes `user:v2:data:{user_id}` and
    /// `user:v2:idx:name:{user_name}` here.
    async fn invalidate_user_cache(&self, _user_id: i64, _user_name: &str) -> anyhow::Result<()> {
        Ok(())
    }
}

/// The public direct-SQL reader (`UserReader.get_by_id` / `get_by_name`).
pub struct PublicUserReader {
    mysql: brz_mysql::MysqlService,
}

impl PublicUserReader {
    pub fn new(mysql: brz_mysql::MysqlService) -> Self {
        Self { mysql }
    }
}

#[async_trait]
impl UserByIdReader for PublicUserReader {
    async fn get_by_id(&self, user_id: i64) -> anyhow::Result<Option<UserRecord>> {
        let row: Option<UserRow> = self
            .mysql
            .fetch_optional(USER_BY_ID_QUERY, (user_id,))
            .await?;
        Ok(row.map(UserRecord::from))
    }

    async fn get_by_name(&self, user_name: &str) -> anyhow::Result<Option<UserRecord>> {
        let row: Option<UserRow> = self
            .mysql
            .fetch_optional(USER_BY_NAME_QUERY, (user_name,))
            .await?;
        Ok(row.map(UserRecord::from))
    }

    async fn get_entity_by_id(&self, user_id: i64) -> anyhow::Result<Option<UserRecord>> {
        let row: Option<UserEntityRow> = self
            .mysql
            .fetch_optional(USER_ENTITY_BY_ID_QUERY, (user_id,))
            .await?;
        Ok(row.map(UserRecord::from))
    }
}

impl From<UserRow> for UserRecord {
    fn from(row: UserRow) -> Self {
        Self {
            id: i64::from(row.id),
            user_name: row.user_name,
            password_hash: row.users_password_hash,
            email: row.email,
            git_info: row.git_info.0.to_value(),
            is_active: row.is_active != 0,
            role: row.role,
            auth_source: row.auth_source,
            preferences: row.preferences,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// One `db.get(User, id)` row: the unlabeled entity projection SQLAlchemy
/// renders for a `Session.get` lookup.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct UserEntityRow {
    id: i64,
    user_name: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    password_hash: String,
    email: Option<String>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    git_info: brz_mysql::Json<brz_json::OpaqueJson>,
    is_active: i8,
    #[allow(dead_code, reason = "selected to match the source column list")]
    role: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    auth_source: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    preferences: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match the source column list")]
    updated_at: chrono::NaiveDateTime,
}

impl From<UserEntityRow> for UserRecord {
    fn from(row: UserEntityRow) -> Self {
        Self {
            id: row.id,
            user_name: row.user_name,
            password_hash: row.password_hash,
            email: row.email,
            git_info: row.git_info.0.to_value(),
            is_active: row.is_active != 0,
            role: row.role,
            auth_source: row.auth_source,
            preferences: row.preferences,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// The by-id ORM statement SQLAlchemy renders for `UserReader.get_by_id`'s
/// `db.query(User).filter(User.id == user_id).first()`: every mapped
/// column, aliased `users_<column>`.
pub const USER_BY_ID_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.id = ? \
     LIMIT 1";

/// The labeled `users_<column>` projection shared verbatim by every
/// `db.query(User)` rendering. Derived from [`USER_BY_ID_QUERY`] so the full
/// mapped column list stays defined once for joins that embed the `users`
/// projection (for example the cloud-project member read).
pub(crate) fn users_projection() -> &'static str {
    USER_BY_ID_QUERY
        .strip_prefix("SELECT ")
        .and_then(|rest| rest.split(" FROM users").next())
        .expect("the by-id statement carries the users projection")
}

/// The `Session.get(User, id)` statement SQLAlchemy renders for the ORM
/// identity-map lookup: the bare entity columns with no labels and no
/// `LIMIT`, with the id bound as one parameter.
pub const USER_ENTITY_BY_ID_QUERY: &str = "SELECT users.id, users.user_name, users.password_hash, \
     users.email, users.git_info, users.is_active, users.`role`, users.auth_source, \
     users.preferences, users.created_at, users.updated_at \
     FROM users \
     WHERE users.id = ?";

/// The by-name ORM statement SQLAlchemy renders for `UserReader.get_by_name`'s
/// `db.query(User).filter(User.user_name == user_name).first()`: every mapped
/// column, aliased `users_<column>`.
pub const USER_BY_NAME_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.user_name = ? \
     LIMIT 1";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn by_id_query_matches_the_source_projection() {
        // Every mapped column keeps its SQLAlchemy label and the statement
        // binds exactly one parameter.
        for label in [
            "users_id",
            "users_user_name",
            "users_password_hash",
            "users_email",
            "users_git_info",
            "users_is_active",
            "users_role",
            "users_auth_source",
            "users_preferences",
            "users_created_at",
            "users_updated_at",
        ] {
            assert!(USER_BY_ID_QUERY.contains(label), "missing {label}");
        }
        assert_eq!(USER_BY_ID_QUERY.matches('?').count(), 1);
        assert!(USER_BY_ID_QUERY.contains("WHERE users.id = ? LIMIT 1"));
    }

    #[test]
    fn entity_by_id_query_matches_the_session_get_projection() {
        // `Session.get(User, id)` renders the bare entity columns with no
        // labels and no LIMIT, binding exactly one parameter.
        assert!(!USER_ENTITY_BY_ID_QUERY.contains(" AS users_"));
        assert_eq!(USER_ENTITY_BY_ID_QUERY.matches('?').count(), 1);
        assert!(USER_ENTITY_BY_ID_QUERY.contains("WHERE users.id = ?"));
        assert!(!USER_ENTITY_BY_ID_QUERY.to_uppercase().contains("LIMIT"));
        for column in [
            "users.id, users.user_name, users.password_hash, users.email,",
            "users.git_info, users.is_active, users.`role`, users.auth_source,",
            "users.preferences, users.created_at, users.updated_at",
        ] {
            assert!(USER_ENTITY_BY_ID_QUERY.contains(column), "missing {column}");
        }
    }

    #[test]
    fn by_name_query_matches_the_source_projection() {
        for label in [
            "users_id",
            "users_user_name",
            "users_password_hash",
            "users_email",
            "users_git_info",
            "users_is_active",
            "users_role",
            "users_auth_source",
            "users_preferences",
            "users_created_at",
            "users_updated_at",
        ] {
            assert!(USER_BY_NAME_QUERY.contains(label), "missing {label}");
        }
        assert_eq!(USER_BY_NAME_QUERY.matches('?').count(), 1);
        assert!(USER_BY_NAME_QUERY.contains("WHERE users.user_name = ? LIMIT 1"));
    }
}
