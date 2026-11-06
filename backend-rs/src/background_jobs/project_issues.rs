// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Provider-aware Issue carriers created by scheduled and external events.

use super::{
    authority,
    store::{self, Node, iso},
};
use crate::{
    board_snapshot::external_provider::{
        ProviderCredential, decrypt_provider_token, url_encode_path,
    },
    state::AppState,
};
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use chrono::Utc;
use serde_json::{Value, json};

pub(super) struct Issue {
    pub id: String,
    pub title: String,
}

pub(super) async fn create(
    state: &AppState,
    project: &Node,
    owner: i64,
    title: &str,
    description: &str,
    tags: &[&str],
    context: &Value,
) -> Result<Issue> {
    authority::require(state, &project.id, owner).await?;
    let title: String = title.chars().take(255).collect();
    if matches!(
        project.metadata.0["task_provider"].as_str(),
        Some("github" | "gitlab")
    ) {
        return create_external(state, project, owner, &title, description, tags).await;
    }
    let metadata = initial_metadata(project, owner, &title, description, tags, context);
    let issue=state.mysql.with_transaction(async |tx| {
        let project=store::locked(tx,"project",&project.id).await?.expect("authorized project");
        let sequence=project.next_item_number;
        let id=format!("{}-{sequence}",project.project_key);
        let status=project.metadata.0["board_config"]["statuses"].as_array().map(|statuses|statuses.first().and_then(|v|v["id"].as_str()).unwrap_or("")).unwrap_or("inbox");
        let mut metadata=metadata.clone();
        if !status.is_empty(){metadata["status_history"]=json!([{"from_status":"","to_status":status,"from_status_name":"","to_status_name":status_name(&project,status),"trigger":"create","by_user_id":owner,"at":iso(Utc::now().naive_utc())}]);}
        store::insert(tx,"task",json!({"id":id,"cloud_project_id":project.id,"sequence_number":sequence,"created_by_user_id":owner,"title":title,"description":description,"priority":"medium","status":status,"metadata":metadata})).await?;
        tx.execute("UPDATE loop_items SET next_item_number=next_item_number+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(project.id.as_str(),)).await?;
        Ok(Issue{id,title:title.clone()})
    }).await?;
    Ok(issue)
}

fn initial_metadata(
    project: &Node,
    owner: i64,
    title: &str,
    description: &str,
    tags: &[&str],
    context: &Value,
) -> Value {
    let mut metadata = json!({"security_level":if project.metadata.0["default_issue_security"]=="related"{"related"}else{"open"},"tags":tags,"automation":context,
        "content_revision":1,"read_revisions":{owner.to_string():1}});
    metadata["automation"]["prompt"] = json!(description);
    let definition = &project.metadata.0["workflow_definition"];
    if definition.is_object()
        && (definition["stage_mode"] == "dag" || definition["advancement_policy"] == "ai")
    {
        metadata["workflow"] = instantiate(definition);
    }
    add_change_request_badges(&mut metadata, &format!("{title}\n{description}"));
    metadata
}

fn instantiate(definition: &Value) -> Value {
    let mut nodes = if definition["stage_mode"] == "dag" {
        definition["nodes"].as_array().cloned().unwrap_or_default()
    } else {
        Vec::new()
    };
    for node in &mut nodes {
        let completed = node["node_type"] == "event" && node["role"] == "start";
        let root = node["depends_on"].as_array().is_none_or(|v| v.is_empty())
            && node["loop_id"].as_str().is_none_or(|v| v.is_empty())
            && !matches!(node["node_type"].as_str(), Some("loop_start" | "branch"));
        let status = if completed {
            "completed"
        } else if root {
            "ready"
        } else {
            "blocked"
        };
        let object = node.as_object_mut().expect("validated workflow node");
        object.insert("status".into(), json!(status));
        object.insert(
            "loop_state".into(),
            json!(if completed { "completed" } else { "idle" }),
        );
        for (key, value) in [
            ("attempts", json!(0)),
            ("pending_events", json!([])),
            ("catch_up_done", json!(false)),
            ("task_ids", json!([])),
            ("task_statuses", json!({})),
            ("delivery_ids", json!([])),
            ("decision_history", json!([])),
            ("collectors", json!({})),
        ] {
            object.insert(key.into(), value);
        }
        for key in [
            "active_condition",
            "loop_deadline",
            "exit_reason",
            "last_event",
            "activated_at",
            "task_binding_id",
            "trigger_event",
            "execution_id",
            "automation_run_id",
            "execution_error",
        ] {
            object.insert(key.into(), Value::Null);
        }
    }
    json!({"version":1,"definition_version":definition["version"].as_i64().unwrap_or(1),"stage_mode":definition["stage_mode"].as_str().unwrap_or("none"),"advancement_policy":definition["advancement_policy"].as_str().unwrap_or("manual"),"coordinator_prompt":definition["coordinator_prompt"].as_str().unwrap_or(""),"approval_policy":definition["approval_policy"].as_str().unwrap_or("required"),"ai_automation_rule_id":definition["ai_automation_rule_id"],"execution_config":definition["execution_config"],"orchestration_status":"idle","active_run_id":null,"active_plan_version":null,"current_stage_id":null,"nodes":nodes})
}

pub(crate) fn status_name(project: &Node, status: &str) -> String {
    if let Some(statuses) = project.metadata.0["board_config"]["statuses"].as_array() {
        return statuses
            .iter()
            .find(|value| value["id"] == status)
            .and_then(|v| v["name"].as_str())
            .unwrap_or("")
            .into();
    }
    match status {
        "inbox" => "收集箱",
        "pending" => "待开始",
        "in_progress" => "进行中",
        "in_review" => "待确认",
        "completed" => "已完成",
        _ => "",
    }
    .into()
}

pub(super) fn add_change_request_badges(metadata: &mut Value, content: &str) {
    update_change_request_source(metadata, "issue", content)
}

pub(crate) fn update_change_request_source(metadata: &mut Value, source: &str, content: &str) {
    let regex = regex::Regex::new(r#"https?://[^\s<>\"'`\])}]+"#).expect("static URL pattern");
    let mut urls = std::collections::BTreeSet::new();
    for found in regex.find_iter(content) {
        let raw = found.as_str().trim_end_matches([
            '.', ',', ';', ':', '!', '?', '。', '，', '；', '：', '！', '？',
        ]);
        if let Ok(url) = url::Url::parse(raw) {
            if !url.username().is_empty() || url.password().is_some() {
                continue;
            }
            let segments: Vec<_> = url.path().trim_matches('/').split('/').collect();
            let marker = segments
                .iter()
                .position(|part| *part == "pull")
                .filter(|index| *index == 2)
                .or_else(|| {
                    segments
                        .windows(2)
                        .position(|parts| parts == ["-", "merge_requests"])
                        .map(|index| index + 1)
                });
            if let Some(index) = marker
                && let Some(number) = segments
                    .get(index + 1)
                    .and_then(|v| v.parse::<u64>().ok())
                    .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
            {
                let path = segments[..=index].join("/");
                urls.insert(format!(
                    "{}/{path}/{number}",
                    url.origin().ascii_serialization()
                ));
            }
        }
    }
    let badges:Vec<_>=urls.into_iter().map(|url|json!({"id":url,"label":format!("{}{}",if url.contains("/-/merge_requests/"){"!"}else{"#"},url.rsplit('/').next().unwrap_or("")),"url":url,"icon":"git-pull-request","tone":"neutral"})).collect();
    if !metadata.is_object() {
        *metadata = json!({})
    }
    let previous = metadata["badge_sources"].as_object();
    let mut sources = previous.cloned().unwrap_or_default();
    if badges.is_empty() && !sources.contains_key(source) {
        return;
    }
    if previous.is_none() {
        let unmanaged: Vec<_> = metadata["badges"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|badge| badge["id"].is_string() && badge["label"].is_string())
            .cloned()
            .collect();
        if !unmanaged.is_empty() {
            sources.insert("unmanaged".into(), json!(unmanaged));
        }
    }
    if badges.is_empty() {
        sources.remove(source);
    } else {
        sources.insert(source.into(), json!(badges));
    }
    let mut merged = std::collections::BTreeMap::new();
    for badges in sources.values() {
        for badge in badges.as_array().into_iter().flatten() {
            if let Some(id) = badge["id"].as_str() {
                merged.insert(id.to_owned(), badge.clone());
            }
        }
    }
    metadata["badge_sources"] = Value::Object(sources);
    metadata["badges"] = json!(merged.into_values().collect::<Vec<_>>());
}

pub(super) async fn provider_request(
    state: &AppState,
    project: &Node,
    method: &str,
    path: &str,
    body: &Value,
) -> Result<Value> {
    let provider = project.metadata.0["task_provider"].as_str().unwrap_or("");
    let config = &project.metadata.0["provider_config"];
    let repository = config["repository"]
        .as_str()
        .unwrap_or("")
        .trim()
        .trim_matches('/');
    if repository.is_empty() {
        bail!("Provider repository is required")
    }
    let domain = config["domain"]
        .as_str()
        .unwrap_or(if provider == "github" {
            "github.com"
        } else {
            "gitlab.com"
        })
        .trim();
    let credential: ProviderCredential = serde_json::from_value(config["credential"].clone())
        .context("Provider credential is not configured")?;
    if credential.context != format!("{provider}:{domain}:{repository}") {
        bail!("provider credential context does not match project")
    }
    let token =
        decrypt_provider_token(&state.auth.jwt_key, &credential).map_err(anyhow::Error::msg)?;
    let default = if provider == "github" {
        "https://api.github.com".to_owned()
    } else {
        format!("https://{domain}/api/v4")
    };
    let base = config["api_base"]
        .as_str()
        .unwrap_or(&default)
        .trim_end_matches('/');
    let client = brz_http::Client::builder()
        .read_timeout(std::time::Duration::from_secs(30))
        .build()?;
    let url = format!("{base}{path}");
    let request = match method {
        "POST" => client.post(&url)?,
        "PATCH" => client.request(brz_http::Method::PATCH, &url)?,
        "PUT" => client.put(&url)?,
        _ => client.get(&url)?,
    };
    let request = if provider == "github" {
        request
            .header("authorization", format!("Bearer {token}"))
            .header("accept", "application/vnd.github+json")
    } else {
        request.header("PRIVATE-TOKEN", token)
    };
    let response = if method == "GET" {
        request
    } else {
        request.json(body)
    }
    .send()
    .await?;
    if !response.status().is_success() {
        return Err(ProviderRequestError {
            status: response.status().as_u16(),
        }
        .into());
    }
    Ok(response.json().await?)
}

#[derive(Debug)]
pub(crate) struct ProviderRequestError {
    pub(crate) status: u16,
}
impl std::fmt::Display for ProviderRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Provider request failed: HTTP {}", self.status)
    }
}
impl std::error::Error for ProviderRequestError {}

