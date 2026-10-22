// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PUT /api/users/me` — update the current user's profile.
//!
//! Mirrors `app.api.endpoints.users.update_current_user_endpoint` and
//! `app.services.user.UserService.update_current_user` as wrapped by the
//! application's registered update hooks:
//! authenticate the bearer session (`app.core.security.get_current_user`),
//! apply the `UserUpdate` to the stored `users` row with the ORM-shaped
//! `UPDATE`, invalidate the deployment user cache, commit, and refresh the row.
//! When the registered `UserGitInfoMasker` returns a masked `git_info` for the
//! refreshed row (the patch's step 3), the masked document is persisted with a
//! second `UPDATE` + cache invalidation + `COMMIT` + refresh. Every service
//! failure collapses to `HTTPException(400, str(e))`.
mod git_info;
mod request;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json};
use serde_json::Value;

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::json_compat::python_json_value;
use crate::state::AppState;
use crate::user_reader::USER_ENTITY_BY_ID_QUERY;
use crate::users_me::{UserView, current_user_response, stored_git_info};
use request::UserUpdate;

/// `shared.utils.crypto`-backed `security.get_password_hash` cost
/// (`passlib` `CryptContext(schemes=["bcrypt"])` default).
const BCRYPT_COST: u32 = bcrypt::DEFAULT_COST;

/// `PUT /api/users/me`: the update free function, injecting the
/// process-lifetime application state.
#[brz_http_server::put("/api/users/me")]
async fn update_current_user_route(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: Value,
) -> Result<UserView, FastApiError> {
    update_current_user(state, user.0, body).await
}

/// Handler body for `PUT /api/users/me`.
async fn update_current_user(
    state: &AppState,
    user: UserRow,
    body: Value,
) -> Result<UserView, FastApiError> {
    let update = UserUpdate::decode(&body)?;
    // The endpoint wraps `update_current_user` + `_build_user_response` in a
    // `try/except Exception` that re-raises `HTTPException(400, str(error))`.
    let refreshed = apply_update(state, &user, &update)
        .await
        .map_err(|detail| FastApiError::detail(StatusCode::BAD_REQUEST, detail))?;
    Ok(current_user_response(
        &refreshed,
        state.user_profile.current_user_ext(&refreshed),
        stored_git_info(&refreshed),
    ))
}

/// One changed `users` column in table order, with the value bound as a
/// string (SQLAlchemy's own rendering for the `String`/`JSON` columns here).
struct Change {
    column: &'static str,
    value: String,
}

/// What the step-2 `db.add(user); db.commit()` emits.
struct Step2Plan<'a> {
    /// The columns the ORM `UPDATE` writes; `None` when the change set is empty.
    update: Option<&'a [Change]>,
    /// The `User` `after_update` cache invalidation.
    invalidate: bool,
    /// The `db.commit()` `COMMIT`.
    commit: bool,
}

/// The step-2 flush for a row that may be dirty. SQLAlchemy drops an assigned
/// column from the `UPDATE` when it equals the loaded value, so a no-op
/// assignment writes no column; the row stays dirty, so the `after_update`
/// listener still invalidates the deployment cache and `db.commit()` still
/// emits `COMMIT`. A row with no assignment at all flushes nothing.
fn step2_plan(dirty: bool, changes: &[Change]) -> Step2Plan<'_> {
    Step2Plan {
        update: (!changes.is_empty()).then_some(changes),
        invalidate: dirty,
        commit: dirty,
    }
}

