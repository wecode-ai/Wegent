use std::{thread, time::Duration};

use serde_json::{json, Value};

use super::{
    eval_json, get_entry, EmbeddedBrowserBridgeRequest, EmbeddedBrowserState,
    BRIDGE_EVAL_TIMEOUT_MS, EMBEDDED_BROWSER_ACTION_SCRIPT, EMBEDDED_BROWSER_BRIDGE_SEQUENCE,
    EMBEDDED_BROWSER_INSPECT_SCRIPT, EMBEDDED_BROWSER_WAIT_SCRIPT,
};

pub(super) async fn eval_json_nonblocking(
    state: &EmbeddedBrowserState,
    label: &str,
    script: String,
    timeout_ms: u64,
) -> Result<Value, String> {
    let entry = get_entry(state, label)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    entry
        .ready_webview()?
        .eval_with_callback(script, move |result| {
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Failed to evaluate embedded browser script: {error}"))?;

    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_millis(timeout_ms))
            .map_err(|_| "Timed out waiting for embedded browser evaluation".to_string())
    })
    .await
    .map_err(|error| format!("Failed to join embedded browser evaluation task: {error}"))??;
    serde_json::from_str(&result).or(Ok(Value::String(result)))
}

pub(super) fn script_expression(expression: &str) -> String {
    format!(
        r#"(() => {{
  try {{
    const value = (() => {{ return ({expression}); }})();
    return {{ ok: true, value }};
  }} catch (error) {{
    return {{ ok: false, error: String(error?.stack || error?.message || error) }};
  }}
}})()"#
    )
}

fn script_wait_for(request: &EmbeddedBrowserBridgeRequest, wait_id: &str) -> String {
    let input = json!({
        "waitId": wait_id,
        "selector": request.selector,
        "text": request.text,
        "url": request.url,
        "expression": request.expression,
        "timeoutMs": request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS),
        "options": request.options,
    });
    let encoded_input = serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string());
    EMBEDDED_BROWSER_WAIT_SCRIPT.replace("__WEWORK_WAIT_INPUT__", &encoded_input)
}

pub(super) fn wait_for_embedded_browser(
    state: &EmbeddedBrowserState,
    label: &str,
    request: &EmbeddedBrowserBridgeRequest,
) -> Result<Value, String> {
    let timeout_ms = request.timeout_ms.unwrap_or(BRIDGE_EVAL_TIMEOUT_MS);
    let poll_ms = request
        .options
        .as_ref()
        .and_then(|options| options.get("pollMs"))
        .and_then(Value::as_u64)
        .unwrap_or(100)
        .clamp(50, 1_000);
    let wait_id = format!(
        "wk-wait-{}",
        EMBEDDED_BROWSER_BRIDGE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let started = std::time::Instant::now();
    let deadline = started + Duration::from_millis(timeout_ms);
    let mut last_result = json!({
        "ok": false,
        "kind": "browser.wait",
        "backend": "wkwebview-js",
        "reason": "not_started",
    });

    while std::time::Instant::now() <= deadline {
        let remaining_ms = deadline
            .saturating_duration_since(std::time::Instant::now())
            .as_millis()
            .try_into()
            .unwrap_or(BRIDGE_EVAL_TIMEOUT_MS);
        let eval_timeout_ms = remaining_ms.clamp(1, BRIDGE_EVAL_TIMEOUT_MS);
        last_result = match eval_json(
            state,
            label,
            script_wait_for(request, &wait_id),
            eval_timeout_ms,
        ) {
            Ok(value) => value,
            Err(error) => json!({
                "ok": false,
                "kind": "browser.wait",
                "backend": "wkwebview-js",
                "reason": "operation_failed",
                "elapsedMs": started.elapsed().as_millis() as u64,
                "observed": {},
                "warnings": [],
                "error": {
                    "code": "wait_eval_failed",
                    "message": error,
                    "recoverable": true,
                    "suggestedNextAction": "wait"
                }
            }),
        };
        if last_result
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(last_result);
        }
        let sleep_ms = deadline
            .saturating_duration_since(std::time::Instant::now())
            .min(Duration::from_millis(poll_ms));
        if sleep_ms.is_zero() {
            break;
        }
        thread::sleep(sleep_ms);
    }

    let elapsed_ms = started.elapsed().as_millis() as u64;
    if let Some(object) = last_result.as_object_mut() {
        object.insert("ok".to_string(), Value::Bool(false));
        object.insert("reason".to_string(), Value::String("timeout".to_string()));
        object.insert("elapsedMs".to_string(), Value::from(elapsed_ms));
        object.insert(
            "error".to_string(),
            json!({
                "code": "wait_timeout",
                "message": "Timed out waiting for embedded browser condition.",
                "recoverable": true,
                "suggestedNextAction": "inspect"
            }),
        );
    }
    Ok(last_result)
}

