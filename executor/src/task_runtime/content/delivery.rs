// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[cfg(test)]
#[path = "delivery_tests.rs"]
mod tests;

/// The single open human collaboration assignment of an Issue, when exactly one
/// exists. A personal task without recorded dispatch identity may settle it;
/// multiple open assignments stay ambiguous and are ignored.
fn open_human_assignment_for(
    connection: &rusqlite::Connection,
    item_id: &str,
) -> Result<Option<String>, TaskRuntimeError> {
    let mut statement = connection.prepare(
        "SELECT id FROM loop_items
         WHERE parent_id = ?1 AND resource_type = 'task' AND deleted_at IS NULL
           AND json_extract(metadata, '$.collaboration_assignment.assignee_type') = 'human'
           AND current_delivery_id IS NULL
           AND COALESCE(status, '') != 'completed'
         ORDER BY sequence_number DESC, id DESC
         LIMIT 2",
    )?;
    let mut ids = statement
        .query_map([item_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(match ids.len() {
        1 => Some(ids.remove(0)),
        _ => None,
    })
}

fn map_delivery(row: &Row<'_>) -> rusqlite::Result<Delivery> {
    let snapshot = row
        .get::<_, Option<String>>(3)?
        .and_then(|value| serde_json::from_str(&value).ok());
    let metadata = row
        .get::<_, Option<String>>(7)?
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .unwrap_or_else(|| json!({}));
    Ok(Delivery {
        id: row.get(0)?,
        title: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
        version: row.get(9)?,
        loop_item_id: row.get(1)?,
        created_by_user_id: 0,
        source_task_binding_id: row.get(2)?,
        source_task_snapshot: snapshot,
        status: row.get(4)?,
        created_at: row.get(5)?,
        delivered_at: row.get(6)?,
        assets: vec![],
        fulfillments: metadata
            .get("fulfillments")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default(),
    })
}

fn map_delivery_asset(row: &Row<'_>) -> rusqlite::Result<DeliveryAsset> {
    Ok(DeliveryAsset {
        id: row.get(0)?,
        kind: row
            .get::<_, Option<String>>(1)?
            .unwrap_or_else(|| "file".to_owned()),
        display_name: row.get(2)?,
        relative_path: row.get(3)?,
        content_type: row.get(4)?,
        size_bytes: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
        sha256: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
    })
}

fn attach_delivery_to_workflow(
    mut metadata: serde_json::Value,
    workflow_node_id: &str,
    delivery_id: &str,
    fulfillments: &[serde_json::Value],
) -> Result<serde_json::Value, TaskRuntimeError> {
    let workflow = metadata
        .get_mut("workflow")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| TaskRuntimeError::Invalid("Issue has no workflow".to_owned()))?;
    let nodes = workflow
        .get_mut("nodes")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| TaskRuntimeError::Invalid("Issue has no workflow nodes".to_owned()))?;
    let node = nodes
        .iter_mut()
        .find(|node| node.get("id").and_then(serde_json::Value::as_str) == Some(workflow_node_id))
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| TaskRuntimeError::Invalid("Workflow node not found".to_owned()))?;
    let requirement_ids = node
        .get("required_deliverables")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|requirement| requirement.get("id").and_then(serde_json::Value::as_str))
        .collect::<std::collections::HashSet<_>>();
    if !requirement_ids.is_empty() && fulfillments.is_empty() {
        return Err(TaskRuntimeError::Invalid(
            "Workflow Delivery must fulfill at least one required deliverable".to_owned(),
        ));
    }
    for requirement_id in fulfillments.iter().filter_map(|value| {
        value
            .get("requirement_id")
            .and_then(serde_json::Value::as_str)
    }) {
        if !requirement_ids.contains(requirement_id) {
            return Err(TaskRuntimeError::Invalid(format!(
                "Unknown workflow deliverable requirement: {requirement_id}"
            )));
        }
    }
    let deliveries = node
        .entry("delivery_ids")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| TaskRuntimeError::Invalid("Workflow delivery_ids is invalid".to_owned()))?;
    if !deliveries
        .iter()
        .any(|value| value.as_str() == Some(delivery_id))
    {
        deliveries.push(json!(delivery_id));
    }
    let fulfilled = node
        .entry("fulfilled_deliverable_ids")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| {
            TaskRuntimeError::Invalid("Workflow fulfilled deliverables is invalid".to_owned())
        })?;
    for requirement_id in fulfillments.iter().filter_map(|value| {
        value
            .get("requirement_id")
            .and_then(serde_json::Value::as_str)
    }) {
        if !fulfilled
            .iter()
            .any(|value| value.as_str() == Some(requirement_id))
        {
            fulfilled.push(json!(requirement_id));
        }
    }
    let version = workflow
        .get("version")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1);
    workflow.insert("version".to_owned(), json!(version + 1));
    Ok(metadata)
}

