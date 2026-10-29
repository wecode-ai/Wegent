// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Vendor webhook normalization shared by polling and incoming-event workers.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Event {
    pub event_type: String,
    pub source_type: String,
    pub resource: Value,
    pub subject: Value,
    pub payload: Value,
}

pub(super) fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("").trim()
}

fn path(value: &Value) -> String {
    text(value)
        .trim_matches('/')
        .strip_suffix(".git")
        .unwrap_or_else(|| text(value).trim_matches('/'))
        .into()
}

fn instance(value: &Value) -> String {
    url::Url::parse(text(value))
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .map(|u| u.origin().ascii_serialization().to_lowercase())
        .unwrap_or_default()
}

fn local(value: &str) -> bool {
    url::Url::parse(value)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .is_some_and(|host| {
            matches!(
                host.as_str(),
                "localhost" | "127.0.0.1" | "0.0.0.0" | "::1" | "[::1]"
            ) || host.ends_with(".localhost")
        })
}

pub(super) fn resource_matches(configured: &Value, observed: &Value) -> bool {
    if text(&configured["resource_type"]) != text(&observed["resource_type"]) {
        return false;
    }
    let (a, b) = (
        instance(&configured["instance_url"]),
        instance(&observed["instance_url"]),
    );
    if !a.is_empty() && !b.is_empty() && a != b {
        return local(&a) && local(&b) && path(&configured["path"]) == path(&observed["path"]);
    }
    let (a, b) = (path(&configured["path"]), path(&observed["path"]));
    if !a.is_empty() && a == b {
        return true;
    }
    let (a, b) = (
        text(&configured["external_id"]),
        text(&observed["external_id"]),
    );
    !a.is_empty() && !b.is_empty() && a.eq_ignore_ascii_case(b)
}

impl Event {
    pub(super) fn identity(&self) -> String {
        let mut object = String::new();
        let mut version = String::new();
        for key in ["check", "review", "comment", "pipeline", "note"] {
            let value = &self.payload[key];
            if !value["id"].is_null() {
                object = format!("{key}:{}", identity(&value["id"]));
                version = ["conclusion", "status", "updated_at", "submitted_at"]
                    .iter()
                    .map(|key| text(&value[key]))
                    .find(|v| !v.is_empty())
                    .unwrap_or("")
                    .into();
                break;
            }
        }
        if object.is_empty() {
            object = format!("subject:{}", identity(&self.subject["id"]));
            version = [
                &self.payload["mergeable_state"],
                &self.payload["merge_status"],
                &self.subject["head_commit"],
            ]
            .into_iter()
            .map(text)
            .find(|v| !v.is_empty())
            .unwrap_or("")
            .into();
        }
        crate::hex_sha256(
            format!(
                "{}|{}|{}|{object}|{version}",
                self.source_type,
                self.event_type,
                text(&self.payload["raw_event"])
            )
            .as_bytes(),
        )[..36]
            .into()
    }
}

