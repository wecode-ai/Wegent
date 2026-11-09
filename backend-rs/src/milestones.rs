//! Project-owned milestones use the existing unified node store.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlTransaction};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    cloud_projects, http_compat::FastApiError, loop_tasks::auth::FlexibleUser, state::AppState,
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MilestoneInput {
    title: String,
    #[serde(default)]
    description: String,
    due_on: Option<String>,
    #[serde(default = "open")]
    state: String,
    version: Option<i64>,
}

fn open() -> String {
    "open".into()
}

impl MilestoneInput {
    fn validate(&self) -> Result<(), FastApiError> {
        let valid_date = self.due_on.as_ref().is_none_or(|date| {
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .is_ok_and(|parsed| parsed.to_string() == *date)
        });
        if self.title.trim().is_empty()
            || self.title.chars().count() > 255
            || !matches!(self.state.as_str(), "open" | "closed")
            || !valid_date
            || self.version.is_some_and(|version| version < 1)
        {
            return Err(FastApiError::detail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Invalid milestone",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, FromMysqlRow)]
struct Milestone {
    id: String,
    project_id: String,
    title: String,
    description: String,
    state: String,
    due_on: Option<String>,
    version: i64,
    open_issues: i64,
    closed_issues: i64,
    archived_issues: i64,
}

fn decode<T: serde::de::DeserializeOwned>(body: Value) -> Result<T, FastApiError> {
    serde_json::from_value(body).map_err(|_| {
        FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid milestone request",
        )
    })
}

fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "milestone storage failed");
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Milestone operation failed",
    )
}

#[derive(Debug)]
struct MilestoneAccess {
    project_id: String,
    visibility: String,
}

async fn authorize<M: Mysql>(
    mysql: &M,
    project: &str,
    user: i32,
    write: bool,
) -> Result<MilestoneAccess, FastApiError> {
    let number = cloud_projects::parse_project_id(project)?;
    let Some((project, role)) = cloud_projects::authorized_project(mysql, number, user)
        .await
        .map_err(internal)?
    else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Cloud project not found",
        ));
    };
    if !cloud_projects::members::has_permission(role, if write { "Maintainer" } else { "Viewer" }) {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }
    let provider = project
        .metadata
        .as_ref()
        .and_then(|m| m.0.value.as_ref())
        .and_then(|m| m.task_provider.as_deref())
        .unwrap_or("backend");
    if !matches!(provider, "local" | "backend") {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Milestones require internally stored Issues",
        ));
    }
    let default_security = project
        .metadata
        .as_ref()
        .and_then(|m| m.0.value.as_ref())
        .and_then(|m| m.default_issue_security.as_deref())
        .unwrap_or("open");
    let visibility = if cloud_projects::members::has_permission(role, "Maintainer") {
        String::new()
    } else {
        crate::loop_tasks::loop_repository::visible_item_filter_sql(
            user,
            if default_security == "related" {
                "related"
            } else {
                "open"
            },
        )
    };
    Ok(MilestoneAccess {
        project_id: project.id,
        visibility,
    })
}

async fn list<M: Mysql>(
    mysql: &M,
    project: &str,
    visibility: &str,
) -> Result<Vec<Milestone>, FastApiError> {
    let sql = format!("SELECT m.id, m.cloud_project_id AS project_id, m.title, m.description, m.status AS state,
        CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(m.metadata, '$.due_on')), 'null') AS CHAR) AS due_on, m.version,
        CAST(COALESCE(c.open_issues, 0) AS SIGNED) AS open_issues,
        CAST(COALESCE(c.closed_issues, 0) AS SIGNED) AS closed_issues,
        CAST(COALESCE(c.archived_issues, 0) AS SIGNED) AS archived_issues
        FROM loop_items m LEFT JOIN (
          SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.milestone_id')) AS milestone_id,
            SUM(CASE WHEN status = 'completed' THEN 0 ELSE 1 END) AS open_issues,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS closed_issues,
            SUM(CASE WHEN deleted_at IS NOT NULL AND deleted_at NOT IN ('1970-01-01 00:00:00','1970-01-01 00:00:01') THEN 1 ELSE 0 END) AS archived_issues
          FROM loop_items WHERE cloud_project_id = ? AND resource_type = 'task' {visibility}
          GROUP BY JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.milestone_id'))
        ) c ON c.milestone_id = m.id
        WHERE m.cloud_project_id = ? AND m.resource_type = 'milestone' AND (m.deleted_at IS NULL OR m.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))
        ORDER BY m.created_at DESC, m.id");
    mysql
        .fetch_all(sql, (project, project))
        .await
        .map_err(internal)
}

#[brz_http_server::get("/api/v1/cloud-projects/:project_id/milestones")]
async fn list_milestones(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] user: FlexibleUser,
) -> Result<Vec<Milestone>, FastApiError> {
    let access = authorize(&state.mysql, project_id, user.id, false).await?;
    list(&state.mysql, &access.project_id, &access.visibility).await
}

fn milestone_insert_sql(required: &std::collections::HashSet<String>) -> String {
    crate::loop_node_storage::insert_sql(
        &[
            "id",
            "resource_type",
            "project_space",
            "cloud_project_id",
            "title",
            "description",
            "status",
            "metadata",
            "created_by_user_id",
            "sort_order",
            "next_item_number",
            "assignee_agent_id",
            "version",
            "created_at",
            "updated_at",
        ],
        &[
            "?",
            "'milestone'",
            "'default'",
            "?",
            "?",
            "?",
            "?",
            "?",
            "?",
            "0",
            "1",
            "''",
            "1",
            "UTC_TIMESTAMP()",
            "UTC_TIMESTAMP()",
        ],
        required,
    )
}