/// `UserService.update_current_user`: resolve each change, persist them with a
/// single `UPDATE`, invalidate the user cache, commit and refresh. The returned
/// `Err` is the source exception message.
async fn apply_update(
    state: &AppState,
    user: &UserRow,
    update: &UserUpdate,
) -> Result<UserRow, String> {
    let mut new_user_name: Option<String> = None;
    let mut new_email: Option<String> = None;
    let mut new_git_info: Option<Vec<Value>> = None;
    let mut new_hash: Option<String> = None;
    let mut new_preferences: Option<String> = None;
    let mut target_change: Option<String> = None;
    // Every source `if obj_in.<field>:` block assigns the ORM attribute, which
    // marks the row dirty. The `after_update` listener then invalidates the
    // cache during flush even when SQLAlchemy emits no `UPDATE` because each
    // assigned value already matched the loaded row.
    let mut dirty = false;

    // `if obj_in.user_name:` — uniqueness against the deployment reader.
    if let Some(name) = update.user_name.as_deref().filter(|name| !name.is_empty()) {
        if let Some(existing) = state
            .user_reader
            .get_by_name(name)
            .await
            .map_err(|error| error.to_string())?
            && existing.id != i64::from(user.id)
        {
            return Err("User with this username already exists".to_string());
        }
        new_user_name = Some(name.to_string());
        dirty = true;
    }

    // `if obj_in.email:` — an EmailStr validated at request decode.
    if let Some(email) = update.email.as_deref().filter(|email| !email.is_empty()) {
        new_email = Some(email.to_string());
        dirty = true;
    }

    // `if obj_in.git_info is not None:` — validate and merge the credentials.
    if let Some(incoming) = update.git_info.as_deref() {
        let existing = user.git_info.0.to_value();
        let merged = git_info::merge(&state.git_repositories.client(), &existing, incoming).await?;
        // `if user.email is None or user.email == ""`.
        let current_email = new_email.clone().or_else(|| user.email.clone());
        if current_email.as_deref().is_none_or(str::is_empty)
            && let Some(email) = merged
                .first()
                .and_then(|item| item.get("git_email"))
                .and_then(Value::as_str)
        {
            new_email = Some(email.to_string());
        }
        new_git_info = Some(merged);
        dirty = true;
    }

    // `if obj_in.password:` — re-hash the credential.
    if let Some(plain) = update
        .credential
        .as_deref()
        .filter(|plain| !plain.is_empty())
    {
        new_hash = Some(hash_credential(plain.to_string()).await?);
        dirty = true;
    }

    // `if obj_in.preferences is not None:` — merge the exclude_unset document.
    if let Some(dump) = update.preferences_dump(state.user_profile.as_ref()) {
        let (document, changed_target) = merge_preferences(&user.preferences, &dump)?;
        new_preferences = Some(document);
        target_change = changed_target;
        dirty = true;
    }

    // The ORM `UPDATE` sets only the columns whose value actually changed, in
    // table order. SQLAlchemy drops an assigned column from the statement when
    // it equals the loaded value, so a no-op assignment leaves the row dirty
    // but writes no column.
    let cache_name = new_user_name
        .clone()
        .unwrap_or_else(|| user.user_name.clone());
    let mut changes: Vec<Change> = Vec::new();
    if let Some(name) = new_user_name.filter(|name| name != &user.user_name) {
        changes.push(Change {
            column: "user_name",
            value: name,
        });
    }
    if let Some(hash) = new_hash.filter(|hash| hash != &user.users_password_hash) {
        changes.push(Change {
            column: "password_hash",
            value: hash,
        });
    }
    if let Some(email) = new_email.filter(|email| Some(email) != user.email.as_ref()) {
        changes.push(Change {
            column: "email",
            value: email,
        });
    }
    if let Some(git_info) =
        new_git_info.filter(|merged| Value::Array(merged.clone()) != user.git_info.0.to_value())
    {
        changes.push(Change {
            column: "git_info",
            value: python_json_value(&Value::Array(git_info)),
        });
    }
    if let Some(preferences) = new_preferences.filter(|document| document != &user.preferences) {
        changes.push(Change {
            column: "preferences",
            value: preferences,
        });
    }

    let plan = step2_plan(dirty, &changes);
    if let Some(update) = plan.update {
        execute_update(&state.mysql, user.id, update).await?;
    }
    if plan.invalidate {
        // The `User` `after_update` listener runs during flush, before COMMIT.
        invalidate_user_cache(state, user.id, &cache_name).await?;
    }
    if plan.commit {
        state
            .mysql
            .execute("COMMIT", ())
            .await
            .map_err(|error| error.to_string())?;
    }

    // `db.refresh(user)`: re-read the row after the commit.
    let mut refreshed = read_user(state, user.id).await?;

    // The application patch (`patched_update_current_user` step 3) re-masks the
    // refreshed `git_info` and commits it a second time whenever the masked
    // document is not `None`. The source wraps it in `try/except Exception:
    // pass`, so a failed second write keeps the pre-mask row.
    if let Some(masked) = state
        .user_git_info_mask
        .masked_git_info(&refreshed.git_info.0.to_value())
        .await
    {
        match write_masked_git_info(state, user.id, &cache_name, masked).await {
            Ok(row) => refreshed = row,
            Err(error) => {
                tracing::warn!(%error, user_id = user.id, "git_info masking write failed");
            }
        }
    }

    // `_send_default_device_notification_async` is a detached side effect that
    // needs the IM channel subsystem; it is reported as a missing capability
    // rather than silently dropped. The response is not affected.
    if let Some(target) = target_change {
        tracing::warn!(
            user_id = user.id,
            %target,
            "default_execution_target changed; IM notification subsystem is not migrated"
        );
    }

    Ok(refreshed.into_user_row())
}