pub(super) fn identity(value: &Value) -> String {
    if value.is_null() {
        return String::new();
    }
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

pub(super) fn normalize(source: &str, payload: &Value, headers: &Value) -> Vec<Event> {
    match source {
        "github" => github(payload, headers),
        "gitlab" => gitlab(payload, headers),
        "generic" => generic(payload),
        _ => Vec::new(),
    }
}

fn resource(source: &str, value: &Value) -> Option<Value> {
    let (resource_type, raw_path, raw_url, fallback) = match source {
        "github" => (
            "repository",
            text(&value["full_name"]).to_string(),
            text(&value["html_url"]),
            "https://github.com",
        ),
        "gitlab" => (
            "project",
            text(&value["path_with_namespace"]).to_string(),
            text(&value["web_url"]),
            "https://gitlab.com",
        ),
        _ => return None,
    };
    let raw_path = if raw_path.is_empty() && source == "github" {
        text(&value["repo"]["full_name"]).into()
    } else {
        raw_path
    };
    if raw_path.is_empty() {
        return None;
    }
    let mut host = instance(&json!(raw_url));
    if host.is_empty() && source == "github" {
        host = instance(&value["repo"]["html_url"]);
    }
    if host.is_empty() {
        host = fallback.into();
    }
    // The Python provider intentionally accepts only string external IDs.
    let id = if text(&value["id"]).is_empty() {
        if source == "github" {
            raw_path.to_lowercase()
        } else {
            raw_path.clone()
        }
    } else {
        text(&value["id"]).into()
    };
    Some(
        json!({"resource_type":resource_type, "instance_url":host, "external_id":id,
        "path":raw_path, "url":if raw_url.is_empty() {format!("{host}/{raw_path}")} else {raw_url.into()}, "display_name":raw_path}),
    )
}

fn optional(value: &Value) -> Value {
    if text(value).is_empty() {
        Value::Null
    } else {
        json!(text(value))
    }
}

fn first(a: &Value, b: &Value) -> Value {
    if text(a).is_empty() {
        optional(b)
    } else {
        optional(a)
    }
}

fn subject(source: &str, resource: &Value, value: &Value) -> Option<Value> {
    let key = if source == "github" { "number" } else { "iid" };
    let number = value[key]
        .as_i64()
        .or_else(|| text(&value[key]).parse().ok())?;
    let mut subject = json!({"type":"change_request", "id":format!("{}#{number}", text(&resource["external_id"])),
        "provider":source,"instance_url":resource["instance_url"],"repository":resource["path"], "number":number});
    if source == "github" {
        subject["url"] = optional(&value["html_url"]);
        subject["head_branch"] = first(&value["head"]["ref"], &value["head_ref"]);
        subject["base_branch"] = first(&value["base"]["ref"], &value["base_ref"]);
        subject["head_commit"] = first(&value["head"]["sha"], &value["head_sha"]);
    } else {
        subject["url"] = optional(&value["url"]);
        subject["head_branch"] = optional(&value["source_branch"]);
        subject["base_branch"] = optional(&value["target_branch"]);
        subject["head_commit"] = first(&value["last_commit"]["id"], &value["last_commit_sha"]);
    }
    Some(subject)
}

fn event(
    kind: &str,
    source: &str,
    resource: &Value,
    subject: Option<Value>,
    payload: Value,
) -> Vec<Event> {
    subject
        .map(|subject| {
            vec![Event {
                event_type: kind.into(),
                source_type: source.into(),
                resource: resource.clone(),
                subject,
                payload,
            }]
        })
        .unwrap_or_default()
}

fn author(source: &str, user: &Value) -> Value {
    let key = if source == "github" {
        "login"
    } else {
        "username"
    };
    if text(&user[key]).is_empty() {
        return Value::Null;
    }
    let mut value = json!({"id":user["id"], key:text(&user[key])});
    if source == "gitlab" {
        value["name"] = optional(&user["name"]);
    }
    value
}

fn github(payload: &Value, headers: &Value) -> Vec<Event> {
    let name = text(&headers["x-github-event"]).to_lowercase();
    let Some(resource) = resource("github", &payload["repository"]) else {
        return vec![];
    };
    let action = text(&payload["action"]);
    match name.as_str() {
        "check_run" | "check_suite" | "workflow_run" => {
            let check = &payload[&name];
            let status = text(&check["status"]).to_lowercase();
            let conclusion = text(&check["conclusion"]).to_lowercase();
            if (!status.is_empty() && status != "completed")
                || !["failure", "timed_out", "cancelled", "action_required"]
                    .contains(&conclusion.as_str())
            {
                return vec![];
            }
            let mut subjects: Vec<Value> = check["pull_requests"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|value| subject("github", &resource, value))
                .collect();
            if subjects.is_empty() {
                let id = if text(&check["head_sha"]).is_empty() {
                    text(&check["id"])
                } else {
                    text(&check["head_sha"])
                };
                if !id.is_empty() {
                    subjects.push(json!({"type":"change_request","id":id,"provider":"github","instance_url":resource["instance_url"],"repository":resource["path"],"head_commit":optional(&check["head_sha"]),"head_branch":optional(&check["head_branch"])}));
                }
            }
            subjects.into_iter().flat_map(|subject| event("change_request.checks_failed", "github", &resource, Some(subject), json!({"raw_event":name,"action":action,"conclusion":conclusion,"check":check}))).collect()
        }
        "pull_request" => {
            let pr = &payload["pull_request"];
            let subject = subject("github", &resource, pr);
            if action.eq_ignore_ascii_case("closed") && pr["merged"] == true {
                return event(
                    "change_request.merged",
                    "github",
                    &resource,
                    subject,
                    json!({"raw_event":name,"action":"closed","merged_at":pr["merged_at"]}),
                );
            }
            let state = text(&pr["mergeable_state"]).to_lowercase();
            if pr["mergeable"] != false && !["dirty", "conflicting"].contains(&state.as_str()) {
                return vec![];
            }
            event(
                "change_request.merge_conflict",
                "github",
                &resource,
                subject,
                json!({"raw_event":name,"action":action,"mergeable_state":state}),
            )
        }
        "pull_request_review" if action.eq_ignore_ascii_case("submitted") => {
            let review = &payload["review"];
            event(
                "change_request.review_submitted",
                "github",
                &resource,
                subject("github", &resource, &payload["pull_request"]),
                json!({"raw_event":name,"review":review,"author":author("github", &review["user"])}),
            )
        }
        "pull_request_review_comment" | "issue_comment"
            if action.eq_ignore_ascii_case("created") =>
        {
            let value = if name == "issue_comment" {
                if !payload["issue"]["pull_request"].is_object() {
                    return vec![];
                }
                &payload["issue"]
            } else {
                &payload["pull_request"]
            };
            let comment = &payload["comment"];
            event(
                "change_request.comment_created",
                "github",
                &resource,
                subject("github", &resource, value),
                json!({"raw_event":name,"comment":comment,"author":author("github", &comment["user"])}),
            )
        }
        _ => vec![],
    }
}

fn gitlab(payload: &Value, headers: &Value) -> Vec<Event> {
    let name = if text(&headers["x-gitlab-event"]).is_empty() {
        text(&payload["object_kind"])
    } else {
        text(&headers["x-gitlab-event"])
    }
    .to_lowercase();
    let Some(resource) = resource("gitlab", &payload["project"]) else {
        return vec![];
    };
    let attributes = &payload["object_attributes"];
    match name.as_str() {
        "pipeline hook" | "pipeline" => {
            if !["failed", "canceled"]
                .contains(&text(&attributes["status"]).to_lowercase().as_str())
            {
                return vec![];
            }
            let subject = subject("gitlab", &resource, &payload["merge_request"]).or_else(|| {
                let id = if text(&attributes["sha"]).is_empty() {text(&attributes["id"])} else {text(&attributes["sha"])};
                Some(json!({"type":"change_request","id":id,"provider":"gitlab","instance_url":resource["instance_url"],"repository":resource["path"],"head_commit":optional(&attributes["sha"]),"head_branch":optional(&attributes["ref"])}))
            });
            event(
                "change_request.checks_failed",
                "gitlab",
                &resource,
                subject,
                json!({"raw_event":name,"pipeline":attributes}),
            )
        }
        "merge request hook" | "merge_request" => {
            let subject = subject("gitlab", &resource, attributes);
            if text(&attributes["state"]).eq_ignore_ascii_case("merged") {
                return event(
                    "change_request.merged",
                    "gitlab",
                    &resource,
                    subject,
                    json!({"raw_event":name,"action":"merge","merged_at":attributes["merged_at"]}),
                );
            }
            let status = if text(&attributes["detailed_merge_status"]).is_empty() {
                text(&attributes["merge_status"])
            } else {
                text(&attributes["detailed_merge_status"])
            }
            .to_lowercase();
            if !["cannot_be_merged", "conflict", "conflicting"].contains(&status.as_str()) {
                return vec![];
            }
            event(
                "change_request.merge_conflict",
                "gitlab",
                &resource,
                subject,
                json!({"raw_event":name,"merge_status":status}),
            )
        }
        "note hook" | "note" => {
            if !payload["merge_request"].is_object()
                || payload["merge_request"]
                    .as_object()
                    .is_some_and(|v| v.is_empty())
                || attributes["system"] == true
            {
                return vec![];
            }
            let action = if text(&attributes["action"]).is_empty() {
                text(&payload["action"])
            } else {
                text(&attributes["action"])
            };
            if !action.is_empty() && !action.eq_ignore_ascii_case("create") {
                return vec![];
            }
            let user = if payload["user"].is_object() {
                &payload["user"]
            } else {
                &attributes["author"]
            };
            event(
                "change_request.comment_created",
                "gitlab",
                &resource,
                subject("gitlab", &resource, &payload["merge_request"]),
                json!({"raw_event":name,"note":attributes,"author":author("gitlab", user)}),
            )
        }
        _ => vec![],
    }
}

fn generic(payload: &Value) -> Vec<Event> {
    let kind = if text(&payload["event_type"]).is_empty() {
        text(&payload["eventType"])
    } else {
        text(&payload["event_type"])
    };
    if kind != "document.changed" {
        return vec![];
    }
    let resource = &payload["resource"];
    let mut raw_path = path(&resource["path"]);
    let raw_url = text(&resource["url"]);
    if raw_path.is_empty()
        && !raw_url.is_empty()
        && let Ok(url) = url::Url::parse(raw_url)
    {
        raw_path = path(&json!(url.path()));
    }
    let mut host = instance(&resource["instance_url"]);
    if !text(&resource["instance_url"]).is_empty() && host.is_empty() {
        return vec![];
    }
    if host.is_empty() {
        host = instance(&resource["url"])
    }
    let id = [text(&resource["external_id"]), &raw_path, raw_url]
        .into_iter()
        .find(|v| !v.is_empty())
        .unwrap_or("");
    if id.is_empty()
        || (!raw_url.is_empty() && instance(&resource["url"]).is_empty())
        || (!text(&resource["instance_url"]).is_empty() && host.is_empty())
    {
        return vec![];
    }
    let resource_type = text(&resource["resource_type"]);
    if !resource_type.is_empty() && resource_type != "endpoint" {
        return vec![];
    }
    let resource = json!({"resource_type":"endpoint","instance_url":host,"external_id":id,"path":raw_path,"url":if !raw_url.is_empty(){json!(raw_url)}else if !host.is_empty()&&!raw_path.is_empty(){json!(format!("{host}/{raw_path}"))}else{Value::Null},"display_name":if text(&resource["display_name"]).is_empty() {if raw_path.is_empty(){id}else{&raw_path}} else {text(&resource["display_name"])}});
    let mut subject = payload["subject"].as_object().cloned().unwrap_or_default();
    let subject_id = if text(&payload["subject"]["id"]).is_empty() {
        text(&payload["version"])
    } else {
        text(&payload["subject"]["id"])
    };
    if subject_id.is_empty() {
        return vec![];
    }
    subject.insert("id".into(), json!(subject_id));
    if text(&payload["subject"]["type"]).is_empty() {
        subject.insert("type".into(), json!("document"));
    }
    event(
        kind,
        "generic",
        &resource,
        Some(Value::Object(subject)),
        payload.clone(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_failed_checks_share_webhook_and_poll_identity() {
        let payload = json!({"action":"completed","repository":{"id":42,"full_name":"acme/app","html_url":"https://github.com/acme/app"},"check_run":{"id":9,"status":"completed","conclusion":"failure","head_sha":"abc","pull_requests":[{"number":7,"head":{"ref":"fix","sha":"abc"},"base":{"ref":"main"}}]}});
        let events = normalize("github", &payload, &json!({"x-github-event":"check_run"}));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "change_request.checks_failed");
        assert_eq!(events[0].subject["id"], "acme/app#7");
        assert_eq!(
            events[0].identity(),
            normalize("github", &payload, &json!({"x-github-event":"check_run"}))[0].identity()
        );
    }

    #[test]
    fn repository_paths_match_numeric_vendor_id_and_local_ports() {
        let configured = json!({"resource_type":"repository","instance_url":"https://github.com","path":"acme/app.git","external_id":"42"});
        let observed = json!({"resource_type":"repository","instance_url":"https://github.com","path":"acme/app","external_id":"acme/app"});
        assert!(resource_matches(&configured, &observed));
        let mut wrong = observed.clone();
        wrong["instance_url"] = json!("https://another.example");
        assert!(!resource_matches(&configured, &wrong));
        let mut a = configured;
        a["instance_url"] = json!("http://127.0.0.1:1234");
        wrong["instance_url"] = json!("http://127.0.0.1:9876");
        assert!(resource_matches(&a, &wrong));
    }

    #[test]
    fn gitlab_user_notes_create_events_but_system_notes_and_updates_do_not() {
        let mut payload = json!({"object_kind":"note","project":{"path_with_namespace":"acme/app","web_url":"https://gitlab.com/acme/app"},"merge_request":{"iid":8,"source_branch":"fix","target_branch":"main"},"object_attributes":{"id":5,"action":"create","system":false,"note":"Please fix"},"user":{"username":"reviewer"}});
        let events = normalize("gitlab", &payload, &json!({}));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["author"]["username"], "reviewer");
        payload["object_attributes"]["system"] = json!(true);
        assert!(normalize("gitlab", &payload, &json!({})).is_empty());
        payload["object_attributes"]["system"] = json!(false);
        payload["object_attributes"]["action"] = json!("update");
        assert!(normalize("gitlab", &payload, &json!({})).is_empty());
    }
    #[test]
    fn generic_observation_uses_url_path_and_rejects_invalid_declared_instances() {
        let mut payload = json!({"event_type":"document.changed","resource":{"url":"https://docs.example/a/b"},"subject":{"id":"v1"}});
        let events = normalize("generic", &payload, &json!({}));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].resource["path"], "a/b");
        assert_eq!(events[0].resource["external_id"], "a/b");
        assert_eq!(events[0].resource["display_name"], "a/b");
        payload["resource"]["instance_url"] = json!("not-http");
        assert!(normalize("generic", &payload, &json!({})).is_empty());
        assert_eq!(identity(&Value::Null), "");
    }
}
