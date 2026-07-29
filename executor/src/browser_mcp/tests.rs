use std::time::Instant;

use serde_json::{json, Value};

use super::payload::{
    action_target_payload, combined_inspect_payload, evaluate_action_violation, inspect_payload,
    wait_options, wait_payload, WaitConditionOptions,
};
use super::result_text::{
    action_text_result, combined_text_result, inspect_text_result, inspect_text_result_with_options,
};
use super::{bridge_value_is_error, execute_tool, handle_request};

#[tokio::test]
async fn exposes_expected_browser_tools() {
    let request = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let response = handle_request(&reqwest::Client::new(), &request, 1, Instant::now())
        .await
        .unwrap();
    let names = response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    assert!(names.contains(&"browser_open"));
    assert!(names.contains(&"browser_inspect"));
    assert!(names.contains(&"browser_fill"));
    assert!(names.contains(&"browser_open_and_inspect"));
    assert!(names.contains(&"browser_click_and_inspect"));
    assert!(names.contains(&"browser_fill_and_inspect"));
    assert!(names.contains(&"browser_type_and_inspect"));
    assert!(names.contains(&"browser_wait_and_inspect"));
    assert!(names.contains(&"browser_navigate"));
    assert!(names.contains(&"browser_evaluate"));
    assert!(names.contains(&"browser_take_screenshot"));
    assert!(names.contains(&"browser_capabilities"));
    assert!(names.contains(&"browser_native_input_probe"));
    assert!(names.contains(&"browser_ax_probe"));
    assert!(names.contains(&"browser_present_probe"));
    assert!(names.contains(&"browser_press_key"));
    assert!(names.contains(&"browser_hover"));
    assert!(names.contains(&"browser_focus"));
    assert!(names.contains(&"browser_scroll"));
    assert!(names.contains(&"browser_scroll_into_view"));
    assert!(names.contains(&"browser_select_option"));
    assert!(names.contains(&"browser_set_checked"));
    assert_eq!(names.len(), 34);
}

#[tokio::test]
async fn action_tool_schema_guides_index_ref_followup_actions() {
    let request = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let response = handle_request(&reqwest::Client::new(), &request, 1, Instant::now())
        .await
        .unwrap();
    let tools = response["result"]["tools"].as_array().unwrap();
    let fill = tools
        .iter()
        .find(|tool| tool["name"] == "browser_fill")
        .expect("browser_fill tool");
    let click = tools
        .iter()
        .find(|tool| tool["name"] == "browser_click")
        .expect("browser_click tool");
    let inspect = tools
        .iter()
        .find(|tool| tool["name"] == "browser_inspect")
        .expect("browser_inspect tool");
    let evaluate = tools
        .iter()
        .find(|tool| tool["name"] == "browser_evaluate")
        .expect("browser_evaluate tool");

    assert!(click["description"]
        .as_str()
        .unwrap()
        .contains("requested click is complete only"));
    assert!(fill["description"]
        .as_str()
        .unwrap()
        .contains("separately requested click"));
    assert!(inspect["description"]
        .as_str()
        .unwrap()
        .contains("Reuse known targets"));
    assert!(evaluate["description"]
        .as_str()
        .unwrap()
        .contains("read-only JavaScript"));
    assert!(evaluate["description"]
        .as_str()
        .unwrap()
        .contains("dedicated tools"));
    assert!(fill
        .pointer("/inputSchema/properties/selector/description")
        .and_then(Value::as_str)
        .unwrap()
        .contains("same action tool"));
    assert!(fill
        .pointer("/inputSchema/properties/index/description")
        .and_then(Value::as_str)
        .unwrap()
        .contains("latest browser_inspect"));
    assert_eq!(
        fill.pointer("/inputSchema/properties/index/type"),
        Some(&json!("integer"))
    );
    assert!(fill
        .pointer("/inputSchema/properties/ref/description")
        .and_then(Value::as_str)
        .unwrap()
        .contains("browser_inspect"));
}

#[test]
fn inspect_payload_sets_defaults_and_overrides() {
    let payload = inspect_payload(&json!({
        "interactiveOnly": true,
        "includeTextBlocks": false,
        "maxNodes": 25,
        "timeoutMs": 4500
    }));

    assert_eq!(payload["action"], "inspect");
    assert_eq!(payload["options"]["mode"], "compact");
    assert_eq!(payload["options"]["interactiveOnly"], true);
    assert_eq!(payload["options"]["includeTextBlocks"], false);
    assert_eq!(payload["options"]["maxNodes"], 25.0);
    assert_eq!(payload["options"]["maxTextChars"], 12000.0);
    assert_eq!(payload["timeoutMs"], 4500);
}

