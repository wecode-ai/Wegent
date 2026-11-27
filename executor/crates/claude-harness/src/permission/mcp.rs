//! Run-scoped native PreToolUse policy. A hook never grants permission: reads
//! retain the CLI's configured decision, while writes require its approval UI.
use serde_json::{json, Value};

pub(super) const CALLBACK: &str = "wegent_external_mcp";
pub(super) const INIT: &str = "wegent_permission_hooks";

pub(super) fn initialize(input: &str) -> (Value, &str) {
    let (first, remaining) = input.split_once('\n').unwrap_or((input, ""));
    let (mut init, prompt) = match serde_json::from_str::<Value>(first) {
        Ok(frame)
            if frame["type"] == "control_request"
                && frame["request"]["subtype"] == "initialize" =>
        {
            (frame, remaining)
        }
        _ => (
            json!({"type":"control_request","request":{"subtype":"initialize"}}),
            input,
        ),
    };
    init["request_id"] = json!(INIT);
    let entries = &mut init["request"]["hooks"]["PreToolUse"];
    if entries.is_null() {
        *entries = json!([]);
    }
    // Preserve other SDK registrations. An invalid list is left invalid so the
    // CLI rejects initialization before the host transmits the user message.
    if let Some(entries) = entries.as_array_mut() {
        entries.push(json!({"matcher":"^mcp__", "hookCallbackIds":[CALLBACK]}));
    }
    (init, prompt)
}

pub(super) fn ask() -> Value {
    json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask",
        "permissionDecisionReason":"This action requires the owner's approval."}})
}

pub(super) fn read_only(catalog: &Value, server: &str, tool: &str) -> bool {
    let mut matches = catalog["mcpServers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["name"] == server && entry["status"] == "connected")
        .flat_map(|entry| entry["tools"].as_array().into_iter().flatten())
        .filter(|entry| entry["name"] == tool);
    matches.next().is_some_and(|entry| {
        entry["annotations"]["readOnly"] == true && entry["annotations"]["destructive"] != true
    }) && matches.next().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_roles_and_only_recognizes_unambiguous_live_reads() {
        let frame = json!({"type":"control_request","request":{"subtype":"initialize",
            "agents":{"helper":{}},"hooks":{"PreToolUse":[{"matcher":"Edit","hookCallbackIds":["other"]}]}}});
        let input = format!("{frame}\nuser");
        let (init, prompt) = initialize(&input);
        assert_eq!(init["request"]["hooks"]["PreToolUse"][0]["matcher"], "Edit");
        assert_eq!(
            init["request"]["hooks"]["PreToolUse"][1]["matcher"],
            "^mcp__"
        );
        assert!(init["request"]["agents"]["helper"].is_object());
        assert_eq!(prompt, "user");
        let server = json!({"name":"docs","status":"connected","tools":[{"name":"read","annotations":{"readOnly":true}},{"name":"write","annotations":{"readOnly":true,"destructive":true}}]});
        let catalog = json!({"mcpServers":[server]});
        assert!(read_only(&catalog, "docs", "read"));
        assert!(!read_only(&catalog, "docs", "write"));
        assert!(!read_only(&catalog, "docs", "missing"));
        assert!(!read_only(
            &json!({"mcpServers":[server,server]}),
            "docs",
            "read"
        ));
    }
}
