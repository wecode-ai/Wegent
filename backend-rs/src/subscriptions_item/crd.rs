// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Subscription CRD document normalization (`Subscription.model_dump(mode="json")`)
//! plus the Python `json.dumps` rendering the source stores in the `kinds.json`
//! column.
//!
//! The source validates the stored document into the pydantic CRD and re-dumps
//! it in model declaration order, so a persisted document's key order is the
//! CRD's, not the previously stored order.

use serde_json::{Map, Value, json};

pub(crate) use crate::subscriptions_list::convert::pydantic_datetime;

/// Build `Subscription.model_dump(mode="json")` in declaration order:
/// `apiVersion`, `kind`, `metadata`, `spec`, `status`.
pub(crate) fn build_crd_document(stored: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert(
        "apiVersion".to_string(),
        stored
            .get("apiVersion")
            .cloned()
            .unwrap_or_else(|| json!("agent.wecode.io/v1")),
    );
    out.insert(
        "kind".to_string(),
        stored
            .get("kind")
            .cloned()
            .unwrap_or_else(|| json!("Subscription")),
    );
    out.insert("metadata".to_string(), build_metadata(stored));
    out.insert(
        "spec".to_string(),
        build_spec(stored.get("spec").unwrap_or(&Value::Null)),
    );
    out.insert("status".to_string(), build_status(stored.get("status")));
    out
}

/// `SubscriptionMetadata` in declaration order with pydantic defaults.
fn build_metadata(stored: &Value) -> Value {
    let metadata = stored.get("metadata").and_then(Value::as_object);
    let field = |key: &str| metadata.and_then(|object| object.get(key)).cloned();
    let mut out = Map::new();
    out.insert(
        "name".to_string(),
        field("name").unwrap_or_else(|| json!("")),
    );
    out.insert(
        "namespace".to_string(),
        field("namespace").unwrap_or_else(|| json!("default")),
    );
    out.insert(
        "displayName".to_string(),
        field("displayName").unwrap_or(Value::Null),
    );
    out.insert("labels".to_string(), field("labels").unwrap_or(Value::Null));
    Value::Object(out)
}

/// `SubscriptionStatus` in declaration order with defaults; `None` when absent.
fn build_status(stored: Option<&Value>) -> Value {
    let Some(status) = stored.and_then(Value::as_object) else {
        return Value::Null;
    };
    let field = |key: &str| status.get(key).cloned();
    let mut out = Map::new();
    out.insert(
        "state".to_string(),
        field("state").unwrap_or_else(|| json!("Available")),
    );
    out.insert(
        "lastExecutionTime".to_string(),
        field("lastExecutionTime").unwrap_or(Value::Null),
    );
    out.insert(
        "lastExecutionStatus".to_string(),
        field("lastExecutionStatus").unwrap_or(Value::Null),
    );
    out.insert(
        "nextExecutionTime".to_string(),
        field("nextExecutionTime").unwrap_or(Value::Null),
    );
    out.insert(
        "webhookUrl".to_string(),
        field("webhookUrl").unwrap_or(Value::Null),
    );
    out.insert(
        "executionCount".to_string(),
        field("executionCount").unwrap_or_else(|| json!(0)),
    );
    out.insert(
        "successCount".to_string(),
        field("successCount").unwrap_or_else(|| json!(0)),
    );
    out.insert(
        "failureCount".to_string(),
        field("failureCount").unwrap_or_else(|| json!(0)),
    );
    Value::Object(out)
}

