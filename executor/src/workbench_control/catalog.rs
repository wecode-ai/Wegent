use crate::local::app_ipc::AppIpcError;
use serde_json::{json, Value};

fn text() -> Value {
    json!({"type":"string","minLength":1})
}
fn boolean() -> Value {
    json!({"type":"boolean"})
}
fn integer(min: u64, max: u64) -> Value {
    json!({"type":"integer","minimum":min,"maximum":max})
}

fn schedule() -> Value {
    json!({"type":"object","description":"Examples: {type:interval,value:5,unit:minutes}, {type:cron,expression:0 9 * * *}, or {type:one_time,execute_at:RFC3339 timestamp}.","oneOf":[
        {"properties":{"type":{"const":"interval"},"value":{"type":"integer","minimum":1},"unit":{"enum":["minutes","hours","days"]}},"required":["type","value","unit"],"additionalProperties":false},
        {"properties":{"type":{"const":"cron"},"expression":{"type":"string","minLength":1}},"required":["type","expression"],"additionalProperties":false},
        {"properties":{"type":{"const":"one_time"},"execute_at":{"type":"string","format":"date-time"}},"required":["type","execute_at"],"additionalProperties":false}
    ]})
}

fn operation(
    name: &str,
    description: &str,
    properties: Value,
    required: &[&str],
    read: bool,
) -> Value {
    json!({"name":name,"description":description,
        "inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},
        "outputSchema":super::output_schema::capability(name),
        "annotations":{"readOnlyHint":read,"openWorldHint":false}})
}

fn query_properties(search: bool) -> Value {
    let mut properties = json!({"limit":integer(1,100),"after":text(),"include_archived":{"type":"boolean","description":"Include archived standalone tasks/conversations. Set true when finding a missing, archived or accidentally deleted task."},"workspace_path":text(),"project_key":text(),
        "device_id":{"type":"string","minLength":1,"description":"Query only this owned device; resolve its ID from conversation creation options. Omit to query all sources."},
        "scope":{"type":"string","enum":["all","current_device"],"description":"Defaults to all: current device, cloud history and other owned devices."},
        "updated_after":{"type":"string","format":"date-time"},"updated_before":{"type":"string","format":"date-time"}});
    if search {
        properties["query"] = text();
    }
    properties
}

