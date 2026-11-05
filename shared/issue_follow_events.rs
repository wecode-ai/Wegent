// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Provider event identities shared by the cloud and device collectors.
//! HTTP, authorization and durable delivery belong to the owning runtime.

use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PAGE_SIZE: usize = 100;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Event {
    pub identity: String,
    pub kind: String,
    pub occurred_at: Option<i64>,
    pub comment_id: Option<String>,
    pub body: String,
}

pub fn streams(provider: &str) -> &'static [&'static str] {
    match provider {
        "github" => &["timeline"],
        "gitlab" => &[
            "discussions",
            "resource_state_events",
            "resource_label_events",
        ],
        "dingtalk_aitable" => &["history", "comments"],
        _ => &[],
    }
}

pub fn path(provider: &str, repository: &str, number: i64, stream: &str, page: u64) -> String {
    let root = if provider == "github" {
        format!("/repos/{repository}/issues/{number}")
    } else {
        let repository: String =
            url::form_urlencoded::byte_serialize(repository.as_bytes()).collect();
        format!("/projects/{repository}/issues/{number}")
    };
    format!("{root}/{stream}?per_page={PAGE_SIZE}&page={page}")
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn label_kind(label: &str) -> Option<&'static str> {
    if label.starts_with("wegent:status:") {
        Some("status")
    } else if label.starts_with("wegent:assignee:") {
        Some("assignee")
    } else {
        None
    }
}

fn event(provider: &str, stream: &str, value: &Value, kind: &str) -> Result<Event, String> {
    let id = value["id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or("Provider event has no stable identity")?;
    let occurred_at = DateTime::parse_from_rfc3339(text(&value["created_at"]))
        .map_err(|_| "Provider event has no valid creation time")?
        .timestamp_millis();
    Ok(Event {
        identity: format!("{provider}:{stream}:{id}"),
        kind: kind.into(),
        occurred_at: Some(occurred_at),
        comment_id: (kind == "comment").then(|| id.to_string()),
        body: if kind == "comment" {
            text(&value["body"]).chars().take(200).collect()
        } else {
            String::new()
        },
    })
}

pub fn decode(provider: &str, stream: &str, page: &Value) -> Result<Vec<Event>, String> {
    let rows = page.as_array().ok_or("Provider events are not an array")?;
    let mut events = Vec::new();
    for row in rows {
        if provider == "gitlab" && stream == "discussions" {
            for note in row["notes"].as_array().ok_or("Discussion has no notes")? {
                if note["system"] == false {
                    events.push(event(provider, "comment", note, "comment")?);
                }
            }
            continue;
        }
        let kind = match (provider, stream) {
            ("github", "timeline") => match text(&row["event"]) {
                "commented" => Some("comment"),
                "closed" | "reopened" => Some("status"),
                "labeled" | "unlabeled" => label_kind(text(&row["label"]["name"])),
                _ => None,
            },
            ("gitlab", "resource_state_events") => Some("status"),
            ("gitlab", "resource_label_events") => label_kind(text(&row["label"]["name"])),
            _ => return Err("Unsupported provider event stream".into()),
        };
        if let Some(kind) = kind {
            events.push(event(provider, stream, row, kind)?);
        }
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn captures_intermediate_status_assignment_and_comments() {
        let at = "2026-10-30T08:00:00Z";
        let events = decode("github", "timeline", &json!([
            {"id":1,"event":"labeled","label":{"name":"wegent:status:in_progress"},"created_at":at},
            {"id":2,"event":"labeled","label":{"name":"wegent:assignee:group:qa"},"created_at":at},
            {"id":3,"event":"commented","body":"hello","created_at":at},
            {"id":4,"event":"reopened","created_at":at},
            {"id":5,"event":"renamed","created_at":at}
        ])).unwrap();
        assert_eq!(
            events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
            ["status", "assignee", "comment", "status"]
        );
        assert_eq!(events[2].comment_id.as_deref(), Some("3"));
        assert_ne!(events[0].identity, events[3].identity);
    }

    #[test]
    fn includes_threaded_replies_and_rejects_unidentifiable_events() {
        let events = decode(
            "gitlab",
            "discussions",
            &json!([{"notes":[
                {"id":9,"system":false,"body":"reply","created_at":"2026-10-30T08:00:00Z"},
                {"id":10,"system":true,"body":"system"}
            ]}]),
        )
        .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].identity, "gitlab:comment:9");
        assert!(decode("github", "timeline", &json!([{"event":"closed"}])).is_err());
        assert!(decode("github", "timeline", &json!({})).is_err());
    }
}
