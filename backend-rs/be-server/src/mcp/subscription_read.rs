// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `tools/call` bodies for the subscription MCP server
//! (`app/mcp_server/tools/subscription_read.py`).
//!
//! `get_subscription(token_info, subscription_id)` loads one owned active
//! `Subscription` `kinds` row (`SubscriptionService.get_subscription`:
//! `db.query(Kind).filter(id, user_id, kind='Subscription', is_active=true)
//! .first()`) and renders it through `serialize_subscription(...,
//! include_details=True)`. That row load is the call's single dependency: the
//! conversion reads the stored CRD plus `_internal`, and
//! `resolve_workspace_repo_fields` only touches a Workspace when the row
//! references one.
//!
//! `preview_subscription`, `create_subscription`, and `list_subscriptions`
//! remain unmigrated, so the transport keeps answering them with the
//! protocol's `Unknown tool` error instead of inventing a result.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::internal_callback::py_json::python_dumps_utf8;
use crate::mcp::protocol;
use crate::mcp::tools;
use crate::state::AppState;
use crate::subscriptions_item::FIND_SUBSCRIPTION_QUERY;
use crate::subscriptions_list::KindRow;
use crate::subscriptions_list::convert::convert_to_subscription_in_db;
use crate::subscriptions_list::workspaces::RepoFields;
use crate::task_token;

/// `get_subscription`'s `HTTPException(404)` branch, rendered by the tool body.
const NOT_FOUND_ERROR: &str =
    "Subscription not found, deleted, or not accessible to the current user";

/// The tool whose body this batch migrates.
const GET_SUBSCRIPTION_TOOL: &str = "get_subscription";

/// `serialize_subscription(..., include_details=True)` key order: the
/// `include_details=False` block, the two keys the source adds at their
/// declaration position, and then the detail tail.
const ORDERED_KEYS: &[&str] = &[
    "id",
    "name",
    "display_name",
    "description",
    "task_type",
    "trigger_type",
    "trigger_config",
    "trigger_summary",
    "team_id",
    "workspace_id",
    "model_ref",
    "preserve_history",
    "history_message_count",
    "retry_count",
    "timeout_seconds",
    "enabled",
    "is_active",
    "is_rental",
    "next_execution_time",
    "last_execution_time",
    "last_execution_status",
    "last_execution_message",
    "execution_count",
    "success_count",
    "failure_count",
    "bound_task_id",
    "expires_at",
    "is_expired",
    "trigger_config_valid",
    "trigger_config_error",
    "created_at",
    "updated_at",
    "management_url",
    // `include_details=True` tail.
    "visibility",
    "prompt_template",
    "git_repo",
    "git_domain",
    "branch_name",
    "knowledge_base_refs",
    "skill_refs",
    "source_subscription_id",
    "source_subscription_name",
    "source_subscription_display_name",
    "source_owner_username",
];

/// `Server.call_tool` for the subscription server: `get_subscription` runs the
/// migrated tool body, every other tool keeps the protocol's `Unknown tool`
/// error.
pub(crate) async fn call(
    state: &AppState,
    authorization: Option<&str>,
    id: &Value,
    params: Option<&Value>,
) -> String {
    let Some(request) = params.and_then(Value::as_object) else {
        return protocol::error_body(id, protocol::INVALID_PARAMS, "Invalid arguments");
    };
    let Some(name) = request.get("name").and_then(Value::as_str) else {
        return protocol::error_body(id, protocol::INVALID_PARAMS, "Invalid arguments");
    };
    if name != GET_SUBSCRIPTION_TOOL {
        return protocol::error_body(
            id,
            protocol::INVALID_PARAMS,
            &format!("Unknown tool: {name}"),
        );
    }
    let empty = Map::new();
    let arguments = request
        .get("arguments")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    match get_subscription(state, authorization, arguments).await {
        Ok(text) => protocol::success_body(id, &tools::text_result(text)),
        // `tool_wrapper` serializes any escaped exception as this payload.
        Err(message) => {
            let payload = json!({
                "error": {
                    "code": "MCP_TOOL_EXECUTION_FAILED",
                    "message": message,
                    "server": "subscription",
                    "tool": GET_SUBSCRIPTION_TOOL,
                    "retryable": false,
                }
            });
            protocol::success_body(id, &tools::text_result(python_dumps_utf8(&payload)))
        }
    }
}

