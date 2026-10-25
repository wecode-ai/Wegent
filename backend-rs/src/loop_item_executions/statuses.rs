// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/cloud-projects/{project_id}/executions/statuses` — read the
//! human delivery outcomes for one Executor-owned round barrier.
//!
//! Mirrors `app.api.endpoints.loop_item_executions.execution_statuses` ->
//! `collaboration_human_assignments.collaboration_human_assignment_status`.
//!
//! Source pipeline:
//! 1. `security.get_current_user_jwt_apikey_tasktoken` — X-API-Key, Bearer API
//!    key, user-session JWT, then task-token fallback;
//! 2. `require_cloud_project_role(..., Viewer)` — the point
//!    `project_access_query`; no role source is `404 "Cloud project not
//!    found"`;
//! 3. for each `human_assignment_id`: the active execution bindings of the
//!    issue (`cloud_project_id`, `loop_item_id`, unset `unlinked_at`, ordered
//!    by `linked_at` desc), filtered in Python by the binding metadata's
//!    `human_assignment_id`. A missing assignment reports `queued`;
//! 4. the latest delivered Delivery of those bindings (`status =
//!    delivered`, ordered by `delivered_at` desc, `created_at` desc). Its
//!    markdown object is read (2 MiB bound) to supply `result`.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde_json::{Value, json};

use crate::board_snapshot::repository::has_permission;
use crate::cloud_projects::{LOOP_ITEMS_COLUMNS, role_for_priority};
use crate::http_compat::FastApiError;
use crate::loop_tasks::auth::FlexibleUser;
use crate::state::AppState;

/// `MAX_MARKDOWN_BYTES` (`app/services/delivery/service.py`).
const MAX_MARKDOWN_BYTES: usize = 2 * 1024 * 1024;

/// `LoopItemExecutionStatusQuery` (`app.schemas.project_chat`) with the
/// camelCase aliases accepted alongside the snake_case names
/// (`populate_by_name=True`).
#[derive(Debug, PartialEq)]
struct StatusQuery {
    loop_item_id: String,
    human_assignment_ids: Vec<String>,
}

/// `collaboration_human_assignment_status`: one round assignment's outcome.
async fn assignment_status(
    state: &AppState,
    project_id: i64,
    issue_id: &str,
    human_assignment_id: &str,
) -> Result<Value, FastApiError> {
    let bindings = execution_bindings(&state.mysql, project_id, issue_id)
        .await
        .map_err(internal_error)?;
    let assignment_bindings: Vec<&BindingRow> = bindings
        .iter()
        .filter(|binding| binding.human_assignment_id() == Some(human_assignment_id))
        .collect();
    let work_id = format!("human_assignment:{human_assignment_id}");
    let Some(first) = assignment_bindings.first() else {
        return Ok(json!({
            "assignee_type": "human",
            "work_id": work_id,
            "human_assignment_id": human_assignment_id,
            "status": "queued",
            "result": "",
            "error": "",
        }));
    };
    let binding_ids: Vec<&str> = assignment_bindings
        .iter()
        .map(|binding| binding.id.as_str())
        .collect();
    let delivery = latest_delivery(&state.mysql, issue_id, &binding_ids)
        .await
        .map_err(internal_error)?;
    let binding = delivery
        .as_ref()
        .and_then(|delivery| {
            assignment_bindings
                .iter()
                .find(|binding| binding.id == delivery.source_task_binding_id)
        })
        .unwrap_or(first);
    let result = match &delivery {
        Some(delivery) => read_markdown(state, &delivery.markdown_object_key).await?,
        None => String::new(),
    };
    Ok(json!({
        "assignee_type": "human",
        "work_id": work_id,
        "human_assignment_id": human_assignment_id,
        "status": if delivery.is_some() { "completed" } else { "running" },
        "human_user_id": binding.task_user_id,
        "runtime_device_id": binding.device_id,
        "runtime_task_id": binding.task_id,
        "delivery_id": delivery.as_ref().map(|delivery| delivery.id.clone()),
        "result": result,
        "error": "",
    }))
}

