// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Rule matching and deterministic event-to-run admission.

use anyhow::Result;
use brz_mysql::{Json, MysqlTransaction};
use chrono::Utc;
use serde_json::{Value, json};

use super::{
    dispatch,
    store::{self, COLUMNS, LIVE, Node, UNSET},
};
use crate::state::AppState;

pub(super) struct AutomationEvent {
    pub event_type: String,
    pub project_id: String,
    pub subject_id: String,
    pub source: String,
    pub actor_user_id: i64,
    pub payload: Value,
    pub subject_type: String,
    pub event_id: String,
    pub subscription_id: String,
}

fn supported(event_type: &str) -> bool {
    matches!(
        event_type,
        "task.created"
            | "task.tag_added"
            | "task.status_changed"
            | "change_request.checks_failed"
            | "change_request.merge_conflict"
            | "change_request.review_submitted"
            | "change_request.comment_created"
            | "change_request.merged"
            | "document.changed"
    )
}

fn filter(config: &Value, key: &str, value: &Value) -> bool {
    config[key]
        .as_array()
        .is_none_or(|values| values.is_empty() || values.contains(value))
}

fn entered_processing(project: &Value, previous: &str, current: &str) -> bool {
    let board = &project["board_config"];
    let statuses: Vec<_> = match board["statuses"].as_array() {
        Some(values) => values.iter().filter_map(|v| v["id"].as_str()).collect(),
        None => vec!["inbox", "pending", "in_progress", "in_review", "completed"],
    };
    let boundary = board["processing_start_status_id"]
        .as_str()
        .or_else(|| statuses.get(1).copied())
        .or_else(|| statuses.first().copied());
    let index = |value: &str| statuses.iter().position(|status| *status == value);
    match (index(previous), index(current), boundary.and_then(index)) {
        (Some(previous), Some(current), Some(boundary)) => {
            previous < boundary && boundary <= current
        }
        _ => false,
    }
}

pub(super) fn matches(config: &Value, event: &AutomationEvent, project_metadata: &Value) -> bool {
    if !config.is_object() {
        return true;
    }
    if !filter(config, "sources", &json!(event.source))
        || !filter(
            config,
            "target_branches",
            &event.payload["subject"]["base_branch"],
        )
        || !filter(
            config,
            "repositories",
            &event.payload["subject"]["repository"],
        )
    {
        return false;
    }
    if event.event_type == "task.status_changed" {
        let (Some(previous), Some(current)) = (
            event.payload["previous_status"].as_str(),
            event.payload["status"].as_str(),
        ) else {
            return false;
        };
        if previous == current {
            return false;
        }
        match config["transition"].as_str() {
            Some("any") => {}
            Some("entered_processing")
                if entered_processing(project_metadata, previous, current) => {}
            _ => return false,
        }
    }
    if !filter(config, "priorities", &event.payload["priority"]) {
        return false;
    }
    let actual = if event.event_type == "task.tag_added" {
        &event.payload["added_tags"]
    } else {
        &event.payload["tags"]
    };
    config["tags"].as_array().is_none_or(|tags| {
        tags.is_empty()
            || actual
                .as_array()
                .is_some_and(|actual| tags.iter().any(|tag| actual.contains(tag)))
    })
}