/// `get_subscription`: load the row and render the tool's JSON string.
async fn get_subscription(
    state: &AppState,
    authorization: Option<&str>,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
    // `tool_wrapper`: an unauthenticated call returns this payload as an
    // ordinary (non-error) tool result.
    let Some(identity) = task_token::verify(&state.auth, authorization) else {
        return Ok(python_dumps_utf8(
            &json!({ "error": "Authentication required" }),
        ));
    };
    let Some(subscription_id) = arguments.get("subscription_id").and_then(Value::as_i64) else {
        return Err("subscription_id: Input should be a valid integer".to_string());
    };

    let row = state
        .mysql
        .fetch_optional::<_, _, KindRow>(
            FIND_SUBSCRIPTION_QUERY,
            (subscription_id, identity.user_id),
        )
        .await
        .map_err(|error| error.to_string())?;
    let Some(row) = row else {
        return Ok(python_dumps_utf8(
            &json!({ "success": false, "error": NOT_FOUND_ERROR }),
        ));
    };

    let subscription = serialize_subscription(state, &row).await;
    Ok(python_dumps_utf8(&json!({
        "success": true,
        "subscription": subscription,
    })))
}

/// `serialize_subscription(..., include_details=True)`: the client-safe
/// payload in the source function's key order.
async fn serialize_subscription(state: &AppState, row: &KindRow) -> Value {
    let workspace_cache = load_workspace_cache(state, row).await;
    serialize_row(row, &workspace_cache)
}

/// The pure rendering half of [`serialize_subscription`]: `_convert_to_
/// subscription_in_db` plus the source's `serialize_subscription` overlay.
fn serialize_row(row: &KindRow, workspace_cache: &HashMap<i64, RepoFields>) -> Value {
    let item = convert_to_subscription_in_db(row, workspace_cache);
    let converted = serde_json::to_value(&item).expect("a converted subscription serializes");

    // `trigger_summary` derives from the item's own `trigger_type` and
    // `trigger_config`.
    let trigger_type = item_trigger_type(&converted);
    let trigger_config = converted
        .get("trigger_config")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let mut data = Map::new();
    for key in ORDERED_KEYS {
        let value = match *key {
            "trigger_summary" => json!(describe_trigger(&trigger_type, &trigger_config)),
            "is_active" => json!(true),
            "management_url" => json!(format!("/subscriptions/{}", row.id)),
            // `_serialize_refs`: an absent reference list renders `[]`.
            "knowledge_base_refs" | "skill_refs" => match converted.get(*key) {
                Some(Value::Array(items)) if !items.is_empty() => Value::Array(items.clone()),
                _ => json!([]),
            },
            // `subscription.workspace_id or None` / `subscription.bound_task_id
            // or None`: a zero renders as JSON null.
            "workspace_id" | "bound_task_id"
                if converted.get(*key).and_then(Value::as_i64) == Some(0) =>
            {
                Value::Null
            }
            _ => converted.get(*key).cloned().unwrap_or(Value::Null),
        };
        data.insert((*key).to_string(), value);
    }
    Value::Object(data)
}

/// The serialized item's `trigger_type`.
fn item_trigger_type(converted: &Value) -> String {
    converted
        .get("trigger_type")
        .and_then(Value::as_str)
        .unwrap_or("cron")
        .to_string()
}