#[brz_http_server::post("/api/v1/cloud-projects/:project_id/milestones")]
async fn create_milestone(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] user: FlexibleUser,
    body: Value,
) -> Result<Milestone, FastApiError> {
    let input: MilestoneInput = decode(body)?;
    input.validate()?;
    let access = authorize(&state.mysql, project_id, user.id, true).await?;
    let project_id = access.project_id.as_str();
    let id = format!(
        "ms-{}",
        crate::wework_auth_tokens::uuid4_hex().map_err(|_| FastApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Cannot create milestone ID"
        ))?
    );
    state
        .mysql
        .with_transaction(async |tx| {
            let required = crate::loop_node_storage::required_columns(tx).await?;
            let sql = milestone_insert_sql(&required);
            tx.execute(
                sql,
                (
                    id.as_str(),
                    project_id,
                    input.title.trim(),
                    input.description.as_str(),
                    input.state.as_str(),
                    Json(json!({"due_on":input.due_on})),
                    user.id,
                ),
            )
            .await?;
            Ok(())
        })
        .await
        .map_err(internal)?;
    list(&state.mysql, project_id, "")
        .await?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Milestone not found"))
}

#[brz_http_server::patch("/api/v1/cloud-projects/:project_id/milestones/:milestone_id")]
async fn update_milestone(
    #[inject(state)] state: &AppState,
    project_id: &str,
    milestone_id: &str,
    #[auth] user: FlexibleUser,
    body: Value,
) -> Result<Milestone, FastApiError> {
    let input: MilestoneInput = decode(body)?;
    input.validate()?;
    let access = authorize(&state.mysql, project_id, user.id, true).await?;
    let project_id = access.project_id.as_str();
    let version = input.version.ok_or_else(|| {
        FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, "version is required")
    })?;
    let result = state.mysql.execute("UPDATE loop_items SET title=?,description=?,status=?,metadata=?,version=version+1,updated_at=UTC_TIMESTAMP() WHERE id=? AND cloud_project_id=? AND resource_type='milestone' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) AND version=?",
        (input.title.trim(), input.description.as_str(), input.state.as_str(), Json(json!({"due_on":input.due_on})), milestone_id, project_id, version)).await.map_err(internal)?;
    if result.rows_affected != 1 {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Milestone changed; refresh and try again",
        ));
    }
    list(&state.mysql, project_id, "")
        .await?
        .into_iter()
        .find(|m| m.id == milestone_id)
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Milestone not found"))
}

#[derive(Deserialize)]
struct DeleteInput {
    version: i64,
}

#[brz_http_server::delete("/api/v1/cloud-projects/:project_id/milestones/:milestone_id")]
async fn delete_milestone(
    #[inject(state)] state: &AppState,
    project_id: &str,
    milestone_id: &str,
    #[auth] user: FlexibleUser,
    body: Value,
) -> Result<Value, FastApiError> {
    let input: DeleteInput = decode(body)?;
    if input.version < 1 {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid milestone version",
        ));
    }
    let access = authorize(&state.mysql, project_id, user.id, true).await?;
    let project_id = access.project_id.as_str();
    let changed = state.mysql.with_transaction(async |tx| {
        let result = tx.execute("UPDATE loop_items SET deleted_at=UTC_TIMESTAMP(),version=version+1 WHERE id=? AND cloud_project_id=? AND resource_type='milestone' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) AND version=?", (milestone_id, project_id, input.version)).await?;
        if result.rows_affected != 1 { return Ok(false); }
        tx.execute("UPDATE loop_items SET metadata=JSON_REMOVE(metadata,'$.milestone_id'),version=version+1,updated_at=UTC_TIMESTAMP() WHERE cloud_project_id=? AND resource_type='task' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.milestone_id'))=?", (project_id, milestone_id)).await?;
        Ok(true)
    }).await.map_err(internal)?;
    if !changed {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Milestone changed; refresh and try again",
        ));
    }
    Ok(json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_unknown_project_before_reading_milestones() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let error = authorize(&mysql, "101", 7, false).await.unwrap_err();
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(mysql.queries().len(), 1);
        assert!(
            !mysql.queries()[0]
                .sql
                .contains("resource_type = 'milestone'")
        );
    }

    #[tokio::test]
    async fn counters_reuse_issue_visibility_and_bind_project_twice() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let filter = crate::loop_tasks::loop_repository::visible_item_filter_sql(7, "related");
        assert!(list(&mysql, "101", &filter).await.unwrap().is_empty());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 2);
        assert!(queries[0].sql.contains("security_level"));
        assert!(queries[0].sql.contains("created_by_user_id = 7"));
        assert!(queries[0].sql.contains("resource_type = 'task'"));
        assert!(queries[0].sql.contains("1970-01-01 00:00:01"));
    }

    #[test]
    fn inserts_support_both_nullable_and_production_sentinel_schemas() {
        let nullable = milestone_insert_sql(&Default::default());
        assert!(!nullable.contains("parent_id"));
        let required = ["deleted_at", "parent_id", "assignee_user_id"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let deployed = milestone_insert_sql(&required);
        assert!(deployed.contains("deleted_at"));
        assert!(deployed.contains("1970-01-01 00:00:01"));
        assert!(deployed.contains("assignee_user_id"));
    }
    #[test]
    fn validates_title_state_date_and_version() {
        for value in [
            json!({"title":" "}),
            json!({"title":"v1","state":"done"}),
            json!({"title":"v1","due_on":"2026-02-30"}),
            json!({"title":"v1","version":0}),
        ] {
            assert!(
                serde_json::from_value::<MilestoneInput>(value)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        assert!(
            serde_json::from_value::<MilestoneInput>(
                json!({"title":"版本一","due_on":"2028-02-29"})
            )
            .unwrap()
            .validate()
            .is_ok()
        );
    }
}