pub(super) async fn process(state: &AppState, event: &AutomationEvent) -> Result<Vec<Node>> {
    if !supported(&event.event_type) {
        return Ok(Vec::new());
    }
    let Some(project) = store::get(&state.mysql, "project", event.project_id.as_str()).await?
    else {
        return Ok(Vec::new());
    };
    let deferred = if event.payload["workflow"]["advancement_policy"] == "ai" {
        event.payload["workflow"]["ai_automation_rule_id"]
            .as_str()
            .unwrap_or("")
    } else {
        ""
    };
    let candidates:Vec<Node>=state.mysql.fetch_all(format!("SELECT {COLUMNS} FROM loop_items WHERE resource_type='automation_rule' AND cloud_project_id=? AND status='enabled' AND {LIVE}"),(event.project_id.as_str(),)).await?;
    let mut rules: Vec<_> = candidates
        .into_iter()
        .filter(|rule| {
            let metadata = &rule.metadata.0;
            let subscription = metadata["event_config"]["subscription_id"]
                .as_str()
                .unwrap_or("");
            rule.id != deferred
                && metadata["trigger_type"] == "event"
                && metadata["event_type"] == event.event_type
                && (subscription.is_empty() || subscription == event.subscription_id)
                && matches(&metadata["event_config"], event, &project.metadata.0)
        })
        .collect();
    if matches!(
        event.event_type.as_str(),
        "task.created" | "task.tag_added" | "task.status_changed"
    ) && !rules.is_empty()
    {
        let issue = store::get(&state.mysql, "task", &event.subject_id).await?;
        let bound = issue
            .as_ref()
            .filter(|issue| issue.cloud_project_id == event.project_id)
            .and_then(|issue| issue.metadata.0["workflow_automation"]["rule_id"].as_str())
            .unwrap_or("");
        if !bound.is_empty() {
            rules.retain(|rule| rule.id == bound)
        } else if rules.len() > 1 {
            return Ok(Vec::new());
        }
    }
    let mut runs = Vec::new();
    for rule in rules {
        let public_id = crate::hex_sha256(
            format!("automation-event:{}:{}", event.event_id, rule.id).as_bytes(),
        )[..36]
            .to_owned();
        let admission=state.mysql.with_transaction(async |tx| {
            let existing:Option<Node>=tx.fetch_optional(format!("SELECT {COLUMNS} FROM loop_items WHERE resource_type='automation_run' AND public_id=? FOR UPDATE"),(public_id.as_str(),)).await?;
            if let Some(existing)=existing {if !existing.unresolved(){return Ok((existing.id,false))}
                tx.execute("UPDATE loop_items SET status='pending',description='',completed_at=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(UNSET,existing.id.as_str())).await?;
                return Ok((existing.id,true))}
            // The unique public_id decides concurrent webhook/poll delivery.
            let id=store::insert(tx,"automation_run",store::new_run(&rule,"event",Utc::now().naive_utc(),Some(&public_id))).await?;
            Ok((id,true))
        }).await;
        let (run_id, needs_dispatch) = match admission {
            Ok(admitted) => admitted,
            Err(error) if error.database_code() == Some(1062) => {
                let existing:Node=state.mysql.fetch_one(format!("SELECT {COLUMNS} FROM loop_items WHERE resource_type='automation_run' AND public_id=?"),(public_id.as_str(),)).await?;
                {
                    let needs_dispatch = existing.unresolved();
                    (existing.id, needs_dispatch)
                }
            }
            Err(error) => return Err(error.into()),
        };
        if needs_dispatch {
            let mut run = store::get(&state.mysql, "automation_run", &run_id)
                .await?
                .expect("admitted run");
            let mut metadata = run.meta();
            metadata["event"] = json!({"type":event.event_type,"source":event.source,"event_id":event.event_id,"subscription_id":event.subscription_id,"subject_type":event.subject_type,"subject_id":event.subject_id,"actor_user_id":event.actor_user_id,"payload":event.payload});
            if event.payload["execution_config"].is_object() {
                metadata["workflow_execution_config"] = event.payload["execution_config"].clone();
            }
            let target = rule.metadata.0["event_config"]["execution_target"]
                .as_str()
                .unwrap_or(
                    if matches!(
                        event.event_type.as_str(),
                        "task.created" | "task.tag_added" | "task.status_changed"
                    ) {
                        "existing_issue"
                    } else {
                        "continue_binding"
                    },
                );
            let outcome = match target {
                "continue_binding" => match resolve_binding(state, event).await? {
                    Ok(binding) => {
                        metadata["execution_target"] = json!({"kind":"continue_binding","binding_id":binding.id,"device_id":binding.device_id,"runtime_task_id":binding.task_id});
                        state.mysql.execute("UPDATE loop_items SET task_id=?,task_title=?,device_id=?,backend_task_id=?,metadata=?,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(binding.loop_item_id.as_str(),binding.task_title.as_str(),binding.device_id.as_str(),binding.backend_task_id,Json(metadata.clone()),run.id.as_str())).await?;
                        dispatch::continue_binding(state, &rule, &run, &binding, event).await?;
                        None
                    }
                    Err(reason) => Some(Err(reason)),
                },
                "existing_issue" => {
                    let issue = store::get(&state.mysql, "task", &event.subject_id).await?;
                    match issue.filter(|issue| issue.cloud_project_id == event.project_id) {
                        Some(issue) => Some(Ok((issue.id, issue.title))),
                        None => Some(Err("Event Issue was not found".into())),
                    }
                }
                "create_issue" => {
                    let title = event.payload["title"]
                        .as_str()
                        .or_else(|| event.payload["subject"]["title"].as_str())
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("{}: {}", event.source, event.event_type));
                    let description = event.payload["description"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or(serde_json::to_string_pretty(&event.payload)?);
                    let issue=dispatch::create_issue(state,&project,rule.created_by_user_id,&title,&description,&["automation",&event.source],&json!({"trigger":"external_event","event_id":event.event_id,"subscription_id":event.subscription_id})).await?;
                    Some(Ok((issue.id, issue.title)))
                }
                _ => Some(Err("Unsupported execution target".into())),
            };
            if let Some(outcome) = outcome {
                match outcome {
                    Ok((task_id, title)) => {
                        metadata["execution_target"] = json!({"kind":target,"task_id":task_id});
                        state.mysql.execute("UPDATE loop_items SET task_id=?,task_title=?,metadata=?,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(task_id.as_str(),title.as_str(),Json(metadata),run.id.as_str())).await?;
                        run.task_id = task_id;
                        run.task_title = title;
                        dispatch::run(state, &rule, &run).await?;
                    }
                    Err(reason) => {
                        metadata["execution_target"] = json!({"kind":"skipped","reason":reason});
                        state.mysql.execute("UPDATE loop_items SET status='skipped',description=?,completed_at=UTC_TIMESTAMP(6),metadata=?,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(reason.as_str(),Json(metadata),run.id.as_str())).await?;
                    }
                }
            }
        }
        if let Some(run) = store::get(&state.mysql, "automation_run", &run_id).await? {
            runs.push(run)
        }
    }
    if !runs.is_empty()
        && let Err(error) = super::super::robot::prepare_and_wake(state).await
    {
        tracing::error!(%error,"Project event queue wake failed after commit");
    }
    Ok(runs)
}

async fn resolve_binding(
    state: &AppState,
    event: &AutomationEvent,
) -> Result<std::result::Result<Node, String>> {
    let bindings:Vec<Node>=state.mysql.fetch_all(format!("SELECT {COLUMNS} FROM loop_items WHERE resource_type='execution' AND cloud_project_id=? AND loop_item_id IS NOT NULL AND (unlinked_at IS NULL OR unlinked_at<='1970-01-02') AND {LIVE}"),(event.project_id.as_str(),)).await?;
    let subject = &event.payload["subject"];
    let mut matches: Vec<_> = bindings
        .into_iter()
        .filter(|binding| {
            binding.metadata.0["change_requests"]
                .as_array()
                .is_some_and(|candidates| {
                    candidates
                        .iter()
                        .any(|candidate| binding_matches(subject, candidate))
                })
        })
        .collect();
    Ok(match matches.len() {
        0 => Err("No active task binding was found".into()),
        1 => Ok(matches.remove(0)),
        _ => Err("Multiple active task bindings matched the change request".into()),
    })
}

fn binding_matches(subject: &Value, candidate: &Value) -> bool {
    let text = |value: &Value| value.as_str().unwrap_or("").trim().to_owned();
    let normalize = |value: &Value| {
        text(value)
            .trim_matches('/')
            .trim_end_matches(".git")
            .to_lowercase()
    };
    for key in ["provider", "instance_url", "repository"] {
        let observed = if key == "provider" {
            text(&subject[key])
        } else {
            normalize(&subject[key])
        };
        if !observed.is_empty()
            && observed
                != if key == "provider" {
                    text(&candidate[key])
                } else {
                    normalize(&candidate[key])
                }
        {
            return false;
        }
    }
    let number = |value: &Value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|v| v.parse::<i64>().ok()))
    };
    if let Some(expected) = number(&subject["number"]) {
        return number(&candidate["number"]) == Some(expected);
    }
    for key in ["head_commit", "head_branch"] {
        let expected = text(&subject[key]);
        if !expected.is_empty() {
            return text(&candidate[key]) == expected;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(kind: &str, payload: Value) -> AutomationEvent {
        AutomationEvent {
            event_type: kind.into(),
            project_id: "p".into(),
            subject_id: "i".into(),
            source: "github".into(),
            actor_user_id: 1,
            payload,
            subject_type: "task".into(),
            event_id: "e".into(),
            subscription_id: "h".into(),
        }
    }
    #[test]
    fn status_rules_follow_the_projects_processing_boundary() {
        let config = json!({"transition":"entered_processing"});
        let metadata = json!({"board_config":{"statuses":[{"id":"new"},{"id":"doing"},{"id":"done"}],"processing_start_status_id":"doing"}});
        assert!(matches(
            &config,
            &event(
                "task.status_changed",
                json!({"previous_status":"new","status":"doing"})
            ),
            &metadata
        ));
        assert!(!matches(
            &config,
            &event(
                "task.status_changed",
                json!({"previous_status":"doing","status":"done"})
            ),
            &metadata
        ));
        assert!(!matches(
            &config,
            &event(
                "task.status_changed",
                json!({"previous_status":"unknown","status":"doing"})
            ),
            &metadata
        ));
    }
    #[test]
    fn tag_added_checks_only_the_new_tags_and_all_other_filters_apply() {
        let config = json!({"sources":["github"],"tags":["go"],"target_branches":["main"]});
        assert!(!matches(
            &config,
            &event(
                "task.tag_added",
                json!({"tags":["go"],"added_tags":["other"],"subject":{"base_branch":"main"}})
            ),
            &json!({})
        ));
        assert!(matches(
            &config,
            &event(
                "task.tag_added",
                json!({"added_tags":["go"],"subject":{"base_branch":"main"}})
            ),
            &json!({})
        ));
    }
}