/// `userReader.invalidate_user_cache` (`UserService` `_on_change`): the
/// `user:v2:data:{id}` and `user:v2:idx:name:{name}` deletion.
async fn invalidate_user_cache(state: &AppState, id: i32, cache_name: &str) -> Result<(), String> {
    state
        .user_reader
        .invalidate_user_cache(i64::from(id), cache_name)
        .await
        .map_err(|error| error.to_string())
}

/// `db.get(User, id)`: the refreshed response row with the unlabeled column
/// projection.
async fn read_user(state: &AppState, id: i32) -> Result<UserEntityRow, String> {
    let row: Option<UserEntityRow> = state
        .mysql
        .fetch_optional(USER_ENTITY_BY_ID_QUERY, (id,))
        .await
        .map_err(|error| error.to_string())?;
    row.ok_or_else(|| "User not found".to_string())
}

/// `patched_update_current_user` step 3's second write: `UPDATE users SET
/// git_info=…, updated_at=now()`, cache invalidation, `COMMIT`, then
/// `db.refresh`.
async fn write_masked_git_info(
    state: &AppState,
    id: i32,
    cache_name: &str,
    masked: Value,
) -> Result<UserEntityRow, String> {
    let change = Change {
        column: "git_info",
        value: python_json_value(&masked),
    };
    execute_update(&state.mysql, id, std::slice::from_ref(&change)).await?;
    invalidate_user_cache(state, id, cache_name).await?;
    state
        .mysql
        .execute("COMMIT", ())
        .await
        .map_err(|error| error.to_string())?;
    read_user(state, id).await
}

/// `security.get_password_hash`: `passlib` bcrypt hashing, bounded on the
/// blocking pool because it is CPU-heavy.
async fn hash_credential(credential: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || bcrypt::hash(credential, BCRYPT_COST))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// The ORM `UPDATE users SET … , updated_at=now() WHERE users.id = ?` with only
/// the changed columns, in table order.
async fn execute_update(
    mysql: &brz_mysql::MysqlService,
    id: i32,
    changes: &[Change],
) -> Result<(), String> {
    let mut sql = String::from("UPDATE users SET ");
    for (index, change) in changes.iter().enumerate() {
        if index > 0 {
            sql.push_str(", ");
        }
        sql.push_str(change.column);
        sql.push_str("=?");
    }
    sql.push_str(", updated_at=now() WHERE users.id = ");
    sql.push_str(&id.to_string());
    let params: Vec<String> = changes.iter().map(|change| change.value.clone()).collect();
    mysql
        .execute(sql.as_str(), params)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// `if obj_in.preferences is not None:` merge block. Returns the serialized
/// merged document and the `default_execution_target` value when the request
/// changed it.
fn merge_preferences(
    stored: &str,
    dump: &serde_json::Map<String, Value>,
) -> Result<(String, Option<String>), String> {
    let existing = parse_stored_preferences(stored)?;
    let incoming = dump.clone();
    let old_target = existing.get("default_execution_target").cloned();
    let new_target = incoming.get("default_execution_target").cloned();
    let mut merged = existing;
    for (key, value) in incoming {
        merged.insert(key, value);
    }
    let document = python_json_value(&Value::Object(merged));
    let target_change = match new_target {
        Some(Value::String(target))
            if Some(&Value::String(target.clone())) != old_target.as_ref() =>
        {
            Some(target)
        }
        _ => None,
    };
    Ok((document, target_change))
}

/// `existing_prefs = json.loads(user.preferences) if user.preferences else {}`.
/// A non-object document is the source's `json.loads`/`{**…}` failure.
fn parse_stored_preferences(stored: &str) -> Result<serde_json::Map<String, Value>, String> {
    if stored.is_empty() {
        return Ok(serde_json::Map::new());
    }
    match serde_json::from_str::<Value>(stored) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(other) => Err(format!(
            "argument of type 'NoneType' is not a mapping: {other}"
        )),
        Err(error) => Err(error.to_string()),
    }
}

/// The `db.get(User, id)` entity re-read after the commit: the unlabeled column
/// projection plus the labeled `UserRow` conversion the response needs.
#[derive(Debug, FromMysqlRow)]
struct UserEntityRow {
    id: i32,
    user_name: String,
    password_hash: String,
    email: Option<String>,
    git_info: Json<brz_json::OpaqueJson>,
    is_active: i8,
    role: String,
    auth_source: String,
    preferences: String,
    created_at: chrono::NaiveDateTime,
    updated_at: chrono::NaiveDateTime,
}

