//! Public business results shared by model discovery and generated HTML tool bindings.
use serde_json::{json, Value};

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required})
}

fn array(items: Value) -> Value {
    json!({"type":"array","items":items})
}

fn string() -> Value {
    json!({"type":"string"})
}

fn nullable(mut schema: Value) -> Value {
    schema["type"] = json!([schema["type"], "null"]);
    schema
}

fn conversation() -> Value {
    object(
        json!({"conversation_id":string(),"taskId":string(),"device_id":string(),
            "title":string(),"name":string(),"status":string(),"runtime":string(),
            "source":string(),"workspacePath":nullable(string()),"project_key":nullable(string()),
            "created_at":{"type":"integer"},"updated_at":{"type":"integer"},
            "model_selection":{"type":["object","null"]},"origin":{"type":["object","null"]},
            "change_requests":nullable(array(string())),"goal":{"type":["object","null"]}}),
        &["conversation_id", "taskId"],
    )
}

fn conversation_page() -> Value {
    object(
        json!({"items":array(conversation()),"has_more":{"type":"boolean"},
            "next_cursor":nullable(string()),"coverage":object(json!({
                "scope":string(),"device_id":string(),"sources":array(json!({"type":"object"})),
                "unavailable_count":{"type":"integer"},
                "unavailable_reasons":{"type":"object","additionalProperties":{"type":"integer"}},
                "authorized_index_complete":{"type":"boolean"}
            }), &["scope","unavailable_count","unavailable_reasons","authorized_index_complete"])}),
        &["items", "has_more", "next_cursor", "coverage"],
    )
}

fn action() -> Value {
    object(
        json!({"success":{"type":"boolean"},"accepted":{"type":"boolean"},
            "taskId":string(),"runtime":string(),"workspacePath":nullable(string()),
            "threadId":nullable(string()),"turnId":nullable(string())}),
        &["accepted"],
    )
}

fn action_with(field: &str, schema: Value) -> Value {
    let mut result = action();
    result["properties"][field] = schema;
    result["required"]
        .as_array_mut()
        .unwrap()
        .push(json!(field));
    result
}

fn receipt() -> Value {
    object(
        json!({"operation_id":string(),"conversation_id":string(),"device_id":string(),
            "task_id":string(),"fingerprint":string(),"created_at":{"type":"integer"},
            "delivery_status":{"enum":["pending","accepted","rejected","needs_attention"]},
            "result":{"type":"object"},"error":object(json!({"code":string(),"message":string()}), &["code","message"])}),
        &[
            "operation_id",
            "conversation_id",
            "device_id",
            "delivery_status",
        ],
    )
}

fn model_catalog() -> Value {
    object(
        json!({"models":array(object(json!({"runtime":string(),"provider":nullable(string()),
            "model_id":string(),"local_model_id":nullable(string()),"label":string(),
            "account_label":nullable(string()),"is_default":{"type":"boolean"}}), &["runtime","model_id","label"])),
            "runtimes":array(string()),"errors":array(string())}),
        &["models", "runtimes", "errors"],
    )
}

fn settings() -> Value {
    object(
        json!({"maxConcurrentTasks":{"type":"integer"},"maxConcurrentStandInTasks":{"type":"integer"},
            "maxConcurrentAgentTasks":{"type":"integer"}}),
        &[
            "maxConcurrentTasks",
            "maxConcurrentStandInTasks",
            "maxConcurrentAgentTasks",
        ],
    )
}

fn supervisor() -> Value {
    nullable(object(
        json!({"mode":string(),"status":string(),"instructions":string(),
            "modelSelection":{"type":["object","null"]},"intervalSeconds":{"type":"integer"},
            "lastEvaluatedAt":{"type":["integer","null"]},"lastError":nullable(string()),
            "suggestions":array(object(json!({"id":string(),"message":string(),"rationale":string(),
                "status":string(),"createdAt":{"type":"integer"},"resolvedAt":{"type":["integer","null"]},
                "sourceTurnId":nullable(string())}), &["id","message","status"]))}),
        &["mode", "status", "instructions", "suggestions"],
    ))
}

