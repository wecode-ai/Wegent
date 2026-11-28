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

use crate::ProjectState;
use crate::board_snapshot::repository::has_permission;
use crate::cloud_projects::{LOOP_ITEMS_COLUMNS, role_for_priority};
use crate::http_compat::FastApiError;
use wegent_identity::flexible_auth::FlexibleUser;

/// `MAX_MARKDOWN_BYTES` (`app/services/delivery/service.py`).
const MAX_MARKDOWN_BYTES: usize = 2 * 1024 * 1024;

/// `LoopItemExecutionStatusQuery` (`app.schemas.project_chat`) with the
/// camelCase aliases accepted alongside the snake_case names
/// (`populate_by_name=True`).
#[derive(Debug, PartialEq)]
struct StatusQuery {
    loop_item_id: String,
    human_assignment_ids: Vec<String>,
    round: Option<Round>,
}

#[derive(Debug, PartialEq, serde::Deserialize)]
struct Round {
    dispatch_id: String,
    round_id: String,
    #[serde(default)]
    execution_ids: Vec<i64>,
}

fn invalid_round() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
        "Invalid collaboration round",
    )
}

async fn round_items(
    state: &ProjectState,
    project: &str,
    issue: &str,
    round: &Round,
    humans: &[String],
) -> Result<Vec<Value>, FastApiError> {
    let id = crate::project_group_access::coordination_key(
        "manager_assignment",
        &[project, issue, &round.dispatch_id, &round.round_id],
    );
    let (Json(metadata),): (Json<Value>,) = state.mysql.fetch_optional(
        "SELECT metadata FROM project_chat_messages WHERE message_id=? AND project_id=? AND task_id=?",
        (id, project, issue)
    ).await.map_err(internal_error)?.ok_or_else(|| FastApiError::not_found("Round not found"))?;
    let assignments = metadata["dispatch_assignments"]
        .as_array()
        .ok_or_else(invalid_round)?;
    if !humans.iter().all(|id| {
        assignments
            .iter()
            .any(|a| a["human_assignment_id"].as_str() == Some(id.as_str()))
    }) {
        return Err(invalid_round());
    }
    let mut items = Vec::with_capacity(round.execution_ids.len());
    for id in &round.execution_ids {
        let assignment = assignments
            .iter()
            .find(|a| a["execution_id"].as_i64() == Some(*id))
            .ok_or_else(invalid_round)?;
        let assignment_id = assignment["assignment_id"]
            .as_str()
            .ok_or_else(invalid_round)?;
        let (status, Json(outcome)): (String, Json<Value>) = state.mysql.fetch_optional(
            "SELECT e.status, JSON_OBJECT('result',COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.execution_payload,'$.assignment_result')), ''),'error',COALESCE(e.error_message,'')) FROM loop_item_executions first_attempt JOIN loop_item_executions e ON e.execution_scope=first_attempt.execution_scope WHERE first_attempt.id=? AND e.cloud_project_id=? AND e.loop_item_id=? AND JSON_UNQUOTE(JSON_EXTRACT(e.execution_payload,'$.origin_context.dispatch_id'))=? AND JSON_UNQUOTE(JSON_EXTRACT(e.execution_payload,'$.origin_context.coordination_round_id'))=? AND JSON_UNQUOTE(JSON_EXTRACT(e.execution_payload,'$.origin_context.assignment_id'))=? ORDER BY e.id DESC LIMIT 1",
            (*id, project, issue, round.dispatch_id.as_str(), round.round_id.as_str(), assignment_id)
        ).await.map_err(internal_error)?.ok_or_else(|| FastApiError::not_found("Assignment not found"))?;
        items.push(json!({"assignee_type":"agent","assignment_id":assignment_id,"execution_id":id,"status":status,"result":outcome["result"],"error":outcome["error"]}));
    }
    Ok(items)
}

/// Read the work referenced by the accepted batch. Issue details only need status,
/// so they never fetch the delivery markdown or expose a member's private result.
pub(crate) async fn assignment_progress<M: Mysql>(
    mysql: &M,
    project: &str,
    issue: &str,
    batch: &str,
) -> MysqlResult<(bool, Vec<Value>)> {
    batch_progress(mysql, project, issue, batch, false).await
}

/// Collect terminal assignment evidence for the authorized manager's next turn.
pub async fn manager_round_outcomes<M: Mysql>(
    mysql: &M,
    project: &str,
    issue: &str,
    batch: &str,
) -> MysqlResult<(bool, Vec<Value>)> {
    batch_progress(mysql, project, issue, batch, true).await
}

