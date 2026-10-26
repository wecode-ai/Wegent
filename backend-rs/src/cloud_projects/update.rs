// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PATCH /api/v1/cloud-projects/{project_id}`: update one cloud project.
//!
//! Mirrors `app.api.endpoints.cloud_projects.update_cloud_project` ->
//! `cloud_project_service.update(db, project_id, current_user.id, values)`
//! followed by `_project_response(db, project, current_user)`.
//!
//! Source pipeline:
//! 1. `get_current_user_jwt_apikey_tasktoken` — JWT session decode plus the
//!    labeled `users` lookup (the twelve-column `users_<column>` projection).
//! 2. `require_cloud_project_role(db, project_id, user_id, Maintainer)` — the
//!    point form of `project_access_query`; no grant raises
//!    `404 "Cloud project not found"`, and a caller below `Maintainer` raises
//!    `403 "Insufficient permission"`.
//! 3. The metadata merge (`merge_metadata`) folds every metadata-backed field
//!    into a copy of the stored `metadata` JSON.
//! 4. `db.query(CloudProject).filter(id ==, version == values.version)`
//!    `.update({**updates, "version": version + 1})` followed by `db.add(...)`
//!    of the public-access grant and `db.commit()`; a lost optimistic-lock race
//!    raises `409 "Cloud project changed"`.
//! 5. `db.refresh(project)` re-reads the row with the unlabeled entity
//!    projection; `_project_response` re-runs `require_cloud_project_role`
//!    (`Viewer`), resolves `_parent_contexts` and `_all_user_grant_roles`, and
//!    renders `CloudProjectResponse`.
//!
//! The post-commit `users` reload reproduces SQLAlchemy's `expire_on_commit`:
//! the response path re-reads the caller by primary key before its first read.
mod fields;
mod metadata;
mod provider;
mod request;
mod statements;

use chrono::Utc;
use serde_json::{Map, Value};

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlTransaction};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::json_compat::python_json_value;
use crate::state::AppState;

use super::response::{self, CloudProjectBody};
use super::{
    ProjectListRow, all_user_grant_roles, cloud_project_not_found, internal_error, parent_contexts,
    parse_project_id, project_access, project_access_point_statement, role_for_priority,
};
use request::CloudProjectUpdate;

/// `ROLE_HIERARCHY`: lower number is the higher privilege.
fn role_level(role: &str) -> i32 {
    match role {
        "Owner" => 0,
        "Maintainer" => 1,
        "Developer" => 2,
        "Reporter" => 3,
        "Viewer" => 4,
        "RestrictedAnalyst" => 5,
        _ => 999,
    }
}

/// `has_permission(user_role, required_role)`.
fn has_permission(user_role: &str, required_role: &str) -> bool {
    role_level(user_role) <= role_level(required_role)
}

/// PATCH /api/v1/cloud-projects/{project_id}: the update free function,
/// injecting the process-lifetime application state.
#[brz_http_server::patch("/api/v1/cloud-projects/:project_id")]
async fn update_cloud_project(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] current_user: SessionUser,
    body: Value,
) -> Result<CloudProjectBody, FastApiError> {
    update_project(state, project_id, &current_user, &body).await
}

/// Marker carried on the sentinel error that ends a rejected transaction.
const REJECTION_PREFIX: &str = "cloud-project update rejected: ";
/// Marker carried on the sentinel error that ends a lost optimistic lock.
const CONFLICT_PREFIX: &str = "cloud-project update conflict: ";

/// A merge branch raised `HTTPException(422, ...)`. The message rides out of
/// `with_transaction` on a sentinel error so the failed transaction rolls back
/// exactly like the source's uncommitted session.
fn rejection(message: String) -> brz_mysql::MysqlError {
    brz_mysql::MysqlError::InvalidQuery {
        reason: format!("{REJECTION_PREFIX}{message}"),
    }
}

/// `db.rollback()` + `HTTPException(409, "Cloud project changed")`: the
/// optimistic-lock UPDATE matched no row, so the transaction must not commit.
fn conflict() -> brz_mysql::MysqlError {
    brz_mysql::MysqlError::InvalidQuery {
        reason: CONFLICT_PREFIX.to_owned(),
    }
}

/// Map a transaction failure to the source's response.
fn map_update_error(error: brz_mysql::MysqlError) -> FastApiError {
    if let brz_mysql::MysqlError::InvalidQuery { reason } = &error {
        if let Some(message) = reason.strip_prefix(REJECTION_PREFIX) {
            return FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, message.to_owned());
        }
        if reason == CONFLICT_PREFIX {
            return FastApiError::detail(StatusCode::CONFLICT, "Cloud project changed");
        }
    }
    internal_error(error)
}

