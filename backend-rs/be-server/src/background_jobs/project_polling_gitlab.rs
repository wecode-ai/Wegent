// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! GitLab incremental notes/pipelines and complete conflict/merge sweeps.
use super::{http::*, inputs::*};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(super) async fn fetch(http: &Http<'_>, resource: &Value, cursor: &Value) -> Result<Page> {
    let path = required(resource, "path")?;
    let instance = required(resource, "instance_url")?.trim_end_matches('/');
    let project = crate::board_snapshot::external_provider::url_encode_path(path);
    let root = format!("{instance}/api/v4/projects/{project}");
    let state = Cursor::new(cursor);
    let cutoff = state.cutoff();
    let mut params = list_params("opened", state.page);
    if let Some(cutoff) = cutoff {
        params.push(("updated_after", utc_iso(cutoff)));
    }
    let payload = http.get(&format!("{root}/merge_requests"), &params).await?;
    let requests = array(&payload, "GitLab merge request response is invalid")?;
    let mut inputs = Vec::new();
    let mut seen = BTreeSet::new();
    for request in requests.iter().filter(|v| v.is_object()) {
        let iid = request["iid"]
            .as_i64()
            .ok_or_else(|| PollError::new("GitLab merge request iid is invalid"))?;
        seen.insert(iid);
        let detail = http
            .get(&format!("{root}/merge_requests/{iid}"), &[])
            .await?;
        if !detail.is_object() {
            return Err(PollError::new("GitLab merge request detail is invalid"));
        }
        let project = gitlab_project(path, instance, &detail);
        inputs.extend(health(http, &root, iid, &detail, &project, cutoff).await?);
        let notes = http
            .list(
                &format!("{root}/merge_requests/{iid}/notes"),
                &[("sort", "asc".into()), ("order_by", "updated_at".into())],
                None,
            )
            .await?;
        for note in notes
            .iter()
            .filter(|v| v["system"] != true && after(&v["created_at"], cutoff))
        {
            inputs.push(Input::new(format!("note:{}",number(&note["id"])),format!("gitlab: note !{iid}"),
                json!({"object_kind":"note","object_attributes":note,"merge_request":gitlab_request(&detail),"project":project}),
                json!({"x-gitlab-event":"Note Hook"}),&note["created_at"]));
        }
    }
    if state.page == 1 {
        inputs.extend(sweep(http, &root, path, instance, &seen, cutoff).await?);
        inputs.extend(merged(http, &root, path, instance).await?);
    }
    let complete = requests.len() < 50;
    Ok(Page {
        inputs,
        cursor: state.next(complete),
        complete,
    })
}

fn list_params(state: &str, page: i64) -> Vec<(&'static str, String)> {
    vec![
        ("state", state.into()),
        ("order_by", "updated_at".into()),
        ("sort", "desc".into()),
        ("per_page", "50".into()),
        ("page", page.to_string()),
    ]
}

async fn health(
    http: &Http<'_>,
    root: &str,
    iid: i64,
    request: &Value,
    project: &Value,
    cutoff: Option<DateTime<Utc>>,
) -> Result<Vec<Input>> {
    let mut inputs = Vec::new();
    if gitlab_conflict(request) {
        inputs.push(gitlab_change(iid, request, project, false));
    }
    for pipeline in http
        .list(&format!("{root}/merge_requests/{iid}/pipelines"), &[], None)
        .await?
    {
        let occurred = if text(&pipeline["updated_at"]).is_empty() {
            &pipeline["created_at"]
        } else {
            &pipeline["updated_at"]
        };
        if after(occurred, cutoff)
            && matches!(
                text(&pipeline["status"]).to_lowercase().as_str(),
                "failed" | "canceled"
            )
        {
            inputs.push(gitlab_pipeline(iid, &pipeline, request, project));
        }
    }
    Ok(inputs)
}

async fn sweep(
    http: &Http<'_>,
    root: &str,
    path: &str,
    instance: &str,
    seen: &BTreeSet<i64>,
    cutoff: Option<DateTime<Utc>>,
) -> Result<Vec<Input>> {
    let mut inputs = Vec::new();
    for page in 1..=50 {
        let payload = http
            .get(
                &format!("{root}/merge_requests"),
                &list_params("opened", page),
            )
            .await?;
        let requests = array(&payload, "GitLab merge request response is invalid")?;
        for request in requests {
            let Some(iid) = request["iid"].as_i64().filter(|iid| !seen.contains(iid)) else {
                continue;
            };
            inputs.extend(
                health(
                    http,
                    root,
                    iid,
                    request,
                    &gitlab_project(path, instance, request),
                    cutoff,
                )
                .await?,
            );
        }
        if requests.len() < 50 {
            break;
        }
    }
    Ok(inputs)
}

async fn merged(http: &Http<'_>, root: &str, path: &str, instance: &str) -> Result<Vec<Input>> {
    let mut params = list_params("merged", 1);
    params.retain(|(key, _)| *key != "page");
    let payload = http.get(&format!("{root}/merge_requests"), &params).await?;
    let requests = array(&payload, "GitLab merge request response is invalid")?;
    Ok(requests
        .iter()
        .filter(|v| text(&v["state"]).eq_ignore_ascii_case("merged"))
        .filter_map(|request| {
            Some(gitlab_change(
                request["iid"].as_i64()?,
                request,
                &gitlab_project(path, instance, request),
                true,
            ))
        })
        .collect())
}