async fn batch_progress<M: Mysql>(
    mysql: &M,
    project: &str,
    issue: &str,
    batch: &str,
    include_evidence: bool,
) -> MysqlResult<(bool, Vec<Value>)> {
    let row: Option<(Json<Value>,)> = mysql.fetch_optional(
        "SELECT metadata FROM project_chat_messages WHERE message_id=? AND project_id=? AND task_id=?",
        (batch, project, issue),
    ).await?;
    let Some((Json(metadata),)) = row else {
        return Ok((true, Vec::new()));
    };
    let mut progress = Vec::new();
    let mut waiting = false;
    let mut bindings = None;
    for entry in metadata["dispatch_assignments"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let assignee = entry
            .get("assignee_id")
            .or_else(|| entry.get("human_user_id"));
        let mut item = json!({
            "assignmentId":entry["assignment_id"], "assigneeType":entry["assignee_type"],
            "assigneeId":assignee.map(|id| id.as_str().map(str::to_owned).unwrap_or_else(|| id.to_string())).unwrap_or_default()
        });
        let status = if let Some(id) = entry["execution_id"].as_i64() {
            item["executionId"] = json!(id);
            mysql.fetch_optional::<_, _, (String, Json<Value>)>(
                "SELECT e.status,JSON_OBJECT('result',IF(?,JSON_UNQUOTE(JSON_EXTRACT(e.execution_payload,'$.assignment_result')),NULL),'error',IF(?,e.error_message,NULL)) FROM loop_item_executions original JOIN loop_item_executions e ON e.execution_scope=original.execution_scope AND e.cloud_project_id=original.cloud_project_id AND e.loop_item_id=original.loop_item_id WHERE original.id=? AND original.cloud_project_id=? AND original.loop_item_id=? ORDER BY e.id DESC LIMIT 1",
                (include_evidence, include_evidence, id, project, issue)
            ).await?.map(|(status, Json(evidence))| {
                if include_evidence {
                    item["result"] = evidence["result"].clone();
                    item["error"] = evidence["error"].clone();
                }
                status
            }).unwrap_or_else(|| "unavailable".into())
        } else if let Some(id) = entry["human_assignment_id"].as_str() {
            item["humanAssignmentId"] = json!(id);
            if bindings.is_none() {
                bindings = Some(execution_bindings(mysql, project, issue).await?);
            }
            let (binding, delivery) =
                human_work(mysql, bindings.as_deref().unwrap_or_default(), issue, id).await?;
            if include_evidence && let Some(delivery) = &delivery {
                item["deliveryId"] = json!(delivery.id);
            }
            human_status(binding, delivery.as_ref()).to_owned()
        } else {
            entry["status"].as_str().unwrap_or("unavailable").to_owned()
        };
        waiting |= !matches!(status.as_str(), "completed" | "failed" | "cancelled");
        item["status"] = json!(status);
        progress.push(item);
    }
    Ok((waiting || progress.is_empty(), progress))
}

/// `collaboration_human_assignment_status`: one round assignment's outcome.
async fn assignment_status(
    state: &ProjectState,
    bindings: &[BindingRow],
    issue_id: &str,
    human_assignment_id: &str,
) -> Result<Value, FastApiError> {
    let (binding, delivery) = human_work(&state.mysql, bindings, issue_id, human_assignment_id)
        .await
        .map_err(internal_error)?;
    let work_id = format!("human_assignment:{human_assignment_id}");
    let Some(binding) = binding else {
        return Ok(json!({
            "assignee_type": "human",
            "work_id": work_id,
            "human_assignment_id": human_assignment_id,
            "status": "queued",
            "result": "",
            "error": "",
        }));
    };
    let result = match &delivery {
        Some(delivery) => read_markdown(state, &delivery.markdown_object_key).await?,
        None => String::new(),
    };
    Ok(json!({
        "assignee_type": "human",
        "work_id": work_id,
        "human_assignment_id": human_assignment_id,
        "status": human_status(Some(binding), delivery.as_ref()),
        "human_user_id": binding.task_user_id,
        "runtime_device_id": binding.device_id,
        "runtime_task_id": binding.task_id,
        "delivery_id": delivery.as_ref().map(|delivery| delivery.id.clone()),
        "result": result,
        "error": "",
    }))
}