pub(super) fn issue_path(project: &Node, number: Option<i64>) -> Result<String> {
    let repository = project.metadata.0["provider_config"]["repository"]
        .as_str()
        .context("Provider repository is required")?
        .trim()
        .trim_matches('/');
    let mut path = if project.metadata.0["task_provider"] == "github" {
        format!("/repos/{repository}/issues")
    } else {
        format!("/projects/{}/issues", url_encode_path(repository))
    };
    if let Some(number) = number {
        path.push_str(&format!("/{number}"));
    }
    Ok(path)
}

async fn create_external(
    state: &AppState,
    project: &Node,
    owner: i64,
    title: &str,
    description: &str,
    tags: &[&str],
) -> Result<Issue> {
    #[derive(FromMysqlRow)]
    struct User {
        user_name: String,
    }
    let owner_row: User = state
        .mysql
        .fetch_one("SELECT user_name FROM users WHERE id=?", (owner,))
        .await?;
    let name = owner_row
        .user_name
        .replace([':', ','], " ")
        .trim()
        .to_owned();
    let mut labels: Vec<String> = tags
        .iter()
        .filter(|value| {
            ![
                "wegent:priority:",
                "wegent:status:",
                "wegent:assignee:",
                "wegent:security:",
            ]
            .iter()
            .any(|prefix| value.starts_with(prefix))
        })
        .map(|v| v.to_string())
        .collect();
    labels.extend([
        format!("wegent:creator:{owner}:{name}"),
        "wegent:priority:medium".into(),
        "wegent:status:inbox".into(),
        format!(
            "wegent:security:{}",
            if project.metadata.0["default_issue_security"] == "related" {
                "related"
            } else {
                "open"
            }
        ),
    ]);
    let github = project.metadata.0["task_provider"] == "github";
    let payload = if github {
        json!({"title":title,"body":description,"labels":labels})
    } else {
        json!({"title":title,"description":description,"labels":labels.join(",")})
    };
    let value = provider_request(
        state,
        project,
        "POST",
        &issue_path(project, None)?,
        &payload,
    )
    .await?;
    let number = value[if github { "number" } else { "iid" }]
        .as_i64()
        .context("Provider returned an Issue without its number")?;
    let id = format!("{}-{number}", project.project_key);
    let mut metadata = json!({"external_index":true});
    add_change_request_badges(&mut metadata, &format!("{title}\n{description}"));
    if metadata["badges"]
        .as_array()
        .is_some_and(|values| !values.is_empty())
    {
        state
            .mysql
            .with_transaction(async |tx| {
                store::insert(
                    tx,
                    "task",
                    json!({"id":id,"cloud_project_id":project.id,"metadata":metadata}),
                )
                .await?;
                Ok(())
            })
            .await?;
    }
    Ok(Issue {
        id,
        title: title.into(),
    })
}