pub(crate) fn capabilities() -> Vec<Value> {
    let id = || json!({"conversation_id":text()});
    let mut ops = vec![
        operation("get_current_context", "Get the calling conversation, owning device and available control scope.", json!({}), &[], true),
        operation("list_conversations", "List standalone Wework tasks (conversations) across this device, cloud history and other devices. Set include_archived:true to find archived or missing tasks, even when no title or deletion time is known. Follow next_cursor until has_more is false and inspect coverage for unavailable sources. Time filters apply to conversation update times.", query_properties(false), &[], true),
        operation("search_conversations", "Search standalone Wework tasks (conversations) by titles, workspaces and complete native/cloud message histories across all devices. Set include_archived:true for archived or missing tasks. Paginate every page and inspect coverage before claiming a conversation is absent.", query_properties(true), &["query"], true),
        operation("get_conversation", "Read conversation metadata, original workspace, model, origin, PR bindings, queue and execution state.", id(), &["conversation_id"], true),
        operation("read_conversation", "Read native or cloud conversation history with cursor pagination. Use either before_cursor or after_cursor, and follow every page needed for the requested time period.", json!({"conversation_id":text(),"limit":integer(1,200),"before_cursor":text(),"after_cursor":text()}), &["conversation_id"], true),
        operation("continue_conversation", "Send a message to the original native conversation and workspace, including other owned devices permitted by existing device policy. Queues when busy. Supply a stable request_key to prevent duplicate delivery, including repeated CI failures.", json!({"conversation_id":text(),"message":text(),"request_key":text(),"queue_if_busy":boolean()}), &["conversation_id","message","request_key"], false),
        operation("get_conversation_creation_options", "Discover creation parameter schemas, this device's projects, models, skills and plugins, plus authorized remote execution environments. Use wework_space to select an Issue binding.", json!({"workspace_path":text(),"include_remote":boolean()}), &[], true),
        operation("create_conversation", "Create a conversation with Wework composer options: device, runtime, model and reasoning, permissions, project/workspace/worktree, skills/plugins, attachments, context, goal and supervisor. Omitted local settings inherit the caller. Returns the actual target conversation address.", super::creation_schema::creation_properties(), &["message"], false),
        operation("bind_change_request", "Persist an explicit PR/MR URL binding to a conversation. Use only a confirmed relationship.", json!({"conversation_id":text(),"url":text(),"remove":boolean()}), &["conversation_id","url"], false),
        operation("find_conversations_by_change_request", "Find confirmed conversation bindings by canonical PR/MR URL. Returns unique, missing or ambiguous; never guesses from a branch.", json!({"url":text()}), &["url"], true),
        operation("get_operation", "Read a message operation receipt and current target execution state. Accepted delivery is distinct from execution completion.", json!({"operation_id":text()}), &["operation_id"], true),
        operation("rename_conversation", "Rename a conversation using the same handler as the Wework UI.", json!({"conversation_id":text(),"title":text()}), &["conversation_id","title"], false),
        operation("archive_conversation", "Archive a conversation.", id(), &["conversation_id"], false),
        operation("unarchive_conversation", "Restore an archived conversation on this device using the existing unarchive workflow. In recovery interactions, let users select a matching archived conversation and restore it; offer opening the conversation after accepted is true. Navigation alone does not restore it.", id(), &["conversation_id"], false),
        operation("cancel_conversation", "Cancel a running or queued conversation.", id(), &["conversation_id"], false),
        operation("guide_conversation", "Send guidance to the active turn of a conversation.", json!({"conversation_id":text(),"message":text()}), &["conversation_id","message"], false),
        operation("present_interaction", "Optionally render dynamically generated, self-contained HTML in this conversation. Respect the user's presentation preference; use when clickable results, forms or navigation help. Direct tool calls remain available. No business-specific template is required. HTML is a fragment with scoped CSS and inline JavaScript. Default to high information density. Simple records use one compact list or table, with name, key status/time and a small action in each row on desktop. No per-item cards, split panels, duplicate headings or oversized gaps. Keep internal IDs and secondary details collapsed. Follow the visualize skill for readable type, compact desktop controls and mobile touch targets. window.wework.callTool(name,args) executes a declared real capability and returns decoded business data matching its outputSchema, without the MCP wrapper. Use one render(state) function for immediate success and state restoration; show meaningful result fields, never raw JSON. navigate(pathOrWeworkUrl) opens an existing destination; navigationTargets lists registered destinations; state and async setState(object) restore/save this card's state. Declare only needed tools. Restore state on load; never repeat mutations automatically. Fill only known values and let users complete missing fields in the generated form. Disable duplicate submissions. After tool success, a later render or state-save failure must not re-enable the write or report it as failed. The host handles resizing and theme tokens. Opening the interaction does not execute its business operations.", json!({"title":text(),"html":{"type":"string","minLength":1,"maxLength":1048576},"tools":{"type":"array","maxItems":64,"items":text(),"description":"Exact capability names this interaction may call. Use [] for navigation-only interactions."}}), &["title","html","tools"], true),
        operation("list_automations", "List saved schedules without exposing execution payloads or credentials.", json!({}), &[], true),
        operation("get_automation", "Read one schedule, including its current version and public execution settings.", json!({"automation_id":text()}), &["automation_id"], true),
        operation("create_automation", "Create a fully specified schedule from the current execution configuration. The owning device must be running for schedules to execute.", json!({"name":text(),"prompt":text(),"schedule":schedule(),"timezone":text(),"conversation_mode":{"type":"string","enum":["independent","continue_thread"]},"conversation_id":text(),"enabled":boolean()}), &["name","prompt","schedule","timezone"], false),
        operation("update_automation", "Update a schedule using its version for optimistic concurrency. Execution credentials remain private.", json!({"automation_id":text(),"version":integer(1,u64::MAX),"name":text(),"prompt":text(),"schedule":schedule(),"timezone":text(),"enabled":boolean()}), &["automation_id","version"], false),
        operation("toggle_automation", "Enable or disable a schedule.", json!({"automation_id":text(),"enabled":boolean()}), &["automation_id","enabled"], false),
        operation("delete_automation", "Delete a saved schedule.", json!({"automation_id":text()}), &["automation_id"], false),
        operation("run_automation", "Start a saved schedule immediately and return its actual run state.", json!({"automation_id":text()}), &["automation_id"], false),
        operation("list_automation_runs", "Read schedule run history.", json!({"automation_id":text()}), &[], true),
        operation("get_runtime_settings", "Read user-visible Runtime settings.", json!({}), &[], true),
        operation("get_runtime_capacity", "Read Runtime execution capacity and queues.", json!({}), &[], true),
        operation("list_models", "Read the owning device's safe model catalog.", json!({}), &[], true),
    ];
    for (name, description) in [
        ("get_conversation_goal", "Read the conversation's goal."),
        ("clear_conversation_goal", "Clear the conversation's goal."),
        (
            "get_conversation_supervisor",
            "Read the conversation's supervisor state.",
        ),
        (
            "clear_conversation_supervisor",
            "Clear the conversation's supervisor.",
        ),
    ] {
        ops.push(operation(
            name,
            description,
            id(),
            &["conversation_id"],
            name.starts_with("get_"),
        ));
    }
    ops
}