fn human_status(binding: Option<&BindingRow>, delivery: Option<&DeliveryRow>) -> &'static str {
    if delivery.is_some() {
        "completed"
    } else if binding.is_some() {
        "running"
    } else {
        "queued"
    }
}

async fn human_work<'a, M: Mysql>(
    mysql: &M,
    bindings: &'a [BindingRow],
    issue: &str,
    assignment: &str,
) -> MysqlResult<(Option<&'a BindingRow>, Option<DeliveryRow>)> {
    let matching = || {
        bindings
            .iter()
            .filter(|row| row.human_assignment_id() == Some(assignment))
    };
    let Some(first) = matching().next() else {
        return Ok((None, None));
    };
    let ids: Vec<_> = matching().map(|row| row.id.as_str()).collect();
    let delivery = latest_delivery(mysql, issue, &ids).await?;
    let binding = delivery
        .as_ref()
        .and_then(|value| matching().find(|row| row.id == value.source_task_binding_id))
        .unwrap_or(first);
    Ok((Some(binding), delivery))
}

/// `delivery_service.read_markdown`: fetch the delivery markdown object with
/// the source's 2 MiB bound and decode it as UTF-8. Every failure is the
/// route's unhandled 500 body (`python_exception_handler`).
async fn read_markdown(state: &ProjectState, object_key: &str) -> Result<String, FastApiError> {
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
    device_id: Option<String>,
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
    project_id: &str,
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

    let round: Option<Round> = if object.contains_key("dispatch_id")
        || object.contains_key("round_id")
        || object.contains_key("execution_ids")
    {
        Some(serde_json::from_value(value.clone()).map_err(|_| invalid_round())?)
    } else {
        None
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
            if items.is_empty() && round.as_ref().is_none_or(|r| r.execution_ids.is_empty()) {
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
    if let Some(round) = &round
        && (round.dispatch_id.is_empty()
            || round.round_id.is_empty()
            || round.execution_ids.len() + human_assignment_ids.as_ref().map_or(0, Vec::len) > 20
            || round.execution_ids.iter().any(|id| *id <= 0))
    {
        return Err(invalid_round());
    }
    Ok(StatusQuery {
        round,
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
#[brz_http_server::post("/api/v1/cloud-projects/:project_id/executions/statuses", group = project_coordination)]
async fn execution_statuses(
    #[inject(state)] state: &ProjectState,
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

    let mut items = if let Some(round) = &values.round {
        let project = crate::project_store::get(&state.mysql, "project", project_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(cloud_project_not_found)?;
        let issue = crate::project_store::get(&state.mysql, "task", &values.loop_item_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| FastApiError::not_found("Issue not found"))?;
        crate::project_authority::require_issue_with_priority(
            &state.mysql,
            &project,
            &issue,
            i64::from(user_id),
            priority,
        )
        .await
        .map_err(|_| FastApiError::forbidden("Issue access denied"))?;
        round_items(
            state,
            project_id,
            &issue.id,
            round,
            &values.human_assignment_ids,
        )
        .await?
    } else {
        Vec::new()
    };
    let bindings = if values.human_assignment_ids.is_empty() {
        Vec::new()
    } else {
        execution_bindings(&state.mysql, project_id, &values.loop_item_id)
            .await
            .map_err(internal_error)?
    };
    for human_assignment_id in &values.human_assignment_ids {
        items.push(
            assignment_status(state, &bindings, &values.loop_item_id, human_assignment_id).await?,
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
                round: None,
                loop_item_id: "PRJ-1".to_string(),
                human_assignment_ids: vec!["a".to_string(), "b".to_string()],
            }
        );
        let snake = parse_status_query(br#"{"loop_item_id":"PRJ-1","human_assignment_ids":["a"]}"#)
            .unwrap();
        assert_eq!(snake.human_assignment_ids, vec!["a".to_string()]);
    }

    #[test]
    fn ai_only_round_requires_scoped_receipts() {
        let mut request = json!({"loop_item_id":"issue","dispatch_id":"dispatch","round_id":"r","human_assignment_ids":[],"execution_ids":[42]});
        let parsed = parse_status_query(request.to_string().as_bytes()).unwrap();
        assert_eq!(parsed.round.unwrap().execution_ids, [42]);
        request["round_id"] = Value::Null;
        assert!(parse_status_query(request.to_string().as_bytes()).is_err());
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
        let rows = execution_bindings(&mysql, "5648598744554847056", "PRJD26304-10")
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
