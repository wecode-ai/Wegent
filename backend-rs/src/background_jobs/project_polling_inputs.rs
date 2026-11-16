// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Provider events use the webhook envelopes consumed by project sources.
use super::http::{Input, number, object, text};
use serde_json::{Value, json};

pub(super) fn github_repository(repository: &str, pull: &Value) -> Value {
    let repo = &pull["base"]["repo"];
    json!({"id":repo["id"],"full_name":if text(&repo["full_name"]).is_empty(){repository}else{text(&repo["full_name"])},"html_url":text(&repo["html_url"])})
}
pub(super) fn github_conflict(number: i64, pull: &Value, repo: &Value) -> Option<Input> {
    if pull["mergeable"] != false
        && !matches!(
            text(&pull["mergeable_state"]).to_lowercase().as_str(),
            "dirty" | "conflicting"
        )
    {
        return None;
    }
    Some(Input::new(
        format!(
            "pull_request:{number}:conflict:{}",
            text(&pull["head"]["sha"])
        ),
        format!("github: pull_request #{number}"),
        json!({"action":"synchronize","pull_request":pull,"repository":repo}),
        json!({"x-github-event":"pull_request"}),
        &pull["updated_at"],
    ))
}
pub(super) fn github_checks(
    number: i64,
    pull: &Value,
    checks: &[Value],
    repo: &Value,
) -> Vec<Input> {
    let sha = text(&pull["head"]["sha"]);
    checks
        .iter()
        .filter_map(|check| {
            let conclusion = text(&check["conclusion"]).to_lowercase();
            if !text(&check["status"]).eq_ignore_ascii_case("completed")
                || !matches!(
                    conclusion.as_str(),
                    "failure" | "timed_out" | "cancelled" | "action_required"
                )
            {
                return None;
            }
            let mut body = object(check);
            body["pull_requests"] = json!([pull]);
            body["head_sha"] = json!(sha);
            Some(Input::new(
                format!("check_run:{}:{conclusion}:{sha}", number_value(check)),
                format!("github: check_run #{number}"),
                json!({"action":"completed","check_run":body,"repository":repo}),
                json!({"x-github-event":"check_run"}),
                &check["completed_at"],
            ))
        })
        .collect()
}
fn number_value(value: &Value) -> String {
    number(&value["id"])
}
pub(super) fn github_merged(number: i64, pull: &Value, repo: &Value) -> Input {
    let sha = if text(&pull["merge_commit_sha"]).is_empty() {
        text(&pull["head"]["sha"])
    } else {
        text(&pull["merge_commit_sha"])
    };
    let occurred = if text(&pull["merged_at"]).is_empty() {
        &pull["updated_at"]
    } else {
        &pull["merged_at"]
    };
    Input::new(
        format!("pull_request:{number}:merged:{sha}"),
        format!("github: pull_request #{number}"),
        json!({"action":"closed","pull_request":pull,"repository":repo}),
        json!({"x-github-event":"pull_request"}),
        occurred,
    )
}
pub(super) fn gitlab_project(path: &str, instance: &str, request: &Value) -> Value {
    json!({"id":request["project_id"],"path_with_namespace":path,"web_url":format!("{instance}/{path}")})
}
pub(super) fn gitlab_request(request: &Value) -> Value {
    let mut value = object(request);
    value["url"] = if request["web_url"].as_str().is_some_and(|s| !s.is_empty()) {
        request["web_url"].clone()
    } else {
        request["url"].clone()
    };
    value["last_commit"] = json!({"id":request["sha"]});
    value
}
pub(super) fn gitlab_conflict(request: &Value) -> bool {
    let state = if text(&request["detailed_merge_status"]).is_empty() {
        text(&request["merge_status"])
    } else {
        text(&request["detailed_merge_status"])
    };
    request["has_conflicts"] == true
        || matches!(
            state.to_lowercase().as_str(),
            "cannot_be_merged" | "conflict" | "conflicting"
        )
}
pub(super) fn gitlab_change(iid: i64, request: &Value, project: &Value, merged: bool) -> Input {
    let kind = if merged { "merged" } else { "conflict" };
    let occurred = if merged && !text(&request["merged_at"]).is_empty() {
        &request["merged_at"]
    } else {
        &request["updated_at"]
    };
    Input::new(
        format!("merge_request:{iid}:{kind}:{}", text(&request["sha"])),
        format!("gitlab: merge_request !{iid}"),
        json!({"object_kind":"merge_request","object_attributes":gitlab_request(request),"project":project}),
        json!({"x-gitlab-event":"Merge Request Hook"}),
        occurred,
    )
}
pub(super) fn gitlab_pipeline(
    iid: i64,
    pipeline: &Value,
    request: &Value,
    project: &Value,
) -> Input {
    let mut attributes = object(pipeline);
    if text(&attributes["sha"]).is_empty() {
        attributes["sha"] = request["sha"].clone();
    }
    if text(&attributes["ref"]).is_empty() {
        attributes["ref"] = request["source_branch"].clone();
    }
    let occurred = if text(&pipeline["updated_at"]).is_empty() {
        &pipeline["created_at"]
    } else {
        &pipeline["updated_at"]
    };
    Input::new(
        format!(
            "pipeline:{}:{}",
            number(&pipeline["id"]),
            number(&pipeline["status"])
        ),
        format!("gitlab: pipeline !{iid}"),
        json!({"object_kind":"pipeline","object_attributes":attributes,"merge_request":gitlab_request(request),"project":project}),
        json!({"x-gitlab-event":"Pipeline Hook"}),
        occurred,
    )
}
