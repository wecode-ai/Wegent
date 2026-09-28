// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};

use crate::{agents::request_backend_url, protocol::ExecutionRequest};

const CONTEXT_KEY: &str = "wework.session.current";
const GUIDANCE: &str = concat!(
    "Current Wework HTTP API IDs (not Codex IDs); null means unavailable. ",
    "Session endpoints require api_conversation_supported=true and a separate personal API Key.",
);

pub(super) fn inject_current_session(
    request: &mut ExecutionRequest,
    device_id: &str,
    local_task_id: &str,
) {
    // Establish the same user-message identity sent to Codex and projected by the API.
    let message_id = request
        .extra
        .get("client_user_message_id")
        .or_else(|| request.extra.get("clientUserMessageId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    request
        .extra
        .insert("client_user_message_id".to_owned(), json!(message_id));
    let selection = request
        .extra
        .get("modelSelection")
        .or_else(|| request.extra.get("model_selection"));
    let context = json!({
        "api_conversation_supported": true,
        "base_url": request_backend_url(request).and_then(|url| api_base_url(&url)),
        "conversation_id": handle("conv_", &[device_id, local_task_id]),
        "response_id": handle("resp_", &[device_id, local_task_id, &message_id]),
        "execution": {"type": "wework", "device_id": device_id},
        "model": selection.and_then(api_model_id),
        "model_name": selection.and_then(|s| s.get("modelName").or_else(|| s.get("model_name")))
            .and_then(Value::as_str)
            .or_else(|| request.model_config.get("model_id").and_then(Value::as_str)),
        "model_type": selection.and_then(|s| s.get("modelType").or_else(|| s.get("model_type"))).and_then(Value::as_str),
    });
    let mut additional = request
        .extra
        .get("additionalContext")
        .or_else(|| request.extra.get("additional_context"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    additional.insert(
        CONTEXT_KEY.to_owned(),
        json!({
            "kind": "application",
            "value": format!("{GUIDANCE}\n{context}"),
        }),
    );
    request
        .extra
        .insert("additionalContext".to_owned(), Value::Object(additional));
}

// Keep this wire format aligned with backend/app/services/wework_api/identity.py.
fn handle(prefix: &str, parts: &[&str]) -> String {
    format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(json!(parts).to_string())
    )
}

fn api_model_id(selection: &Value) -> Option<String> {
    let model_type = selection
        .get("modelType")
        .or_else(|| selection.get("model_type"))?
        .as_str()?;
    if !matches!(model_type, "public" | "user" | "group") {
        return None;
    }
    let name = selection
        .get("modelName")
        .or_else(|| selection.get("model_name"))?
        .as_str()?;
    let options = selection.get("options")?;
    let namespace = options.get("weworkCloudModelNamespace")?.as_str()?;
    let owner = options.get("weworkCloudModelResourceUserId")?;
    let owner = owner
        .as_str()
        .map(str::to_owned)
        .or_else(|| owner.as_u64().map(|id| id.to_string()))?;
    let owner = owner.parse::<u64>().ok()?;
    if name.is_empty() || namespace.is_empty() {
        return None;
    }
    Some(format!("{model_type}:{namespace}:{owner}:{name}"))
}

fn api_base_url(backend_url: &str) -> Option<String> {
    let mut url = url::Url::parse(backend_url).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/');
    let root = path
        .strip_suffix("/api/v1")
        .or_else(|| path.strip_suffix("/api"))
        .unwrap_or(path);
    url.set_path(&format!("{root}/api/v1"));
    Some(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(request: &ExecutionRequest) -> Value {
        let value = request.extra["additionalContext"][CONTEXT_KEY]["value"]
            .as_str()
            .unwrap();
        serde_json::from_str(value.lines().last().unwrap()).unwrap()
    }

    fn cloud_selection(name: &str) -> Value {
        json!({"modelName": name, "modelType": "public", "options": {
            "weworkCloudModelNamespace": "default",
            "weworkCloudModelResourceUserId": "0",
            "api_key": "selection-secret"
        }})
    }

    #[test]
    fn current_session_uses_api_handles_and_preserves_other_context() {
        let _lock = crate::test_env::lock();
        let mut request = ExecutionRequest {
            task_id: "execution-not-conversation".into(),
            project_workspace_path: Some("/Users/test/Documents/Codex/task-1".into()),
            subtask_id: "native-turn-not-response".into(),
            auth_token: Some("auth-secret".into()),
            model_config: json!({"api_key": "model-secret"}),
            ..ExecutionRequest::default()
        };
        request
            .extra
            .insert("client_user_message_id".into(), json!("message-1"));
        request
            .extra
            .insert("modelSelection".into(), cloud_selection("my-model"));
        request.extra.insert(
            "additionalContext".into(),
            json!({
                "wework.terminal.current": {"kind": "application", "value": "terminal"},
                "wework.session.current": {"kind": "application", "value": "stale"}
            }),
        );
        inject_current_session(&mut request, "device-1", "task-1");
        let value = context(&request);
        assert_eq!(value["api_conversation_supported"], true);
        assert_eq!(
            value["conversation_id"],
            "conv_WyJkZXZpY2UtMSIsInRhc2stMSJd"
        );
        assert_eq!(
            value["response_id"],
            "resp_WyJkZXZpY2UtMSIsInRhc2stMSIsIm1lc3NhZ2UtMSJd"
        );
        assert_eq!(value["model"], "public:default:0:my-model");
        assert_eq!(
            value["execution"],
            json!({"type": "wework", "device_id": "device-1"})
        );
        assert_eq!(
            request.extra["additionalContext"]["wework.terminal.current"]["value"],
            "terminal"
        );
        assert!(!request.extra["additionalContext"]
            .to_string()
            .contains("secret"));

        request
            .extra
            .insert("client_user_message_id".into(), json!("message-2"));
        request
            .extra
            .insert("modelSelection".into(), cloud_selection("new-model"));
        inject_current_session(&mut request, "device-1", "task-1");
        let follow_up = context(&request);
        assert_eq!(follow_up["conversation_id"], value["conversation_id"]);
        assert_ne!(follow_up["response_id"], value["response_id"]);
        assert_eq!(follow_up["model"], "public:default:0:new-model");
    }

    #[test]
    fn current_session_establishes_message_identity_without_inventing_api_model() {
        let _lock = crate::test_env::lock();
        let mut request = ExecutionRequest::default();
        request.extra.insert(
            "modelSelection".into(),
            json!({"modelName": "gpt-local", "modelType": "runtime"}),
        );
        inject_current_session(&mut request, "设备", "task-1");
        let value = context(&request);
        assert_eq!(value["api_conversation_supported"], true);
        let message_id = request.extra["client_user_message_id"].as_str().unwrap();
        assert!(uuid::Uuid::parse_str(message_id).is_ok());
        let parts: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(
                    value["response_id"]
                        .as_str()
                        .unwrap()
                        .strip_prefix("resp_")
                        .unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(parts, json!(["设备", "task-1", message_id]));
        assert!(value["model"].is_null());
        assert_eq!(value["model_name"], "gpt-local");
    }

    #[test]
    fn api_context_normalizes_urls_and_excludes_credentials() {
        for path in ["", "/", "/api", "/api/", "/api/v1", "/api/v1/"] {
            assert_eq!(
                api_base_url(&format!("https://example.com{path}")),
                Some("https://example.com/api/v1".into())
            );
        }
        assert_eq!(
            api_base_url("https://user:secret@example.com/prefix/api?token=secret#secret"),
            Some("https://example.com/prefix/api/v1".into())
        );
        assert_eq!(api_base_url("invalid"), None);
        assert_eq!(api_base_url("file:///tmp"), None);
    }

    #[test]
    fn api_model_identity_requires_catalog_metadata() {
        let mut selection = cloud_selection("模型");
        selection["options"]["weworkCloudModelResourceUserId"] = json!(42);
        selection["modelType"] = json!("user");
        assert_eq!(
            api_model_id(&selection),
            Some("user:default:42:模型".into())
        );
        selection["options"]
            .as_object_mut()
            .unwrap()
            .remove("weworkCloudModelNamespace");
        assert_eq!(api_model_id(&selection), None);
    }
}
