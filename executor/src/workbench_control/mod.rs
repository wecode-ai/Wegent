//! Managed, execution-scoped access to Wework application operations.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};

use crate::{local::app_ipc::AppIpcError, protocol::ExecutionRequest};

mod catalog;
mod creation_schema;
pub(crate) mod journal;
pub(crate) use catalog::{capabilities, validate_arguments};

pub(crate) const SERVER_NAME: &str = "wework_control";
pub(crate) const INSTRUCTIONS: &str = concat!(
    "Wework control routing:\n",
    "- Use wework_control for Wework conversation discovery, native history, cross-conversation continuation, confirmed PR bindings and personal schedules. Discovery and continuation cover the owning device.\n",
    "- Use get_conversation_creation_options before choosing creation settings. create_conversation accepts composer options and an explicit target device/model; remote creation uses existing Backend device policy. Never treat remote creation as remote history or continuation support.\n",
    "- Read get_current_context and discover capabilities when needed. Continue the exact conversation_id returned by the tools. Use a stable request_key per user instruction or CI failure (repository, PR, head SHA, run ID and attempt). Check get_operation after delivery; accepted is not completed.\n",
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
        if restricted_origin(request.extra.get("origin")) {
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

pub(crate) fn restricted_origin(origin: Option<&Value>) -> bool {
    matches!(
        origin.and_then(|value| value["type"].as_str()),
        Some("stand_in_identity" | "connection_work" | "dingtalk_work")
    ) || ["dispatchRole", "dispatch_role", "dispatchId", "dispatch_id"]
        .iter()
        .any(|key| {
            origin
                .and_then(|value| value.get(key))
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
        Ok(value) => {
            let failed = value.get("success") == Some(&Value::Bool(false))
                || value.get("accepted") == Some(&Value::Bool(false))
                || value
                    .pointer("/operation/delivery_status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| {
                        matches!(status, "pending" | "needs_attention" | "rejected")
                    });
            json!({"content": [{"type": "text", "text": value.to_string()}], "structuredContent": value, "isError": failed})
        }
        Err(error) => {
            json!({"content": [{"type": "text", "text": json!({"code": error.code, "error": error.message}).to_string()}], "isError": true})
        }
    }
}

pub(crate) fn tools() -> Vec<Value> {
    let mut tools = capabilities();
    tools.extend([
        json!({"name":"list_capabilities", "description":"Discover Wework application operations and their input schemas.", "inputSchema":{"type":"object","properties":{},"additionalProperties":false}}),
        json!({"name":"describe_capability", "description":"Read the contract of one Wework operation.", "inputSchema":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}}),
        json!({"name":"invoke_capability", "description":"Invoke a discovered Wework operation using its exact input schema.", "inputSchema":{"type":"object","properties":{"name":{"type":"string"},"arguments":{"type":"object"}},"required":["name","arguments"],"additionalProperties":false}}),
    ]);
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(
            result["structuredContent"]["capabilities"]
                .as_array()
                .unwrap()
                .len(),
            30
        );
    }
}
