// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! CLI OIDC user persistence with writer-owned transaction boundaries.
use brz_mysql::{MysqlError, MysqlService, MysqlTransaction};
use serde_json::{Map, Value};

use super::{EMPLOYEE_ID_PREFERENCE_KEY, random_uuid_v4, store_employee_id_preference};
use crate::sql_support::StatementArg;
use crate::user_reader::USER_ENTITY_BY_ID_QUERY;

pub(super) struct ResolvedUser {
    pub(super) id: i32,
    pub(super) user_name: String,
    pub(super) is_active: bool,
    pub(super) created: bool,
}

const RESOLUTION_FAILED: &str = "CLI OIDC user resolution failed";

/// Commit before applying defaults or checking the account's active state.
/// Reload before commit on this writer, so a replica cannot hide the new row.
pub(super) async fn resolve_user(
    mysql: &MysqlService,
    user_name: &str,
    email: &str,
    employee_id: Option<&str>,
) -> Result<ResolvedUser, String> {
    let mut failure = None;
    let result = mysql
        .with_transaction(async |transaction| {
            resolve_user_on(transaction, user_name, email, employee_id)
                .await
                .map_err(|message| {
                    failure = Some(message);
                    MysqlError::InvalidQuery {
                        reason: RESOLUTION_FAILED.into(),
                    }
                })
        })
        .await;
    match result {
        Ok(user) => Ok(user),
        Err(MysqlError::InvalidQuery { reason }) if reason == RESOLUTION_FAILED => {
            Err(failure.expect("resolution failure was captured before rollback"))
        }
        Err(error) => Err(error.to_string()),
    }
}

/// The `db.scalar(select(User).where(User.user_name == user_name))` statement:
/// the bare mapped columns with no `AS users_<column>` labels and no `LIMIT`,
/// exactly as SQLAlchemy renders a `select(User)` scalar read. The recorded
/// exchange for this route carries the same projection and predicate.
pub(super) const USER_ENTITY_BY_NAME_QUERY: &str = "SELECT users.id, users.user_name, users.password_hash, users.email, users.git_info, users.is_active, users.`role`, users.auth_source, users.preferences, users.created_at, users.updated_at FROM users WHERE users.user_name = ?";

/// `security.get_password_hash`: a bcrypt hash of a fresh `uuid.uuid4()`
/// string. The local user has no usable password (OIDC-only account).
const INSERT_USER_QUERY: &str = "INSERT INTO users (user_name, password_hash, email, git_info, is_active, `role`, auth_source, preferences, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'user', 'oidc', ?, NOW(), NOW())";

/// The `users` row projection the source's `select(User)` reads carry.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct CliUserRow {
    id: i32,
    user_name: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    password_hash: String,
    email: Option<String>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    git_info: brz_mysql::Json<brz_json::OpaqueJson>,
    is_active: i8,
    #[allow(dead_code, reason = "selected to match the source column list")]
    role: String,
    auth_source: String,
    preferences: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match the source column list")]
    updated_at: chrono::NaiveDateTime,
}

/// Resolve and refresh the local user on the same scoped writer connection.
async fn resolve_user_on<T: MysqlTransaction>(
    transaction: &mut T,
    user_name: &str,
    email: &str,
    employee_id: Option<&str>,
) -> Result<ResolvedUser, String> {
    let existing: Option<CliUserRow> = transaction
        .fetch_optional(USER_ENTITY_BY_NAME_QUERY, (user_name,))
        .await
        .map_err(|error| error.to_string())?;
    let created = existing.is_none();
    let user = match existing {
        Some(user) => {
            update_changed_columns(transaction, &user, email, employee_id).await?;
            refresh_user(transaction, user.id).await?
        }
        None => create_user(transaction, user_name, email, employee_id).await?,
    };
    Ok(ResolvedUser {
        id: user.id,
        user_name: user.user_name,
        is_active: user.is_active != 0,
        created,
    })
}

/// `db.refresh(user)`: the identity-map reload by primary key.
async fn refresh_user<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i32,
) -> Result<CliUserRow, String> {
    transaction
        .fetch_optional(USER_ENTITY_BY_ID_QUERY, (user_id,))
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "OIDC user row disappeared on refresh".to_string())
}

/// The existing-user branch. SQLAlchemy's unit of work emits one UPDATE
/// carrying only the changed mapped columns, in model declaration order
/// (`email`, `auth_source`, `preferences`); nothing changed emits no write,
/// which is what the recorded exchange shows for this route.
async fn update_changed_columns<T: MysqlTransaction>(
    transaction: &mut T,
    user: &CliUserRow,
    email: &str,
    employee_id: Option<&str>,
) -> Result<(), String> {
    let mut assignments: Vec<(&'static str, StatementArg)> = Vec::new();
    if user.email.as_deref() != Some(email) {
        assignments.push(("email = ?", StatementArg::Str(email.to_string())));
    }
    if user.auth_source == "unknown" {
        assignments.push(("auth_source = ?", StatementArg::Str("oidc".to_string())));
    }
    if let Some(preferences) = store_employee_id_preference(&user.preferences, employee_id) {
        assignments.push(("preferences = ?", StatementArg::Str(preferences)));
    }
    if assignments.is_empty() {
        return Ok(());
    }
    let set_clause = assignments
        .iter()
        .map(|(clause, _)| *clause)
        .collect::<Vec<_>>()
        .join(", ");
    let mut arguments: Vec<StatementArg> = assignments
        .into_iter()
        .map(|(_, argument)| argument)
        .collect();
    arguments.push(StatementArg::Int(i64::from(user.id)));
    transaction
        .execute(
            format!("UPDATE users SET {set_clause}, updated_at = NOW() WHERE users.id = ?"),
            arguments,
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// The new-user branch: `User(...)` with the source's field values, then the
/// `db.refresh` reload by the inserted primary key.
async fn create_user<T: MysqlTransaction>(
    transaction: &mut T,
    user_name: &str,
    email: &str,
    employee_id: Option<&str>,
) -> Result<CliUserRow, String> {
    // `security.get_password_hash(str(uuid.uuid4()))` — bcrypt is CPU-heavy,
    // so it runs on the blocking pool like the login path's verification.
    let password_hash =
        tokio::task::spawn_blocking(|| bcrypt::hash(random_uuid_v4(), bcrypt::DEFAULT_COST))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;

    let mut preferences = Map::new();
    if let Some(employee_id) = employee_id {
        preferences.insert(
            EMPLOYEE_ID_PREFERENCE_KEY.to_string(),
            Value::String(employee_id.to_string()),
        );
    }
    let preferences =
        crate::internal_callback::py_json::python_dumps_utf8(&Value::Object(preferences));

    let execution = transaction
        .execute(
            INSERT_USER_QUERY,
            (
                user_name,
                password_hash.as_str(),
                email,
                "[]",
                preferences.as_str(),
            ),
        )
        .await
        .map_err(|error| error.to_string())?;
    #[allow(
        clippy::cast_possible_truncation,
        reason = "AUTO_INCREMENT id fits i32"
    )]
    let user_id = execution.last_insert_id as i32;
    refresh_user(transaction, user_id).await
}
