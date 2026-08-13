use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;

use super::{
    browser_label, current_unix_millis, EmbeddedBrowserBridgeRequest, EmbeddedBrowserState,
    EMBEDDED_BROWSER_AGENT_STATE_EVENT, EMBEDDED_BROWSER_NATIVE_SEQUENCE,
};

const AGENT_APPROVAL_RESOLUTION_GRACE: Duration = Duration::from_millis(250);

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmbeddedBrowserAgentStatePayload {
    label: String,
    status: String,
    action: Option<String>,
    target: Option<String>,
    message: Option<String>,
    error_code: Option<String>,
    approval: Option<EmbeddedBrowserApprovalPayload>,
    created_at_unix_ms: u128,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct EmbeddedBrowserApprovalPayload {
    pub(super) approval_id: String,
    pub(super) risk: String,
    pub(super) action_kind: String,
    pub(super) reason: String,
    pub(super) target: Option<Value>,
    pub(super) expires_at_unix_ms: u128,
}

#[derive(Debug, Clone)]
pub(super) struct EmbeddedBrowserApprovalState {
    pub(super) label: String,
    pub(super) signature: String,
    pub(super) payload: EmbeddedBrowserApprovalPayload,
    pub(super) approved: bool,
}

pub(super) fn emit_agent_state(
    app: &tauri::AppHandle,
    label: &str,
    status: &str,
    action: Option<&str>,
    target: Option<String>,
    message: Option<String>,
    error_code: Option<String>,
    approval: Option<EmbeddedBrowserApprovalPayload>,
) {
    let payload = EmbeddedBrowserAgentStatePayload {
        label: label.to_string(),
        status: status.to_string(),
        action: action.map(str::to_string),
        target,
        message,
        error_code,
        approval,
        created_at_unix_ms: current_unix_millis(),
    };
    let _ = app.emit(EMBEDDED_BROWSER_AGENT_STATE_EVENT, payload);
}

pub(super) fn is_agent_observable_bridge_action(action: &str) -> bool {
    matches!(
        action,
        "open"
            | "navigate"
            | "inspect"
            | "resolveRef"
            | "click"
            | "typeText"
            | "fill"
            | "hover"
            | "focus"
            | "select"
            | "setChecked"
            | "scroll"
            | "scrollIntoView"
            | "press"
            | "waitFor"
            | "screenshot"
    )
}

pub(super) fn is_agent_mutating_bridge_action(action: &str) -> bool {
    matches!(
        action,
        "open"
            | "navigate"
            | "click"
            | "typeText"
            | "fill"
            | "hover"
            | "focus"
            | "select"
            | "setChecked"
            | "scroll"
            | "scrollIntoView"
            | "press"
    )
}

pub(super) fn agent_action_target(request: &EmbeddedBrowserBridgeRequest) -> Option<String> {
    if let Some(ref_) = &request.ref_ {
        return Some(ref_.clone());
    }
    if let Some(index) = request.index {
        return Some(format!("index {index}"));
    }
    if let Some(selector) = &request.selector {
        return Some(selector.clone());
    }
    request.url.clone()
}

pub(super) fn agent_action_signature(
    action: &str,
    request: &EmbeddedBrowserBridgeRequest,
) -> String {
    let target = if let Some(ref_) = &request.ref_ {
        format!("ref:{ref_}")
    } else if let Some(inspect_id) = &request.inspect_id {
        format!("inspect:{inspect_id}:{}", request.index.unwrap_or_default())
    } else if let Some(selector) = &request.selector {
        format!("selector:{selector}")
    } else if request.x.is_some() || request.y.is_some() {
        format!(
            "coord:{:.1}:{:.1}",
            request.x.unwrap_or_default(),
            request.y.unwrap_or_default()
        )
    } else {
        "active".to_string()
    };
    format!("{action}:{target}")
}

pub(super) fn merge_request_option(
    request: &mut EmbeddedBrowserBridgeRequest,
    key: &str,
    value: Value,
) {
    let mut options = request.options.take().unwrap_or_else(|| json!({}));
    if let Some(object) = options.as_object_mut() {
        object.insert(key.to_string(), value);
        request.options = Some(options);
        return;
    }
    request.options = Some(json!({ key: value }));
}

pub(super) fn consume_approved_agent_risk(
    state: &EmbeddedBrowserState,
    label: &str,
    signature: &str,
) -> Result<bool, String> {
    let deadline = Instant::now() + AGENT_APPROVAL_RESOLUTION_GRACE;
    let mut approvals = state
        .agent_approvals
        .lock()
        .map_err(|_| "Embedded browser approval state lock poisoned".to_string())?;

    loop {
        let now = current_unix_millis();
        approvals.retain(|_, approval| approval.payload.expires_at_unix_ms > now);
        let approved_id = approvals.iter().find_map(|(id, approval)| {
            (approval.label == label && approval.signature == signature && approval.approved)
                .then(|| id.clone())
        });
        if let Some(approval_id) = approved_id {
            approvals.remove(&approval_id);
            return Ok(true);
        }
        let pending = approvals.values().any(|approval| {
            approval.label == label && approval.signature == signature && !approval.approved
        });
        if !pending {
            return Ok(false);
        }

        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Ok(false);
        };
        let (next_approvals, wait_result) = state
            .agent_approval_changed
            .wait_timeout(approvals, remaining)
            .map_err(|_| "Embedded browser approval state lock poisoned".to_string())?;
        approvals = next_approvals;
        if wait_result.timed_out() {
            return Ok(false);
        }
    }
}