fn capacity() -> Value {
    let category = object(
        json!({"limit":{"type":"integer"},"active":{"type":"integer"},
            "active_task_ids":array(string()),"queued":{"type":"integer"}}),
        &["limit", "active", "active_task_ids", "queued"],
    );
    let mut result = settings();
    result["properties"]
        .as_object_mut()
        .unwrap()
        .extend(category["properties"].as_object().unwrap().clone());
    result["properties"]["categories"] = object(
        json!({"personal":category,"standIn":category,"agent":category}),
        &["personal", "standIn", "agent"],
    );
    result["required"].as_array_mut().unwrap().extend(
        ["limit", "active", "active_task_ids", "queued", "categories"].map(|field| json!(field)),
    );
    result
}

fn automation() -> Value {
    object(
        json!({"id":string(),"version":{"type":"integer","minimum":1},"name":string(),
            "description":string(),"prompt":string(),"schedule":{"type":"object","properties":{
                "type":{"enum":["interval","cron","one_time"]},"value":{"type":"integer"},
                "unit":{"enum":["minutes","hours","days"]},"expression":string(),"execute_at":string()},"required":["type"]},
            "timezone":string(),"enabled":{"type":"boolean"},
            "conversationMode":{"enum":["independent","continue_thread"]},
            "notificationPolicy":{"enum":["all_runs","attention_only","never"]},
            "nextRunAt":nullable(string()),"lastRunAt":nullable(string()),
            "createdAt":string(),"updatedAt":string()}),
        &["id", "version", "name"],
    )
}

fn run() -> Value {
    object(
        json!({"id":string(),"automationId":string(),"scheduledFor":string(),"trigger":string(),
            "status":{"enum":["pending","running","succeeded","failed","skipped","needs_attention","cancelled"]},
            "taskId":nullable(string()),"error":nullable(string()),"createdAt":string(),"updatedAt":string()}),
        &["id", "automationId", "status"],
    )
}

