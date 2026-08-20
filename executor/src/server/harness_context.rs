use std::{
    collections::{BTreeMap, HashMap},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use axum::{
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, MethodRouter},
    Json,
};
use getrandom::fill;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CONTEXT_TTL: Duration = Duration::from_secs(30 * 60);
pub(crate) const USER_ROUTE: &str = "/v1/harness-context/{token}/user";
pub(crate) const MODEL_ROUTE: &str = "/v1/harness-context/{token}/model";
pub(crate) const STATUS_ROUTE: &str = "/v1/harness-context/{token}/status";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessUserContext {
    pub id: i64,
    pub user_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessModelContext {
    pub runtime_model_id: String,
    pub display_name: String,
    pub model_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
    pub capabilities: BTreeMap<String, bool>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct HarnessContextRegistrationRequest {
    pub scope: String,
    pub user: HarnessUserContext,
    pub model: HarnessModelContext,
}

pub(crate) fn parse_registration_payload(
    payload: Value,
) -> Result<HarnessContextRegistrationRequest, String> {
    let request = serde_json::from_value::<HarnessContextRegistrationRequest>(payload)
        .map_err(|error| format!("Invalid Harness context registration: {error}"))?;
    if request.scope.trim().is_empty() {
        return Err("Harness context scope is required".to_owned());
    }
    Ok(request)
}

#[derive(Debug, Clone)]
struct RegisteredContext {
    scope: String,
    user: HarnessUserContext,
    model: HarnessModelContext,
    expires_at: Instant,
}

#[derive(Default)]
struct ContextRegistry {
    contexts: HashMap<String, RegisteredContext>,
}

fn registry() -> &'static Mutex<ContextRegistry> {
    static REGISTRY: OnceLock<Mutex<ContextRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(ContextRegistry::default()))
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    fill(&mut bytes).expect("secure Harness context token generation should work");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn prune_expired(registry: &mut ContextRegistry) {
    let now = Instant::now();
    registry
        .contexts
        .retain(|_, context| context.expires_at > now);
}

pub(crate) fn register_harness_context(
    scope: &str,
    user: HarnessUserContext,
    model: HarnessModelContext,
) -> String {
    let mut registry = registry()
        .lock()
        .expect("Harness context registry should not be poisoned");
    prune_expired(&mut registry);
    let token = generate_token();
    registry.contexts.insert(
        token.clone(),
        RegisteredContext {
            scope: scope.to_owned(),
            user,
            model,
            expires_at: Instant::now() + CONTEXT_TTL,
        },
    );
    token
}

pub(crate) fn unregister_harness_context(token: &str) {
    if let Ok(mut registry) = registry().lock() {
        registry.contexts.remove(token);
    }
}

fn context_for(token: &str) -> Option<RegisteredContext> {
    let mut registry = registry()
        .lock()
        .expect("Harness context registry should not be poisoned");
    prune_expired(&mut registry);
    registry.contexts.get(token).cloned()
}

fn registered_user_context(token: &str) -> Option<HarnessUserContext> {
    context_for(token).map(|context| context.user)
}

fn registered_model_context(token: &str) -> Option<HarnessModelContext> {
    context_for(token).map(|context| context.model)
}

pub(crate) fn user_route<S>() -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    get(handle_user).post(handle_user)
}

pub(crate) fn model_route<S>() -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    get(handle_model).post(handle_model)
}

pub(crate) fn status_route<S>() -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    get(handle_status).post(handle_status)
}

async fn handle_user(Path(token): Path<String>) -> Result<Json<HarnessUserContext>, Response> {
    registered_user_context(&token)
        .map(Json)
        .ok_or_else(|| context_error(StatusCode::UNAUTHORIZED, "context_unavailable"))
}

async fn handle_model(Path(token): Path<String>) -> Result<Json<HarnessModelContext>, Response> {
    registered_model_context(&token)
        .map(Json)
        .ok_or_else(|| context_error(StatusCode::UNAUTHORIZED, "context_unavailable"))
}

