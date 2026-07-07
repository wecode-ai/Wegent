// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

use super::util::{
    codex_wrapped_item_payload, is_codex_context_compaction_item_type, is_codex_tool_item_type,
    is_codex_tool_output_item_type, is_likely_codex_tool_item_type,
    is_likely_codex_tool_output_item_type, item_type,
};

pub(crate) struct CodexNotification<'a> {
    pub(crate) method: String,
    pub(crate) params: &'a Value,
}

pub(crate) fn codex_notification(message: &Value) -> CodexNotification<'_> {
    if let Some(method) = message.get("method").and_then(Value::as_str) {
        let params = message.get("params").unwrap_or(message);
        if matches!(method, "item/started" | "item/completed")
            && notification_item_type(params) == "subagentactivity"
        {
            return CodexNotification {
                method: "subagent/activity".to_owned(),
                params,
            };
        }
        if matches!(method, "item/started" | "item/completed")
            && notification_item_type(params) == "collabagenttoolcall"
        {
            return CodexNotification {
                method: "collab-agent/activity".to_owned(),
                params,
            };
        }
        if method == "turn/completed" && !is_root_codex_turn_event(params) {
            return CodexNotification {
                method: "subagent/activity".to_owned(),
                params,
            };
        }
        return CodexNotification {
            method: method.to_owned(),
            params,
        };
    }

    let wrapper_type = item_type(message);
    let params = codex_wrapped_item_payload(message).unwrap_or(message);
    let payload_type = item_type(params);
    let method = wrapped_item_method(&wrapper_type, &payload_type)
        .unwrap_or_default()
        .to_owned();
    CodexNotification { method, params }
}

pub(crate) fn debug_ignored_codex_notification(message: &Value, method: &str, params: &Value) {
    if !runtime_work_debug_enabled() {
        return;
    }

    let payload_type = message
        .get("payload")
        .map(item_type)
        .unwrap_or_else(|| "<none>".to_owned());
    eprintln!(
        "[runtime-work] ignored Codex notification method={} type={} payload_type={} params_type={}",
        if method.is_empty() { "<none>" } else { method },
        item_type(message),
        payload_type,
        item_type(params)
    );
}

fn wrapped_item_method(wrapper_type: &str, payload_type: &str) -> Option<&'static str> {
    match (wrapper_type, payload_type) {
        ("eventmsg", "execcommandoutputdelta") => Some("item/commandExecution/outputDelta"),
        ("eventmsg", "agentmessage") | ("responseitem", "message") => Some("item/completed"),
        ("eventmsg", "subagentactivity") | ("responseitem", "subagentactivity") => {
            Some("subagent/activity")
        }
        ("eventmsg" | "responseitem", payload_type)
            if is_codex_context_compaction_item_type(payload_type) =>
        {
            Some("context/compaction")
        }
        ("eventmsg", "collabagenttoolcall") | ("responseitem", "collabagenttoolcall") => {
            Some("collab-agent/activity")
        }
        ("responseitem", "reasoning") => Some("item/reasoningSummary/delta"),
        ("responseitem", payload_type) if is_codex_tool_item_type(payload_type) => {
            Some("item/started")
        }
        ("responseitem", payload_type) if is_codex_tool_output_item_type(payload_type) => {
            Some("item/completed")
        }
        ("eventmsg", payload_type) if is_codex_tool_output_item_type(payload_type) => {
            Some("item/completed")
        }
        ("responseitem" | "eventmsg", payload_type)
            if is_likely_codex_tool_output_item_type(payload_type) =>
        {
            Some("item/completed")
        }
        ("responseitem" | "eventmsg", payload_type)
            if is_likely_codex_tool_item_type(payload_type) =>
        {
            Some("item/started")
        }
        _ => None,
    }
}

fn is_root_codex_turn_event(params: &Value) -> bool {
    codex_agent_path(params)
        .or_else(|| params.get("turn").and_then(codex_agent_path))
        .map_or(true, |agent_path| agent_path == "/root")
}

fn codex_agent_path(value: &Value) -> Option<String> {
    super::util::string_field(value, "agent_path")
        .or_else(|| super::util::string_field(value, "agentPath"))
}