pub(super) fn capability(name: &str) -> Value {
    match name {
        "get_current_context" => object(
            json!({"conversation_id":string(),"device_id":string(),
            "scope":string(),"continuation_scope":string(),"other_tools":array(string())}),
            &["conversation_id", "device_id", "scope"],
        ),
        "list_conversations" | "search_conversations" => conversation_page(),
        "get_conversation" | "bind_change_request" => conversation(),
        "read_conversation" => object(
            json!({"messages":array(json!({"type":"object"})),
            "hasMoreBefore":{"type":"boolean"},"hasMoreAfter":{"type":"boolean"},
            "beforeCursor":nullable(string()),"afterCursor":nullable(string()),
            "has_more_before":{"type":"boolean"},"has_more_after":{"type":"boolean"},
            "before_cursor":nullable(string()),"after_cursor":nullable(string()),
            "contentMayBeTruncated":{"type":"boolean"}}),
            &["messages"],
        ),
        "continue_conversation" => object(
            json!({"operation":receipt(),"duplicate":{"type":"boolean"}}),
            &["operation", "duplicate"],
        ),
        "get_operation" => object(
            json!({"operation":receipt(),"current_conversation":nullable(conversation()),
            "completion":{"const":"inspect_original_conversation"}}),
            &["operation", "current_conversation", "completion"],
        ),
        "get_conversation_creation_options" => object(
            json!({"device_id":string(),"scope":string(),
            "parameters":{"type":"object","description":"JSON Schema for create_conversation arguments."},
            "models":model_catalog(),"configured_models":array(object(json!({"runtime":string(),
                "modelName":string(),"modelType":{"const":"runtime"},"label":nullable(string()),
                "source":{"const":"model_interface"}}), &["runtime","modelName","modelType","source"])),
            "projects":array(object(json!({"key":string(),"name":string(),"workspace_path":string(),
                "roots":array(string()),"active":{"type":"boolean"}}), &["key","name","workspace_path"])),
            "composer_catalog":{"type":"object"},"composer_catalog_unavailable":{"type":"boolean"},
            "execution_environments":{},"cloud_models":{}}),
            &[
                "device_id",
                "scope",
                "parameters",
                "models",
                "configured_models",
                "projects",
            ],
        ),
        "create_conversation" => {
            let mut result = action();
            result["properties"]["conversation_id"] = string();
            result["properties"]["device_id"] = string();
            result["required"] = json!(["conversation_id", "device_id"]);
            result
        }
        "find_conversations_by_change_request" => object(
            json!({"resolution":{"enum":["missing","unique","ambiguous"]},
            "items":array(conversation()),"url":string()}),
            &["resolution", "items", "url"],
        ),
        "rename_conversation"
        | "archive_conversation"
        | "unarchive_conversation"
        | "cancel_conversation"
        | "guide_conversation" => action(),
        "get_conversation_goal" => action_with(
            "goal",
            json!({"type":["object","null"],"properties":{
            "objective":string(),"status":string(),"tokenBudget":{"type":["integer","null"]}}}),
        ),
        "clear_conversation_goal" => action_with("cleared", json!({"type":"boolean"})),
        "get_conversation_supervisor" | "clear_conversation_supervisor" => {
            action_with("supervisor", supervisor())
        }
        "present_interaction" => object(json!({"title":string()}), &["title"]),
        "list_automations" => object(json!({"items":array(automation())}), &["items"]),
        "get_automation" | "create_automation" | "update_automation" | "toggle_automation" => {
            object(json!({"automation":automation()}), &["automation"])
        }
        "delete_automation" => object(
            json!({"deleted":{"type":"boolean"},"automationId":string()}),
            &["deleted", "automationId"],
        ),
        "run_automation" => object(json!({"run":nullable(run())}), &["run"]),
        "list_automation_runs" => object(json!({"items":array(run())}), &["items"]),
        "get_runtime_settings" => settings(),
        "get_runtime_capacity" => capacity(),
        "list_models" => model_catalog(),
        _ => unreachable!("Missing public output contract for {name}"),
    }
}

pub(super) fn discovery(name: &str) -> Value {
    let definition = object(
        json!({"name":string(),"description":string(),
        "inputSchema":{"type":"object"},"outputSchema":{"type":"object"},"annotations":{"type":"object"}}),
        &["name", "description", "inputSchema", "outputSchema"],
    );
    match name {
        "list_capabilities" => object(json!({"capabilities":array(definition)}), &["capabilities"]),
        "describe_capability" => definition,
        "invoke_capability" => {
            json!({"type":"object","description":"Business data matching the selected capability's outputSchema. Use describe_capability before invoking."})
        }
        _ => unreachable!("Unknown discovery tool {name}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_work::automations::{AutomationRun, AutomationRunStatus};

    #[test]
    fn run_contract_matches_serialized_business_states_and_null_runs() {
        for status in [
            AutomationRunStatus::Pending,
            AutomationRunStatus::Running,
            AutomationRunStatus::Succeeded,
            AutomationRunStatus::Failed,
            AutomationRunStatus::Skipped,
            AutomationRunStatus::NeedsAttention,
            AutomationRunStatus::Cancelled,
        ] {
            let now = chrono::Utc::now();
            let run = AutomationRun {
                id: "run-contract".into(),
                automation_id: "automation-contract".into(),
                scheduled_for: now,
                trigger: "manual".into(),
                status,
                task_id: None,
                error: Some("Needs review".into()),
                created_at: now,
                updated_at: now,
                coordination: None,
            };
            super::super::assert_output_contract("run_automation", &json!({"run":run}));
            super::super::assert_output_contract("list_automation_runs", &json!({"items":[run]}));
        }
        super::super::assert_output_contract("run_automation", &json!({"run":null}));
    }
}
