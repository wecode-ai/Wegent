//! Browser login sessions remain owned by their exact plugin and connector.

use super::*;

pub(super) async fn active_browser_auth_state(
    plugin_key: &str,
    connector_slug: &str,
) -> Option<Value> {
    let state = {
        let sessions = browser_auth_sessions().lock().await;
        sessions
            .values()
            .find(|session| {
                session.plugin_key == plugin_key
                    && session.connector_slug == connector_slug
                    && !session.task.is_finished()
            })
            .map(|session| Arc::clone(&session.state))
    }?;
    let response = state.lock().await.clone();
    Some(response)
}

pub(super) async fn start_browser_auth(
    payload: Value,
    plugin_root: PathBuf,
    spec: LocalAuthSpec,
) -> Result<Value, AppIpcError> {
    let plugin_key = string_field(&payload, "pluginKey")
        .or_else(|| string_field(&payload, "plugin_key"))
        .ok_or_else(|| AppIpcError::new("bad_request", "pluginKey is required"))?;
    let connector_slug = string_field(&payload, "connectorSlug")
        .or_else(|| string_field(&payload, "connector_slug"))
        .or_else(|| string_field(&payload, "slug"))
        .ok_or_else(|| AppIpcError::new("bad_request", "connectorSlug is required"))?;
    if let Some(state) = active_browser_auth_state(&plugin_key, &connector_slug).await {
        return Ok(state);
    }
    let session_id = Uuid::new_v4().to_string();
    let state = Arc::new(Mutex::new(browser_session_state(
        "preparing",
        "Preparing the local authorization tool",
        &session_id,
    )));
    let task_state = Arc::clone(&state);
    let task_session_id = session_id.clone();
    let task = tokio::spawn(async move {
        let tool = match resolve_auth_tool(spec.tool.as_ref(), true).await {
            Ok(tool) => tool,
            Err(error) => {
                *task_state.lock().await = browser_session_state(
                    "error",
                    &redact_secrets(&error.message),
                    &task_session_id,
                );
                return;
            }
        };
        *task_state.lock().await = browser_session_state(
            "waiting_browser",
            "Complete authorization in the browser",
            &task_session_id,
        );
        let started = run_plugin_command(
            &plugin_root,
            &spec.start,
            tool.as_deref(),
            spec.timeout_seconds,
        )
        .await;
        let started = match started {
            Ok(result) => normalize_status_response(&result, &spec, None),
            Err(error) => {
                *task_state.lock().await = browser_session_state(
                    "error",
                    &redact_secrets(&error.message),
                    &task_session_id,
                );
                return;
            }
        };
        if started.get("status").and_then(Value::as_str) != Some("ok") {
            let hint = started
                .get("hint")
                .and_then(Value::as_str)
                .unwrap_or("Browser authorization did not complete");
            *task_state.lock().await = browser_session_state("error", hint, &task_session_id);
            return;
        }
        *task_state.lock().await = browser_session_state(
            "verifying",
            "Verifying the local authorization",
            &task_session_id,
        );
        let verified = run_plugin_command(
            &plugin_root,
            &spec.health,
            tool.as_deref(),
            DEFAULT_COMMAND_TIMEOUT_SECONDS,
        )
        .await;
        let mut final_state = match verified {
            Ok(result) => normalize_status_response(&result, &spec, None),
            Err(error) => {
                browser_session_state("error", &redact_secrets(&error.message), &task_session_id)
            }
        };
        final_state = match spec
            .account_auth
            .complete_login(final_state, account_lifecycle(&plugin_root, &spec, "login"))
            .await
        {
            Ok(result) => result,
            Err(error) => browser_session_state("error", &error.code, &task_session_id),
        };
        final_state["sessionId"] = Value::String(task_session_id);
        *task_state.lock().await = final_state;
    });

    let mut sessions = browser_auth_sessions().lock().await;
    let stale_ids = sessions
        .iter()
        .filter(|(_, session)| {
            session.plugin_key == plugin_key && session.connector_slug == connector_slug
        })
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for stale_id in stale_ids {
        if let Some(stale) = sessions.remove(&stale_id) {
            stale.task.abort();
        }
    }
    sessions.insert(
        session_id.clone(),
        BrowserAuthSession {
            plugin_key,
            connector_slug,
            state,
            task,
        },
    );
    Ok(browser_session_state(
        "preparing",
        "Preparing the local authorization tool",
        &session_id,
    ))
}

pub(super) async fn poll_browser_auth(payload: &Value) -> Result<Value, AppIpcError> {
    let session_id = request_session_id(payload)?;
    let sessions = browser_auth_sessions().lock().await;
    let session = sessions.get(&session_id).ok_or_else(|| {
        AppIpcError::new(
            "local_auth_session_missing",
            "Authorization session was not found",
        )
    })?;
    validate_session_identity(payload, session)?;
    let state = Arc::clone(&session.state);
    drop(sessions);
    let response = state.lock().await.clone();
    if matches!(
        response.get("status").and_then(Value::as_str),
        Some("ok" | "error" | "expired" | "cancelled")
    ) {
        browser_auth_sessions().lock().await.remove(&session_id);
    }
    Ok(response)
}

pub(super) fn browser_session_state(status: &str, hint: &str, session_id: &str) -> Value {
    json!({
        "status": status,
        "rawStatus": status,
        "hint": hint,
        "sessionId": session_id,
    })
}
