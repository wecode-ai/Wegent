use super::*;

impl LocalTaskStore {
    /// Page across local projects in one query, with batched task bindings.
    pub fn my_work_page(
        &self,
        limit: usize,
        cursor: Option<&str>,
        assigned_only: bool,
        include_completed: bool,
        viewer_ids: &[i64],
    ) -> Result<Value, TaskRuntimeError> {
        if !(1..=100).contains(&limit) {
            return Err(TaskRuntimeError::Invalid(
                "My work limit must be 1..100".into(),
            ));
        }
        let before: Option<(String, String)> = cursor
            .map(serde_json::from_str)
            .transpose()
            .map_err(|error| {
                TaskRuntimeError::Invalid(format!("Invalid My work cursor: {error}"))
            })?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT t.id,t.resource_type,t.project_space,t.cloud_project_id,t.parent_id,
                    t.public_id,t.project_key,t.name,t.title,t.description,t.sequence_number,
                    t.next_item_number,t.status,t.priority,t.sort_order,t.current_delivery_id,
                    t.metadata,t.version,t.created_at,t.updated_at,t.completed_at,
                    t.assignee_agent_id,t.created_by_user_id,t.assignee_user_id,p.project_key,p.name
             FROM loop_items t JOIN loop_items p ON p.id=t.cloud_project_id
             WHERE t.resource_type='task' AND t.deleted_at IS NULL
               AND p.resource_type='project' AND p.deleted_at IS NULL AND p.status='active'
               AND p.id<>?1 AND COALESCE(json_extract(p.metadata,'$.task_provider'),'local')='local'
               AND json_extract(t.metadata,'$.archived_at') IS NULL
               AND (?2=0 OR t.assignee_user_id IN (SELECT value FROM json_each(?7)))
               AND (?3=1 OR t.status NOT IN ('completed','cancelled'))
               AND (?4 IS NULL OR t.updated_at<?4 OR (t.updated_at=?4 AND t.id<?5))
             ORDER BY t.updated_at DESC,t.id DESC LIMIT ?6",
        )?;
        let mut rows = statement
            .query_map(
                params![
                    DEFAULT_WORK_ITEM_PROJECT_ID,
                    assigned_only,
                    include_completed,
                    before.as_ref().map(|value| &value.0),
                    before.as_ref().map(|value| &value.1),
                    limit + 1,
                    json!(viewer_ids).to_string()
                ],
                |row| {
                    Ok((
                        projections::map_loop_item_fields(row)?,
                        row.get::<_, String>(24)?,
                        row.get::<_, String>(25)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let next_cursor = if has_more {
            rows.last()
                .map(|(item, _, _)| json!([item.updated_at, item.id]).to_string())
        } else {
            None
        };
        let ids = rows
            .iter()
            .map(|(item, _, _)| item.id.clone())
            .collect::<Vec<_>>();
        let mut bindings_by_issue: HashMap<String, Vec<TaskBinding>> = HashMap::new();
        for binding in Self::list_task_bindings_from(&connection, &ids)? {
            if viewer_ids.contains(&binding.task_user_id) {
                if let Some(issue_id) = binding.loop_item_id.clone() {
                    bindings_by_issue.entry(issue_id).or_default().push(binding);
                }
            }
        }
        let mut executions = projections::latest_executions_for_items(&connection, &ids)?;
        let items = rows
            .into_iter()
            .map(|(item, project_key, project_name)| {
                let bindings = bindings_by_issue.remove(&item.id).unwrap_or_default();
                let execution = executions.remove(&item.id);
                json!({
                    "issue": attach_execution(item, execution),
                    "project_key": project_key,
                    "project_name": project_name,
                    "task_bindings": bindings,
                    "assignment_context": null
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({"items":items,"next_cursor":next_cursor}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_all_local_projects_without_losing_equal_timestamp_items() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("work.sqlite")).unwrap();
        for name in ["First", "Second"] {
            let project = store
                .create_project(serde_json::from_value(json!({"name":name})).unwrap())
                .unwrap();
            for index in 0..18 {
                store
                    .create_task(
                        &project.id,
                        serde_json::from_value(json!({"title":format!("{name} {index}")})).unwrap(),
                    )
                    .unwrap();
            }
        }
        let first = store.my_work_page(30, None, false, true, &[0]).unwrap();
        let next = first["next_cursor"].as_str().unwrap();
        let second = store
            .my_work_page(30, Some(next), false, true, &[0])
            .unwrap();
        let ids = first["items"]
            .as_array()
            .unwrap()
            .iter()
            .chain(second["items"].as_array().unwrap())
            .map(|item| item["issue"]["id"].as_str().unwrap())
            .collect::<HashSet<_>>();
        assert_eq!(first["items"].as_array().unwrap().len(), 30);
        assert_eq!(second["items"].as_array().unwrap().len(), 6);
        assert_eq!(ids.len(), 36);
        assert!(second["next_cursor"].is_null());
        assert!(store.my_work_page(101, None, false, true, &[0]).is_err());
        assert!(store
            .my_work_page(30, Some("invalid"), false, true, &[0])
            .is_err());
    }

    #[test]
    fn assignment_scope_honors_local_identity_aliases_and_completion_filter() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("scope.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Scope"})).unwrap())
            .unwrap();
        for (owner, status) in [
            (0, "pending"),
            (7, "pending"),
            (9, "pending"),
            (0, "completed"),
        ] {
            let task = store
                .create_task(
                    &project.id,
                    serde_json::from_value(json!({"title":"Work"})).unwrap(),
                )
                .unwrap();
            store
                .connection()
                .unwrap()
                .execute(
                    "UPDATE loop_items SET assignee_user_id=?1,status=?2 WHERE id=?3",
                    params![owner, status, task.id],
                )
                .unwrap();
        }
        let page = store.my_work_page(30, None, true, false, &[0, 7]).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 2);
        assert!(page["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| [json!(0), json!(7)].contains(&row["issue"]["assignee_user_id"])));
        assert_eq!(
            store.my_work_page(30, None, false, true, &[0]).unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }
}
