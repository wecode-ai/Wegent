//! Queued group work validates the enabling actor, never the device's login account.
use crate::protocol::ExecutionRequest;
use serde_json::Value;
use std::time::Duration;

pub(super) const IDENTITY_KEY: &str = "collaborationCoordinatorIdentity";

pub(super) fn capture_identity(request: &ExecutionRequest) -> Option<Value> {
    let scope = request.extra.get("origin")?.get("project_coordination")?;
    Some(
        serde_json::json!({"context":scope,"authToken":request.auth_token,
        "runtimeAuthToken":request.runtime_auth_token,"skillIdentityToken":request.skill_identity_token}),
    )
}

pub(super) fn restore_identity(
    request: &mut ExecutionRequest,
    handle: &Value,
) -> Result<(), String> {
    let Some(scope) = request
        .extra
        .get("origin")
        .and_then(|origin| origin.get("project_coordination"))
    else {
        return Ok(());
    };
    let identity = &handle[IDENTITY_KEY];
    if identity["context"] != *scope
        || !identity["authToken"]
            .as_str()
            .is_some_and(|token| !token.trim().is_empty())
    {
        return Err("The enabling member's execution identity is unavailable; project coordination must recover before another round can start".into());
    }
    request.auth_token = identity["authToken"].as_str().map(ToOwned::to_owned);
    request.runtime_auth_token = identity["runtimeAuthToken"].as_str().map(ToOwned::to_owned);
    request.skill_identity_token = identity["skillIdentityToken"]
        .as_str()
        .map(ToOwned::to_owned);
    Ok(())
}

fn command_path(context: &Value) -> Result<String, String> {
    for key in ["projectId", "groupId"] {
        let id = context[key].as_str().ok_or("Missing coordination target")?;
        if id
            .parse::<i64>()
            .ok()
            .map_or(true, |number| number <= 0 || number.to_string() != id)
        {
            return Err("Invalid coordination target".into());
        }
    }
    let command = context["commandId"]
        .as_str()
        .ok_or("Missing coordination command")?;
    if command.is_empty()
        || command.len() > 64
        || !command
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err("Invalid coordination command".into());
    }
    if context["userId"].as_i64().map_or(true, |user| user <= 0)
        || ["deviceId", "generation", "inputDigest"].iter().any(|key| {
            !context[*key]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        })
    {
        return Err("Incomplete coordination execution identity".into());
    }
    Ok(format!(
        "/api/v1/cloud-projects/{}/coordinator-bindings/{}/commands/{command}/authorization",
        context["projectId"].as_str().unwrap(),
        context["groupId"].as_str().unwrap()
    ))
}

pub(super) async fn validate_request(request: &ExecutionRequest) -> Result<(), String> {
    let Some(context) = request
        .extra
        .get("origin")
        .and_then(|origin| origin.get("project_coordination"))
    else {
        return Ok(());
    };
    let backend = crate::agents::backend_url::request_backend_url(request)
        .ok_or("Project coordination backend is unavailable")?;
    validate_cloud_command(request, context, &backend).await
}

async fn validate_cloud_command(
    request: &ExecutionRequest,
    context: &Value,
    backend: &str,
) -> Result<(), String> {
    let path = command_path(context)?;
    let token = request
        .auth_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or("Project coordination execution identity is unavailable")?;
    let response = crate::agents::backend_url::backend_http_client()?
        .get(format!("{}{path}", backend.trim_end_matches('/')))
        .bearer_auth(token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "Unable to validate current project coordination authorization".to_owned())?;
    if !response.status().is_success() {
        return Err(format!(
            "Project coordination authorization returned {}; this queued work was not started",
            response.status()
        ));
    }
    let result: Value = response
        .json()
        .await
        .map_err(|_| "Invalid project coordination authorization response")?;
    if result["authorized"] != true || result["context"] != *context {
        return Err(
            "Project coordination execution identity changed; this queued work was not started"
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        routing::get,
        Json, Router,
    };
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn context() -> Value {
        json!({"projectId":"1001","groupId":"101","commandId":"command-1","userId":7,
            "deviceId":"coordination-host","generation":"generation-1","inputDigest":"digest"})
    }

    #[test]
    fn invalid_or_malleable_command_identities_are_rejected_before_network_access() {
        for (key, value) in [
            ("projectId", json!("01001")),
            ("groupId", json!("../101")),
            ("commandId", json!("../command")),
            ("commandId", json!("")),
            ("userId", json!("7")),
            ("userId", json!(0)),
            ("generation", Value::Null),
            ("inputDigest", json!("")),
        ] {
            let mut scope = context();
            scope[key] = value;
            assert!(command_path(&scope).is_err(), "{key}");
        }
        assert!(command_path(&Value::Null).is_err());
    }

    #[tokio::test]
    async fn inherited_member_work_uses_its_execution_token_and_exact_recorded_context() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let router = Router::new()
            .route(
                &command_path(&context()).unwrap(),
                get(
                    |State(seen): State<Arc<Mutex<Vec<String>>>>, headers: HeaderMap| async move {
                        seen.lock()
                            .unwrap()
                            .push(headers["authorization"].to_str().unwrap().to_owned());
                        let token = headers["authorization"].to_str().unwrap();
                        match token {
                            "Bearer enabling-member-task-token" => (
                                StatusCode::OK,
                                Json(json!({"authorized":true,"context":context()})),
                            ),
                            "Bearer old-generation" => {
                                let mut old = context();
                                old["generation"] = json!("superseded");
                                (
                                    StatusCode::OK,
                                    Json(json!({"authorized":true,"context":old})),
                                )
                            }
                            _ => (StatusCode::FORBIDDEN, Json(json!({"detail":"revoked"}))),
                        }
                    },
                ),
            )
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut request = ExecutionRequest {
            auth_token: Some("enabling-member-task-token".into()),
            ..Default::default()
        };
        validate_cloud_command(&request, &context(), &backend)
            .await
            .unwrap();
        for token in ["device-owner-session", "old-generation"] {
            request.auth_token = Some(token.into());
            assert!(validate_cloud_command(&request, &context(), &backend)
                .await
                .is_err());
        }
        request.auth_token = None;
        assert!(validate_cloud_command(&request, &context(), &backend)
            .await
            .is_err());
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                "Bearer enabling-member-task-token",
                "Bearer device-owner-session",
                "Bearer old-generation"
            ]
        );
        server.abort();
    }

    #[tokio::test]
    async fn legacy_work_has_no_new_authentication_dependency() {
        validate_request(&ExecutionRequest::default())
            .await
            .unwrap();
    }
}
