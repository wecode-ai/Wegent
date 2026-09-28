// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Users repository mirroring `Wegent/backend/app/core/security.py`
//! (`get_current_user`'s direct `db.query(User).filter(User.user_name ==
//! username).first()`; it uses the public direct reader).
use anyhow::Result;

use brz_mysql::Mysql;

use super::auth::model::{AuthUser, UserRow};

/// Users repository for the authentication path.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Users;

/// `get_current_user`'s user-by-name statement, rendered exactly as
/// SQLAlchemy labels it.
#[allow(
    dead_code,
    reason = "route authentication now runs through AppAuthenticator"
)]
pub(crate) const USER_BY_NAME_QUERY: &str = "SELECT users.id AS users_id, \
     users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.user_name = ? \
     LIMIT 1";

impl Users {
    /// Load a user by name, including inactive users, exactly like the
    /// source's direct SQLAlchemy query (authentication only needs the user
    /// record, then checks `is_active`).
    #[allow(
        dead_code,
        reason = "route authentication now runs through AppAuthenticator"
    )]
    pub(crate) async fn get_user_by_name<M>(
        &self,
        mysql: &M,
        user_name: &str,
    ) -> Result<Option<AuthUser>>
    where
        M: Mysql,
    {
        let row: Option<UserRow> = mysql
            .fetch_optional(USER_BY_NAME_QUERY, (user_name,))
            .await?;
        Ok(row.map(AuthUser::from))
    }
}
