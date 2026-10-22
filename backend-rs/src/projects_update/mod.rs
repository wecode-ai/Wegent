// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PUT /api/projects/{project_id}` — update one project
//! (`app.api.endpoints.projects.update_project_endpoint` ->
//! `app.services.project_service.update_project`).
//!
//! Source pipeline (recorded cases `api-projects-wildcard/afa6900c` and
//! `a4809f15`, JWT bearer session, `client_origin=frontend`):
//!
//! 1. `security.get_current_user` — the labeled `users` lookup.
//! 2. The labeled `projects` read of the caller's active project scoped to
//!    `client_origin` (`query.first()`); no row raises
//!    `404 {"detail": "Project not found"}`.
//! 3. `update_data.model_dump(exclude_unset=True)` applies only the fields the
//!    request set (an explicit `null` counts as set). SQLAlchemy drops an
//!    assigned column from the flush when it equals the loaded value, so a
//!    no-op assignment emits no `UPDATE`; the `config` field is additionally
//!    `flag_modified`-ed, so a present config always flushes. A flushed update
//!    writes the changed columns in table order with `updated_at=now()`.
//! 4. `db.commit()` (`COMMIT`), then `db.refresh(project)` re-reads the row
//!    with the unlabeled entity projection.
//! 5. `task_store.count_active_project_tasks` counts the project's active
//!    tasks (the sharded deployment reuses the merged list read).
//! 6. `ProjectResponse.model_validate(project)` renders the response.
//!
//! Every non-`HTTPException` failure collapses to
//! `500 {"detail": "Failed to update project: <error>"}`.
mod config;
mod request;

use std::sync::Arc;

use brz_http_server::Response;
use brz_http_server::StatusCode;
use brz_mysql::{Json, Mysql, MysqlResult, MysqlRow, MysqlValue, MysqlValueWriter};
use chrono::NaiveDateTime;
use serde_json::Value;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::{
    NullableConfig, ProjectRow, StoredProjectConfig, find_active_project, parse_client_origin,
    pydantic_datetime,
};
use config::dump_config;
use request::{Field, ProjectUpdateRequest};

/// `PUT /api/projects/{project_id}`: the update free function, injecting the
/// process-lifetime application state.
#[brz_http_server::put("/api/projects/:project_id")]
pub(super) async fn update_project(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] current_user: SessionUser,
    project_id: i64,
    client_origin: Option<String>,
    body: Value,
) -> Result<Response, FastApiError> {
    // FastAPI validates the query parameter and the body before the endpoint
    // body runs; either failure surfaces as 422 without dependency traffic.
    let client_origin = parse_client_origin(client_origin.as_deref())?;
    let update = ProjectUpdateRequest::decode(&body)?;
    update_project_inner(state, &current_user, project_id, &client_origin, &update).await
}

/// `ProjectResponse` (`app.schemas.project`), in the pydantic model's field
/// order (`ProjectBase` fields first, then `ProjectResponse`).
#[derive(Debug, serde::Serialize)]
struct ProjectResponseBody {
    name: String,
    description: String,
    color: Option<String>,
    client_origin: String,
    config: Option<NullableConfig>,
    id: i64,
    user_id: i64,
    sort_order: i64,
    is_expanded: bool,
    task_count: i64,
    created_at: String,
    updated_at: String,
}

// ============================================================================
// Handler body
// ============================================================================

/// One bound column of the ORM `UPDATE`, in table order. `Id` carries the
/// `WHERE projects.id = ?` binding.
enum UpdateColumn {
    Name(Option<String>),
    Description(Option<String>),
    Color(Option<String>),
    Config(Option<Value>),
    SortOrder(i64),
    IsExpanded(bool),
    Id(i64),
}

/// `impl MysqlValue` for the bound update parameters.
struct BoundColumn(UpdateColumn);

impl MysqlValue for BoundColumn {
    fn write(self, writer: &mut MysqlValueWriter) -> MysqlResult<()> {
        match self.0 {
            UpdateColumn::Name(value) => value.write(writer),
            UpdateColumn::Description(value) => value.write(writer),
            UpdateColumn::Color(value) => value.write(writer),
            UpdateColumn::Config(value) => value.write(writer),
            UpdateColumn::SortOrder(value) => value.write(writer),
            UpdateColumn::IsExpanded(value) => value.write(writer),
            UpdateColumn::Id(value) => value.write(writer),
        }
    }
}

