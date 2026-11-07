use super::*;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MilestoneInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub due_on: Option<String>,
    #[serde(default = "open")]
    pub state: String,
    pub version: Option<i64>,
}

fn open() -> String {
    "open".into()
}

fn require_project(connection: &Connection, project_id: &str) -> Result<(), TaskRuntimeError> {
    let project = get_item_from(connection, project_id, "project")?
        .ok_or(TaskRuntimeError::ProjectNotFound)?;
    if task_provider(&project)? != TaskProviderKind::Local {
        return Err(TaskRuntimeError::UnsupportedProvider("external".into()));
    }
    Ok(())
}

pub(super) fn require_milestone(
    connection: &Connection,
    project: &str,
    milestone: Option<&str>,
) -> Result<(), TaskRuntimeError> {
    if let Some(id) = milestone {
        let valid: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM loop_items WHERE id=?1 AND cloud_project_id=?2 AND resource_type='milestone' AND deleted_at IS NULL)",
            params![id, project], |row| row.get(0))?;
        if !valid {
            return Err(TaskRuntimeError::Invalid(
                "Milestone does not belong to this project".into(),
            ));
        }
    }
    Ok(())
}

impl LocalTaskStore {
    pub fn list_milestones(&self, project: &str) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        require_project(&connection, project)?;
        let mut statement = connection.prepare(
            "SELECT m.id,m.title,m.description,m.status,json_extract(m.metadata,'$.due_on'),m.version,
                COALESCE(c.open_issues,0),COALESCE(c.closed_issues,0),COALESCE(c.archived_issues,0)
             FROM loop_items m LEFT JOIN (
                SELECT json_extract(metadata,'$.milestone_id') AS milestone_id,
                    SUM(CASE WHEN status='completed' THEN 0 ELSE 1 END) AS open_issues,
                    SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS closed_issues,
                    SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS archived_issues
                FROM loop_items WHERE cloud_project_id=?1 AND resource_type='task'
                GROUP BY json_extract(metadata,'$.milestone_id')
             ) c ON c.milestone_id=m.id
             WHERE m.cloud_project_id=?1 AND m.resource_type='milestone' AND m.deleted_at IS NULL
             ORDER BY m.created_at DESC,m.id")?;
        let rows = statement.query_map([project], |row| {
            Ok(json!({
                "id":row.get::<_,String>(0)?, "project_id":project, "title":row.get::<_,String>(1)?,
                "description":row.get::<_,String>(2)?, "state":row.get::<_,String>(3)?,
                "due_on":row.get::<_,Option<String>>(4)?, "version":row.get::<_,i64>(5)?,
                "open_issues":row.get::<_,i64>(6)?, "closed_issues":row.get::<_,i64>(7)?, "archived_issues":row.get::<_,i64>(8)?
            }))
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn save_milestone(
        &self,
        project: &str,
        id: Option<&str>,
        input: MilestoneInput,
    ) -> Result<Value, TaskRuntimeError> {
        validate_name(input.title.trim(), "milestone title")?;
        if !matches!(input.state.as_str(), "open" | "closed")
            || input.due_on.as_ref().is_some_and(|date| {
                NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .map_or(true, |parsed| parsed.to_string() != *date)
            })
        {
            return Err(TaskRuntimeError::Invalid(
                "Invalid milestone state or date".into(),
            ));
        }
        let id_to_save = id
            .map(str::to_owned)
            .unwrap_or_else(|| format!("ms-{}", Uuid::new_v4()));
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_project(&transaction, project)?;
        let metadata = json!({"due_on":input.due_on}).to_string();
        if id.is_some() {
            let version = input
                .version
                .ok_or_else(|| TaskRuntimeError::Invalid("version is required".into()))?;
            let count = transaction.execute("UPDATE loop_items SET title=?1,description=?2,status=?3,metadata=?4,version=version+1,updated_at=?5 WHERE id=?6 AND cloud_project_id=?7 AND resource_type='milestone' AND deleted_at IS NULL AND version=?8",
                params![input.title.trim(),input.description,input.state,metadata,now(),id_to_save,project,version])?;
            if count != 1 {
                return Err(TaskRuntimeError::VersionConflict);
            }
        } else {
            transaction.execute("INSERT INTO loop_items(id,resource_type,cloud_project_id,title,description,status,metadata,version,created_at,updated_at) VALUES (?1,'milestone',?2,?3,?4,?5,?6,1,?7,?7)",
                params![id_to_save,project,input.title.trim(),input.description,input.state,metadata,now()])?;
        }
        transaction.commit()?;
        drop(connection);
        self.list_milestones(project)?
            .into_iter()
            .find(|m| m["id"] == id_to_save)
            .ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub fn delete_milestone(
        &self,
        project: &str,
        id: &str,
        version: i64,
    ) -> Result<(), TaskRuntimeError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_project(&transaction, project)?;
        let changed = transaction.execute("UPDATE loop_items SET deleted_at=?1,version=version+1 WHERE id=?2 AND cloud_project_id=?3 AND resource_type='milestone' AND deleted_at IS NULL AND version=?4",params![now(),id,project,version])?;
        if changed != 1 {
            return Err(TaskRuntimeError::VersionConflict);
        }
        transaction.execute("UPDATE loop_items SET metadata=json_remove(metadata,'$.milestone_id'),version=version+1,updated_at=?1 WHERE cloud_project_id=?2 AND resource_type='task' AND json_extract(metadata,'$.milestone_id')=?3",params![now(),project,id])?;
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(value: Value) -> MilestoneInput {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn milestones_preserve_issues_and_count_completion_after_reopening() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("milestones.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Release"})).unwrap())
            .unwrap();
        let milestone = store
            .save_milestone(
                &project.id,
                None,
                input(json!({"title":"v1","state":"open","due_on":"2026-12-01"})),
            )
            .unwrap();
        let id = milestone["id"].as_str().unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Ship","milestone_id":id})).unwrap(),
            )
            .unwrap();
        assert_eq!(
            store.list_milestones(&project.id).unwrap()[0]["open_issues"],
            1
        );
        store
            .update_task(
                &project.id,
                &issue.id,
                serde_json::from_value(json!({"version":issue.version,"status":"completed"}))
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(
            store.list_milestones(&project.id).unwrap()[0]["closed_issues"],
            1
        );
        store.archive_task(&project.id, &issue.id).unwrap();
        let archived_counts = &store.list_milestones(&project.id).unwrap()[0];
        assert_eq!(archived_counts["closed_issues"], 1);
        assert_eq!(archived_counts["archived_issues"], 1);
        let restored = store.restore_task(&project.id, &issue.id).unwrap();
        let completed = restored
            .iter()
            .find(|restored| restored.id == issue.id)
            .unwrap();
        let reopened = store
            .update_task(
                &project.id,
                &issue.id,
                serde_json::from_value(json!({"version":completed.version,"status":"pending"}))
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(
            store.list_milestones(&project.id).unwrap()[0]["closed_issues"],
            0
        );
        store.archive_task(&project.id, &issue.id).unwrap();
        let unfinished_archive = &store.list_milestones(&project.id).unwrap()[0];
        assert_eq!(unfinished_archive["open_issues"], 1);
        assert_eq!(unfinished_archive["closed_issues"], 0);
        assert_eq!(unfinished_archive["archived_issues"], 1);
        let restored_again = store.restore_task(&project.id, &issue.id).unwrap();
        let reopened_version = restored_again
            .iter()
            .find(|item| item.id == issue.id)
            .unwrap()
            .version;
        drop(store);
        let store = LocalTaskStore::open(directory.path().join("milestones.sqlite")).unwrap();
        let closed = store
            .save_milestone(
                &project.id,
                Some(id),
                input(json!({"title":"v1","state":"closed","version":1})),
            )
            .unwrap();
        assert_eq!(closed["open_issues"], 1);
        assert!(matches!(
            store.delete_milestone(&project.id, id, 1),
            Err(TaskRuntimeError::VersionConflict)
        ));
        store.delete_milestone(&project.id, id, 2).unwrap();
        let kept = store.get_task(&project.id, &issue.id).unwrap();
        assert!(kept.metadata["milestone_id"].is_null());
        assert_eq!(kept.title, reopened.title);
        assert_eq!(kept.version, reopened_version + 1);
        assert!(store.list_milestones(&project.id).unwrap().is_empty());
    }

    #[test]
    fn rejects_cross_project_and_deleted_associations_without_creating_an_issue() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("milestones.sqlite")).unwrap();
        let a = store
            .create_project(serde_json::from_value(json!({"name":"A"})).unwrap())
            .unwrap();
        let b = store
            .create_project(serde_json::from_value(json!({"name":"B"})).unwrap())
            .unwrap();
        let milestone = store
            .save_milestone(&a.id, None, input(json!({"title":"v1","state":"open"})))
            .unwrap();
        let id = milestone["id"].as_str().unwrap();
        assert!(store
            .create_task(
                &b.id,
                serde_json::from_value(json!({"title":"Cross project","milestone_id":id})).unwrap()
            )
            .is_err());
        let archived_issue = store
            .create_task(
                &a.id,
                serde_json::from_value(
                    json!({"title":"Archived delivery","status":"completed","milestone_id":id}),
                )
                .unwrap(),
            )
            .unwrap();
        store.archive_task(&a.id, &archived_issue.id).unwrap();
        store.delete_milestone(&a.id, id, 1).unwrap();
        let restored = store.restore_task(&a.id, &archived_issue.id).unwrap();
        assert!(restored
            .iter()
            .find(|issue| issue.id == archived_issue.id)
            .unwrap()
            .metadata["milestone_id"]
            .is_null());
        assert!(store
            .create_task(
                &a.id,
                serde_json::from_value(json!({"title":"Deleted milestone","milestone_id":id}))
                    .unwrap()
            )
            .is_err());
        assert!(store
            .save_milestone(
                &a.id,
                None,
                input(json!({"title":"invalid","state":"open","due_on":"2026-02-30"}))
            )
            .is_err());
    }
}