/// Handler body for `PATCH /api/v1/cloud-projects/{project_id}`.
async fn update_project(
    state: &AppState,
    project_id: &str,
    current_user: &SessionUser,
    body: &Value,
) -> Result<CloudProjectBody, FastApiError> {
    // FastAPI validates the path parameter and the body before the endpoint
    // body runs; either failure is a 422 without dependency traffic.
    let project_number = parse_project_id(project_id)?;
    let update = CloudProjectUpdate::decode(body)?;

    // `require_cloud_project_role(db, project_id, user_id, Maintainer)`.
    let user_id = current_user.0.id;
    let target = update_target(&state.mysql, project_number, user_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;
    let role = role_for_priority(target.priority).unwrap_or("RestrictedAnalyst");
    if !has_permission(role, "Maintainer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    let jwt_key = provider::jwt_key();
    state
        .mysql
        .with_transaction(async |transaction| {
            apply_update(transaction, &update, &target, user_id, &jwt_key).await
        })
        .await
        .map_err(map_update_error)?;

    // `db.refresh(project)`: the unlabeled entity projection re-reads the
    // committed row.
    let project = refresh_project(&state.mysql, project_number)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;

    // `expire_on_commit` reloads the caller through a `Session.get` before the
    // response path dereferences `current_user.id`.
    let reloaded_name = reload_user(&state.mysql, user_id)
        .await
        .map_err(internal_error)?
        .unwrap_or_else(|| current_user.0.user_name.clone());

    // `_project_response` -> `require_cloud_project_role(..., Viewer)`.
    let (_, response_priority) = project_access(&state.mysql, project_number, user_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(cloud_project_not_found)?;
    let response_role = role_for_priority(response_priority).unwrap_or("RestrictedAnalyst");

    let project_ids = [project.id.clone()];
    let contexts = parent_contexts(&state.mysql, &project_ids)
        .await
        .map_err(internal_error)?;
    let all_user_roles = all_user_grant_roles(&state.mysql, &project_ids)
        .await
        .map_err(internal_error)?;

    Ok(response::project_response(
        &project,
        user_id,
        &reloaded_name,
        response_role,
        all_user_roles.get(&project.id).map(String::as_str),
        contexts.get(&project.id),
    ))
}

/// `require_cloud_project_role`'s row: the requested project id, its stored
/// `metadata` JSON, and the caller's resolved role priority.
struct UpdateTarget {
    id: String,
    metadata: Map<String, Value>,
    priority: i64,
}

/// The point form of `project_access_query`, projecting only the fields the
/// update needs (the same statement the GET endpoint issues).
async fn update_target<M: Mysql>(
    mysql: &M,
    project_id: i64,
    user_id: i32,
) -> Result<Option<UpdateTarget>, brz_mysql::MysqlError> {
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[mysql(rename = "loop_items_id")]
        id: String,
        #[mysql(rename = "loop_items_metadata")]
        metadata: Option<Json<brz_json::OpaqueJson>>,
        #[mysql(rename = "anon_3_priority")]
        priority: i64,
    }
    let statement = project_access_point_statement(user_id, project_id);
    let row: Option<Row> = mysql.fetch_optional(statement, ()).await?;
    Ok(row.map(|row| UpdateTarget {
        id: row.id,
        metadata: row
            .metadata
            .map(|json| json.0.to_value())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default(),
        priority: row.priority,
    }))
}

/// The transaction body of `cloud_project_service.update`.
async fn apply_update<T: MysqlTransaction>(
    transaction: &mut T,
    update: &CloudProjectUpdate,
    target: &UpdateTarget,
    user_id: i32,
    jwt_key: &str,
) -> brz_mysql::MysqlResult<()> {
    // `updates = values.model_dump(exclude={"version"}, exclude_none=True)`.
    let direct = update.direct_columns();
    let columns: Vec<&str> = direct.iter().map(|(column, _)| *column).collect();
    let values: Vec<&str> = direct.iter().map(|(_, value)| value.as_str()).collect();

    let project_number: i64 = target.id.parse().unwrap_or_default();
    let metadata = if update.touches_metadata() {
        match metadata::merge_metadata(
            transaction,
            target.metadata.clone(),
            update,
            project_number,
            user_id,
            jwt_key,
        )
        .await
        {
            Ok(outcome) => Some(outcome),
            Err(metadata::MergeError::Rejected(message)) => return Err(rejection(message)),
            Err(metadata::MergeError::Db(error)) => return Err(error),
        }
    } else {
        None
    };
    let metadata_json = metadata
        .as_ref()
        .map(|outcome| python_json_value(&Value::Object(outcome.metadata.clone())));

    // `db.query(CloudProject).filter(id ==, version == values.version).update(...)`.
    //
    // The source renders the expected-version predicate as an integer literal
    // (`loop_items.version = 1`), so the bound value keeps its integer type:
    // replay constrains exact value types, and a string `"1"` does not match.
    let statement = statements::project_update_sql(&columns, metadata.is_some());
    let id = target.id.as_str();
    let version = update.version;
    let execution = match (values.as_slice(), metadata_json.as_deref()) {
        ([], Some(document)) => {
            transaction
                .execute(statement, (document, id, version))
                .await?
        }
        ([name], Some(document)) => {
            transaction
                .execute(statement, (*name, document, id, version))
                .await?
        }
        ([name, description], Some(document)) => {
            transaction
                .execute(statement, (*name, *description, document, id, version))
                .await?
        }
        ([], None) => transaction.execute(statement, (id, version)).await?,
        ([name], None) => transaction.execute(statement, (*name, id, version)).await?,
        ([name, description], None) => {
            transaction
                .execute(statement, (*name, *description, id, version))
                .await?
        }
        _ => {
            return Err(brz_mysql::MysqlError::InvalidQuery {
                reason: "unsupported cloud-project update column set".to_owned(),
            });
        }
    };

    if execution.rows_affected != 1 {
        // `db.rollback()` then `HTTPException(409, "Cloud project changed")`.
        return Err(conflict());
    }

    if let Some(grant) = metadata.and_then(|outcome| outcome.grant_role) {
        // `ResourceMember.create` defaults `requested_at` to
        // `datetime.utcnow()`; the source driver renders it as the ISO text
        // literal the recording carries, so the target binds the same text.
        // The value is source-generated, which is what the recorded time value
        // rules cover.
        let requested_at = rendered_utc_now();
        transaction
            .execute(
                statements::INSERT_GRANT_SQL,
                (project_number, grant.as_str(), requested_at.as_str()),
            )
            .await?;
    }
    Ok(())
}

/// pymysql's `escape_datetime`: `datetime.isoformat(" ")`, with microseconds
/// omitted when they are zero.
fn rendered_utc_now() -> String {
    render_python_datetime(Utc::now().naive_utc())
}

fn render_python_datetime(value: chrono::NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%d %H:%M:%S").to_string();
    let micros = value.and_utc().timestamp_subsec_micros();
    if micros == 0 {
        base
    } else {
        format!("{base}.{micros:06}")
    }
}

/// `db.refresh(project)`: re-read the project through the unlabeled entity
/// projection and adapt it to the shared response row.
async fn refresh_project<M: Mysql>(
    mysql: &M,
    project_id: i64,
) -> Result<Option<ProjectListRow>, brz_mysql::MysqlError> {
    #[derive(Debug, FromMysqlRow)]
    struct EntityRow {
        #[mysql(rename = "id")]
        id: String,
        #[mysql(rename = "public_id")]
        public_id: Option<String>,
        #[mysql(rename = "project_key")]
        project_key: Option<String>,
        #[mysql(rename = "name")]
        name: Option<String>,
        #[mysql(rename = "description")]
        description: Option<String>,
        #[mysql(rename = "created_by_user_id")]
        created_by_user_id: i32,
        #[mysql(rename = "status")]
        status: String,
        #[mysql(rename = "version")]
        version: i64,
        #[mysql(rename = "created_at")]
        created_at: Option<chrono::NaiveDateTime>,
        #[mysql(rename = "updated_at")]
        updated_at: Option<chrono::NaiveDateTime>,
        #[mysql(rename = "metadata")]
        metadata: Option<Json<brz_json::JsonProjection<super::CloudMetadataInput>>>,
    }
    let row: Option<EntityRow> = mysql
        .fetch_optional(statements::entity_project_sql(), (project_id.to_string(),))
        .await?;
    Ok(row.map(|row| ProjectListRow {
        id: row.id,
        public_id: row.public_id,
        project_key: row.project_key,
        name: row.name,
        description: row.description,
        created_by_user_id: row.created_by_user_id,
        status: row.status,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
        metadata: row.metadata,
    }))
}

/// The `expire_on_commit` reload of the caller (`Session.get(User, id)`).
async fn reload_user<M: Mysql>(
    mysql: &M,
    user_id: i32,
) -> Result<Option<String>, brz_mysql::MysqlError> {
    #[derive(Debug, FromMysqlRow)]
    struct ReloadedUser {
        #[mysql(rename = "id")]
        id: i64,
        #[mysql(rename = "user_name")]
        user_name: String,
    }
    let row: Option<ReloadedUser> = mysql
        .fetch_optional(
            crate::user_reader::USER_ENTITY_BY_ID_QUERY,
            (i64::from(user_id),),
        )
        .await?;
    Ok(row.map(|row| {
        let _ = row.id;
        row.user_name
    }))
}

#[cfg(test)]
#[path = "update_tests.rs"]
mod tests;
