use super::*;

impl LocalTaskStore {
    pub fn archive_task(&self, project_id: &str, task_id: &str) -> Result<(), TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let owner = work_container_from(&transaction, project_id)?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        if owner.resource_type == "chat_group" {
            chat_groups::local_group(&transaction, project_id, true)?;
        }
        let parent_id: Option<String> = transaction
            .query_row(
                "SELECT parent_id FROM loop_items
                 WHERE id = ?1 AND resource_type = 'task'
                   AND cloud_project_id = ?2 AND deleted_at IS NULL",
                params![task_id, project_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let subtree_ids: Vec<String> = {
            let mut statement = transaction.prepare(
                "WITH RECURSIVE task_tree(id) AS (
                 SELECT id FROM loop_items
                 WHERE id = ?1 AND resource_type = 'task'
                   AND cloud_project_id = ?2 AND deleted_at IS NULL
                 UNION ALL
                 SELECT child.id FROM loop_items child
                 JOIN task_tree parent ON child.parent_id = parent.id
                 WHERE child.resource_type = 'task'
                   AND child.cloud_project_id = ?2 AND child.deleted_at IS NULL
             )
             SELECT id FROM task_tree",
            )?;
            let rows = statement.query_map(params![task_id, project_id], |row| row.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for id in subtree_ids {
            cancel_active_executions(
                &transaction,
                &id,
                "Issue was archived before the run finished",
                "Stop the active Runtime task before archiving this Issue",
            )?;
        }
        let archived_at = now();
        let updated = transaction.execute(
            "WITH RECURSIVE task_tree(id) AS (
                 SELECT id FROM loop_items
                 WHERE id = ?1 AND resource_type = 'task'
                   AND cloud_project_id = ?2 AND deleted_at IS NULL
                 UNION ALL
                 SELECT child.id FROM loop_items child
                 JOIN task_tree parent ON child.parent_id = parent.id
                 WHERE child.resource_type = 'task'
                   AND child.cloud_project_id = ?2 AND child.deleted_at IS NULL
             )
             UPDATE loop_items
             SET deleted_at = ?3, updated_at = ?3, version = version + 1
             WHERE id IN (SELECT id FROM task_tree)",
            params![task_id, project_id, archived_at],
        )?;
        if updated == 0 {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        if let Some(parent_id) = parent_id.as_deref() {
            refresh_runtime_projection_additional_context(&transaction, parent_id)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn list_archived_tasks(
        &self,
        project_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<ArchivedLoopItemPage, TaskRuntimeError> {
        let owner = self.get_work_container(project_id)?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(&format!(
            "SELECT item.id, item.resource_type, item.project_space, item.cloud_project_id,
                    item.parent_id, item.public_id, item.project_key, item.name, item.title,
                    item.description, item.sequence_number, item.next_item_number, item.status,
                    item.priority, item.sort_order, item.current_delivery_id, item.metadata,
                    item.version, item.created_at, item.updated_at, item.completed_at,
                    item.assignee_agent_id, item.created_by_user_id, item.assignee_user_id,
                    item.deleted_at
             FROM loop_items item
             LEFT JOIN loop_items parent ON parent.id = item.parent_id
             WHERE item.resource_type = 'task' AND {}
               AND item.deleted_at IS NOT NULL
               AND (
                   item.parent_id IS NULL OR item.parent_id = '' OR parent.id IS NULL
                   OR parent.deleted_at IS NULL OR parent.deleted_at != item.deleted_at
               )
             ORDER BY item.deleted_at DESC, item.id DESC
             LIMIT ?3 OFFSET ?4",
            thread_project_links::project_task_scope("item"),
        ))?;
        let rows = statement.query_map(
            params![
                project_id,
                owner.resource_type == "project",
                limit.saturating_add(1),
                offset
            ],
            |row| {
                Ok(ArchivedLoopItem {
                    item: map_loop_item(&connection, row)?,
                    archived_at: row.get(24)?,
                })
            },
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        for archived in &mut items {
            chat_groups::annotate_threads(&connection, std::slice::from_mut(&mut archived.item))?;
        }
        Ok(ArchivedLoopItemPage {
            items,
            next_cursor: has_more.then(|| offset.saturating_add(limit).to_string()),
        })
    }

    pub fn restore_task(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let owner = work_container_from(&transaction, project_id)?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        if owner.resource_type == "chat_group" {
            chat_groups::local_group(&transaction, project_id, true)?;
        }
        let (archived_at, parent_id): (String, Option<String>) = transaction
            .query_row(
                "SELECT item.deleted_at, item.parent_id
                 FROM loop_items item
                 LEFT JOIN loop_items parent ON parent.id = item.parent_id
                 WHERE item.id = ?1 AND item.resource_type = 'task'
                   AND item.cloud_project_id = ?2 AND item.deleted_at IS NOT NULL
                   AND (
                       item.parent_id IS NULL OR item.parent_id = '' OR parent.id IS NULL
                       OR parent.deleted_at IS NULL OR parent.deleted_at != item.deleted_at
                   )",
                params![task_id, project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let restored_ids = {
            let mut statement = transaction.prepare(
                "WITH RECURSIVE task_tree(id) AS (
                     SELECT id FROM loop_items
                     WHERE id = ?1 AND resource_type = 'task'
                       AND cloud_project_id = ?2 AND deleted_at = ?3
                     UNION ALL
                     SELECT child.id FROM loop_items child
                     JOIN task_tree parent ON child.parent_id = parent.id
                     WHERE child.resource_type = 'task'
                       AND child.cloud_project_id = ?2 AND child.deleted_at = ?3
                 )
                 SELECT id FROM task_tree",
            )?;
            let restored_ids = statement
                .query_map(params![task_id, project_id, archived_at], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<Result<HashSet<_>, _>>()?;
            restored_ids
        };
        let updated = transaction.execute(
            "WITH RECURSIVE task_tree(id) AS (
                 SELECT id FROM loop_items
                 WHERE id = ?1 AND resource_type = 'task'
                   AND cloud_project_id = ?2 AND deleted_at = ?3
                 UNION ALL
                 SELECT child.id FROM loop_items child
                 JOIN task_tree parent ON child.parent_id = parent.id
                 WHERE child.resource_type = 'task'
                   AND child.cloud_project_id = ?2 AND child.deleted_at = ?3
             )
             UPDATE loop_items
             SET deleted_at = NULL, updated_at = ?4, version = version + 1
             WHERE id IN (SELECT id FROM task_tree)",
            params![task_id, project_id, archived_at, now()],
        )?;
        if updated == 0 {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        if let Some(parent_id) = parent_id.as_deref() {
            refresh_runtime_projection_additional_context(&transaction, parent_id)?;
        }
        transaction.commit()?;
        drop(connection);
        self.list_tasks(project_id).map(|items| {
            items
                .into_iter()
                .filter(|item| restored_ids.contains(&item.id))
                .collect()
        })
    }

    pub fn reorder_tasks(
        &self,
        project_id: &str,
        input: TaskReorder,
    ) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        if input.item_ids.is_empty() {
            return Err(TaskRuntimeError::Invalid(
                "item_ids must contain at least one task".to_owned(),
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project = work_container_from(&transaction, project_id)?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        if project.resource_type == "chat_group" {
            chat_groups::local_group(&transaction, project_id, true)?;
        }
        if let Some(status) = &input.status {
            project_status::validate(&project.metadata, status)?;
        }
        if task_provider(&project)? != TaskProviderKind::Local {
            return Err(TaskRuntimeError::UnsupportedProvider("external".to_owned()));
        }
        let siblings = ordering::siblings(&transaction, project_id, input.parent_id.as_deref())?;
        let lane = siblings
            .iter()
            .filter(|(_, status)| input.status.as_ref().map_or(true, |scope| scope == status))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut seen = HashSet::new();
        let mut ordered_ids = input
            .item_ids
            .into_iter()
            .filter(|id| lane.contains(id) && seen.insert(id.clone()))
            .collect::<Vec<_>>();
        if ordered_ids.is_empty() {
            return Err(TaskRuntimeError::Invalid(
                "task not found in lane".to_owned(),
            ));
        }
        ordered_ids.extend(lane.iter().filter(|id| !seen.contains(*id)).cloned());
        let mut ordered_lane = ordered_ids.iter();
        let global_ids = siblings
            .into_iter()
            .map(|(id, _)| {
                if lane.contains(&id) {
                    ordered_lane
                        .next()
                        .expect("all lane positions are present")
                        .clone()
                } else {
                    id
                }
            })
            .collect::<Vec<_>>();
        ordering::persist(&transaction, &global_ids, None)?;
        transaction.commit()?;
        drop(connection);
        let by_id = self
            .list_tasks(project_id)?
            .into_iter()
            .map(|item| (item.id.clone(), item))
            .collect::<std::collections::HashMap<_, _>>();
        Ok(ordered_ids
            .into_iter()
            .filter_map(|id| by_id.get(&id).cloned())
            .collect())
    }
}