pub(super) fn script_browser_action(
    action: &str,
    request: &EmbeddedBrowserBridgeRequest,
) -> Result<String, String> {
    let input = json!({
        "action": action,
        "selector": request.selector,
        "text": request.text,
        "key": request.key,
        "x": request.x,
        "y": request.y,
        "inspectId": request.inspect_id,
        "index": request.index,
        "ref": request.ref_,
        "options": request.options,
    });
    let encoded_input = serde_json::to_string(&input)
        .map_err(|error| format!("Failed to encode embedded browser action input: {error}"))?;
    Ok(EMBEDDED_BROWSER_ACTION_SCRIPT.replace("__WEWORK_ACTION_INPUT__", &encoded_input))
}

fn script_semantic_inspect(options: &Value) -> Result<String, String> {
    let encoded_options = serde_json::to_string(options)
        .map_err(|error| format!("Failed to encode embedded browser inspect options: {error}"))?;
    Ok(EMBEDDED_BROWSER_INSPECT_SCRIPT.replace("__WEWORK_INSPECT_OPTIONS__", &encoded_options))
}

pub(super) fn inspect_embedded_browser(
    state: &EmbeddedBrowserState,
    label: &str,
    options: Value,
    timeout_ms: u64,
) -> Result<Value, String> {
    eval_json(state, label, script_semantic_inspect(&options)?, timeout_ms)
}

pub(super) fn embedded_browser_capabilities() -> Value {
    json!({
        "kind": "browser.capabilities",
        "backend": "wkwebview",
        "schemaVersion": 1,
        "inspect": {
            "structuredDom": true,
            "indexRef": true,
            "frame": "same-origin",
            "shadowDom": "open-shadow-dom"
        },
        "actions": {
            "syntheticDom": [
                "click",
                "type",
                "fill",
                "hover",
                "focus",
                "press",
                "select",
                "setChecked",
                "scroll",
                "scrollIntoView"
            ],
            "trustedNativeInput": "poc_only",
            "appKitNativeInputProbe": true
        },
        "wait": {
            "structured": true,
            "conditions": [
                "selectorAttached",
                "selectorVisible",
                "textVisible",
                "urlIncludes",
                "urlMatches",
                "titleIncludes",
                "revisionChanged",
                "domStable",
                "pageStable",
                "inputValueChanged",
                "elementGone",
                "expression"
            ]
        },
        "screenshot": {
            "viewport": cfg!(target_os = "macos"),
            "primaryBackend": cfg!(target_os = "macos").then_some("wkwebview-nsview-cache"),
            "fallbackBackend": null,
            "wkTakeSnapshot": false
        },
        "p2": {
            "reparentApiAvailable": true,
            "newWindowHookAvailable": true,
            "popupObservation": true,
            "controlledPopup": "not_productionized",
            "macAxTreeProbe": "not_productionized"
        },
        "warnings": [
            {
                "code": "synthetic_input_limit",
                "message": "Current production actions use DOM synthetic events; some pages may require trusted input."
            },
            {
                "code": "p2_poc_not_default",
                "message": "P2 native input, AX tree and WebView reparent are exposed as capability/probe surfaces, not production defaults."
            }
        ]
    })
}

