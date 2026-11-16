// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! GitHub incremental reviews/comments plus full conflict/check/merge sweeps.
use super::{http::*, inputs::*};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(super) async fn fetch(http: &Http<'_>, resource: &Value, cursor: &Value) -> Result<Page> {
    let repository = required(resource, "path")?;
    let instance = required(resource, "instance_url")?.trim_end_matches('/');
    let base = if instance == "https://github.com" {
        "https://api.github.com".into()
    } else {
        format!("{instance}/api/v3")
    };
    let root = format!("{base}/repos/{repository}");
    let state = Cursor::new(cursor);
    let payload = http
        .get(&format!("{root}/pulls"), &list_params("open", state.page))
        .await?;
    let pulls = array(&payload, "GitHub pull request response is invalid")?;
    let cutoff = state.cutoff();
    let mut seen = BTreeSet::new();
    let mut inputs = Vec::new();
    let mut relevant_count = 0;
    for pull in pulls
        .iter()
        .filter(|v| v.is_object() && after(&v["updated_at"], cutoff))
    {
        relevant_count += 1;
        let number = pull["number"]
            .as_i64()
            .ok_or_else(|| PollError::new("GitHub pull request number is invalid"))?;
        seen.insert(number);
        inputs.extend(pull_inputs(http, &root, repository, number, cutoff).await?);
    }
    if state.page == 1 {
        inputs.extend(health_sweep(http, &root, repository, &seen).await?);
        inputs.extend(merged_sweep(http, &root, repository).await?);
    }
    let complete = pulls.len() < 50 || relevant_count < pulls.len();
    Ok(Page {
        inputs,
        cursor: state.next(complete),
        complete,
    })
}

fn list_params(state: &str, page: i64) -> Vec<(&'static str, String)> {
    vec![
        ("state", state.into()),
        ("sort", "updated".into()),
        ("direction", "desc".into()),
        ("per_page", "50".into()),
        ("page", page.to_string()),
    ]
}

async fn detail(http: &Http<'_>, root: &str, number: i64) -> Result<Value> {
    let value = http.get(&format!("{root}/pulls/{number}"), &[]).await?;
    if !value.is_object() {
        return Err(PollError::new("GitHub pull request detail is invalid"));
    }
    Ok(value)
}

async fn health(
    http: &Http<'_>,
    root: &str,
    repository: &str,
    number: i64,
    pull: &Value,
) -> Result<Vec<Input>> {
    let repo = github_repository(repository, pull);
    let mut inputs: Vec<_> = github_conflict(number, pull, &repo).into_iter().collect();
    let sha = text(&pull["head"]["sha"]);
    if !sha.is_empty() {
        let checks = http
            .list(
                &format!("{root}/commits/{sha}/check-runs"),
                &[("filter", "latest".into())],
                Some("check_runs"),
            )
            .await?;
        inputs.extend(github_checks(number, pull, &checks, &repo));
    }
    Ok(inputs)
}

async fn pull_inputs(
    http: &Http<'_>,
    root: &str,
    repository: &str,
    number: i64,
    cutoff: Option<DateTime<Utc>>,
) -> Result<Vec<Input>> {
    let pull = detail(http, root, number).await?;
    let repo = github_repository(repository, &pull);
    let mut inputs = health(http, root, repository, number, &pull).await?;
    for review in http
        .list(&format!("{root}/pulls/{number}/reviews"), &[], None)
        .await?
    {
        if after(&review["submitted_at"], cutoff) {
            inputs.push(Input::new(
                format!("pull_request_review:{}", number_value(&review)),
                format!("github: pull_request_review #{number}"),
                json!({"action":"submitted","review":review,"pull_request":pull,"repository":repo}),
                json!({"x-github-event":"pull_request_review"}),
                &review["submitted_at"],
            ));
        }
    }
    let params = cutoff
        .map(|v| vec![("since", utc_iso(v))])
        .unwrap_or_default();
    for (path, event) in [
        (format!("issues/{number}/comments"), "issue_comment"),
        (
            format!("pulls/{number}/comments"),
            "pull_request_review_comment",
        ),
    ] {
        for comment in http.list(&format!("{root}/{path}"), &params, None).await? {
            let mut payload = json!({"action":"created","comment":comment,"repository":repo});
            if event == "issue_comment" {
                let mut issue = pull.clone();
                issue["pull_request"] = json!({"url":pull["url"]});
                payload["issue"] = issue;
            } else {
                payload["pull_request"] = pull.clone();
            }
            inputs.push(Input::new(
                format!("{event}:{}", number_value(&comment)),
                format!("github: {event} #{number}"),
                payload,
                json!({"x-github-event":event}),
                &comment["created_at"],
            ));
        }
    }
    Ok(inputs)
}
fn number_value(value: &Value) -> String {
    number(&value["id"])
}

async fn health_sweep(
    http: &Http<'_>,
    root: &str,
    repository: &str,
    seen: &BTreeSet<i64>,
) -> Result<Vec<Input>> {
    let mut inputs = Vec::new();
    for page in 1..=50 {
        let payload = http
            .get(&format!("{root}/pulls"), &list_params("open", page))
            .await?;
        let pulls = array(&payload, "GitHub pull request response is invalid")?;
        for pull in pulls {
            let Some(number) = pull["number"].as_i64().filter(|n| !seen.contains(n)) else {
                continue;
            };
            // Sweep detail responses that are not objects are ignored by the source.
            let detail = http.get(&format!("{root}/pulls/{number}"), &[]).await?;
            if detail.is_object() {
                inputs.extend(health(http, root, repository, number, &detail).await?);
            }
        }
        if pulls.len() < 50 {
            break;
        }
    }
    Ok(inputs)
}

async fn merged_sweep(http: &Http<'_>, root: &str, repository: &str) -> Result<Vec<Input>> {
    let mut inputs = Vec::new();
    for page in 1..=3 {
        let payload = http
            .get(&format!("{root}/pulls"), &list_params("closed", page))
            .await?;
        let pulls = array(&payload, "GitHub pull request response is invalid")?;
        for pull in pulls.iter().filter(|v| v["merged"] == true) {
            if let Some(number) = pull["number"].as_i64() {
                inputs.push(github_merged(
                    number,
                    pull,
                    &github_repository(repository, pull),
                ));
            }
        }
        if pulls.len() < 50 {
            break;
        }
    }
    Ok(inputs)
}
