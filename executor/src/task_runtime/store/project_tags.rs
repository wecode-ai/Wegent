// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::task_runtime::model::ProjectTagChange;

fn replace_tags(value: &Value, change: &ProjectTagChange) -> Value {
    let mut tags = Vec::new();
    for tag in value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let next = if tag == change.source {
            change.target.as_deref()
        } else {
            Some(tag)
        };
        if let Some(next) = next {
            let next = Value::String(next.to_owned());
            if !tags.contains(&next) {
                tags.push(next);
            }
        }
    }
    Value::Array(tags)
}

fn change_views(metadata: &mut Value, change: &ProjectTagChange) -> Result<(), TaskRuntimeError> {
    let previous = metadata["board_views"].clone();
    if previous.is_null() {
        return Ok(());
    }
    super::super::board_views::validate_update(&previous, &previous)?;
    let config = &mut metadata["board_views"];
    for view in config["views"].as_array_mut().unwrap() {
        let mut removed = HashSet::new();
        view["columns"]
            .as_array_mut()
            .unwrap()
            .retain_mut(|column| {
                if column["type"] != "tag" || column["value"] != change.source {
                    return true;
                }
                if let Some(target) = &change.target {
                    column["value"] = json!(target);
                    true
                } else {
                    removed.insert(column["id"].as_str().unwrap().to_owned());
                    false
                }
            });
        if let Some(filter) = view.get_mut("filter") {
            filter["tags"] = replace_tags(&filter["tags"], change);
        }
        if let Some(sorts) = view.get_mut("sorts").and_then(Value::as_object_mut) {
            sorts.retain(|id, _| !removed.contains(id));
        }
    }
    super::super::board_views::validate_update(&previous, config)
}

impl LocalTaskStore {
    /// Update catalog, saved views and every affected Issue in one SQLite transaction.
    pub(super) fn change_project_tag(
        &self,
        project_id: &str,
        version: i64,
        change: &ProjectTagChange,
    ) -> Result<LoopItem, TaskRuntimeError> {
        for tag in std::iter::once(&change.source).chain(change.target.iter()) {
            super::super::tagging::validate_tag(tag)?;
            if tag != tag.trim() {
                return Err(TaskRuntimeError::Invalid("Invalid tag name".into()));
            }
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut project = get_item_from(&transaction, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        if project.version != version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if task_provider(&project)? != TaskProviderKind::Local {
            return Err(TaskRuntimeError::Invalid(
                "Project tag changes require locally stored Issues".into(),
            ));
        }
        project.metadata["tags"] = replace_tags(&project.metadata["tags"], change);
        change_views(&mut project.metadata, change)?;
        let items = {
            let mut statement = transaction.prepare(
                "SELECT id, metadata FROM loop_items WHERE cloud_project_id = ?1
                 AND resource_type = 'task' AND deleted_at IS NULL ORDER BY id",
            )?;
            let rows = statement.query_map([project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (id, metadata) in items {
            let mut metadata: Value = serde_json::from_str(&metadata)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            if !metadata["tags"]
                .as_array()
                .is_some_and(|tags| tags.iter().any(|tag| tag == &change.source))
            {
                continue;
            }
            let tags = replace_tags(&metadata["tags"], change);
            if metadata["tags"] == tags {
                continue;
            }
            metadata["tags"] = tags;
            transaction.execute(
                "UPDATE loop_items SET metadata = ?1, version = version + 1,
                 updated_at = ?2 WHERE id = ?3",
                params![metadata.to_string(), now(), id],
            )?;
        }
        transaction.execute(
            "UPDATE loop_items SET metadata = ?1, version = version + 1,
             updated_at = ?2 WHERE id = ?3",
            params![project.metadata.to_string(), now(), project_id],
        )?;
        transaction.commit()?;
        drop(connection);
        self.get_project(project_id)
    }
}
