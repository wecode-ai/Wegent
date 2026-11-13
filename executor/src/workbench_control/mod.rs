//! Managed, execution-scoped access to Wework application operations.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};

use crate::{local::app_ipc::AppIpcError, protocol::ExecutionRequest};

pub(crate) mod apps;
mod catalog;
mod creation_schema;
pub(crate) mod journal;
mod output_schema;
pub(crate) mod read_budget;
pub(crate) use catalog::{capabilities, validate_arguments};

pub(crate) const SERVER_NAME: &str = "wework_control";
pub(crate) const INSTRUCTIONS: &str = concat!(
    "Wework control routing:\n",
    "- Use wework_control for Wework conversation discovery, native history, cross-conversation continuation, confirmed PR bindings and personal schedules. Discovery and history queries cover this device, cloud history and other owned devices by default. Native conversation continuation supports other owned devices through the desktop's existing send API and device policy.\n",
    "- Standalone Wework tasks are conversations, including archived tasks. For a missing, archived or accidentally deleted task, first call list_conversations with include_archived:true, or search_conversations with include_archived:true when a query is known. A title or deletion time is not required for listing candidates. Inspect actual results and coverage before claiming absence or inability to recover; offer matching candidates and restoration using the user's preferred presentation instead of only directing the user to Settings. Permanent deletion and archival are different states; these tools restore archived conversations.\n",
    "- Use get_conversation_creation_options before choosing creation settings. create_conversation accepts composer options and an explicit target device/model; remote creation uses existing Backend device policy. Use the native conversation_id returned by discovery for remote continuation; cloud-history references without a Runtime address are read-only.\n",
    "- Read get_current_context and discover capabilities when needed. Continue the exact conversation_id returned by the tools. Use a stable request_key per user instruction or CI failure (repository, PR, head SHA, run ID and attempt). Check get_operation after delivery; accepted is not completed.\n",
    "- Interactive HTML is optional. Respect explicit user preferences for text, direct execution or an interactive page. For a clear, fully specified request, direct tool execution and a concise reply are valid. Choose present_interaction when selection, editable inputs, multiple results or ongoing management help the user. These choices apply equally to every capability.\n",
    "- When choosing present_interaction in Codex, generate HTML for the current scenario and follow the visualize skill's fragment and design guidance. Bind real operations with window.wework.callTool and existing destinations with window.wework.navigate. Declare only needed tools. Restore window.wework.state and persist completed interactions with setState so reopening does not repeat operations. Collect unknown values in the form. Pure explanatory visualizations use the ordinary visualize reference.\n",
    "- Generated interactions default to high information density unless the user requests otherwise. For simple records, use one compact list or table: one row per item with name, key status/time and a small action button together on desktop. Do not use per-item cards, split panels, repeated headings or large vertical gaps. Hide internal IDs and secondary details unless decision-relevant. Keep readable type and compact desktop controls; 44px touch targets apply on mobile. A short list must not need several screens, internal scrolling or artificial pagination.\n",
    "- Every capability has inputSchema and outputSchema in the same catalog, available through list_capabilities and describe_capability and supplied to bound HTML tools. Newly registered capabilities share discovery, tool binding and execution without a dedicated UI adapter. When an interaction helps, discover its real contracts, query current data and generate the relevant form or actions. HTML writes execute only on user action. A missing dedicated app is not a missing capability. When no operation exists, use window.wework.navigationTargets for a registered destination; never invent tools or routes.\n",
    "- callTool returns the business data matching that capability's outputSchema, not the MCP content wrapper. Do not assume all operations return the same object shape. Use one render(state) function after a successful operation and when restoring saved state. Render a concise result immediately; never display a raw JSON result as the success or error view. Save the same completed state with setState. A later rendering or card-state save failure does not undo the operation; do not re-enable or repeat the mutation.\n",
    "- When using an interaction, match its primary action to the user's goal and the target's state. For archived-conversation recovery, show matching candidates with unarchive_conversation actions. After accepted is true, show the restored state and offer opening the conversation. A navigation button is not a substitute for a restoration operation.\n",
    "- For weekly reports, list conversations with updated_after set to the period start, include archived conversations, follow every next_cursor and every history cursor, and select messages by their timestamps. Do not use updated_before to exclude conversations with newer activity. State any missing coverage.\n",
    "- When a user names a device, resolve its device_id from creation options and query that device directly. Use list_conversations/search_conversations to inspect existing conversations; do not create a new conversation just to discover them. query_timeout in coverage identifies a source to retry with device_id.\n",
    "- Inspect coverage.unavailable_reasons in conversation search and listings. Failed checks can mean invalid Backend requests, connectivity or permission errors, or timeouts; incomplete results do not prove a conversation is absent.\n",
    "- Report a target conversation's origin restriction using the exact tool reason. It is not a missing login or system approval request. Do not suggest granting unrelated permissions or retry the send through another path.\n",
    "- Use wework_space for project-space operations and existing GitHub tools for CI checks. Delegated project runs cannot acquire personal control. Do not use personal API keys, direct storage reads or UI clicks to bypass a control permission error."
);