impl UserEntityRow {
    fn into_user_row(self) -> UserRow {
        UserRow {
            id: self.id,
            user_name: self.user_name,
            users_password_hash: self.password_hash,
            email: self.email,
            git_info: self.git_info,
            is_active: self.is_active,
            role: self.role,
            auth_source: self.auth_source,
            preferences: self.preferences,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The merged document is `json.dumps({**existing, **new_prefs})`: existing
    /// key order preserved, updated keys replaced in place, non-ASCII escaped
    /// (`ensure_ascii=True`), `", "`/`": "` separators.
    #[test]
    fn merge_preferences_matches_python_json_dumps() {
        let stored =
            r#"{"keep": 1, "wework_new_chat_model_selection": {"modelName": "old"}, "tail": true}"#;
        let dump = json!({"wework_new_chat_model_selection": {"modelName": "公网", "modelType": "public"}})
            .as_object()
            .unwrap()
            .clone();
        let (document, target) = merge_preferences(stored, &dump).unwrap();
        assert_eq!(
            document,
            r#"{"keep": 1, "wework_new_chat_model_selection": {"modelName": "\u516c\u7f51", "modelType": "public"}, "tail": true}"#
        );
        assert_eq!(target, None);
    }

    /// A preferences update whose merged document already equals the stored
    /// string is a no-op assignment: SQLAlchemy marks the row dirty but writes
    /// no `preferences` column, so the change detection must drop it. The row
    /// is Python `json.dumps` output (`ensure_ascii=True`), which
    /// `python_json_value` reproduces.
    #[test]
    fn unchanged_preferences_document_matches_stored_string() {
        let existing = json!({
            "employee_id": null,
            "company_profile": {"name": "Example User", "employee_id": "10001"},
            "wework_new_chat_model_selection": {
                "modelName": "sample-model",
                "modelType": "public",
                "options": {
                    "reasoning": "high",
                    "weworkCloudModelNamespace": "default",
                    "weworkCloudModelResourceUserId": "0"
                }
            }
        });
        let stored = python_json_value(&existing);
        let dump = json!({
            "wework_new_chat_model_selection": {
                "modelName": "sample-model",
                "modelType": "public",
                "options": {
                    "reasoning": "high",
                    "weworkCloudModelNamespace": "default",
                    "weworkCloudModelResourceUserId": "0"
                }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let (document, target) = merge_preferences(&stored, &dump).unwrap();
        assert_eq!(
            document, stored,
            "an unchanged merge must render byte-identical to the stored row"
        );
        assert_eq!(target, None);
    }

    /// A dirty-but-unchanged step-2 row still invalidates the cache and emits
    /// its `COMMIT`; only the `UPDATE` is dropped. A row with no assignment
    /// flushes nothing at all.
    #[test]
    fn dirty_but_unchanged_row_still_invalidates_and_commits() {
        let idle = step2_plan(false, &[]);
        assert!(idle.update.is_none());
        assert!(!idle.invalidate);
        assert!(!idle.commit);

        let noop = step2_plan(true, &[]);
        assert!(noop.update.is_none(), "a no-op assignment writes no column");
        assert!(
            noop.invalidate,
            "the after_update listener still invalidates"
        );
        assert!(noop.commit, "db.commit() still emits COMMIT");

        let changed = [Change {
            column: "preferences",
            value: "{}".to_string(),
        }];
        let plan = step2_plan(true, &changed);
        assert_eq!(plan.update.map(<[Change]>::len), Some(1));
        assert!(plan.invalidate);
        assert!(plan.commit);
    }

    /// A new key is appended in the dump's declaration order.
    #[test]
    fn merge_preferences_appends_new_keys() {
        let stored = r#"{"employee_id": "1"}"#;
        let dump = json!({
            "send_key": "cmd_enter",
            "wework_project_execution_mode": "git_worktree"
        })
        .as_object()
        .unwrap()
        .clone();
        let (document, _) = merge_preferences(stored, &dump).unwrap();
        assert_eq!(
            document,
            r#"{"employee_id": "1", "send_key": "cmd_enter", "wework_project_execution_mode": "git_worktree"}"#
        );
    }

    /// `default_execution_target` is reported only when the incoming document
    /// sets it to a different string.
    #[test]
    fn merge_preferences_reports_a_changed_default_target() {
        let stored = r#"{"default_execution_target": "cloud"}"#;
        let dump = json!({"default_execution_target": "device-9"})
            .as_object()
            .unwrap()
            .clone();
        let (_, target) = merge_preferences(stored, &dump).unwrap();
        assert_eq!(target.as_deref(), Some("device-9"));

        let unchanged = json!({"default_execution_target": "cloud"})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(merge_preferences(stored, &unchanged).unwrap().1, None);
    }

    /// An empty stored document is `{}`; a non-object document is the source's
    /// `json.loads`/`{**…}` failure.
    #[test]
    fn parse_stored_preferences_rejects_non_objects() {
        assert!(parse_stored_preferences("").unwrap().is_empty());
        assert!(parse_stored_preferences("null").is_err());
        assert!(parse_stored_preferences("not json").is_err());
    }
}