/// The flushed columns of the `exclude_unset` update: SQLAlchemy drops an
/// assigned column when it equals the loaded value, while `config` is
/// `flag_modified`-ed, so a present config always flushes. Table order.
fn update_columns(project: &ProjectRow, update: &ProjectUpdateRequest) -> Vec<UpdateColumn> {
    let mut columns: Vec<UpdateColumn> = Vec::new();
    if let Field::Set(Some(name)) = &update.name
        && *name != project.projects_name
    {
        columns.push(UpdateColumn::Name(Some(name.clone())));
    }
    if let Field::Set(description) = &update.description
        && *description != project.projects_description
    {
        columns.push(UpdateColumn::Description(description.clone()));
    }
    if let Field::Set(color) = &update.color
        && *color != project.projects_color
    {
        columns.push(UpdateColumn::Color(color.clone()));
    }
    if let Field::Set(config) = &update.config {
        columns.push(UpdateColumn::Config(config.as_ref().map(dump_config)));
    }
    if let Field::Set(Some(sort_order)) = &update.sort_order
        && *sort_order != project.projects_sort_order
    {
        columns.push(UpdateColumn::SortOrder(*sort_order));
    }
    if let Field::Set(Some(is_expanded)) = &update.is_expanded
        && *is_expanded != (project.projects_is_expanded != 0)
    {
        columns.push(UpdateColumn::IsExpanded(*is_expanded));
    }
    columns
}

/// `update_project`: apply the `exclude_unset` fields, flush the changed
/// columns, commit, refresh, count, and render `ProjectResponse`.
async fn update_project_inner(
    state: &Arc<AppState>,
    user: &SessionUser,
    project_id: i64,
    client_origin: &str,
    update: &ProjectUpdateRequest,
) -> Result<Response, FastApiError> {
    let user_id = i64::from(user.0.id);

    // The labeled `query.first()` read; a missing project is a 404 before any
    // write.
    let project = find_active_project(state, project_id, user_id, client_origin).await?;

    let columns = update_columns(&project, update);
    if !columns.is_empty() {
        // The flushed `UPDATE`: the changed columns in table order with the
        // `onupdate` `updated_at=now()` appended.
        let mut sql = String::from("UPDATE projects SET ");
        for (index, column) in columns.iter().enumerate() {
            if index > 0 {
                sql.push_str(", ");
            }
            sql.push_str(match column {
                UpdateColumn::Name(_) => "name=?",
                UpdateColumn::Description(_) => "description=?",
                UpdateColumn::Color(_) => "color=?",
                UpdateColumn::Config(_) => "config=?",
                UpdateColumn::SortOrder(_) => "sort_order=?",
                UpdateColumn::IsExpanded(_) => "is_expanded=?",
                // The trailing `WHERE` binding; unreachable in the SET list.
                UpdateColumn::Id(_) => unreachable!("Id binds only the WHERE clause"),
            });
        }
        sql.push_str(", updated_at=now() WHERE projects.id = ?");
        let params: Vec<BoundColumn> = columns
            .into_iter()
            .map(BoundColumn)
            .chain(std::iter::once(BoundColumn(UpdateColumn::Id(project_id))))
            .collect();
        state
            .mysql
            .execute(sql, params)
            .await
            .map_err(update_project_error)?;
    }
    // `db.commit()` runs whether or not the flush wrote anything.
    state
        .mysql
        .execute("COMMIT", ())
        .await
        .map_err(update_project_error)?;

    // `db.refresh(project)`: the unlabeled entity projection re-reads the
    // committed row.
    let refreshed = refresh_project(&state.mysql, project_id)
        .await
        .map_err(update_project_error)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Project not found"))?;

    // `task_store.count_active_project_tasks`.
    let task_count = state
        .task_store
        .count_active_project_tasks(project_id, Some(refreshed.user_id), Some(client_origin))
        .await
        .map_err(update_project_error)?;

    let body = ProjectResponseBody {
        name: refreshed.name,
        description: refreshed.description.unwrap_or_default(),
        color: refreshed.color,
        client_origin: refreshed.client_origin,
        config: refreshed
            .config
            .map(|config| NullableConfig::Config(Box::new(config))),
        id: refreshed.id,
        user_id: refreshed.user_id,
        sort_order: refreshed.sort_order,
        is_expanded: refreshed.is_expanded != 0,
        task_count,
        created_at: pydantic_datetime(refreshed.created_at),
        updated_at: pydantic_datetime(refreshed.updated_at),
    };
    let bytes = serde_json::to_vec(&body).map_err(|_| FastApiError::internal())?;
    Ok(Response::owned_bytes(StatusCode::OK, bytes).content_type("application/json"))
}