#[derive(Clone)]
pub(crate) struct ControlContext {
    pub request: ExecutionRequest,
    pub device_id: String,
    pub task_id: String,
}

impl std::fmt::Debug for ControlContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ControlContext")
            .field("device_id", &self.device_id)
            .field("task_id", &self.task_id)
            .finish_non_exhaustive()
    }
}

impl ControlContext {
    pub fn from_request(request: &ExecutionRequest) -> Option<Self> {
        // Restricted executions retain their own managed tools and approval boundaries.
        if restricted_request(request) {
            return None;
        }
        let device_id = request.extra.get("runtimeDeviceId")?.as_str()?.to_owned();
        let task_id = request
            .extra
            .get("runtimeLocalTaskId")?
            .as_str()?
            .to_owned();
        if device_id.is_empty() || task_id.is_empty() {
            return None;
        }
        Some(Self {
            request: request.clone(),
            device_id,
            task_id,
        })
    }
}

pub(crate) fn restricted_request(request: &ExecutionRequest) -> bool {
    restricted_origin(request.extra.get("origin"))
        || crate::runtime_work::external_work_kind(request).is_some()
        || request.extra.get("origin").is_some_and(|origin| {
            origin["type"] == "project_coordinator" || origin.get("project_coordination").is_some()
        })
}

pub(crate) fn restricted_origin(origin: Option<&Value>) -> bool {
    origin_restriction(origin).is_some()
}

pub(crate) fn origin_restriction(origin: Option<&Value>) -> Option<&'static str> {
    if matches!(
        origin.and_then(|value| value["type"].as_str()),
        Some("stand_in_identity" | "connection_work" | "dingtalk_work")
    ) {
        return Some("type");
    }
    ["dispatchRole", "dispatch_role", "dispatchId", "dispatch_id"]
        .into_iter()
        .find(|key| {
            origin
                .and_then(|value| value.get(*key))
                .is_some_and(|value| !value.is_null())
        })
}

pub(crate) trait ControlService: Send + Sync {
    fn call<'a>(
        &'a self,
        context: &'a ControlContext,
        operation: &'a str,
        arguments: Value,
    ) -> BoxFuture<'a, Result<Value, AppIpcError>>;
}

fn services() -> &'static Mutex<HashMap<String, Arc<dyn ControlService>>> {
    static SERVICES: OnceLock<Mutex<HashMap<String, Arc<dyn ControlService>>>> = OnceLock::new();
    SERVICES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn register(device: &str, service: Arc<dyn ControlService>) {
    services()
        .lock()
        .expect("control service registry poisoned")
        .insert(device.to_owned(), service);
}

pub(crate) fn available(context: &ControlContext) -> bool {
    services()
        .lock()
        .is_ok_and(|services| services.contains_key(&context.device_id))
}

pub(crate) fn conversation_id(device: &str, task: &str) -> String {
    format!(
        "conv_{}",
        URL_SAFE_NO_PAD.encode(json!([device, task]).to_string())
    )
}

pub(crate) fn conversation_address(id: &str) -> Result<(String, String), AppIpcError> {
    let invalid = || AppIpcError::new("bad_request", "A valid Wework conversation_id is required");
    let bytes = URL_SAFE_NO_PAD
        .decode(id.strip_prefix("conv_").ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    let parts: Vec<String> = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if parts.len() != 2 || parts.iter().any(|part| part.is_empty()) {
        return Err(invalid());
    }
    Ok((parts[0].clone(), parts[1].clone()))
}

pub(crate) async fn call(context: &ControlContext, name: &str, mut arguments: Value) -> Value {
    let result = async {
        catalog::validate_tool_arguments(name, &arguments)?;
        if ControlContext::from_request(&context.request).is_none() {
            return Err(AppIpcError::new(
                "permission_denied",
                "Personal Wework control is unavailable to delegated runs",
            ));
        }
        let mut operation = name.to_owned();
        if name == "list_capabilities" {
            return Ok(json!({"capabilities": capabilities()}));
        }
        if name == "describe_capability" {
            return capabilities()
                .into_iter()
                .find(|c| c["name"] == arguments["name"])
                .ok_or_else(|| AppIpcError::new("not_found", "Unknown Wework capability"));
        }
        if name == "invoke_capability" {
            operation = arguments["name"].as_str().unwrap_or_default().to_owned();
            arguments = arguments
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
        }
        validate_arguments(&operation, &arguments)?;
        let service = services()
            .lock()
            .map_err(|_| AppIpcError::new("unavailable", "Control service unavailable"))?
            .get(&context.device_id)
            .cloned()
            .ok_or_else(|| AppIpcError::new("unavailable", "The owning Runtime is unavailable"))?;
        service.call(context, &operation, arguments).await
    }
    .await;
    match result {
        Ok(mut value) => {
            let metadata = value
                .as_object_mut()
                .and_then(|object| object.remove("_meta"));
            let failed = value.get("success") == Some(&Value::Bool(false))
                || value.get("accepted") == Some(&Value::Bool(false))
                || value
                    .pointer("/operation/delivery_status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| {
                        matches!(status, "pending" | "needs_attention" | "rejected")
                    });
            let mut result = json!({"content": [{"type": "text", "text": value.to_string()}], "structuredContent": value, "isError": failed});
            if let Some(metadata) = metadata {
                result["_meta"] = metadata;
            }
            result
        }
        Err(error) => {
            json!({"content": [{"type": "text", "text": json!({"code": error.code, "error": error.message}).to_string()}], "isError": true})
        }
    }
}