impl LocalTaskStore {
    pub fn list_project_delivery_files(
        &self,
        project_id: &str,
    ) -> Result<Vec<serde_json::Value>, TaskRuntimeError> {
        self.get_project(project_id)?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT a.id, d.id, COALESCE(d.loop_item_id, json_extract(d.metadata, '$.external_item_id')),
                    a.relative_path, a.display_name, a.content_type, a.size_bytes, d.delivered_at
             FROM loop_items a JOIN loop_items d ON a.delivery_id = d.id
             WHERE a.resource_type = 'delivery_asset' AND d.resource_type = 'delivery'
               AND d.cloud_project_id = ?1 AND d.status = 'delivered'
               AND a.deleted_at IS NULL AND d.deleted_at IS NULL ORDER BY d.delivered_at DESC, a.relative_path"
        )?;
        let rows = statement
            .query_map([project_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(|(asset_id, delivery_id, item_id, path, name, content_type, size, delivered_at)| {
            let mut item_path = Vec::new();
            let mut next = Some(item_id.clone());
            let mut visited = std::collections::HashSet::new();
            while let Some(id) = next.take() {
                if !visited.insert(id.clone()) { break; }
                let item = connection.query_row(
                    "SELECT title, parent_id FROM loop_items WHERE id = ?1 AND resource_type = 'task' AND cloud_project_id = ?2 AND deleted_at IS NULL",
                    params![id, project_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
                ).optional()?;
                let Some((title, parent)) = item else { break; };
                item_path.push(json!({"id": id, "title": title})); next = parent;
            }
            let title = item_path.first().and_then(|item| item["title"].as_str()).unwrap_or(&item_id).to_owned();
            item_path.reverse();
            Ok(json!({"asset_id": asset_id, "delivery_id": delivery_id, "loop_item_id": item_id,
                "loop_item_title": title, "relative_path": path, "display_name": name, "content_type": content_type,
                "size_bytes": size, "delivered_at": delivered_at, "loop_item_path": item_path}))
        }).collect()
    }

    pub fn update_delivery(
        &self,
        delivery_id: &str,
        input: DeliveryUpdate,
    ) -> Result<DeliveryDetail, TaskRuntimeError> {
        let detail = self.delivery_detail(delivery_id)?;
        let invalid = |message: &str| TaskRuntimeError::Invalid(message.to_owned());
        if detail.delivery.status != "delivered" || detail.delivery.version != input.version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if input.title.trim().is_empty() || input.title.chars().count() > 255 {
            return Err(invalid("Delivery title must contain 1 to 255 characters"));
        }
        if input.chat.as_ref().is_some_and(|chat| !chat.is_object()) {
            return Err(invalid("Delivery chat must be an object"));
        }
        if input.markdown.len() > 2 * 1024 * 1024
            || input
                .chat
                .as_ref()
                .is_some_and(|chat| chat.to_string().len() > 10 * 1024 * 1024)
        {
            return Err(invalid("Delivery text is too large"));
        }
        let retained: std::collections::HashSet<_> = input.retained_asset_ids.iter().collect();
        if retained.len() != input.retained_asset_ids.len()
            || retained
                .iter()
                .any(|id| !detail.delivery.assets.iter().any(|asset| &asset.id == *id))
        {
            return Err(invalid("Invalid retained delivery asset"));
        }
        let mut paths: std::collections::HashSet<String> = detail
            .delivery
            .assets
            .iter()
            .filter(|asset| retained.contains(&asset.id))
            .map(|asset| asset.relative_path.clone())
            .collect();
        let mut staged = Vec::new();
        for entry in &input.files {
            let path = normalize_relative_path(&entry.relative_path)?;
            if !paths.insert(path.clone()) {
                return Err(invalid("Duplicate delivery file path"));
            }
            staged.push((numeric_id(), path, decode_binary(&entry.file)?, &entry.file));
        }
        // Fulfillment references must remain valid after editing.
        for fulfillment in &detail.delivery.fulfillments {
            let ids = fulfillment
                .get("asset_ids")
                .and_then(serde_json::Value::as_array);
            if ids
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .any(|id| !retained.contains(&id.to_owned()))
                || fulfillment
                    .get("asset_id")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|id| !retained.contains(&id.to_owned()))
            {
                return Err(invalid(
                    "Cannot remove an asset referenced by a deliverable requirement",
                ));
            }
        }
        let revision_key = format!("deliveries/{delivery_id}/revisions/{}", numeric_id());
        let revision_path = self.resolve_object_key(Path::new(&revision_key))?;
        let obsolete = {
            let connection = self.connection()?;
            let (markdown, chat): (String, Option<String>) = connection.query_row(
                "SELECT markdown_object_key, chat_object_key FROM loop_items WHERE id = ?1 AND resource_type = 'delivery'", [delivery_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
            let mut keys = vec![markdown];
            keys.extend(chat);
            for asset in detail
                .delivery
                .assets
                .iter()
                .filter(|asset| !retained.contains(&asset.id))
            {
                let key = connection.query_row("SELECT object_key FROM loop_items WHERE id = ?1 AND resource_type = 'delivery_asset'", [&asset.id], |row| row.get::<_, String>(0))?;
                keys.push(key);
            }
            keys
        };
        let result = (|| {
            let markdown_key = format!("{revision_key}/markdown.md");
            write_binary(
                &self.resolve_object_key(Path::new(&markdown_key))?,
                input.markdown.as_bytes(),
            )?;
            let chat_key = input
                .chat
                .as_ref()
                .map(|chat| -> Result<String, TaskRuntimeError> {
                    let key = format!("{revision_key}/chat.json");
                    write_binary(
                        &self.resolve_object_key(Path::new(&key))?,
                        &serde_json::to_vec(chat).map_err(|e| invalid(&e.to_string()))?,
                    )?;
                    Ok(key)
                })
                .transpose()?;
            let timestamp = now();
            let mut connection = self.connection()?;
            let transaction = connection.transaction()?;
            let changed = transaction.execute(
                "UPDATE loop_items SET title = ?1, markdown_object_key = ?2, chat_object_key = ?3,
                    version = version + 1, updated_at = ?4
                 WHERE id = ?5 AND resource_type = 'delivery' AND status = 'delivered'
                    AND deleted_at IS NULL AND version = ?6",
                params![
                    input.title.trim(),
                    markdown_key,
                    chat_key,
                    timestamp,
                    delivery_id,
                    input.version
                ],
            )?;
            if changed != 1 {
                return Err(TaskRuntimeError::VersionConflict);
            }
            for asset in &detail.delivery.assets {
                if !retained.contains(&asset.id) {
                    transaction.execute("UPDATE loop_items SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND delivery_id = ?3 AND resource_type = 'delivery_asset'", params![timestamp, asset.id, delivery_id])?;
                }
            }
            for (id, path, bytes, file) in &staged {
                let object_key = format!("{revision_key}/files/{id}");
                write_binary(&self.resolve_object_key(Path::new(&object_key))?, bytes)?;
                transaction.execute(
                    "INSERT INTO loop_items (id, resource_type, project_space, cloud_project_id, loop_item_id,
                        delivery_id, kind, display_name, relative_path, object_key, content_type, size_bytes,
                        sha256, metadata, status, version, created_at, updated_at)
                     SELECT ?1, 'delivery_asset', project_space, cloud_project_id, loop_item_id,
                        id, 'file', ?2, ?3, ?4, ?5, ?6, ?7, metadata, 'delivered', 1, ?8, ?8
                     FROM loop_items WHERE id = ?9 AND resource_type = 'delivery'",
                    params![id, file.display_name, path, object_key, file.content_type, bytes.len() as i64, sha256_hex(bytes), timestamp, delivery_id],
                )?;
            }
            refresh_runtime_projection_additional_context(
                &transaction,
                &detail.delivery.loop_item_id,
            )?;
            transaction.commit()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(revision_path);
        }
        result?;
        for key in obsolete {
            if let Ok(path) = self.resolve_object_key(Path::new(&key)) {
                if let Err(error) = fs::remove_file(path) {
                    eprintln!("Could not remove obsolete delivery object: {error}");
                }
            }
        }
        self.delivery_detail(delivery_id)
    }

    pub fn create_delivery(
        &self,
        project_id: &str,
        item_id: &str,
        persisted_task: bool,
        input: DeliveryCreate,
    ) -> Result<Delivery, TaskRuntimeError> {
        self.get_project(project_id)?;
        if persisted_task {
            self.get_item(item_id, "task")?;
        }
        let id = numeric_id();
        let base_key = format!("deliveries/{id}");
        let markdown_key = format!("{base_key}/markdown.md");
        let markdown_path = self.resolve_object_key(Path::new(&markdown_key))?;
        write_binary(&markdown_path, input.markdown.as_bytes())?;
        let chat_key = input
            .chat
            .as_ref()
            .map(|chat| {
                let key = format!("{base_key}/chat.json");
                let path = self.resolve_object_key(Path::new(&key))?;
                let bytes = serde_json::to_vec_pretty(chat)
                    .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
                write_binary(&path, &bytes)?;
                Ok::<_, TaskRuntimeError>(key)
            })
            .transpose()?;
        let source_binding = input
            .source_task
            .as_ref()
            .map(|task| self.find_task_binding(&task.device_id, &task.task_id))
            .transpose()?;
        if source_binding.as_ref().is_some_and(|binding| {
            binding.cloud_project_id != project_id
                || binding.loop_item_id.as_deref() != Some(item_id)
        }) {
            return Err(TaskRuntimeError::Invalid(
                "source Runtime task is not bound to this Issue".to_owned(),
            ));
        }
        let source_binding_id = source_binding.map(|binding| binding.id);
        let source_snapshot = input
            .source_task
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        let timestamp = now();
        let loop_item_id = persisted_task.then_some(item_id);
        let metadata = json!({
            "external_item_id": (!persisted_task).then_some(item_id),
        });
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, loop_item_id,
                source_task_binding_id, source_task_snapshot, markdown_object_key,
                chat_object_key, metadata, status, version, created_at, updated_at, title
             ) VALUES (?1, 'delivery', 'default', ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                       'draft', 1, ?9, ?9, ?10)",
            params![
                id,
                project_id,
                loop_item_id,
                source_binding_id,
                source_snapshot.map(|value| value.to_string()),
                markdown_key,
                chat_key,
                metadata.to_string(),
                timestamp,
                input.title.trim(),
            ],
        )?;
        if persisted_task {
            refresh_runtime_projection_additional_context(&connection, item_id)?;
        }
        drop(connection);
        self.get_delivery(item_id, &id)
    }

    pub fn add_delivery_asset(
        &self,
        delivery_id: &str,
        relative_path: &str,
        input: BinaryInput,
    ) -> Result<DeliveryAsset, TaskRuntimeError> {
        let (project_id, loop_item_id, external_item_id, status): (
            String,
            Option<String>,
            Option<String>,
            String,
        ) = {
            let connection = self.connection()?;
            connection.query_row(
                "SELECT cloud_project_id, loop_item_id,
                        json_extract(metadata, '$.external_item_id'), status
                 FROM loop_items
                 WHERE id = ?1 AND resource_type = 'delivery' AND deleted_at IS NULL",
                [delivery_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?
        };
        if status != "draft" {
            return Err(TaskRuntimeError::Invalid(
                "delivery is already delivered".to_owned(),
            ));
        }
        let relative_path = normalize_relative_path(relative_path)?;
        let bytes = decode_binary(&input)?;
        let id = numeric_id();
        let object_key = format!("deliveries/{delivery_id}/{relative_path}");
        let object_path = self.resolve_object_key(Path::new(&object_key))?;
        write_binary(&object_path, &bytes)?;
        let timestamp = now();
        let metadata = json!({"external_item_id": external_item_id});
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO loop_items (
                id, resource_type, project_space, cloud_project_id, loop_item_id,
                delivery_id, kind, display_name, relative_path, object_key,
                content_type, size_bytes, sha256, metadata, status, version, created_at, updated_at
             ) VALUES (?1, 'delivery_asset', 'default', ?2, ?3, ?4, 'file', ?5, ?6,
                       ?7, ?8, ?9, ?10, ?11, 'draft', 1, ?12, ?12)",
            params![
                id,
                project_id,
                loop_item_id,
                delivery_id,
                input.display_name,
                relative_path,
                object_key,
                input.content_type,
                bytes.len() as i64,
                sha256_hex(&bytes),
                metadata.to_string(),
                timestamp,
            ],
        )?;
        drop(connection);
        self.get_delivery_asset(&id)
    }

    pub fn finalize_delivery(
        &self,
        item_id: &str,
        delivery_id: &str,
        input: DeliveryFinalize,
    ) -> Result<Delivery, TaskRuntimeError> {
        self.get_delivery(item_id, delivery_id)?;
        let timestamp = now();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let is_human_collaboration_assignment = transaction
            .query_row(
                "SELECT COALESCE(
                            json_extract(
                                metadata,
                                '$.collaboration_assignment.assignee_type'
                            ) = 'human',
                            0
                        )
                 FROM loop_items
                 WHERE id = ?1 AND resource_type = 'task' AND deleted_at IS NULL",
                [item_id],
                |row| row.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false);
        let (source_binding_id, delivery_metadata): (Option<String>, String) = transaction
            .query_row(
                "SELECT source_task_binding_id, metadata FROM loop_items
             WHERE id = ?1 AND resource_type = 'delivery' AND status = 'draft'",
                [delivery_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
        let binding_identity = source_binding_id
            .as_deref()
            .map(|binding_id| {
                transaction.query_row(
                    "SELECT json_extract(binding.metadata, '$.workflow_node_id'),
                            json_extract(binding.metadata, '$.human_assignment_id'),
                            (
                                SELECT execution.execution_payload
                                FROM loop_item_executions execution
                                WHERE execution.runtime_device_id = binding.device_id
                                  AND execution.runtime_task_id = binding.task_id
                                ORDER BY execution.id DESC
                                LIMIT 1
                            )
                     FROM loop_items binding
                     WHERE binding.id = ?1 AND binding.resource_type = 'execution'
                       AND binding.unlinked_at IS NULL",
                    [binding_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
            })
            .transpose()?;
        let workflow_node_id = binding_identity
            .as_ref()
            .and_then(|(node_id, _, _)| node_id.clone());
        let binding_human_assignment_id = binding_identity
            .as_ref()
            .and_then(|(_, human_assignment_id, _)| human_assignment_id.clone());
        // The item that closes the collaboration round when this delivery is
        // finalized: the work item itself, the assignment recorded on the
        // personal task binding, or - for a personal task started without a
        // recorded dispatch - the single open human assignment of the Issue.
        let candidate_assignment: Option<String> = if is_human_collaboration_assignment {
            Some(item_id.to_owned())
        } else if let Some(human_assignment_id) = binding_human_assignment_id {
            Some(human_assignment_id)
        } else if binding_identity
            .as_ref()
            .is_some_and(|(_, _, payload)| payload.is_none())
        {
            open_human_assignment_for(&transaction, item_id)?
        } else {
            None
        };
        let human_assignment_item = candidate_assignment
            .as_deref()
            .map(|assignment_id| {
                transaction.query_row(
                    "SELECT id FROM loop_items
                     WHERE id = ?1 AND resource_type = 'task' AND deleted_at IS NULL
                       AND json_extract(metadata, '$.collaboration_assignment.assignee_type') = 'human'
                       AND COALESCE(status, '') != 'completed' AND current_delivery_id IS NULL
                       AND (id = ?2 OR parent_id = ?2)",
                    params![assignment_id, item_id],
                    |row| row.get::<_, String>(0),
                ).optional()
            })
            .transpose()?
            .flatten();
        if is_human_collaboration_assignment && human_assignment_item.is_none() {
            return Err(TaskRuntimeError::Invalid(
                "human assignment is already completed".to_owned(),
            ));
        }
        let mut delivery_metadata =
            serde_json::from_str::<serde_json::Value>(&delivery_metadata)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        delivery_metadata["fulfillments"] = json!(input.fulfillments);
        let next_metadata = workflow_node_id
            .as_deref()
            .map(|node_id| {
                transaction
                    .query_row(
                        "SELECT metadata FROM loop_items
                     WHERE id = ?1 AND resource_type = 'task' AND deleted_at IS NULL",
                        [item_id],
                        |row| row.get::<_, String>(0),
                    )
                    .and_then(|metadata| {
                        serde_json::from_str::<serde_json::Value>(&metadata).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                metadata.len(),
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })
                    })
                    .and_then(|metadata| {
                        attach_delivery_to_workflow(
                            metadata,
                            node_id,
                            delivery_id,
                            delivery_metadata["fulfillments"]
                                .as_array()
                                .map(Vec::as_slice)
                                .unwrap_or_default(),
                        )
                        .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))
                    })
            })
            .transpose()?;
        transaction.execute(
            "UPDATE loop_items SET status = 'delivered', delivered_at = ?1, updated_at = ?1,
                    metadata = ?2
             WHERE id = ?3 AND resource_type = 'delivery'",
            params![timestamp, delivery_metadata.to_string(), delivery_id],
        )?;
        transaction.execute(
            "UPDATE loop_items SET status = 'delivered', updated_at = ?1
             WHERE delivery_id = ?2 AND resource_type = 'delivery_asset'",
            params![timestamp, delivery_id],
        )?;
        if let Some(metadata) = next_metadata {
            transaction.execute(
                "UPDATE loop_items
                 SET current_delivery_id = ?1, metadata = ?2, version = version + 1,
                     updated_at = ?3
                 WHERE id = ?4",
                params![delivery_id, metadata.to_string(), timestamp, item_id],
            )?;
        } else if !is_human_collaboration_assignment {
            transaction.execute(
                "UPDATE loop_items SET current_delivery_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![delivery_id, timestamp, item_id],
            )?;
        }
        let settled_assignment =
            if let Some(human_assignment_item) = human_assignment_item.as_deref() {
                let changed = transaction.execute(
                    "UPDATE loop_items
                 SET current_delivery_id = ?1, status = 'completed',
                     completed_at = ?2,
                     metadata = json_set(metadata, '$.is_unread', json('true')),
                     version = version + 1, updated_at = ?2
                 WHERE id = ?3 AND resource_type = 'task' AND deleted_at IS NULL
                   AND json_extract(metadata, '$.collaboration_assignment.assignee_type') = 'human'
                   AND COALESCE(status, '') != 'completed'
                   AND (id = ?4 OR parent_id = ?4)",
                    params![delivery_id, timestamp, human_assignment_item, item_id],
                )?;
                (changed > 0).then_some(human_assignment_item.to_owned())
            } else {
                None
            };
        transaction.commit()?;
        drop(connection);
        let delivery = self.get_delivery(item_id, delivery_id)?;
        if let Some(human_assignment_item) = settled_assignment {
            self.resume_manager_for_human_delivery(&human_assignment_item)?;
        }
        Ok(delivery)
    }

    pub fn discard_delivery(&self, delivery_id: &str) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let item_id = connection
            .query_row(
                "SELECT loop_item_id FROM loop_items
                 WHERE id = ?1 AND resource_type = 'delivery'",
                [delivery_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        connection.execute(
            "UPDATE loop_items SET deleted_at = ?1, updated_at = ?1
             WHERE (id = ?2 AND resource_type = 'delivery')
                OR (delivery_id = ?2 AND resource_type = 'delivery_asset')",
            params![now(), delivery_id],
        )?;
        if let Some(item_id) = item_id {
            refresh_runtime_projection_additional_context(&connection, &item_id)?;
        }
        let _ = fs::remove_dir_all(self.binary_root()?.join("deliveries").join(delivery_id));
        Ok(())
    }

    pub fn list_deliveries(&self, item_id: &str) -> Result<Vec<Delivery>, TaskRuntimeError> {
        let connection = self.connection()?;
        let ids = {
            let mut statement = connection.prepare(
                "SELECT id FROM loop_items
                 WHERE resource_type = 'delivery'
                   AND (loop_item_id = ?1 OR json_extract(metadata, '$.external_item_id') = ?1)
                   AND deleted_at IS NULL ORDER BY created_at DESC",
            )?;
            let ids = statement
                .query_map([item_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        drop(connection);
        ids.into_iter()
            .map(|id| self.get_delivery(item_id, &id))
            .collect()
    }

    pub fn delivery_detail(&self, delivery_id: &str) -> Result<DeliveryDetail, TaskRuntimeError> {
        let (item_id, markdown_path, chat_path): (String, String, Option<String>) = {
            let connection = self.connection()?;
            connection.query_row(
                "SELECT COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                        markdown_object_key, chat_object_key
                 FROM loop_items WHERE id = ?1 AND resource_type = 'delivery'
                   AND deleted_at IS NULL",
                [delivery_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?
        };
        let delivery = self.get_delivery(&item_id, delivery_id)?;
        let markdown = fs::read_to_string(self.resolve_object_key(Path::new(&markdown_path))?)
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        let chat = chat_path
            .map(|path| self.resolve_object_key(Path::new(&path)))
            .transpose()?
            .map(fs::read_to_string)
            .transpose()
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?
            .map(|content| serde_json::from_str(&content))
            .transpose()
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        Ok(DeliveryDetail {
            delivery,
            markdown,
            chat,
        })
    }

    pub fn delivery_asset_path(&self, asset_id: &str) -> Result<PathBuf, TaskRuntimeError> {
        self.object_path(asset_id, "delivery_asset")
    }

    fn get_delivery(&self, item_id: &str, delivery_id: &str) -> Result<Delivery, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut delivery = connection
            .query_row(
                "SELECT id,
                        COALESCE(loop_item_id, json_extract(metadata, '$.external_item_id')),
                        source_task_binding_id, source_task_snapshot,
                        status, created_at, delivered_at, metadata, title, version
                 FROM loop_items
                 WHERE id = ?1 AND resource_type = 'delivery'
                   AND (loop_item_id = ?2 OR json_extract(metadata, '$.external_item_id') = ?2)
                   AND deleted_at IS NULL",
                params![delivery_id, item_id],
                map_delivery,
            )
            .optional()?
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let mut statement = connection.prepare(
            "SELECT id, kind, display_name, relative_path, content_type, size_bytes, sha256
             FROM loop_items WHERE resource_type = 'delivery_asset' AND delivery_id = ?1
               AND deleted_at IS NULL ORDER BY relative_path",
        )?;
        delivery.assets = statement
            .query_map([delivery_id], map_delivery_asset)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(delivery)
    }

    fn get_delivery_asset(&self, asset_id: &str) -> Result<DeliveryAsset, TaskRuntimeError> {
        let connection = self.connection()?;
        connection
            .query_row(
                "SELECT id, kind, display_name, relative_path, content_type, size_bytes, sha256
                 FROM loop_items WHERE id = ?1 AND resource_type = 'delivery_asset'
                   AND deleted_at IS NULL",
                [asset_id],
                map_delivery_asset,
            )
            .optional()?
            .ok_or(TaskRuntimeError::TaskNotFound)
    }
}