/// `db.refresh(project)`: the unlabeled `projects` projection re-read by
/// primary key after the commit.
async fn refresh_project<M: Mysql>(
    mysql: &M,
    project_id: i64,
) -> MysqlResult<Option<RefreshedProject>> {
    let row: Option<MysqlRow> = mysql
        .fetch_optional(
            "SELECT projects.id, projects.user_id, projects.name, projects.description, \
             projects.color, projects.client_origin, projects.config, projects.sort_order, \
             projects.is_expanded, projects.is_active, projects.created_at, projects.updated_at \
             \nFROM projects \nWHERE projects.id = ?",
            (project_id,),
        )
        .await?;
    row.map(|row| {
        Ok(RefreshedProject {
            id: row.get_required("id")?,
            user_id: row.get_required("user_id")?,
            name: row.get_required("name")?,
            description: row.get_required("description")?,
            color: row.get_required("color")?,
            client_origin: row.get_required("client_origin")?,
            // `projects.config` is `Column(JSON, nullable=True)`: a legacy
            // task-group row stores SQL `NULL` (recorded cases render
            // `config: null`), while a workspace row stores JSON that may
            // itself be `null`. Both NULL shapes map to `None`.
            config: decode_stored_config(row.get::<Json<NullableConfig>>("config")?),
            sort_order: row.get_required("sort_order")?,
            is_expanded: row.get_required("is_expanded")?,
            created_at: row.get_required("created_at")?,
            updated_at: row.get_required("updated_at")?,
        })
    })
    .transpose()
}

