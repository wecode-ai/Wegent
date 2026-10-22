// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, sync::OnceLock};

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use url::Url;

use super::{now, TaskRuntimeError};

fn change_request_badges(content: &str) -> Vec<Value> {
    static URLS: OnceLock<Regex> = OnceLock::new();
    let pattern = URLS.get_or_init(|| Regex::new(r#"https?://[^\s<>"'`\])}]+"#).unwrap());
    let mut badges = BTreeMap::new();
    for candidate in pattern.find_iter(content) {
        let value = candidate.as_str().trim_end_matches([
            '.', ',', ';', ':', '!', '?', '。', '，', '；', '：', '！', '？',
        ]);
        let Ok(mut url) = Url::parse(value) else {
            continue;
        };
        if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
            continue;
        }
        let parts: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
        let marker = if parts.len() >= 4 && parts[2] == "pull" {
            Some((2, "#"))
        } else {
            parts
                .windows(2)
                .position(|parts| parts == ["-", "merge_requests"])
                .filter(|index| *index >= 2)
                .map(|index| (index + 1, "!"))
        };
        let Some((index, prefix)) = marker else {
            continue;
        };
        let Some(number) = parts
            .get(index + 1)
            .and_then(|number| number.parse::<u64>().ok())
            .filter(|number| *number > 0 && *number <= 9_007_199_254_740_991)
        else {
            continue;
        };
        if parts[index + 1] != number.to_string() {
            continue;
        }
        let path = format!("/{}", parts[..=index + 1].join("/"));
        url.set_path(&path);
        url.set_query(None);
        url.set_fragment(None);
        let url = url.to_string();
        badges.insert(url.clone(), json!({"id": url, "label": format!("{prefix}{number}"), "url": url, "icon": "git-pull-request", "tone": "neutral"}));
    }
    badges.into_values().collect()
}

pub(super) fn update_source(metadata: &mut Value, source: &str, content: &str) {
    let badges = change_request_badges(content);
    if badges.is_empty() && metadata["badge_sources"].get(source).is_none() {
        return;
    }
    if !metadata.is_object() {
        *metadata = json!({});
    }
    if !metadata["badge_sources"].is_object() {
        metadata["badge_sources"] = if metadata["badges"].is_array() {
            json!({"unmanaged": metadata["badges"].clone()})
        } else {
            json!({})
        };
    }
    let sources = metadata["badge_sources"].as_object_mut().unwrap();
    if badges.is_empty() {
        sources.remove(source);
    } else {
        sources.insert(source.to_owned(), json!(badges));
    }
    let by_id: BTreeMap<_, _> = sources
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|badge| {
            badge["id"]
                .as_str()
                .map(|id| (id.to_owned(), badge.clone()))
        })
        .collect();
    metadata["badges"] = json!(by_id.into_values().collect::<Vec<_>>());
}

pub(super) fn update_stored_source(
    connection: &Connection,
    task_id: &str,
    source: &str,
    content: &str,
) -> Result<(), TaskRuntimeError> {
    let value: Option<String> = connection
        .query_row(
            "SELECT metadata FROM loop_items WHERE id = ?1 AND resource_type = 'task'",
            [task_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(value) = value else { return Ok(()) };
    let mut metadata: Value = serde_json::from_str(&value)
        .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
    let previous = metadata.clone();
    update_source(&mut metadata, source, content);
    if metadata != previous {
        connection.execute("UPDATE loop_items SET metadata = ?1, version = version + 1, updated_at = ?2 WHERE id = ?3", params![metadata.to_string(), now(), task_id])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_badges_persist_comments_without_scanning_on_reopen() {
        use super::super::{
            LocalCommentCreate, LocalTaskStore, ProjectCreate, TaskCreate, TaskUpdate,
        };
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let project = store
            .create_project(
                serde_json::from_value::<ProjectCreate>(
                    json!({"name":"Badges","project_key":"BADGE"}),
                )
                .unwrap(),
            )
            .unwrap();
        let url = "https://github.com/org/app/pull/42";
        let task = store
            .create_task(
                &project.id,
                serde_json::from_value::<TaskCreate>(
                    json!({"title":"Badge task", "description":url}),
                )
                .unwrap(),
            )
            .unwrap();
        let comment = store
            .create_comment(&LocalCommentCreate {
                project_id: project.id.clone(),
                task_id: task.id.clone(),
                client_message_id: None,
                sender_type: "user".into(),
                sender_id: "1".into(),
                sender_name: "User".into(),
                content: url.into(),
                metadata: json!({}),
                reply_to_message_id: None,
            })
            .unwrap();
        let task = store.get_task(&project.id, &task.id).unwrap();
        assert_eq!(task.metadata["badges"].as_array().unwrap().len(), 1);
        let task = store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: task.version,
                    description: Some("removed".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(task.metadata["badges"][0]["url"], url);
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        let task = store.get_task(&project.id, &task.id).unwrap();
        assert_eq!(task.metadata["badges"][0]["url"], url);
        assert!(task.metadata["badge_sources"]
            .get(format!("comment:{}", comment.message_id))
            .is_some());
        let version = task.version;
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        assert_eq!(
            store.get_task(&project.id, &task.id).unwrap().version,
            version
        );
        {
            let connection = store.connection().unwrap();
            connection
                .execute(
                    "UPDATE loop_items SET metadata = '{}', description = ?1 WHERE id = ?2",
                    params![url, task.id],
                )
                .unwrap();
        }
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();
        let task = store.get_task(&project.id, &task.id).unwrap();
        assert!(task.metadata.get("badges").is_none());
        let task = store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: task.version,
                    status: Some("pending".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(task.metadata.get("badges").is_none());
    }

    #[test]
    fn sources_deduplicate_links_and_preserve_unrelated_badges() {
        let mut metadata = json!({"tags": ["bug"], "badge_sources": {"review": [{"id": "review", "label": "Reviewed", "tone": "success"}]}});
        update_source(&mut metadata, "issue", "[PR](https://github.com/org/app/pull/42/files#diff) https://user:pass@github.com/org/app/pull/8");
        update_source(&mut metadata, "comment:1", "https://github.com/org/app/pull/42 https://gitlab.local/group/sub/app/-/merge_requests/7?x=1");
        assert_eq!(metadata["badges"].as_array().unwrap().len(), 3);
        update_source(&mut metadata, "issue", "removed");
        assert_eq!(metadata["badges"].as_array().unwrap().len(), 3);
        update_source(&mut metadata, "comment:1", "removed");
        assert_eq!(
            metadata["badges"],
            json!([{"id": "review", "label": "Reviewed", "tone": "success"}])
        );
        assert_eq!(metadata["tags"], json!(["bug"]));
    }
}