/// `delivery_service.read_markdown`: fetch the delivery markdown object with
/// the source's 2 MiB bound and decode it as UTF-8. Every failure is the
/// route's unhandled 500 body (`python_exception_handler`).
async fn read_markdown(state: &AppState, object_key: &str) -> Result<String, FastApiError> {
    let bytes = crate::delivery_storage::read_object(&state.attachment_http, object_key)
        .await
        .map_err(|_| FastApiError::unhandled())?;
    if bytes.len() > MAX_MARKDOWN_BYTES {
        return Err(FastApiError::unhandled());
    }
    String::from_utf8(bytes).map_err(|_| FastApiError::unhandled())
}

/// One active execution binding of the issue.
#[derive(Debug, FromMysqlRow)]
struct BindingRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_task_user_id")]
    task_user_id: i32,
    #[mysql(rename = "loop_items_device_id")]
    device_id: String,
    #[mysql(rename = "loop_items_task_id")]
    task_id: String,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<Json<Value>>,
}

impl BindingRow {
    /// `LoopItemTaskBinding.metadata_json.get("human_assignment_id")` when the
    /// metadata is a JSON object.
    fn human_assignment_id(&self) -> Option<&str> {
        self.metadata
            .as_ref()
            .and_then(|json| json.0.as_object())
            .and_then(|metadata| metadata.get("human_assignment_id"))
            .and_then(Value::as_str)
    }
}

/// One delivered Delivery row of the issue.
#[derive(Debug, FromMysqlRow)]
struct DeliveryRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_source_task_binding_id")]
    source_task_binding_id: String,
    #[mysql(rename = "loop_items_markdown_object_key")]
    markdown_object_key: String,
}

/// `db.query(LoopItemTaskBinding).filter(cloud_project_id,
/// loop_item_id, loop_datetime_is_unset(unlinked_at)).order_by(linked_at.desc())`.
async fn execution_bindings<M: Mysql>(
    mysql: &M,
    project_id: i64,
    issue_id: &str,
) -> MysqlResult<Vec<BindingRow>> {
    let sql = format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \n\
         FROM loop_items \n\
         WHERE loop_items.cloud_project_id = ? AND loop_items.loop_item_id = ? AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) AND loop_items.resource_type IN ('execution') ORDER BY loop_items.linked_at DESC"
    );
    mysql
        .fetch_all(sql, (project_id.to_string(), issue_id.to_string()))
        .await
}

/// The latest delivered Delivery of the assignment bindings.
async fn latest_delivery<M: Mysql>(
    mysql: &M,
    issue_id: &str,
    binding_ids: &[&str],
) -> MysqlResult<Option<DeliveryRow>> {
    let placeholders = vec!["?"; binding_ids.len()].join(", ");
    let sql = format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \n\
         FROM loop_items \n\
         WHERE loop_items.loop_item_id = ? AND loop_items.source_task_binding_id IN ({placeholders}) AND loop_items.status = 'delivered' AND loop_items.resource_type IN ('delivery') ORDER BY loop_items.delivered_at DESC, loop_items.created_at DESC \n LIMIT 1"
    );
    let mut values: Vec<String> = Vec::with_capacity(binding_ids.len() + 1);
    values.push(issue_id.to_string());
    values.extend(binding_ids.iter().map(|id| (*id).to_string()));
    mysql.fetch_optional(sql, values).await
}

/// `404 "Cloud project not found"` from `require_cloud_project_role`.
fn cloud_project_not_found() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::NOT_FOUND,
        "Cloud project not found",
    )
}

fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "execution-status dependency failure");
    FastApiError::detail(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error",
    )
}

/// FastAPI-style 422 entry (`{type, loc, msg, input[, ctx]}`).
fn validation_entry(
    kind: &str,
    loc: Value,
    message: &str,
    input: Value,
    ctx: Option<Value>,
) -> Value {
    let mut entry = json!({
        "type": kind,
        "loc": loc,
        "msg": message,
        "input": input,
    });
    if let Some(ctx) = ctx {
        entry["ctx"] = ctx;
    }
    entry
}