/// The refreshed `projects` row (`db.refresh`'s unlabeled projection).
struct RefreshedProject {
    id: i64,
    user_id: i64,
    name: String,
    description: Option<String>,
    color: Option<String>,
    client_origin: String,
    config: Option<StoredProjectConfig>,
    sort_order: i64,
    is_expanded: i8,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

/// Decode the stored `projects.config` cell: SQL `NULL` arrives as `None`
/// and JSON `null` as `NullableConfig::Null`; both render `config: null`,
/// matching the source's `Optional[ProjectConfig]`.
fn decode_stored_config(cell: Option<Json<NullableConfig>>) -> Option<StoredProjectConfig> {
    match cell {
        None | Some(Json(NullableConfig::Null)) => None,
        Some(Json(NullableConfig::Config(config))) => Some(*config),
    }
}

/// `update_project_endpoint`'s dependency failure: the source wraps any
/// exception as `500 {"detail": "Failed to update project: <error>"}`.
fn update_project_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "update project dependency failure");
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("Failed to update project: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::config::{dump_config, validate_project_config};
    use super::*;
    use crate::projects::NullableConfig;
    use brz_mysql::Json;
    use chrono::NaiveDateTime;
    use serde_json::json;

    fn project_row(is_expanded: i8) -> ProjectRow {
        ProjectRow {
            projects_id: 2554,
            projects_user_id: 4974,
            projects_name: "k8s".to_string(),
            projects_description: Some(String::new()),
            projects_color: Some(String::new()),
            projects_client_origin: "frontend".to_string(),
            projects_config: Some(Json(NullableConfig::Null)),
            projects_sort_order: 6,
            projects_is_expanded: is_expanded,
            projects_created_at: NaiveDateTime::parse_from_str(
                "2026-10-15 19:22:09",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
            projects_updated_at: NaiveDateTime::parse_from_str(
                "2026-10-15 19:22:14",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
        }
    }

    fn decode(body: Value) -> ProjectUpdateRequest {
        ProjectUpdateRequest::decode(&body).expect("valid update body")
    }

    #[test]
    fn decode_tracks_set_and_unset_fields() {
        // The recorded case body: only `is_expanded` is set.
        let update = decode(json!({"is_expanded": false}));
        assert!(matches!(update.name, Field::Unset));
        assert!(matches!(update.description, Field::Unset));
        assert!(matches!(update.color, Field::Unset));
        assert!(matches!(update.sort_order, Field::Unset));
        assert!(matches!(update.config, Field::Unset));
        assert!(matches!(update.is_expanded, Field::Set(Some(false))));
    }

    #[test]
    fn decode_treats_explicit_null_as_set() {
        let update = decode(json!({"color": null, "description": null}));
        assert!(matches!(update.color, Field::Set(None)));
        assert!(matches!(update.description, Field::Set(None)));
    }

    #[test]
    fn decode_rejects_invalid_values() {
        for (body, kind, loc) in [
            (
                json!({"name": ""}),
                "string_too_short",
                json!(["body", "name"]),
            ),
            (
                json!({"name": "x".repeat(101)}),
                "string_too_long",
                json!(["body", "name"]),
            ),
            (json!({"name": 5}), "string_type", json!(["body", "name"])),
            (
                json!({"color": "x".repeat(21)}),
                "string_too_long",
                json!(["body", "color"]),
            ),
            (
                json!({"sort_order": "abc"}),
                "int_parsing",
                json!(["body", "sort_order"]),
            ),
            (
                json!({"sort_order": 1.5}),
                "int_from_float",
                json!(["body", "sort_order"]),
            ),
            (
                json!({"is_expanded": "maybe"}),
                "bool_parsing",
                json!(["body", "is_expanded"]),
            ),
            (
                json!({"is_expanded": 2}),
                "bool_parsing",
                json!(["body", "is_expanded"]),
            ),
            (
                json!({"config": 5}),
                "model_type",
                json!(["body", "config"]),
            ),
            (
                json!({"config": {"mode": "bogus"}}),
                "literal_error",
                json!(["body", "config", "mode"]),
            ),
            (
                json!({"config": {"unknown": 1}}),
                "extra_forbidden",
                json!(["body", "config", "unknown"]),
            ),
        ] {
            let error = ProjectUpdateRequest::decode(&body).unwrap_err();
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY, "{body}");
            let detail: serde_json::Value =
                serde_json::from_str(&error.validation_detail()).unwrap();
            assert_eq!(
                detail[0]["type"], kind,
                "type mismatch for {body}: {detail}"
            );
            assert_eq!(detail[0]["loc"], loc, "{body}");
        }
    }

    #[test]
    fn decode_accepts_pydantic_coercions() {
        let update = decode(json!({"is_expanded": "yes", "sort_order": 5.0}));
        assert!(matches!(update.is_expanded, Field::Set(Some(true))));
        assert!(matches!(update.sort_order, Field::Set(Some(5))));
    }

    #[test]
    fn update_columns_skip_equal_values_and_always_flush_config() {
        // The recorded no-op case: `is_expanded=false` on an already-collapsed
        // row flushes nothing.
        let update = decode(json!({"is_expanded": false}));
        assert!(update_columns(&project_row(0), &update).is_empty());

        // The recorded changed case flushes the one column.
        let update = decode(json!({"is_expanded": false}));
        let columns = update_columns(&project_row(1), &update);
        assert_eq!(columns.len(), 1);
        assert!(matches!(columns[0], UpdateColumn::IsExpanded(false)));

        // A present `config` always flushes, even when it equals the stored
        // value (`flag_modified`).
        let update = decode(json!({"config": null}));
        let columns = update_columns(&project_row(0), &update);
        assert_eq!(columns.len(), 1);
        assert!(matches!(columns[0], UpdateColumn::Config(None)));
    }

    #[test]
    fn update_columns_keep_table_order() {
        let update = decode(json!({"name": "new", "sort_order": 3, "color": null}));
        let columns = update_columns(&project_row(0), &update);
        assert_eq!(columns.len(), 3);
        assert!(matches!(&columns[0], UpdateColumn::Name(Some(name)) if name == "new"));
        assert!(matches!(&columns[1], UpdateColumn::Color(None)));
        assert!(matches!(columns[2], UpdateColumn::SortOrder(3)));
    }

    #[test]
    fn config_validation_applies_the_workspace_mutations() {
        // `device_id` derives the local execution target.
        let config = validate_project_config(&json!({
            "mode": "workspace", "device_id": "dev-1"
        }))
        .unwrap();
        let dump = dump_config(&config);
        assert_eq!(
            dump,
            json!({
                "mode": "workspace",
                "device_id": "dev-1",
                "execution": {"targetType": "local", "deviceId": "dev-1"}
            })
        );

        // A git workspace without `checkoutPath` derives the safe key.
        let config = validate_project_config(&json!({
            "mode": "workspace",
            "execution": {"targetType": "cloud"},
            "workspace": {"source": "git"},
            "git": {"url": "https://git.example.invalid/example/wegent.git"}
        }))
        .unwrap();
        let dump = dump_config(&config);
        assert_eq!(dump["workspace"]["checkoutPath"], json!("wegent"));
        assert_eq!(dump["git"]["branch"], json!("main"));
    }

    #[test]
    fn config_validation_rejects_workspace_violations() {
        for body in [
            json!({"mode": "workspace", "workspace": {"source": "git"}}),
            json!({"mode": "workspace",
                   "workspace": {"source": "local_path"},
                   "execution": {"targetType": "local", "deviceId": "d"}}),
            json!({"mode": "workspace",
                   "workspace": {"source": "device_path", "devicePath": "/d"},
                   "execution": {"targetType": "cloud"}}),
            json!({"mode": "workspace",
                   "workspace": {"source": "git", "checkoutPath": "/abs"},
                   "git": {"url": "u"},
                   "execution": {"targetType": "cloud"}}),
        ] {
            assert!(
                validate_project_config(&body).is_err(),
                "expected rejection for {body}"
            );
        }
    }

    #[test]
    fn config_dump_strips_nulls_and_keeps_defaults() {
        let config = validate_project_config(&json!({
            "mode": "workspace", "team": {"name": "t"}
        }))
        .unwrap();
        assert_eq!(
            dump_config(&config),
            json!({
                "mode": "workspace",
                "team": {"name": "t", "namespace": "default"}
            })
        );
    }

    #[test]
    fn response_renders_the_refreshed_row_in_model_order() {
        let project = project_row(0);
        let body = ProjectResponseBody {
            name: project.projects_name.clone(),
            description: project.projects_description.clone().unwrap_or_default(),
            color: project.projects_color.clone(),
            client_origin: project.projects_client_origin.clone(),
            config: None,
            id: project.projects_id,
            user_id: project.projects_user_id,
            sort_order: project.projects_sort_order,
            is_expanded: project.projects_is_expanded != 0,
            task_count: 7,
            created_at: pydantic_datetime(project.projects_created_at),
            updated_at: pydantic_datetime(project.projects_updated_at),
        };
        let rendered = serde_json::to_value(&body).unwrap();
        // The recorded response body: field order and values.
        assert_eq!(
            rendered,
            json!({
                "name": "k8s",
                "description": "",
                "color": "",
                "client_origin": "frontend",
                "config": null,
                "id": 2554,
                "user_id": 4974,
                "sort_order": 6,
                "is_expanded": false,
                "task_count": 7,
                "created_at": "2026-10-15T19:22:09",
                "updated_at": "2026-10-15T19:22:14"
            })
        );
        let keys: Vec<&str> = rendered
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "name",
                "description",
                "color",
                "client_origin",
                "config",
                "id",
                "user_id",
                "sort_order",
                "is_expanded",
                "task_count",
                "created_at",
                "updated_at"
            ]
        );
    }
}