pub(crate) async fn load(state: &AppState, project: &Node, id: &str, user: i64) -> Result<Node> {
    if !matches!(
        project.metadata.0["task_provider"].as_str(),
        Some("github" | "gitlab")
    ) {
        return store::get(&state.mysql, "task", id)
            .await?
            .filter(|issue| issue.cloud_project_id == project.id)
            .context("Automation task carrier is unavailable");
    }
    let prefix = format!("{}-", project.project_key);
    let number = id
        .strip_prefix(&prefix)
        .and_then(|number| number.parse::<i64>().ok())
        .context("Automation task carrier is unavailable")?;
    let value = provider_request(
        state,
        project,
        "GET",
        &issue_path(project, Some(number))?,
        &Value::Null,
    )
    .await?;
    let labels: Vec<_> = value["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|label| label.as_str().or_else(|| label["name"].as_str()))
        .collect();
    let title = value["title"].as_str().unwrap_or("");
    let description = value[if project.metadata.0["task_provider"] == "github" {
        "body"
    } else {
        "description"
    }]
    .as_str()
    .unwrap_or("");
    let status = labels
        .iter()
        .find_map(|label| label.strip_prefix("wegent:status:"))
        .unwrap_or("pending");
    let priority = labels
        .iter()
        .find_map(|label| label.strip_prefix("wegent:priority:"))
        .unwrap_or("none");
    let creator = labels
        .iter()
        .find_map(|label| label.strip_prefix("wegent:creator:"))
        .and_then(|value| value.split(':').next())
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let security = labels
        .iter()
        .find_map(|label| label.strip_prefix("wegent:security:"))
        .unwrap_or(
            if project.metadata.0["default_issue_security"] == "related" {
                "related"
            } else {
                "open"
            },
        );
    let assigned_user = labels
        .iter()
        .find_map(|label| label.strip_prefix("wegent:assignee:user:"))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let mut snapshot = store::get(&state.mysql, "task", id)
        .await?
        .unwrap_or_else(|| {
            let mut issue = project.clone();
            issue.id = id.into();
            issue.resource_type = "task".into();
            issue.cloud_project_id = project.id.clone();
            issue
        });
    snapshot.created_by_user_id = creator;
    snapshot.assignee_user_id = assigned_user;
    snapshot.metadata = Json(json!({"security_level":security}));
    authority::require_issue(state, project, &snapshot, user).await?;
    state.mysql.with_transaction(async |tx|{
        let existing=store::locked(tx,"task",id).await?;
        let mut metadata=existing.as_ref().map(Node::meta).unwrap_or(json!({}));metadata["external_index"]=json!(true);metadata["security_level"]=json!(security);
        metadata["tags"]=json!(labels.iter().filter(|label|!label.starts_with("wegent:")).collect::<Vec<_>>());
        if existing.is_none(){store::insert(tx,"task",json!({"id":id,"cloud_project_id":project.id,"title":title,"description":description,"status":status,"priority":priority,"created_by_user_id":creator,"assignee_user_id":assigned_user,"metadata":metadata})).await?;}
        else{tx.execute("UPDATE loop_items SET title=?,description=?,status=?,priority=?,created_by_user_id=?,assignee_user_id=?,metadata=? WHERE id=?",(title,description,status,priority,creator,assigned_user,Json(metadata),id)).await?;}
        Ok(())
    }).await?;
    let issue = store::get(&state.mysql, "task", id)
        .await?
        .context("Automation task carrier is unavailable")?;
    authority::require_issue(state, project, &issue, user).await?;
    Ok(issue)
}

pub(super) async fn assign_external(
    state: &AppState,
    project: &Node,
    issue: &Node,
    kind: &str,
    target: &str,
    _name: &str,
    user: i64,
) -> Result<()> {
    let number = issue
        .id
        .rsplit('-')
        .next()
        .and_then(|v| v.parse::<i64>().ok())
        .context("TODO not found")?;
    let value = provider_request(
        state,
        project,
        "GET",
        &issue_path(project, Some(number))?,
        &Value::Null,
    )
    .await?;
    let mut labels: Vec<String> = value["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().or_else(|| value["name"].as_str()))
        .filter(|label| !label.starts_with("wegent:assignee:"))
        .map(str::to_owned)
        .collect();
    let encoded = if kind == "human" { "user" } else { kind };
    labels.push(format!("wegent:assignee:{encoded}:{target}"));
    if kind != "human" && issue.status != "completed" {
        labels.retain(|label| !label.starts_with("wegent:status:"));
        labels.push("wegent:status:in_progress".into());
    }
    let github = project.metadata.0["task_provider"] == "github";
    let body = json!({"labels":if github{json!(labels)}else{json!(labels.join(","))}});
    provider_request(
        state,
        project,
        if github { "PATCH" } else { "PUT" },
        &issue_path(project, Some(number))?,
        &body,
    )
    .await?;
    let _ = user;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workflow_roots_and_start_events_have_the_source_initial_states() {
        let result = instantiate(
            &json!({"stage_mode":"dag","nodes":[{"id":"start","node_type":"event","role":"start"},{"id":"a","node_type":"task","depends_on":[]},{"id":"b","node_type":"task","depends_on":["a"]},{"id":"branch","node_type":"branch","depends_on":[]}]}),
        );
        assert_eq!(result["nodes"][0]["status"], "completed");
        assert_eq!(result["nodes"][1]["status"], "ready");
        assert_eq!(result["nodes"][2]["status"], "blocked");
        assert_eq!(result["nodes"][3]["status"], "blocked");
    }
    #[test]
    fn source_badges_preserve_unmanaged_and_other_activities_and_remove_only_their_source() {
        let mut metadata = json!({"badges":[{"id":"legacy","label":"old"}]});
        update_change_request_source(
            &mut metadata,
            "activity:m1",
            "Created https://github.com/acme/app/pull/7.",
        );
        assert_eq!(metadata["badge_sources"]["unmanaged"][0]["id"], "legacy");
        assert_eq!(metadata["badges"].as_array().unwrap().len(), 2);
        update_change_request_source(
            &mut metadata,
            "activity:m2",
            "https://gitlab.example/acme/app/-/merge_requests/3",
        );
        update_change_request_source(&mut metadata, "activity:m1", "");
        assert!(metadata["badge_sources"].get("activity:m1").is_none());
        assert_eq!(metadata["badge_sources"]["activity:m2"][0]["label"], "!3");
        assert_eq!(metadata["badges"].as_array().unwrap().len(), 2);
        let before = metadata.clone();
        update_change_request_source(&mut metadata, "activity:missing", "");
        assert_eq!(metadata, before);
    }
}