/// `LoopItemExecutionStatusQuery.model_validate_json(body)` with the
/// camelCase aliases and the pydantic v2 error locations.
fn parse_status_query(raw: &[u8]) -> Result<StatusQuery, FastApiError> {
    let value: Value = match serde_json::from_slice(raw) {
        Ok(value) => value,
        Err(error) => {
            return Err(FastApiError::validation(json!([validation_entry(
                "json_invalid",
                json!(["body"]),
                &format!("Invalid JSON: {error}"),
                Value::String(String::from_utf8_lossy(raw).into_owned()),
                Some(json!({"error": error.to_string()})),
            )])));
        }
    };
    let Value::Object(object) = &value else {
        return Err(FastApiError::validation(json!([validation_entry(
            "model_type",
            json!(["body"]),
            "Input should be an object",
            value,
            Some(json!({"class_name": "LoopItemExecutionStatusQuery"})),
        )])));
    };

    let mut errors = Vec::new();
    let loop_item_id = match field(object, "loopItemId", "loop_item_id") {
        None => {
            errors.push(validation_entry(
                "missing",
                json!(["body", "loopItemId"]),
                "Field required",
                value.clone(),
                None,
            ));
            None
        }
        Some(Value::String(text)) => {
            let length = text.chars().count();
            if length < 1 {
                errors.push(validation_entry(
                    "string_too_short",
                    json!(["body", "loop_item_id"]),
                    "String should have at least 1 character",
                    Value::String(text.clone()),
                    Some(json!({"min_length": 1})),
                ));
                None
            } else if length > 64 {
                errors.push(validation_entry(
                    "string_too_long",
                    json!(["body", "loop_item_id"]),
                    "String should have at most 64 characters",
                    Value::String(text.clone()),
                    Some(json!({"max_length": 64})),
                ));
                None
            } else {
                Some(text.clone())
            }
        }
        Some(other) => {
            errors.push(validation_entry(
                "string_type",
                json!(["body", "loop_item_id"]),
                "Input should be a valid string",
                other.clone(),
                None,
            ));
            None
        }
    };

    let human_assignment_ids = match field(object, "humanAssignmentIds", "human_assignment_ids") {
        None => {
            errors.push(validation_entry(
                "missing",
                json!(["body", "humanAssignmentIds"]),
                "Field required",
                value.clone(),
                None,
            ));
            None
        }
        Some(Value::Array(items)) => {
            let mut parsed = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                match item {
                    Value::String(text) => parsed.push(text.clone()),
                    other => errors.push(validation_entry(
                        "string_type",
                        json!(["body", "human_assignment_ids", index]),
                        "Input should be a valid string",
                        other.clone(),
                        None,
                    )),
                }
            }
            if items.is_empty() {
                errors.push(validation_entry(
                    "too_short",
                    json!(["body", "human_assignment_ids"]),
                    "List should have at least 1 item after validation, not 0",
                    Value::Array(items.clone()),
                    Some(json!({"field_type": "List", "min_length": 1, "actual_length": 0})),
                ));
                None
            } else if items.len() > 20 {
                errors.push(validation_entry(
                    "too_long",
                    json!(["body", "human_assignment_ids"]),
                    &format!(
                        "List should have at most 20 items after validation, not {}",
                        items.len()
                    ),
                    Value::Array(items.clone()),
                    Some(json!({
                        "field_type": "List",
                        "max_length": 20,
                        "actual_length": items.len(),
                    })),
                ));
                None
            } else if parsed.len() == items.len() {
                Some(parsed)
            } else {
                None
            }
        }
        Some(other) => {
            errors.push(validation_entry(
                "list_type",
                json!(["body", "human_assignment_ids"]),
                "Input should be a valid list",
                other.clone(),
                None,
            ));
            None
        }
    };

    if !errors.is_empty() {
        return Err(FastApiError::validation(Value::Array(errors)));
    }
    Ok(StatusQuery {
        loop_item_id: loop_item_id.expect("validated"),
        human_assignment_ids: human_assignment_ids.expect("validated"),
    })
}

/// `populate_by_name=True`: the alias (camelCase) is preferred, then the
/// field name.
fn field<'a>(
    object: &'a serde_json::Map<String, Value>,
    alias: &str,
    name: &str,
) -> Option<&'a Value> {
    object.get(alias).or_else(|| object.get(name))
}