async fn handle_status(Path(token): Path<String>) -> Result<Json<serde_json::Value>, Response> {
    let context = context_for(&token)
        .ok_or_else(|| context_error(StatusCode::UNAUTHORIZED, "context_unavailable"))?;
    Ok(Json(json!({"status": "active", "scope": context.scope})))
}

fn context_error(status: StatusCode, code: &'static str) -> Response {
    (status, Json(json!({"error": code}))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_request_deserializes_only_context_contract() {
        let request = parse_registration_payload(serde_json::json!({
            "scope": "harness:smart-app:instance-4",
            "user": {
                "id": 123,
                "userName": "zhangsan",
                "displayName": "张三",
                "email": "user@example.com",
                "mode": "cloud",
                "authToken": "cloud-token"
            },
            "model": {
                "runtimeModelId": "wework-selected",
                "displayName": "DeepSeek",
                "modelType": "public",
                "namespace": "default",
                "contextWindow": 128000,
                "maxOutputTokens": 8192,
                "capabilities": {"toolSearch": true},
                "apiKey": "provider-secret"
            },
            "unexpected": "ignored"
        }))
        .unwrap();

        assert_eq!(request.scope, "harness:smart-app:instance-4");
        assert_eq!(request.user.user_name, "zhangsan");
        assert_eq!(request.model.runtime_model_id, "wework-selected");
    }

    #[test]
    fn context_registration_returns_scoped_token_and_context() {
        let token = register_harness_context(
            "harness:smart-app:instance-1",
            HarnessUserContext {
                id: 123,
                user_name: "zhangsan".to_owned(),
                display_name: Some("张三".to_owned()),
                email: Some("user@example.com".to_owned()),
                mode: "cloud".to_owned(),
            },
            HarnessModelContext {
                runtime_model_id: "wework-selected".to_owned(),
                display_name: "DeepSeek".to_owned(),
                model_type: "public".to_owned(),
                namespace: Some("default".to_owned()),
                context_window: Some(128_000),
                max_output_tokens: Some(8_192),
                capabilities: BTreeMap::from([("toolSearch".to_owned(), true)]),
            },
        );

        assert!(!token.is_empty());
        assert_eq!(
            registered_user_context(&token).unwrap().user_name,
            "zhangsan"
        );
        assert_eq!(
            registered_model_context(&token).unwrap().runtime_model_id,
            "wework-selected"
        );
    }

    #[test]
    fn context_registration_drops_untrusted_fields() {
        let token = register_harness_context(
            "harness:smart-app:instance-2",
            HarnessUserContext {
                id: 456,
                user_name: "local".to_owned(),
                display_name: None,
                email: None,
                mode: "local".to_owned(),
            },
            HarnessModelContext {
                runtime_model_id: "wework-selected".to_owned(),
                display_name: "Local model".to_owned(),
                model_type: "local".to_owned(),
                namespace: None,
                context_window: None,
                max_output_tokens: None,
                capabilities: BTreeMap::new(),
            },
        );

        let user = serde_json::to_value(registered_user_context(&token).unwrap()).unwrap();
        let model = serde_json::to_value(registered_model_context(&token).unwrap()).unwrap();
        assert!(!user.to_string().contains("cloud-token"));
        assert!(!user.to_string().contains("provider-secret"));
        assert!(!model.to_string().contains("apiKey"));
        assert!(!model.to_string().contains("baseUrl"));
    }

    #[test]
    fn unregister_revokes_context() {
        let token = register_harness_context(
            "harness:smart-app:instance-3",
            HarnessUserContext {
                id: 1,
                user_name: "local".to_owned(),
                display_name: None,
                email: None,
                mode: "local".to_owned(),
            },
            HarnessModelContext {
                runtime_model_id: "wework-selected".to_owned(),
                display_name: "Local model".to_owned(),
                model_type: "local".to_owned(),
                namespace: None,
                context_window: None,
                max_output_tokens: None,
                capabilities: BTreeMap::new(),
            },
        );

        unregister_harness_context(&token);

        assert!(registered_user_context(&token).is_none());
        assert!(registered_model_context(&token).is_none());
    }
}
