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
        order: &str,
    ) -> Result<Value, TaskRuntimeError> {
        if !(1..=100).contains(&limit) {
            return Err(TaskRuntimeError::Invalid(
                "My work limit must be 1..100".into(),
            ));
        }
        let sort_mode = match order {
            "recent" => 0,
            "attention" => 1,
            "activity" => 2,
            "assignment" => 3,
            "priority" => 4,
            _ => return Err(TaskRuntimeError::Invalid("Invalid My work sort".into())),
        };
        let attention = sort_mode != 0;
        let before: Option<(i64, i64, String, String, String)> = cursor
            .map(serde_json::from_str)
            .transpose()
            .map_err(|error| {
                TaskRuntimeError::Invalid(format!("Invalid My work cursor: {error}"))
            })?;
        if before.as_ref().is_some_and(|key| {
            key.4 != order || !(0..=4).contains(&key.0) || !(0..=4).contains(&key.1)
        }) {
            return Err(TaskRuntimeError::Invalid(
                "Invalid My work ordering key".into(),
            ));
        }
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "WITH work AS (
             SELECT t.id,t.resource_type,t.project_space,t.cloud_project_id,t.parent_id,
                    t.public_id,t.project_key,t.name,t.title,t.description,t.sequence_number,
                    t.next_item_number,t.status,t.priority,t.sort_order,t.current_delivery_id,
                    t.metadata,t.version,t.created_at,t.updated_at,t.completed_at,
                    t.assignee_agent_id,t.created_by_user_id,t.assignee_user_id,p.project_key AS home_project_key,p.name AS home_project_name,
                    CASE WHEN ?8=0 THEN 0
                         WHEN t.status IN ('completed','cancelled','archived') THEN 4
                         WHEN ?8=3 THEN CASE WHEN json_extract(t.metadata,'$.assignment_history[#-1].to_type')='user' AND CAST(json_extract(t.metadata,'$.assignment_history[#-1].to_id') AS TEXT) IN (SELECT CAST(value AS TEXT) FROM json_each(?7)) AND json_extract(t.metadata,'$.assignment_history[#-1].at') IS NOT NULL THEN 0 ELSE 3 END
                         WHEN ?8 IN (2,4) THEN 0
                         WHEN EXISTS(SELECT 1 FROM loop_items h WHERE h.resource_type='human_request_index' AND h.parent_id=t.id AND h.assignee_user_id IN (SELECT value FROM json_each(?7)))
                           OR (t.status='in_review' AND t.assignee_user_id IN (SELECT value FROM json_each(?7)))
                           OR ((SELECT status FROM loop_item_executions e WHERE e.loop_item_id=t.id ORDER BY e.id DESC LIMIT 1)='pending_approval' AND EXISTS(SELECT 1 FROM loop_items a WHERE a.id=t.assignee_agent_id AND a.created_by_user_id IN (SELECT value FROM json_each(?7)))) THEN 0
                         WHEN ?2=1 AND t.status IN ('inbox','pending') AND t.assignee_user_id IN (SELECT value FROM json_each(?7))
                           AND NOT EXISTS(SELECT 1 FROM loop_item_executions e WHERE e.loop_item_id=t.id)
                           AND NOT EXISTS(SELECT 1 FROM loop_items b WHERE b.resource_type='execution' AND b.loop_item_id=t.id AND b.task_user_id IN (SELECT value FROM json_each(?7)) AND b.unlinked_at IS NULL) THEN 1
                         WHEN ?2=1 AND (t.status='in_progress' OR (SELECT status FROM loop_item_executions e WHERE e.loop_item_id=t.id ORDER BY e.id DESC LIMIT 1) IN ('queued','claimed','running','cancel_requested')) THEN 2
                         ELSE 3 END AS attention_rank,
                    CASE WHEN ?8 IN (0,2,3) OR (?8=1 AND ?2=0) THEN 0 ELSE CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END END AS attention_priority,
                    CASE WHEN ?8=3 THEN COALESCE(CASE WHEN json_extract(t.metadata,'$.assignment_history[#-1].to_type')='user' AND CAST(json_extract(t.metadata,'$.assignment_history[#-1].to_id') AS TEXT) IN (SELECT CAST(value AS TEXT) FROM json_each(?7)) THEN json_extract(t.metadata,'$.assignment_history[#-1].at') END,'9999-01-01T00:00:00+00:00') WHEN ?8=0 THEN t.updated_at ELSE MAX(t.updated_at,
                      COALESCE((SELECT MAX(c.created_at) FROM loop_item_comments c WHERE c.task_id=t.id AND c.deleted_at IS NULL),t.updated_at),
                      COALESCE((SELECT MAX(e.completed_at) FROM loop_item_executions e WHERE e.loop_item_id=t.id AND e.status IN ('completed','failed','cancelled')),t.updated_at)) END AS activity_at
             FROM loop_items t JOIN loop_items p ON p.id=t.cloud_project_id
             WHERE t.resource_type='task' AND t.deleted_at IS NULL
               AND p.resource_type='project' AND p.deleted_at IS NULL AND p.status='active'
               AND p.id<>?1 AND COALESCE(json_extract(p.metadata,'$.task_provider'),'local')='local'
               AND json_extract(t.metadata,'$.archived_at') IS NULL
               AND (?2=0 OR t.assignee_user_id IN (SELECT value FROM json_each(?7)))
               AND (COALESCE(t.created_by_user_id,0) IN (SELECT value FROM json_each(?7))
                 OR t.assignee_user_id IN (SELECT value FROM json_each(?7))
                 OR EXISTS(SELECT 1 FROM loop_items b WHERE b.resource_type='execution'
                   AND b.loop_item_id=t.id AND b.cloud_project_id=t.cloud_project_id
                   AND b.task_user_id IN (SELECT value FROM json_each(?7))
                   AND b.unlinked_at IS NULL AND b.deleted_at IS NULL)
                 OR EXISTS(SELECT 1 FROM loop_items a WHERE a.resource_type='chat_agent'
                   AND a.id=t.assignee_agent_id AND a.cloud_project_id=t.cloud_project_id
                   AND COALESCE(a.created_by_user_id,0) IN (SELECT value FROM json_each(?7))
                   AND a.status='active' AND a.deleted_at IS NULL)
                 OR EXISTS(SELECT 1 FROM loop_item_comments c WHERE c.task_id=t.id
                   AND c.project_id=t.cloud_project_id AND c.sender_type='user'
                   AND c.sender_id IN (SELECT CAST(value AS TEXT) FROM json_each(?7))
                   AND c.deleted_at IS NULL)
                 OR EXISTS(SELECT 1 FROM loop_items h WHERE h.resource_type='human_request_index'
                   AND h.parent_id=t.id AND h.assignee_user_id IN (SELECT value FROM json_each(?7))))
               AND (?3=1 OR t.status NOT IN ('completed','cancelled'))
             ) SELECT * FROM work
             WHERE ?4 IS NULL OR attention_rank>?9
               OR (attention_rank=?9 AND attention_priority>?10)
               OR (attention_rank=?9 AND attention_priority=?10 AND ((?8=3 AND activity_at>?4) OR (?8<>3 AND activity_at<?4) OR (activity_at=?4 AND id<?5)))
             ORDER BY attention_rank,attention_priority,CASE WHEN ?8=3 THEN activity_at END ASC,CASE WHEN ?8<>3 THEN activity_at END DESC,id DESC LIMIT ?6",
        )?;
        let mut rows = statement
            .query_map(
                params![
                    DEFAULT_WORK_ITEM_PROJECT_ID,
                    assigned_only,
                    include_completed,
                    before.as_ref().map(|value| &value.2),
                    before.as_ref().map(|value| &value.3),
                    limit + 1,
                    json!(viewer_ids).to_string(),
                    sort_mode,
                    before.as_ref().map(|value| value.0),
                    before.as_ref().map(|value| value.1)
                ],
                |row| {
                    Ok((
                        projections::map_loop_item_fields(row)?,
                        row.get::<_, String>(24)?,
                        row.get::<_, String>(25)?,
                        row.get::<_, i64>(26)?,
                        row.get::<_, i64>(27)?,
                        row.get::<_, String>(28)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let next_cursor = if has_more {
            rows.last().map(|(item, _, _, rank, priority, activity)| {
                json!([rank, priority, activity, item.id, order]).to_string()
            })
        } else {
            None
        };
        let ids = rows
            .iter()
            .map(|(item, ..)| item.id.clone())
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
            .map(
                |(item, project_key, project_name, rank, priority, activity)| {
                    let bindings = bindings_by_issue.remove(&item.id).unwrap_or_default();
                    let execution = executions.remove(&item.id);
                    json!({
                        "issue": attach_execution(item, execution),
                        "project_key": project_key,
                        "project_name": project_name,
                        "task_bindings": bindings,
                        "assignment_context": null,
                        "attention_order": attention.then_some(json!([rank,priority,activity]))
                    })
                },
            )
            .collect::<Vec<_>>();
        Ok(json!({"items":items,"next_cursor":next_cursor}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn participating_filters_relations_before_pagination_and_excludes_expired_relations() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("participating.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Participation"})).unwrap())
            .unwrap();
        let agent = store
            .create_chat_agent(
                &project.id,
                serde_json::from_value(json!({"name":"owned-agent"})).unwrap(),
            )
            .unwrap();
        let mut ids = Vec::new();
        for index in 0..8 {
            let issue = store
                .create_task(
                    &project.id,
                    serde_json::from_value(json!({"title":format!("Work {index}")})).unwrap(),
                )
                .unwrap();
            store
                .connection()
                .unwrap()
                .execute(
                    "UPDATE loop_items SET created_by_user_id=99,assignee_user_id=NULL WHERE id=?1",
                    [&issue.id],
                )
                .unwrap();
            ids.push(issue.id);
        }
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_items SET created_by_user_id=7 WHERE id=?1",
                [&ids[0]],
            )
            .unwrap();
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_items SET assignee_user_id=7 WHERE id=?1",
                [&ids[1]],
            )
            .unwrap();
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_items SET created_by_user_id=7 WHERE id=?1",
                [&agent.id],
            )
            .unwrap();
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_items SET assignee_agent_id=?1 WHERE id=?2",
                params![agent.id, ids[4]],
            )
            .unwrap();
        for index in [2, 7] {
            let task = format!("runtime-{index}");
            store
                .bind_task(
                    &project.id,
                    Some(&ids[index]),
                    None,
                    serde_json::from_value(json!({"deviceId":"mac","taskId":task})).unwrap(),
                    None,
                )
                .unwrap();
            store.connection().unwrap().execute("UPDATE loop_items SET task_user_id=7 WHERE resource_type='execution' AND task_id=?1", [&task]).unwrap();
        }
        store.connection().unwrap().execute("UPDATE loop_items SET unlinked_at='2026-11-12T12:00:00Z' WHERE resource_type='execution' AND task_id='runtime-7'", []).unwrap();
        for index in [3, 6] {
            let comment = store
                .create_comment(&LocalCommentCreate {
                    project_id: project.id.clone(),
                    task_id: ids[index].clone(),
                    client_message_id: None,
                    sender_type: "user".into(),
                    sender_id: "7".into(),
                    sender_name: "Me".into(),
                    content: "I participated".into(),
                    metadata: json!({}),
                    reply_to_message_id: None,
                })
                .unwrap();
            if index == 6 {
                store.connection().unwrap().execute("UPDATE loop_item_comments SET deleted_at='2026-11-12T12:00:00Z' WHERE message_id=?1", [&comment.message_id]).unwrap();
            }
        }
        for (index, id) in ids.iter().enumerate() {
            store
                .connection()
                .unwrap()
                .execute(
                    "UPDATE loop_items SET updated_at=?1 WHERE id=?2",
                    params![format!("2026-11-12T12:00:0{index}Z"), id],
                )
                .unwrap();
        }
        let mut cursor = None;
        let mut actual = Vec::new();
        loop {
            let page = store
                .my_work_page(1, cursor.as_deref(), false, true, &[7], "recent")
                .unwrap();
            actual.extend(
                page["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| row["issue"]["id"].as_str().unwrap().to_owned()),
            );
            cursor = page["next_cursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(actual, ids[..5].iter().rev().cloned().collect::<Vec<_>>());
        let assigned = store
            .my_work_page(30, None, true, true, &[7], "recent")
            .unwrap();
        assert_eq!(assigned["items"].as_array().unwrap().len(), 1);
        assert_eq!(assigned["items"][0]["issue"]["id"], ids[1]);
        for viewers in [vec![8], vec![]] {
            assert!(store
                .my_work_page(30, None, false, true, &viewers, "recent")
                .unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty());
        }
    }

    #[test]
    fn pending_request_recipient_participates_before_pagination() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("recipient.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Requests"})).unwrap())
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Needs an answer"})).unwrap(),
            )
            .unwrap();
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_items SET created_by_user_id=99,assignee_user_id=NULL WHERE id=?1",
                [&issue.id],
            )
            .unwrap();
        store.connection().unwrap().execute(
            "INSERT INTO loop_items (id,resource_type,parent_id,assignee_user_id,name,created_at,updated_at) VALUES ('request-recipient','human_request_index',?1,7,'question',?2,?2)",
            params![issue.id, now()],
        ).unwrap();
        let page = store
            .my_work_page(1, None, false, false, &[7], "attention")
            .unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        assert_eq!(page["items"][0]["issue"]["id"], issue.id);
        assert_eq!(page["items"][0]["attention_order"][0], 0);
        assert!(store
            .my_work_page(1, None, false, false, &[8], "attention")
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(store
            .my_work_page(1, None, true, false, &[7], "attention")
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn explicit_sort_modes_page_in_database_order_and_preserve_assignment_age() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("sort.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Sort"})).unwrap())
            .unwrap();
        let mut ids = Vec::new();
        for index in 0..3 {
            let issue = store
                .create_task(
                    &project.id,
                    serde_json::from_value(json!({"title":format!("Work {index}")})).unwrap(),
                )
                .unwrap();
            let history = if index == 2 {
                json!([])
            } else {
                json!([{"to_type":"user","to_id":0,"at":format!("2026-01-0{}T00:00:00+00:00", 2-index)}])
            };
            store.connection().unwrap().execute("UPDATE loop_items SET assignee_user_id=0,priority=?1,updated_at=?2,metadata=json_set(metadata,'$.assignment_history',json(?3)) WHERE id=?4", params![["urgent","low","high"][index],format!("2026-02-0{}T00:00:00+00:00",index+1), history.to_string(),issue.id]).unwrap();
            ids.push(issue.id);
        }
        for (order, expected) in [
            ("assignment", [1, 0, 2]),
            ("activity", [2, 1, 0]),
            ("priority", [0, 2, 1]),
        ] {
            let mut cursor = None;
            let mut actual = Vec::new();
            for _ in 0..3 {
                let page = store
                    .my_work_page(1, cursor.as_deref(), true, false, &[0], order)
                    .unwrap();
                actual.push(page["items"][0]["issue"]["id"].as_str().unwrap().to_owned());
                cursor = page["next_cursor"].as_str().map(str::to_owned);
            }
            assert_eq!(actual, expected.map(|index| ids[index].clone()), "{order}");
            assert!(cursor.is_none());
        }
        let first = store
            .my_work_page(1, None, true, false, &[0], "assignment")
            .unwrap();
        assert!(store
            .my_work_page(
                1,
                first["next_cursor"].as_str(),
                true,
                false,
                &[0],
                "priority"
            )
            .is_err());
    }

    #[test]
    fn attention_sort_precedes_pagination_and_participating_ignores_priority() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("attention.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Attention"})).unwrap())
            .unwrap();
        let mut ids = Vec::new();
        for (index, (status, priority)) in [
            ("in_review", "none"),
            ("pending", "high"),
            ("inbox", "low"),
            ("in_progress", "none"),
            ("blocked", "none"),
            ("completed", "urgent"),
        ]
        .iter()
        .enumerate()
        {
            let issue = store
                .create_task(
                    &project.id,
                    serde_json::from_value(json!({"title":format!("Work {index}")})).unwrap(),
                )
                .unwrap();
            store.connection().unwrap().execute("UPDATE loop_items SET status=?1,priority=?2,assignee_user_id=0,updated_at=?3 WHERE id=?4",params![status,priority,format!("2026-01-01T00:0{index}:00+00:00"),issue.id]).unwrap();
            ids.push(issue.id);
        }
        let mut cursor = None;
        let mut actual = Vec::new();
        for _ in 0..3 {
            let page = store
                .my_work_page(2, cursor.as_deref(), true, true, &[0], "attention")
                .unwrap();
            actual.extend(
                page["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| row["issue"]["id"].as_str().unwrap().to_owned()),
            );
            cursor = page["next_cursor"].as_str().map(str::to_owned);
        }
        assert_eq!(actual, ids);
        assert!(cursor.is_none());
        let page = store
            .my_work_page(30, None, false, true, &[0], "attention")
            .unwrap();
        let actual = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["issue"]["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            actual,
            vec![&ids[0], &ids[4], &ids[3], &ids[2], &ids[1], &ids[5]]
        );
    }

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
        let first = store
            .my_work_page(30, None, false, true, &[0], "recent")
            .unwrap();
        let next = first["next_cursor"].as_str().unwrap();
        let second = store
            .my_work_page(30, Some(next), false, true, &[0], "recent")
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
        assert!(store
            .my_work_page(101, None, false, true, &[0], "recent")
            .is_err());
        assert!(store
            .my_work_page(30, Some("invalid"), false, true, &[0], "recent")
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
        let page = store
            .my_work_page(30, None, true, false, &[0, 7], "recent")
            .unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 2);
        assert!(page["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| [json!(0), json!(7)].contains(&row["issue"]["assignee_user_id"])));
        assert_eq!(
            store
                .my_work_page(30, None, false, true, &[0], "recent")
                .unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }
}