pub(crate) fn tools() -> Vec<Value> {
    let mut tools = capabilities();
    tools.extend([
        json!({"name":"list_capabilities", "description":"Discover all Wework operations and their input/output contracts for dynamically generated HTML or direct execution.", "inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"describe_capability", "description":"Read the contract of one Wework operation.", "inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}}),
        json!({"name":"invoke_capability", "description":"Invoke a discovered Wework operation using its exact input schema.", "inputSchema":{"type":"object","properties":{"name":{"type":"string"},"arguments":{"type":"object"}},"required":["name","arguments"],"additionalProperties":false}}),
    ]);
    for tool in &mut tools {
        let name = tool["name"].as_str().unwrap_or_default().to_owned();
        if tool.get("outputSchema").is_none() {
            tool["outputSchema"] = output_schema::discovery(&name);
        }
        tool["_meta"] = apps::tool_metadata(&name);
    }
    tools
}

#[cfg(test)]
pub(crate) fn assert_output_contract(name: &str, value: &Value) {
    let definition = tools()
        .into_iter()
        .find(|tool| tool["name"] == name)
        .unwrap();
    assert!(
        catalog::matches_schema(&definition["outputSchema"], value),
        "{name} returned data outside its outputSchema: {value}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_diagnostics_preserve_every_existing_restriction() {
        for (origin, expected) in [
            (Value::Null, None),
            (json!({}), None),
            (json!({"type":"personal","dispatchRole":null}), None),
            (json!({"type":"stand_in_identity"}), Some("type")),
            (json!({"type":"connection_work"}), Some("type")),
            (json!({"type":"dingtalk_work"}), Some("type")),
            (json!({"dispatchRole":"executor"}), Some("dispatchRole")),
            (json!({"dispatch_role":"manager"}), Some("dispatch_role")),
            (json!({"dispatchId":"delegated"}), Some("dispatchId")),
            (json!({"dispatch_id":"delegated"}), Some("dispatch_id")),
            (json!({"dispatchRole":""}), Some("dispatchRole")),
            (json!({"dispatchId":false}), Some("dispatchId")),
        ] {
            assert_eq!(origin_restriction(Some(&origin)), expected);
            assert_eq!(restricted_origin(Some(&origin)), expected.is_some());
        }
        assert_eq!(origin_restriction(None), None);
    }

    #[tokio::test]
    async fn discovery_and_invocation_enforce_their_declared_schemas() {
        let mut request = ExecutionRequest::default();
        request
            .extra
            .insert("runtimeDeviceId".into(), json!("schema-device"));
        request
            .extra
            .insert("runtimeLocalTaskId".into(), json!("caller"));
        let context = ControlContext::from_request(&request).unwrap();
        assert_eq!(
            call(&context, "list_capabilities", json!({"extra":true})).await["isError"],
            true
        );
        assert_eq!(
            call(
                &context,
                "invoke_capability",
                json!({"name":"list_conversations"})
            )
            .await["isError"],
            true
        );
        assert_eq!(
            call(
                &context,
                "describe_capability",
                json!({"name":"runtime.codex.app_server.request"})
            )
            .await["isError"],
            true
        );
        let result = call(&context, "list_capabilities", json!({})).await;
        assert_eq!(result["isError"], false);
        let listed = result["structuredContent"]["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == "list_conversations")
            .unwrap();
        assert_eq!(listed["inputSchema"]["required"], json!([]));
        assert_eq!(listed["annotations"]["readOnlyHint"], true);
        assert_eq!(
            listed["inputSchema"]["properties"]["include_archived"]["type"],
            "boolean"
        );
        assert!(
            validate_arguments("list_conversations", &json!({"include_archived":true})).is_ok()
        );
        assert_eq!(
            result["structuredContent"]["capabilities"],
            json!(capabilities())
        );
    }
}