pub(super) fn native_input_probe_result(request: &EmbeddedBrowserBridgeRequest) -> Value {
    json!({
        "ok": false,
        "kind": "browser.nativeInputProbe",
        "backend": "appkit-poc",
        "probeKind": request.options
            .as_ref()
            .and_then(|value| value.get("kind"))
            .and_then(Value::as_str)
            .unwrap_or("unknown"),
        "permissionRequired": false,
        "eventTrusted": null,
        "effect": {
            "urlChanged": false,
            "domChanged": false,
            "focusChanged": false,
            "valueChanged": false
        },
        "warnings": [
            {
                "code": "native_input_probe_not_executed",
                "message": "Native AppKit event dispatch is not enabled as a production path; use DOM actions or user control."
            },
            {
                "code": "requires_real_tauri_verification",
                "message": "Trusted input must be verified in an isolated real Tauri session before enabling."
            }
        ],
        "error": {
            "code": "requires_trusted_input",
            "message": "AppKit native input is only a PoC surface in this build.",
            "recoverable": true,
            "category": "capability",
            "suggestedNextAction": "ask_user_to_take_control"
        }
    })
}

pub(super) fn ax_probe_result() -> Value {
    json!({
        "ok": false,
        "kind": "browser.axProbe",
        "backend": "macos-ax-poc",
        "permissionRequired": true,
        "root": null,
        "stats": {
            "nodeCount": 0,
            "durationMs": 0,
            "roleCount": {}
        },
        "warnings": [
            {
                "code": "ax_tree_not_enabled",
                "message": "macOS AX tree collection is not enabled by default because it may require Accessibility permission."
            }
        ],
        "error": {
            "code": "unsupported_browser_capability",
            "message": "AX tree probing has not been productionized for WKWebView content.",
            "recoverable": true,
            "category": "capability",
            "suggestedNextAction": "inspect"
        }
    })
}

pub(super) fn present_probe_result(
    state: &EmbeddedBrowserState,
    label: &str,
) -> Result<Value, String> {
    let entry = get_entry(state, label)?;
    Ok(json!({
        "ok": true,
        "kind": "browser.presentProbe",
        "backend": "tauri-webview",
        "label": label,
        "nativeLabel": entry.native_label,
        "placement": {
            "kind": "panel",
            "surfaceEpoch": 1
        },
        "reparentApiAvailable": true,
        "reparented": false,
        "restoredByReload": false,
        "warnings": [
            {
                "code": "popout_not_productionized",
                "message": "Tauri exposes Webview::reparent, but panel/popout shell state has not been enabled as a production user flow."
            }
        ]
    }))
}

pub(super) fn script_resolve_inspect_target(request: &EmbeddedBrowserBridgeRequest) -> String {
    let input = json!({
        "inspectId": request.inspect_id,
        "index": request.index,
        "ref": request.ref_,
    });
    let encoded_input = serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string());
    format!(
        r#"(() => {{
  try {{
    const resolver = window.__WEWORK_BROWSER_AGENT__?.resolveInspectTarget;
    if (typeof resolver !== "function") {{
      return {{
        ok: false,
        errorCode: "stale_inspect",
        message: "No inspect registry is available."
      }};
    }}
    return resolver({encoded_input});
  }} catch (error) {{
    return {{
      ok: false,
      errorCode: "resolve_failed",
      message: String(error?.stack || error?.message || error)
    }};
  }}
}})()"#
    )
}

#[cfg(test)]
pub(super) fn script_semantic_inspect_for_test(options: &Value) -> Result<String, String> {
    script_semantic_inspect(options)
}