pub(super) fn register_agent_approval(
    state: &EmbeddedBrowserState,
    label: &str,
    action: &str,
    signature: &str,
    result: &mut Value,
) -> Result<Option<EmbeddedBrowserApprovalPayload>, String> {
    if result.pointer("/error/code").and_then(Value::as_str) != Some("approval_required") {
        return Ok(None);
    }
    let approval_source = result.get("approval").cloned().unwrap_or_else(|| json!({}));
    let approval_id = format!(
        "browser-approval-{}",
        EMBEDDED_BROWSER_NATIVE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let payload = EmbeddedBrowserApprovalPayload {
        approval_id: approval_id.clone(),
        risk: approval_source
            .get("risk")
            .and_then(Value::as_str)
            .unwrap_or("high")
            .to_string(),
        action_kind: approval_source
            .get("actionKind")
            .and_then(Value::as_str)
            .unwrap_or(action)
            .to_string(),
        reason: approval_source
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("This browser action may change data on the page.")
            .to_string(),
        target: approval_source.get("target").cloned(),
        expires_at_unix_ms: current_unix_millis() + 60_000,
    };
    if let Some(object) = result.as_object_mut() {
        object.insert(
            "approval".to_string(),
            serde_json::to_value(&payload).unwrap_or_default(),
        );
    }
    state
        .agent_approvals
        .lock()
        .map_err(|_| "Embedded browser approval state lock poisoned".to_string())?
        .insert(
            approval_id,
            EmbeddedBrowserApprovalState {
                label: label.to_string(),
                signature: signature.to_string(),
                payload: payload.clone(),
                approved: false,
            },
        );
    Ok(Some(payload))
}

pub(super) fn is_agent_control_paused(
    state: &EmbeddedBrowserState,
    label: &str,
) -> Result<bool, String> {
    let paused = state
        .agent_control_paused
        .lock()
        .map_err(|_| "Embedded browser agent control state lock poisoned".to_string())?
        .get(label)
        .copied()
        .unwrap_or(false);
    Ok(paused)
}

pub(super) fn agent_control_paused_result(action: &str) -> Value {
    json!({
        "ok": false,
        "kind": "browser.action",
        "action": action,
        "error": {
            "code": "user_control",
            "message": "User is controlling the embedded browser. Ask before continuing.",
            "recoverable": true,
            "category": "control",
            "suggestedNextAction": "ask_user_to_resume_agent_control"
        }
    })
}

pub(super) fn clear_label_agent_state(
    state: &EmbeddedBrowserState,
    label: &str,
) -> Result<(), String> {
    state
        .agent_control_paused
        .lock()
        .map_err(|_| "Embedded browser agent control state lock poisoned".to_string())?
        .remove(label);
    state
        .agent_approvals
        .lock()
        .map_err(|_| "Embedded browser approval state lock poisoned".to_string())?
        .retain(|_, approval| approval.label != label);
    state.agent_approval_changed.notify_all();
    Ok(())
}

pub(super) fn set_agent_control_paused(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddedBrowserState>,
    label: Option<String>,
    paused: bool,
) -> Result<(), String> {
    let label = browser_label(label);
    {
        let mut paused_labels = state
            .agent_control_paused
            .lock()
            .map_err(|_| "Embedded browser agent control state lock poisoned".to_string())?;
        if paused {
            paused_labels.insert(label.clone(), true);
        } else {
            paused_labels.remove(&label);
        }
    }
    emit_agent_state(
        &app,
        &label,
        if paused { "paused" } else { "idle" },
        None,
        None,
        None,
        None,
        None,
    );
    Ok(())
}

pub(super) fn resolve_agent_approval(
    app: tauri::AppHandle,
    state: tauri::State<'_, EmbeddedBrowserState>,
    label: Option<String>,
    approval_id: String,
    approved: bool,
) -> Result<(), String> {
    let label = browser_label(label);
    let mut approvals = state
        .agent_approvals
        .lock()
        .map_err(|_| "Embedded browser approval state lock poisoned".to_string())?;
    let approval = approvals
        .get_mut(&approval_id)
        .ok_or_else(|| "Browser approval request not found".to_string())?;
    if approval.label != label {
        return Err("Browser approval request belongs to a different label".to_string());
    }
    if approval.payload.expires_at_unix_ms <= current_unix_millis() {
        approvals.remove(&approval_id);
        return Err("Browser approval request expired".to_string());
    }
    if approved {
        approval.approved = true;
        let payload = approval.payload.clone();
        drop(approvals);
        state.agent_approval_changed.notify_all();
        emit_agent_state(
            &app,
            &label,
            "idle",
            Some(&payload.action_kind),
            None,
            Some("Browser action approved. The agent can retry it now.".to_string()),
            None,
            None,
        );
    } else {
        let payload = approval.payload.clone();
        approvals.remove(&approval_id);
        drop(approvals);
        state.agent_approval_changed.notify_all();
        emit_agent_state(
            &app,
            &label,
            "error",
            Some(&payload.action_kind),
            None,
            Some("Browser action was rejected by the user.".to_string()),
            Some("approval_rejected".to_string()),
            None,
        );
    }
    Ok(())
}