#[test]
fn inspect_text_result_prioritizes_agent_readable_tree() {
    let text = inspect_text_result(&json!({
        "kind": "browser.inspect",
        "inspectText": "[0] button \"登录\"",
        "textPreview": "large body text",
        "nodes": [{ "index": 0, "role": "button", "name": "登录" }]
    }))
    .unwrap();

    assert!(text.starts_with("[0] button \"登录\"\n\nAction guidance:"));
    assert!(text.contains("Action guidance:"));
    assert!(text.contains("Continue the user's requested actions"));
    assert!(text.contains("reuse known targets"));
    assert!(text.contains("avoid redundant inspections"));
    assert!(text.contains("Metadata:"));
    assert!(text.contains("\"kind\":\"browser.inspect\""));
    assert!(!text.contains("large body text"));
    assert!(!text.contains("\"nodes\""));
}

#[test]
fn combined_text_result_repeats_action_guidance_after_inspect() {
    let text = combined_text_result(&json!({
        "kind": "browser.combined",
        "ok": true,
        "tool": "open_and_inspect",
        "wait": { "ok": true, "reason": "load_finished" },
        "inspect": {
            "kind": "browser.inspect",
            "inspectText": "[0] textbox \"百度一下\"",
            "textPreview": "large body text",
            "nodes": [{ "index": 0, "role": "textbox", "name": "百度一下" }]
        }
    }))
    .unwrap();

    assert!(text.contains("Inspect:\n[0] textbox \"百度一下\""));
    assert!(text.contains("Action guidance:"));
    assert!(text.contains("reuse known targets"));
    assert!(text.contains("Metadata:"));
    assert!(!text.contains("large body text"));
    assert!(!text.contains("\"nodes\""));
}

#[test]
fn action_text_result_is_concise_and_drives_the_next_requested_action() {
    let text = action_text_result(&json!({
        "ok": true,
        "action": "fill",
        "target": { "index": 20, "role": "textbox", "name": "百度搜索" },
        "before": { "bodyTextHash": "large-before" },
        "after": { "bodyTextHash": "large-after" },
        "effect": { "valueChanged": true }
    }))
    .unwrap();

    assert!(text.contains("{\"action\":\"fill\",\"success\":true}"));
    assert!(text.contains("Continue any remaining requested action"));
    assert!(text.contains("without another inspect"));
    assert!(!text.contains("large-before"));
    assert!(!text.contains("large-after"));
}

#[test]
fn full_json_output_remains_available_for_e2e_diagnostics() {
    let data = json!({
        "kind": "browser.inspect",
        "inspectId": "wk-inspect-1",
        "inspectText": "[20] textbox \"百度搜索\"",
        "nodes": [{ "index": 20, "ref": "wk-ref-20", "role": "textbox" }]
    });

    let compact = inspect_text_result_with_options(&data, false).unwrap();
    let full = inspect_text_result_with_options(&data, true).unwrap();

    assert!(!compact.contains("wk-ref-20"));
    assert!(full.contains("JSON:"));
    assert!(full.contains("wk-ref-20"));
}

#[test]
fn action_target_payload_prefers_inspect_target_fields() {
    let payload = action_target_payload(
        "click",
        &json!({
            "inspectId": "wk-inspect-1",
            "index": 3,
            "ref": "wk-mvp:wk-inspect-1:main:3:abcd1234",
            "selector": "css=#fallback",
            "timeoutMs": 5000
        }),
    );

    assert_eq!(payload["action"], "click");
    assert_eq!(payload["inspectId"], "wk-inspect-1");
    assert_eq!(payload["index"], 3);
    assert_eq!(payload["ref"], "wk-mvp:wk-inspect-1:main:3:abcd1234");
    assert_eq!(payload["selector"], "#fallback");
    assert_eq!(payload["timeoutMs"], 5000);
}

