use std::time::Instant;

use serde_json::{json, Value};

use super::payload::{evaluate_action_violation, wait_payload};
use super::result_text::action_text_result;
use super::{bridge_payload_is_read_only, execute_tool, BrowserMcpRequestContext};

#[test]
fn reserves_approval_time_only_for_mutating_browser_requests() {
    assert_eq!(
        super::bridge_request_timeout(&json!({ "action": "inspect" })).as_secs(),
        45
    );
    assert_eq!(
        super::bridge_request_timeout(&json!({ "action": "fill" })).as_secs(),
        105
    );
    assert_eq!(super::BROWSER_TOOL_TIMEOUT_SECONDS, 120);
}

#[test]
fn unverified_click_result_requires_follow_up_observation() {
    let text = action_text_result(&json!({
        "ok": true,
        "action": "click",
        "outcome": "dispatched_unverified",
        "effectObserved": false,
        "effect": {}
    }))
    .unwrap();

    assert!(text.contains("dispatched_unverified"));
    assert!(text.contains("browser_wait_and_inspect"));
    assert!(!text.contains("The click succeeded"));
}

#[test]
fn evaluate_rejects_page_action_expressions_but_allows_diagnostics() {
    assert_eq!(
        evaluate_action_violation("document.querySelector('#kw').value = '微博'"),
        Some("input value assignment")
    );
    assert_eq!(
        evaluate_action_violation("document.querySelector('#su').click()"),
        Some("click invocation")
    );
    assert_eq!(
        evaluate_action_violation("document.querySelector('form').requestSubmit()"),
        Some("form submission")
    );
    assert_eq!(
        evaluate_action_violation("({ title: document.title, url: location.href })"),
        None
    );
}

#[test]
fn bridge_reconnect_replays_only_observation_requests() {
    assert!(bridge_payload_is_read_only(&json!({ "action": "inspect" })));
    assert!(bridge_payload_is_read_only(&json!({ "action": "waitFor" })));
    assert!(!bridge_payload_is_read_only(&json!({ "action": "click" })));
    assert!(!bridge_payload_is_read_only(&json!({ "action": "fill" })));
    assert!(!bridge_payload_is_read_only(&json!({ "action": "open" })));
}

#[tokio::test]
async fn evaluate_tool_rejects_click_without_calling_bridge() {
    let result = execute_tool(
        &reqwest::Client::new(),
        "browser_evaluate",
        &json!({ "expression": "document.querySelector('#su').click()" }),
        &BrowserMcpRequestContext::new(None, "browser-test-session".to_owned()),
        1,
        Instant::now(),
    )
    .await;

    assert_eq!(result["isError"], true);
    assert!(result
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .unwrap()
        .contains("Use browser_fill/browser_click"));
}

#[test]
fn open_and_inspect_waits_for_page_stability_across_redirects() {
    let payload = wait_payload(
        "browser_open_and_inspect",
        &json!({
            "url": "http://example.com/start"
        }),
    );

    assert!(payload.get("url").is_none());
    assert_eq!(payload["options"]["condition"]["waitUntil"], "pageStable");
    assert!(payload.get("expression").is_some());

    let explicit = wait_payload(
        "browser_open_and_inspect",
        &json!({
            "url": "http://example.com/start",
            "condition": { "urlIncludes": "/dashboard" }
        }),
    );
    assert_eq!(explicit["url"], "/dashboard");
}