fn notification_item_type(params: &Value) -> String {
    params
        .get("item")
        .map(super::util::item_type)
        .unwrap_or_else(|| super::util::item_type(params))
}

fn runtime_work_debug_enabled() -> bool {
    std::env::var("WEGENT_RUNTIME_WORK_DEBUG")
        .ok()
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn maps_wrapped_response_items_to_stream_methods() {
        let message = json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "call_id": "call-1"
            }
        });
        let notification = codex_notification(&message);
        assert_eq!(notification.method, "item/started");
        assert_eq!(notification.params["type"], "function_call");

        let message = json!({
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call-1"
            }
        });
        let notification = codex_notification(&message);
        assert_eq!(notification.method, "item/completed");

        let message = json!({
            "type": "response_item",
            "payload": {
                "type": "reasoning",
                "summary": ["checking"]
            }
        });
        let notification = codex_notification(&message);
        assert_eq!(notification.method, "item/reasoningSummary/delta");

        let message = json!({
            "type": "event_msg",
            "payload": {
                "type": "agent_message",
                "phase": "commentary",
                "message": "checking"
            }
        });
        let notification = codex_notification(&message);
        assert_eq!(notification.method, "item/completed");

        let message = json!({
            "type": "event_msg",
            "payload": {
                "type": "exec_command_end",
                "call_id": "call-1",
                "cwd": "/tmp/project",
                "aggregated_output": "ok\n"
            }
        });
        let notification = codex_notification(&message);
        assert_eq!(notification.method, "item/completed");

        let message = json!({
            "type": "event_msg",
            "payload": {
                "type": "custom_command_begin",
                "call_id": "call-2"
            }
        });
        let notification = codex_notification(&message);
        assert_eq!(notification.method, "item/started");

        let message = json!({
            "type": "event_msg",
            "payload": {
                "type": "custom_command_end",
                "call_id": "call-2",
                "stdout": "ok\n"
            }
        });
        let notification = codex_notification(&message);
        assert_eq!(notification.method, "item/completed");
    }

    #[test]
    fn maps_codex_context_compacted_event_to_stream_method() {
        let message = json!({
            "type": "event_msg",
            "payload": {
                "id": "ctx-1",
                "type": "context_compacted"
            }
        });
        let notification = codex_notification(&message);
        assert_eq!(notification.method, "context/compaction");
        assert_eq!(notification.params["type"], "context_compacted");
    }

    #[test]
    fn maps_codex_subagent_activity_to_stream_method() {
        let message = json!({
            "type": "event_msg",
            "payload": {
                "type": "sub_agent_activity",
                "agent_path": "/root/worker",
                "kind": "started"
            }
        });
        let notification = codex_notification(&message);
        assert_eq!(notification.method, "subagent/activity");
        assert_eq!(notification.params["agent_path"], "/root/worker");
    }

    #[test]
    fn maps_child_turn_completion_to_subagent_activity() {
        let message = json!({
            "method": "turn/completed",
            "params": {
                "turn": {
                    "agent_path": "/root/worker"
                }
            }
        });
        let notification = codex_notification(&message);
        assert_eq!(notification.method, "subagent/activity");
    }

    #[test]
    fn maps_explicit_subagent_activity_item_to_stream_method() {
        let message = json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "subAgentActivity",
                    "agentPath": "/root/worker",
                    "agentThreadId": "thread-worker",
                    "kind": "interacted"
                }
            }
        });
        let notification = codex_notification(&message);
        assert_eq!(notification.method, "subagent/activity");
        assert_eq!(notification.params["item"]["agentPath"], "/root/worker");
    }

    #[test]
    fn maps_explicit_collab_agent_tool_call_to_stream_method() {
        let message = json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "type": "collabAgentToolCall",
                    "tool": "spawnAgent",
                    "receiverThreadIds": ["thread-worker"],
                    "agentsStates": {
                        "thread-worker": {
                            "status": "pendingInit",
                            "message": null
                        }
                    }
                }
            }
        });
        let notification = codex_notification(&message);
        assert_eq!(notification.method, "collab-agent/activity");
    }
}