pub(crate) fn validate_arguments(name: &str, arguments: &Value) -> Result<(), AppIpcError> {
    let definition = capabilities()
        .into_iter()
        .find(|op| op["name"] == name)
        .ok_or_else(|| AppIpcError::new("not_found", "Unknown Wework capability"))?;
    validate_schema(&definition["inputSchema"], arguments)
}

pub(super) fn validate_tool_arguments(name: &str, arguments: &Value) -> Result<(), AppIpcError> {
    let definition = super::tools()
        .into_iter()
        .find(|tool| tool["name"] == name)
        .ok_or_else(|| AppIpcError::new("not_found", "Unknown Wework tool"))?;
    validate_schema(&definition["inputSchema"], arguments)
}

fn validate_schema(schema: &Value, arguments: &Value) -> Result<(), AppIpcError> {
    if matches_schema(schema, arguments) {
        Ok(())
    } else {
        Err(AppIpcError::new(
            "bad_request",
            "Arguments do not match the capability's inputSchema",
        ))
    }
}

// Validate the schema vocabulary used by this fixed application catalog.
pub(super) fn matches_schema(schema: &Value, value: &Value) -> bool {
    if schema
        .get("const")
        .is_some_and(|expected| expected != value)
        || schema["enum"]
            .as_array()
            .is_some_and(|allowed| !allowed.contains(value))
        || schema["oneOf"].as_array().is_some_and(|choices| {
            choices
                .iter()
                .filter(|choice| matches_schema(choice, value))
                .count()
                != 1
        })
    {
        return false;
    }
    if let Some(types) = schema["type"].as_array() {
        return types.iter().any(|kind| {
            let mut variant = schema.clone();
            variant["type"] = kind.clone();
            matches_schema(&variant, value)
        });
    }
    match schema["type"].as_str() {
        Some("string") => value.as_str().is_some_and(|s| {
            s.chars().count() >= schema["minLength"].as_u64().unwrap_or(0) as usize
                && s.chars().count() <= schema["maxLength"].as_u64().unwrap_or(u64::MAX) as usize
                && (schema["minLength"].as_u64().unwrap_or(0) == 0 || !s.trim().is_empty())
                && (schema["format"] != "date-time"
                    || chrono::DateTime::parse_from_rfc3339(s).is_ok())
        }),
        Some("boolean") => value.is_boolean(),
        Some("null") => value.is_null(),
        Some("array") => value.as_array().is_some_and(|items| {
            items.len() >= schema["minItems"].as_u64().unwrap_or(0) as usize
                && items.len() <= schema["maxItems"].as_u64().unwrap_or(u64::MAX) as usize
                && items.iter().all(|item| {
                    schema
                        .get("items")
                        .map_or(true, |spec| matches_schema(spec, item))
                })
        }),
        Some("integer") => value.as_u64().is_some_and(|n| {
            n >= schema["minimum"].as_u64().unwrap_or(0)
                && n <= schema["maximum"].as_u64().unwrap_or(u64::MAX)
        }),
        Some("object") | None
            if schema.get("properties").is_some() || schema["type"] == "object" =>
        {
            let Some(fields) = value.as_object() else {
                return false;
            };
            schema["required"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .all(|key| fields.contains_key(key))
                && fields
                    .iter()
                    .all(|(key, child)| match schema["properties"].get(key) {
                        Some(spec) => matches_schema(spec, child),
                        None if schema["additionalProperties"].is_object() => {
                            matches_schema(&schema["additionalProperties"], child)
                        }
                        None => schema["additionalProperties"] != false,
                    })
        }
        None => true,
        _ => false,
    }
}
