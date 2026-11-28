//! Versioned collaboration tools share a schema and preserve individual authority.

use super::*;
use sha2::{Digest, Sha256};

mod queries;
mod reads;
#[cfg(test)]
mod tests;
mod writes;

const SCHEMA: &str = include_str!("../../../../shared/protocol/wework_space_tools_v2.json");

pub(super) fn tools() -> Vec<Value> {
    serde_json::from_str::<Value>(SCHEMA).expect("checked-in board schema")["tools"]
        .as_array()
        .expect("tool array")
        .clone()
}

pub(super) fn contains(name: &str) -> bool {
    tools().iter().any(|tool| tool["name"] == name)
}

pub(super) async fn discovered_projects(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
) -> Result<Value, String> {
    queries::discovery(runtime, context, &json!({})).await
}

pub(super) fn hash(value: &Value) -> String {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(values) => {
                let sorted = values
                    .iter()
                    .map(|(key, value)| (key.clone(), canonical(value)))
                    .collect::<BTreeMap<_, _>>();
                serde_json::to_value(sorted).expect("JSON object")
            }
            Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
            _ => value.clone(),
        }
    }
    format!(
        "{:x}",
        Sha256::digest(canonical(value).to_string().as_bytes())
    )
}

fn owner(runtime: &TaskRuntime, context: &SpaceMcpRequestContext) -> String {
    hash(&json!([
        runtime.stand_in_store().path(),
        context.backend_url,
        context
            .principal_id
            .as_ref()
            .or(context.auth_token.as_ref()),
        context.grant.as_ref().map(|grant| json!([
            grant.task_id,
            grant.space_id,
            grant.item_id,
            grant.role
        ]))
    ]))
}

pub(super) fn device(context: &SpaceMcpRequestContext) -> Result<String, String> {
    context
        .current_device_id
        .clone()
        .or_else(|| {
            context
                .control
                .as_ref()
                .map(|control| control.device_id.clone())
        })
        .or_else(|| {
            context
                .grant
                .as_ref()
                .and_then(|grant| grant.device_id.clone())
        })
        .or_else(|| non_empty_env("WEGENT_APP_IPC_DEVICE_ID"))
        .or_else(|| non_empty_env("DEVICE_ID"))
        .ok_or_else(|| "Current Executor device identity is unavailable".into())
}

async fn authorize(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    target: &Value,
    action: &str,
) -> Result<(), String> {
    let space = target.get("space").unwrap_or(target);
    let project = space["space_id"].as_str().ok_or("space_id is required")?;
    if space["project_store"] == "local" {
        if space["device_id"].as_str() != Some(device(context)?.as_str()) {
            return Err("scope_violation: target belongs to another device".into());
        }
        if project_space_ref(runtime, context, project)?["project_store"] != "local" {
            return Err("Project reference does not match its store".into());
        }
    } else if space["project_store"] != "backend" {
        return Err("Invalid project store".into());
    }
    if let Some(category) = board_tool_category(action) {
        if !grant_allows(context.grant.as_ref(), category) {
            return Err("scope_violation: delegated tool category denied".into());
        }
    }
    if let Some(grant) = context.grant.as_ref() {
        if let Some(bound_project) = grant.space_id.as_deref().filter(|_| grant.role.is_some()) {
            let catalogued = runtime.stand_in_store().get_project(bound_project);
            let bound_store = match (context.bound_project_store.as_deref(), &catalogued) {
                (Some(store), _) => store,
                (None, Ok(project)) => project.metadata["project_store"]
                    .as_str()
                    .ok_or("Project storage identity is unavailable")?,
                (None, Err(super::super::TaskRuntimeError::ProjectNotFound)) => "backend",
                (None, Err(error)) => return Err(error.to_string()),
            };
            if space["project_store"] != bound_store {
                return Err("scope_violation: target belongs to another project store".into());
            }
        }
        let arguments = json!({"space_id":project,"item_id":target.get("item_id")});
        if let Some(error) = context_scope_error(grant, &arguments) {
            if !parent_issue::authorize_read(runtime, action, &arguments, context).await? {
                return Err(error);
            }
        }
    }
    Ok(())
}

async fn individual(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let result = call_individual_tool(runtime, name, arguments, context).await;
    let text = result["content"][0]["text"]
        .as_str()
        .ok_or("Missing tool result")?;
    if result["isError"] == true {
        return Err(text.into());
    }
    serde_json::from_str(text).map_err(|error| error.to_string())
}

pub(super) async fn cloud(
    context: &SpaceMcpRequestContext,
    name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let (Some(url), Some(token)) = (&context.backend_url, &context.auth_token) else {
        return Err("Backend connection is unavailable".into());
    };
    let endpoint = crate::agents::runtime_capabilities::api_url(url, "/api/mcp/wework-space/sse")?;
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|error| error.to_string())?
        .post(endpoint)
        .bearer_auth(token)
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":arguments}}))
        .send()
        .await
        .map_err(|_| "source_unavailable: backend operation response was not received".to_owned())?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| "Invalid MCP response".to_owned())?;
    if !status.is_success() {
        return Err(format!("Backend MCP request failed ({status})"));
    }
    let value: Value = serde_json::from_str(&body)
        .or_else(|_| {
            body.lines()
                .filter_map(|line| line.strip_prefix("data: "))
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find(|value| value.get("result").is_some())
                .ok_or_else(|| serde_json::from_str::<Value>("").unwrap_err())
        })
        .map_err(|_| "Invalid MCP response".to_owned())?;
    if value.get("error").is_some() || value["result"]["isError"] == true {
        return Err("Backend MCP operation failed".into());
    }
    let result: Value = serde_json::from_str(
        value["result"]["content"][0]["text"]
            .as_str()
            .ok_or("Missing MCP content")?,
    )
    .map_err(|error| error.to_string())?;
    if result.get("error").is_some() {
        return Err(result["error"].to_string());
    }
    Ok(result)
}

fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    if let Some(options) = schema["oneOf"].as_array() {
        if options
            .iter()
            .filter(|schema| validate(schema, value).is_ok())
            .count()
            != 1
        {
            return Err("Invalid request variant".into());
        }
    }
    if let Some(expected) = schema.get("const") {
        if expected != value {
            return Err("Invalid constant".into());
        }
    }
    if let Some(options) = schema["enum"].as_array() {
        if !options.contains(value) {
            return Err("Invalid enum value".into());
        }
    }
    if let Some(kind) = schema.get("type") {
        let kinds = kind
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![kind.clone()]);
        if !kinds.iter().any(|kind| match kind.as_str() {
            Some("object") => value.is_object(),
            Some("array") => value.is_array(),
            Some("string") => value.is_string(),
            Some("integer") => value.is_i64() || value.is_u64(),
            Some("boolean") => value.is_boolean(),
            Some("null") => value.is_null(),
            _ => false,
        }) {
            return Err("Invalid value type".into());
        }
    }
    if let Some(object) = value.as_object() {
        for key in schema["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !object.contains_key(key) {
                return Err(format!("{key} is required"));
            }
        }
        for (key, value) in object {
            if let Some(child) = schema["properties"].get(key) {
                validate(child, value)?;
            } else if schema["additionalProperties"] == false {
                return Err(format!("Unknown field: {key}"));
            }
        }
    }
    if let Some(values) = value.as_array() {
        if schema["uniqueItems"] == true
            && values.iter().map(hash).collect::<HashSet<_>>().len() != values.len()
        {
            return Err("Duplicate array value".into());
        }
        if values.len() < schema["minItems"].as_u64().unwrap_or(0) as usize
            || values.len() > schema["maxItems"].as_u64().unwrap_or(u64::MAX) as usize
        {
            return Err("Invalid array size".into());
        }
        if let Some(child) = schema.get("items") {
            for value in values {
                validate(child, value)?;
            }
        }
    }
    if let Some(text) = value.as_str() {
        if text.chars().count() < schema["minLength"].as_u64().unwrap_or(0) as usize
            || text.chars().count() > schema["maxLength"].as_u64().unwrap_or(u64::MAX) as usize
        {
            return Err("Invalid string size".into());
        }
        if schema["format"] == "date-time" && chrono::DateTime::parse_from_rfc3339(text).is_err() {
            return Err("Invalid timestamp".into());
        }
    }
    if let Some(number) = value
        .as_i64()
        .map(i128::from)
        .or_else(|| value.as_u64().map(i128::from))
    {
        if number < i128::from(schema["minimum"].as_i64().unwrap_or(i64::MIN))
            || schema["maximum"]
                .as_u64()
                .is_some_and(|maximum| number > i128::from(maximum))
        {
            return Err("Invalid integer range".into());
        }
    }
    Ok(())
}

fn error(entry: &Value, message: String) -> Value {
    let code = if message.contains("version") || message.contains("changed") {
        "version_conflict"
    } else if message.contains("unsupported") {
        "unsupported_operation"
    } else if message.contains("scope") {
        "scope_violation"
    } else {
        "operation_failed"
    };
    json!({"request_id":entry["request_id"],"target":entry["target"],"state":"failed","committed":false,"error":{"code":code,"message":message,"retryable":false}})
}

fn counts(results: &[Value]) -> Value {
    let mut counts = json!({"total":results.len()});
    for state in ["succeeded", "failed", "not_executed", "unknown"] {
        counts[state] = json!(results
            .iter()
            .filter(|result| result["state"] == state)
            .count());
    }
    counts
}

pub(super) async fn call(
    runtime: &TaskRuntime,
    name: &str,
    arguments: Value,
    context: &SpaceMcpRequestContext,
) -> Value {
    let result = async {
        let tool = tools()
            .into_iter()
            .find(|tool| tool["name"] == name)
            .ok_or("Unknown board tool")?;
        validate(&tool["inputSchema"], &arguments)?;
        if let Some(items) = arguments["items"].as_array() {
            let ids = items
                .iter()
                .map(|item| item["request_id"].as_str())
                .collect::<HashSet<_>>();
            if ids.len() != items.len() {
                return Err("Duplicate request_id".into());
            }
        }
        match name {
            "list_spaces" => queries::discover(runtime, context, &arguments).await,
            "describe_space_board" => {
                queries::describe(runtime, context, &arguments["space"]).await
            }
            "search_board_items" => queries::search(runtime, context, &arguments).await,
            "aggregate_board_items" => queries::aggregate(runtime, context, &arguments).await,
            "batch_get_board_items"
            | "batch_list_board_item_comments"
            | "batch_get_assignment_candidates" => {
                reads::call(runtime, context, name, &arguments).await
            }
            "get_board_operation" => writes::read(runtime, context, &arguments).await,
            _ => writes::call(runtime, context, name, &arguments).await,
        }
    }
    .await;
    match result {
        Ok(value) => text_result(value.to_string(), false),
        Err(message) => text_result(message, true),
    }
}