/// `POST /api/v1/cloud-projects/{project_id}/executions/statuses`.
#[brz_http_server::post("/api/v1/cloud-projects/:project_id/executions/statuses")]
async fn execution_statuses(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] current_user: FlexibleUser,
    body: &[u8],
) -> Result<Value, FastApiError> {
    let project_number = crate::cloud_projects::parse_project_id(project_id)?;
    let user_id = current_user.id;
    let values = parse_status_query(body)?;

    // `require_cloud_project_role(db, project_id, user_id, Viewer)`.
    let Some((_project, priority)) =
        crate::cloud_projects::project_access(&state.mysql, project_number, user_id)
            .await
            .map_err(internal_error)?
    else {
        return Err(cloud_project_not_found());
    };
    let Some(role) = role_for_priority(priority) else {
        return Err(cloud_project_not_found());
    };
    if !has_permission(role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    let mut items = Vec::with_capacity(values.human_assignment_ids.len());
    for human_assignment_id in &values.human_assignment_ids {
        items.push(
            assignment_status(
                state,
                project_number,
                &values.loop_item_id,
                human_assignment_id,
            )
            .await?,
        );
    }
    Ok(json!({"items": items}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn query_accepts_aliases_and_names() {
        let camel = parse_status_query(br#"{"loopItemId":"PRJ-1","humanAssignmentIds":["a","b"]}"#)
            .unwrap();
        assert_eq!(
            camel,
            StatusQuery {
                loop_item_id: "PRJ-1".to_string(),
                human_assignment_ids: vec!["a".to_string(), "b".to_string()],
            }
        );
        let snake = parse_status_query(br#"{"loop_item_id":"PRJ-1","human_assignment_ids":["a"]}"#)
            .unwrap();
        assert_eq!(snake.human_assignment_ids, vec!["a".to_string()]);
    }

    #[test]
    fn query_rejects_missing_and_out_of_bound_fields() {
        let missing = parse_status_query(b"{}").unwrap_err();
        assert_eq!(
            missing.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        let detail = missing.validation_detail();
        assert!(detail.contains("\"loopItemId\""));
        assert!(detail.contains("\"humanAssignmentIds\""));

        let empty = parse_status_query(br#"{"loop_item_id":"","human_assignment_ids":["a"]}"#)
            .unwrap_err()
            .validation_detail();
        assert!(empty.contains("string_too_short"));

        let empty_list = parse_status_query(br#"{"loop_item_id":"x","human_assignment_ids":[]}"#)
            .unwrap_err()
            .validation_detail();
        assert!(empty_list.contains("too_short"));

        let many: Vec<String> = (0..21).map(|index| format!("\"{index}\"")).collect();
        let many = format!(
            "{{\"loop_item_id\":\"x\",\"human_assignment_ids\":[{}]}}",
            many.join(",")
        );
        let too_long = parse_status_query(many.as_bytes())
            .unwrap_err()
            .validation_detail();
        assert!(too_long.contains("too_long"));
    }

    #[tokio::test]
    async fn execution_bindings_match_the_recorded_query() {
        let mysql = KindQueryCapture::default();
        let rows = execution_bindings(&mysql, 5648598744554847056, "PRJD26304-10")
            .await
            .expect("binding query is captured");
        assert!(rows.is_empty());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 2);
        assert_eq!(
            queries[0].sql,
            normalize(&format!(
                "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                 WHERE loop_items.cloud_project_id = ? \
                 AND loop_items.loop_item_id = ? \
                 AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN \
                     ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                 AND loop_items.resource_type IN ('execution') \
                 ORDER BY loop_items.linked_at DESC"
            ))
        );
    }

    #[tokio::test]
    async fn latest_delivery_matches_the_recorded_query() {
        let mysql = KindQueryCapture::default();
        let delivery = latest_delivery(&mysql, "PRJD26304-10", &["b1", "b2"])
            .await
            .expect("delivery query is captured");
        assert!(delivery.is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 3);
        assert_eq!(
            queries[0].sql,
            normalize(&format!(
                "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                 WHERE loop_items.loop_item_id = ? \
                 AND loop_items.source_task_binding_id IN (?, ?) \
                 AND loop_items.status = 'delivered' \
                 AND loop_items.resource_type IN ('delivery') \
                 ORDER BY loop_items.delivered_at DESC, loop_items.created_at DESC \n LIMIT 1"
            ))
        );
    }
}