/// `SubscriptionSpec` in declaration order with pydantic defaults.
pub(crate) fn build_spec(stored: &Value) -> Value {
    let spec = stored.as_object();
    let field = |key: &str| spec.and_then(|object| object.get(key)).cloned();
    let mut out = Map::new();
    out.insert(
        "displayName".to_string(),
        field("displayName").unwrap_or_else(|| json!("")),
    );
    out.insert(
        "taskType".to_string(),
        field("taskType").unwrap_or_else(|| json!("collection")),
    );
    out.insert(
        "visibility".to_string(),
        field("visibility").unwrap_or_else(|| json!("private")),
    );
    out.insert(
        "trigger".to_string(),
        build_trigger(field("trigger").as_ref()),
    );
    out.insert(
        "teamRef".to_string(),
        build_named_ref(field("teamRef").as_ref()),
    );
    out.insert(
        "workspaceRef".to_string(),
        build_named_ref(field("workspaceRef").as_ref()),
    );
    out.insert(
        "modelRef".to_string(),
        build_named_ref(field("modelRef").as_ref()),
    );
    out.insert(
        "forceOverrideBotModel".to_string(),
        field("forceOverrideBotModel").unwrap_or_else(|| json!(false)),
    );
    out.insert(
        "promptTemplate".to_string(),
        field("promptTemplate").unwrap_or_else(|| json!("")),
    );
    out.insert(
        "retryCount".to_string(),
        field("retryCount").unwrap_or_else(|| json!(0)),
    );
    out.insert(
        "timeoutSeconds".to_string(),
        field("timeoutSeconds").unwrap_or_else(|| json!(600)),
    );
    out.insert(
        "enabled".to_string(),
        field("enabled").unwrap_or_else(|| json!(true)),
    );
    out.insert(
        "executionTarget".to_string(),
        build_execution_target(field("executionTarget").as_ref()),
    );
    out.insert(
        "description".to_string(),
        field("description").unwrap_or(Value::Null),
    );
    out.insert(
        "preserveHistory".to_string(),
        field("preserveHistory").unwrap_or_else(|| json!(false)),
    );
    out.insert(
        "historyMessageCount".to_string(),
        field("historyMessageCount").unwrap_or_else(|| json!(10)),
    );
    out.insert(
        "sourceSubscriptionRef".to_string(),
        build_source_subscription_ref(field("sourceSubscriptionRef").as_ref()),
    );
    out.insert(
        "knowledgeBaseRefs".to_string(),
        field("knowledgeBaseRefs").unwrap_or(Value::Null),
    );
    out.insert(
        "codeWikiRef".to_string(),
        build_code_wiki_ref(field("codeWikiRef").as_ref()),
    );
    out.insert(
        "notificationWebhooks".to_string(),
        field("notificationWebhooks").unwrap_or(Value::Null),
    );
    out.insert(
        "skillRefs".to_string(),
        field("skillRefs").unwrap_or(Value::Null),
    );
    Value::Object(out)
}

/// `SubscriptionTriggerConfig` in declaration order: type, cron, interval,
/// one_time, event. Only the sub-config matching the trigger type is populated.
fn build_trigger(stored: Option<&Value>) -> Value {
    let stored = stored.and_then(Value::as_object);
    let trigger_type = stored
        .and_then(|object| object.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("cron")
        .to_string();
    let sub = |key: &str| stored.and_then(|object| object.get(key)).cloned();
    let mut out = Map::new();
    out.insert("type".to_string(), json!(trigger_type));
    out.insert("cron".to_string(), build_cron(sub("cron").as_ref()));
    out.insert(
        "interval".to_string(),
        build_interval(sub("interval").as_ref()),
    );
    out.insert(
        "one_time".to_string(),
        build_one_time(sub("one_time").as_ref()),
    );
    out.insert("event".to_string(), build_event(sub("event").as_ref()));
    Value::Object(out)
}

fn build_cron(stored: Option<&Value>) -> Value {
    let Some(cron) = stored.and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert(
        "expression".to_string(),
        cron.get("expression").cloned().unwrap_or_else(|| json!("")),
    );
    out.insert(
        "timezone".to_string(),
        cron.get("timezone")
            .cloned()
            .unwrap_or_else(|| json!("UTC")),
    );
    Value::Object(out)
}

fn build_interval(stored: Option<&Value>) -> Value {
    let Some(interval) = stored.and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert(
        "value".to_string(),
        interval.get("value").cloned().unwrap_or_else(|| json!(0)),
    );
    out.insert(
        "unit".to_string(),
        interval.get("unit").cloned().unwrap_or_else(|| json!("")),
    );
    Value::Object(out)
}

fn build_one_time(stored: Option<&Value>) -> Value {
    let Some(one_time) = stored.and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert(
        "execute_at".to_string(),
        one_time.get("execute_at").cloned().unwrap_or(Value::Null),
    );
    Value::Object(out)
}

fn build_event(stored: Option<&Value>) -> Value {
    let Some(event) = stored.and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert(
        "event_type".to_string(),
        event.get("event_type").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "git_push".to_string(),
        build_git_push(event.get("git_push")),
    );
    out.insert(
        "inbox_message".to_string(),
        build_inbox_message(event.get("inbox_message")),
    );
    Value::Object(out)
}

fn build_git_push(stored: Option<&Value>) -> Value {
    let Some(git_push) = stored.and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert(
        "repository".to_string(),
        git_push
            .get("repository")
            .cloned()
            .unwrap_or_else(|| json!("")),
    );
    out.insert(
        "branch".to_string(),
        git_push.get("branch").cloned().unwrap_or(Value::Null),
    );
    Value::Object(out)
}

fn build_inbox_message(stored: Option<&Value>) -> Value {
    let Some(inbox) = stored.and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert(
        "queue_filter".to_string(),
        inbox.get("queue_filter").cloned().unwrap_or(Value::Null),
    );
    Value::Object(out)
}

/// `{name, namespace}` series references with the `namespace` default.
fn build_named_ref(stored: Option<&Value>) -> Value {
    let Some(reference) = stored.and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert(
        "name".to_string(),
        reference.get("name").cloned().unwrap_or_else(|| json!("")),
    );
    out.insert(
        "namespace".to_string(),
        reference
            .get("namespace")
            .cloned()
            .unwrap_or_else(|| json!("default")),
    );
    Value::Object(out)
}

fn build_execution_target(stored: Option<&Value>) -> Value {
    let Some(target) = stored.and_then(Value::as_object) else {
        return json!({"type": "managed", "device_id": null});
    };
    let mut out = Map::new();
    out.insert(
        "type".to_string(),
        target
            .get("type")
            .cloned()
            .unwrap_or_else(|| json!("managed")),
    );
    out.insert(
        "device_id".to_string(),
        target.get("device_id").cloned().unwrap_or(Value::Null),
    );
    Value::Object(out)
}

fn build_source_subscription_ref(stored: Option<&Value>) -> Value {
    let Some(reference) = stored.and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert(
        "id".to_string(),
        reference.get("id").cloned().unwrap_or_else(|| json!(0)),
    );
    out.insert(
        "name".to_string(),
        reference.get("name").cloned().unwrap_or_else(|| json!("")),
    );
    out.insert(
        "namespace".to_string(),
        reference
            .get("namespace")
            .cloned()
            .unwrap_or_else(|| json!("default")),
    );
    Value::Object(out)
}

/// `SubscriptionCodeWikiRef`: `{id, name, namespace, userId}`.
fn build_code_wiki_ref(stored: Option<&Value>) -> Value {
    let Some(reference) = stored.and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert(
        "id".to_string(),
        reference.get("id").cloned().unwrap_or_else(|| json!(0)),
    );
    out.insert(
        "name".to_string(),
        reference.get("name").cloned().unwrap_or_else(|| json!("")),
    );
    out.insert(
        "namespace".to_string(),
        reference
            .get("namespace")
            .cloned()
            .unwrap_or_else(|| json!("")),
    );
    out.insert(
        "userId".to_string(),
        reference.get("userId").cloned().unwrap_or_else(|| json!(0)),
    );
    Value::Object(out)
}

/// The Python `json.dumps` rendering SQLAlchemy stores in the `kinds.json`
/// column: `ensure_ascii=True` with `", "`/`": "` separators, preserving key
/// order.
pub(crate) fn python_json_dumps(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&number.to_string()),
        Value::String(text) => write_string(text, out),
        Value::Array(entries) => {
            out.push('[');
            for (index, entry) in entries.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                write_value(entry, out);
            }
            out.push(']');
        }
        Value::Object(object) => {
            out.push('{');
            for (index, (key, entry)) in object.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                write_string(key, out);
                out.push_str(": ");
                write_value(entry, out);
            }
            out.push('}');
        }
    }
}

fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            ascii if (ascii as u32) < 0x7f => out.push(ascii),
            other => {
                let code = other as u32;
                if code > 0xffff {
                    // UTF-16 surrogate pair, the form CPython's json emits.
                    let adjusted = code - 0x10000;
                    let high = 0xd800 + (adjusted >> 10);
                    let low = 0xdc00 + (adjusted & 0x3ff);
                    out.push_str(&format!("\\u{high:04x}\\u{low:04x}"));
                } else {
                    out.push_str(&format!("\\u{code:04x}"));
                }
            }
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_is_dumped_in_declaration_order() {
        let stored = json!({
            "spec": {
                "enabled": true,
                "teamRef": {"name": "t", "namespace": "default"},
                "trigger": {
                    "cron": {"timezone": "Asia/Shanghai", "expression": "15 20 * * 5"},
                    "type": "cron"
                },
                "displayName": "d"
            }
        });
        let spec = build_spec(stored.get("spec").unwrap());
        let keys: Vec<&str> = spec
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "displayName",
                "taskType",
                "visibility",
                "trigger",
                "teamRef",
                "workspaceRef",
                "modelRef",
                "forceOverrideBotModel",
                "promptTemplate",
                "retryCount",
                "timeoutSeconds",
                "enabled",
                "executionTarget",
                "description",
                "preserveHistory",
                "historyMessageCount",
                "sourceSubscriptionRef",
                "knowledgeBaseRefs",
                "codeWikiRef",
                "notificationWebhooks",
                "skillRefs",
            ]
        );
        let trigger = spec.get("trigger").unwrap();
        assert_eq!(
            trigger
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["type", "cron", "interval", "one_time", "event"]
        );
        assert_eq!(
            trigger.get("cron").unwrap().get("expression"),
            Some(&json!("15 20 * * 5"))
        );
    }

    #[test]
    fn python_json_dumps_escapes_non_ascii_and_uses_spaces() {
        let value = json!({"a": "平", "b": [1, 2], "c": null, "d": "line\nnext"});
        assert_eq!(
            python_json_dumps(&value),
            "{\"a\": \"\\u5e73\", \"b\": [1, 2], \"c\": null, \"d\": \"line\\nnext\"}"
        );
    }

    #[test]
    fn python_json_dumps_emits_surrogate_pairs() {
        assert_eq!(python_json_dumps(&json!("\u{1f600}")), "\"\\ud83d\\ude00\"");
    }
}