/// `resolve_workspace_repo_fields` with no page cache: only a non-zero
/// `_internal.workspace_id` resolves repository fields. The source also
/// resolves a `spec.workspaceRef` through the task store; that lookup is not
/// migrated here and renders the same empty fields the subscription list
/// conversion uses for an unresolved reference.
async fn load_workspace_cache(state: &AppState, row: &KindRow) -> HashMap<i64, RepoFields> {
    let workspace_id = row
        .json
        .0
        .get("_internal")
        .and_then(|internal| internal.get("workspace_id"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if workspace_id == 0 {
        return HashMap::new();
    }
    state
        .workspace_repository
        .fetch_repo_fields(&state.mysql, &[workspace_id])
        .await
        .unwrap_or_default()
}

/// `format_trigger_description`: the human-readable trigger description.
fn describe_trigger(trigger_type: &str, config: &Value) -> String {
    let string_field = |key: &str| {
        config
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match trigger_type {
        "cron" => format!(
            "Cron表达式: `{}` (时区: {})",
            string_field("expression"),
            config
                .get("timezone")
                .and_then(Value::as_str)
                .unwrap_or("UTC")
        ),
        "interval" => {
            let unit = string_field("unit");
            let unit_zh = match unit.as_str() {
                "minutes" => "分钟".to_string(),
                "hours" => "小时".to_string(),
                "days" => "天".to_string(),
                other => other.to_string(),
            };
            format!(
                "每 {} {}执行",
                config.get("value").and_then(Value::as_i64).unwrap_or(0),
                unit_zh
            )
        }
        "one_time" => format!(
            "一次性执行于 {} (时区: {})",
            string_field("execute_at"),
            config
                .get("timezone")
                .and_then(Value::as_str)
                .unwrap_or("UTC")
        ),
        "event" => format!(
            "事件触发: {}",
            config
                .get("event_type")
                .and_then(Value::as_str)
                .unwrap_or("event")
        ),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;

    fn kind_row(document: Value) -> KindRow {
        KindRow {
            id: 2643427,
            user_id: 4097,
            kind: "Subscription".to_string(),
            name: "sub-uv-51891ddf".to_string(),
            namespace: "default".to_string(),
            json: brz_mysql::Json(document),
            is_active: 1,
            created_at: NaiveDateTime::parse_from_str("2026-11-11 16:24:10", "%Y-%m-%d %H:%M:%S")
                .unwrap(),
            updated_at: NaiveDateTime::parse_from_str("2026-11-11 16:24:10", "%Y-%m-%d %H:%M:%S")
                .unwrap(),
        }
    }

    /// The recorded `get_subscription` row (case cbf00b75).
    fn recorded_document() -> Value {
        json!({
            "kind": "Subscription",
            "spec": {
                "displayName": "短剧需求搜索词天级判定与钉钉推送（uv分档版）",
                "description": "描述",
                "taskType": "collection",
                "visibility": "private",
                "promptTemplate": "模板",
                "modelRef": null,
                "knowledgeBaseRefs": null,
                "skillRefs": null,
                "workspaceRef": null,
                "retryCount": 1,
                "timeoutSeconds": 7200,
                "preserveHistory": false,
                "historyMessageCount": 10,
                "trigger": {
                    "type": "cron",
                    "cron": {"expression": "0 10 * * *", "timezone": "Asia/Shanghai"},
                    "event": null,
                    "interval": null,
                    "one_time": null
                }
            },
            "_internal": {
                "enabled": true,
                "team_id": 110467,
                "expires_at": null,
                "trigger_type": "cron",
                "workspace_id": 0,
                "bound_task_id": 0,
                "failure_count": 0,
                "success_count": 0,
                "webhook_token": "",
                "execution_count": 0,
                "last_execution_time": null,
                "next_execution_time": "2026-11-12T02:00:00",
                "last_execution_status": "",
                "market_whitelist_user_ids": []
            }
        })
    }

    #[test]
    fn serialized_payload_matches_the_recorded_case() {
        let row = kind_row(recorded_document());
        let payload = serialize_row(&row, &HashMap::new());

        // The recorded response's key order (case cbf00b75).
        let keys: Vec<&str> = payload
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        let expected = [
            "id",
            "name",
            "display_name",
            "description",
            "task_type",
            "trigger_type",
            "trigger_config",
            "trigger_summary",
            "team_id",
            "workspace_id",
            "model_ref",
            "preserve_history",
            "history_message_count",
            "retry_count",
            "timeout_seconds",
            "enabled",
            "is_active",
            "is_rental",
            "next_execution_time",
            "last_execution_time",
            "last_execution_status",
            "last_execution_message",
            "execution_count",
            "success_count",
            "failure_count",
            "bound_task_id",
            "expires_at",
            "is_expired",
            "trigger_config_valid",
            "trigger_config_error",
            "created_at",
            "updated_at",
            "management_url",
            "visibility",
            "prompt_template",
            "git_repo",
            "git_domain",
            "branch_name",
            "knowledge_base_refs",
            "skill_refs",
            "source_subscription_id",
            "source_subscription_name",
            "source_subscription_display_name",
            "source_owner_username",
        ];
        assert_eq!(keys, expected);
        assert_eq!(
            payload["trigger_summary"],
            json!("Cron表达式: `0 10 * * *` (时区: Asia/Shanghai)")
        );
        assert_eq!(payload["management_url"], json!("/subscriptions/2643427"));
        assert_eq!(payload["is_active"], json!(true));
        assert_eq!(payload["knowledge_base_refs"], json!([]));
        // `workspace_id or None` / `bound_task_id or None`.
        assert_eq!(payload["workspace_id"], Value::Null);
        assert_eq!(payload["bound_task_id"], Value::Null);
        assert_eq!(payload["next_execution_time"], json!("2026-11-12T02:00:00"));
    }

    #[test]
    fn trigger_descriptions_match_the_source_strings() {
        assert_eq!(
            describe_trigger(
                "cron",
                &json!({"expression": "0 10 * * *", "timezone": "Asia/Shanghai"})
            ),
            "Cron表达式: `0 10 * * *` (时区: Asia/Shanghai)"
        );
        assert_eq!(
            describe_trigger("interval", &json!({"value": 5, "unit": "minutes"})),
            "每 5 分钟执行"
        );
        assert_eq!(
            describe_trigger("event", &json!({"event_type": "git_push"})),
            "事件触发: git_push"
        );
        assert_eq!(describe_trigger("unknown", &json!({})), "");
    }

    #[test]
    fn the_read_selection_matches_the_source_query() {
        assert!(FIND_SUBSCRIPTION_QUERY.contains("kinds.kind = 'Subscription'"));
        assert!(FIND_SUBSCRIPTION_QUERY.contains("kinds.is_active = true"));
        assert!(FIND_SUBSCRIPTION_QUERY.ends_with("LIMIT 1"));
        assert_eq!(GET_SUBSCRIPTION_TOOL, "get_subscription");
    }
}