#[test]
fn fill_payload_maps_value_to_text() {
    let payload = action_target_payload(
        "fill",
        &json!({
            "selector": "#email",
            "value": "user@example.com"
        }),
    );

    assert_eq!(payload["action"], "fill");
    assert_eq!(payload["selector"], "#email");
    assert_eq!(payload["text"], "user@example.com");
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

#[tokio::test]
async fn evaluate_tool_rejects_click_without_calling_bridge() {
    let result = execute_tool(
        &reqwest::Client::new(),
        "browser_evaluate",
        &json!({ "expression": "document.querySelector('#su').click()" }),
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

#[tokio::test]
async fn evaluate_based_legacy_actions_are_disabled() {
    let fill_form = execute_tool(
        &reqwest::Client::new(),
        "browser_fill_form",
        &json!({ "fields": [] }),
        1,
        Instant::now(),
    )
    .await;
    let drag = execute_tool(
        &reqwest::Client::new(),
        "browser_drag",
        &json!({ "startRef": "#a", "endRef": "#b" }),
        1,
        Instant::now(),
    )
    .await;

    assert_eq!(fill_form["isError"], true);
    assert!(fill_form
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .unwrap()
        .contains("unrestricted JavaScript"));
    assert_eq!(drag["isError"], true);
    assert!(drag
        .pointer("/content/0/text")
        .and_then(Value::as_str)
        .unwrap()
        .contains("trusted drag input"));
}

#[test]
fn failed_bridge_action_is_marked_as_tool_error() {
    assert!(bridge_value_is_error(
        "browser_fill",
        &json!({
            "ok": false,
            "error": { "code": "stale_ref" }
        })
    ));
    assert!(!bridge_value_is_error(
        "browser_fill",
        &json!({ "ok": true })
    ));
    assert!(!bridge_value_is_error(
        "browser_inspect",
        &json!({ "kind": "browser.inspect" })
    ));
    assert!(!bridge_value_is_error(
        "browser_native_input_probe",
        &json!({ "ok": false, "error": { "category": "capability" } })
    ));
}

#[test]
fn p1_action_payload_carries_options() {
    let press = action_target_payload(
        "press",
        &json!({
            "key": "Meta+Enter",
            "ref": "wk-mvp:target"
        }),
    );
    let select = action_target_payload(
        "select",
        &json!({
            "selector": "#kind",
            "values": ["finance"],
            "by": "value"
        }),
    );
    let checked = action_target_payload(
        "setChecked",
        &json!({
            "index": 2,
            "checked": true
        }),
    );

    assert_eq!(press["action"], "press");
    assert_eq!(press["key"], "Meta+Enter");
    assert_eq!(press["ref"], "wk-mvp:target");
    assert_eq!(select["options"]["values"], json!(["finance"]));
    assert_eq!(select["options"]["by"], "value");
    assert_eq!(checked["options"]["checked"], true);
}

#[test]
fn combined_inspect_payload_uses_nested_options() {
    let payload = combined_inspect_payload(&json!({
        "text": "typed value",
        "inspectOptions": {
            "interactiveOnly": true,
            "maxNodes": 10
        },
        "timeoutMs": 9000
    }));

    assert_eq!(payload["action"], "inspect");
    assert_eq!(payload["options"]["interactiveOnly"], true);
    assert_eq!(payload["options"]["maxNodes"], 10.0);
    assert_eq!(payload["timeoutMs"], 9000);
}

#[test]
fn wait_payload_uses_condition_text_for_fill_combined() {
    let payload = wait_payload(
        "browser_fill_and_inspect",
        &json!({
            "text": "alice@example.com",
            "condition": { "textVisible": "Saved" },
            "timeoutMs": 4000
        }),
    );

    assert_eq!(payload["action"], "waitFor");
    assert_eq!(payload["text"], "Saved");
    assert_eq!(payload["options"]["condition"]["textVisible"], "Saved");
    assert_eq!(payload["timeoutMs"], 4000);
}

#[test]
fn wait_payload_does_not_treat_fill_text_as_wait_text() {
    let payload = wait_payload(
        "browser_fill_and_inspect",
        &json!({
            "text": "alice@example.com"
        }),
    );

    assert_eq!(payload["action"], "waitFor");
    assert!(payload.get("text").is_none());
    assert!(payload.get("expression").is_some());
    assert_eq!(payload["options"]["condition"]["waitUntil"], "pageStable");
}

#[test]
fn wait_payload_does_not_treat_action_selector_as_wait_selector() {
    let payload = wait_payload(
        "browser_click_and_inspect",
        &json!({
            "selector": "#submit"
        }),
    );

    assert_eq!(payload["action"], "waitFor");
    assert!(payload.get("selector").is_none());
    assert!(payload.get("expression").is_some());
    assert_eq!(payload["options"]["condition"]["waitUntil"], "pageStable");
}

#[test]
fn wait_payload_maps_url_and_title_conditions() {
    let url_payload = wait_payload(
        "browser_wait_and_inspect",
        &json!({ "condition": { "urlMatches": "/dashboard" } }),
    );
    let title_payload = wait_payload(
        "browser_wait_and_inspect",
        &json!({ "condition": { "titleIncludes": "Home" } }),
    );

    assert!(url_payload["expression"]
        .as_str()
        .unwrap()
        .contains("location.href"));
    assert!(title_payload["expression"]
        .as_str()
        .unwrap()
        .contains("document.title.includes"));
    assert_eq!(
        url_payload["options"]["condition"]["urlMatches"],
        "/dashboard"
    );
    assert_eq!(
        title_payload["options"]["condition"]["titleIncludes"],
        "Home"
    );
}

#[test]
fn wait_options_maps_flat_fields_only_when_allowed() {
    let fill_options = wait_options(
        &json!({
            "text": "typed value",
            "selector": "#email",
            "url": "https://example.com/result"
        }),
        WaitConditionOptions {
            allow_flat_text: false,
            allow_flat_selector: false,
            allow_flat_url: false,
        },
    );
    let wait_options = wait_options(
        &json!({
            "text": "Ready",
            "selector": "#done",
            "url": "https://example.com/result"
        }),
        WaitConditionOptions {
            allow_flat_text: true,
            allow_flat_selector: true,
            allow_flat_url: true,
        },
    );

    assert_eq!(fill_options["condition"]["waitUntil"], "pageStable");
    assert!(fill_options["condition"].get("textVisible").is_none());
    assert!(fill_options["condition"].get("selectorAttached").is_none());
    assert_eq!(wait_options["condition"]["textVisible"], "Ready");
    assert_eq!(wait_options["condition"]["selectorAttached"], "#done");
    assert_eq!(
        wait_options["condition"]["urlIncludes"],
        "https://example.com/result"
    );
}
