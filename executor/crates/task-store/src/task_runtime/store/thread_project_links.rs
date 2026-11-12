//! Optional local project classification does not change the owning group.
use super::*;

/// Bind ?1 to the container and ?2 to whether it is a project.
pub(super) fn project_task_scope(table: &str) -> String {
    format!(
        "({table}.cloud_project_id = ?1 OR (?2 AND EXISTS (
    SELECT 1 FROM loop_items link
    JOIN loop_items owner ON owner.id={table}.cloud_project_id
    WHERE link.resource_type='thread_project_link'
      AND link.parent_id=?1 AND link.loop_item_id={table}.id
      AND link.status='active' AND link.deleted_at IS NULL
      AND owner.resource_type='chat_group'
      AND owner.status IN ('active','archived') AND owner.deleted_at IS NULL
)))"
    )
}

pub(super) fn require_target(
    connection: &Connection,
    id: &str,
) -> Result<LoopItem, TaskRuntimeError> {
    let target =
        get_item_from(connection, id, "project")?.ok_or(TaskRuntimeError::ProjectNotFound)?;
    if target.metadata["project_store"].as_str() == Some("backend") {
        return Err(TaskRuntimeError::Invalid(
            "A local Thread requires a local project classification".into(),
        ));
    }
    Ok(target)
}

pub(super) fn create_link(
    connection: &Connection,
    thread: &str,
    project: &str,
) -> Result<(), TaskRuntimeError> {
    connection.execute("INSERT INTO loop_items(id,resource_type,project_space,parent_id,loop_item_id,status,metadata,version,created_at,updated_at) VALUES(?1,'thread_project_link','default',?2,?3,'active','{}',1,?4,?4)",params![Uuid::new_v4().to_string(),project,thread,now()])?;
    Ok(())
}

pub(super) fn linked_project(
    connection: &Connection,
    thread: &str,
) -> Result<Option<String>, TaskRuntimeError> {
    Ok(connection.query_row("SELECT parent_id FROM loop_items WHERE resource_type='thread_project_link' AND loop_item_id=?1 AND status='active' AND deleted_at IS NULL",[thread],|row|row.get(0)).optional()?)
}

impl LocalTaskStore {
    pub(super) fn thread_project_link_request(
        &self,
        method: &str,
        input: Value,
    ) -> Result<Value, TaskRuntimeError> {
        let thread = input["thread_id"].as_str().unwrap_or_default();
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let item = get_item_from(&tx, thread, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
        let group = item
            .cloud_project_id
            .as_deref()
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        chat_groups::local_group(&tx, group, method.ends_with("update"))?;
        if method.ends_with("update") {
            if item.version != input["version"].as_i64().unwrap_or(0) {
                return Err(TaskRuntimeError::VersionConflict);
            }
            let target = input.get("project_id").filter(|value| !value.is_null());
            let project = target
                .map(|value| {
                    value
                        .as_str()
                        .ok_or_else(|| TaskRuntimeError::Invalid("Invalid project identity".into()))
                })
                .transpose()?;
            if let Some(project) = project {
                require_target(&tx, project)?;
            }
            if linked_project(&tx, thread)?.as_deref() == project {
                let current = project
                    .map(|id| get_item_from(&tx, id, "project"))
                    .transpose()?
                    .flatten();
                return Ok(
                    json!({"project":current.map(|project|json!({"id":project.id,"name":project.name})),"restricted":false,"thread_version":item.version}),
                );
            }
            let changed=tx.execute("UPDATE loop_items SET metadata=json_remove(metadata,'$.milestone_id'),version=version+1,updated_at=?1 WHERE id=?2 AND resource_type='task' AND version=?3",params![now(),thread,input["version"].as_i64().unwrap_or(0)])?;
            if changed != 1 {
                return Err(TaskRuntimeError::VersionConflict);
            }
            let id:Option<String>=tx.query_row("SELECT id FROM loop_items WHERE resource_type='thread_project_link' AND loop_item_id=?1 AND deleted_at IS NULL",[thread],|row|row.get(0)).optional()?;
            if let Some(id) = id {
                tx.execute("UPDATE loop_items SET parent_id=COALESCE(?1,parent_id),status=?2,version=version+1,updated_at=?3 WHERE id=?4",params![project,if project.is_some(){"active"}else{"removed"},now(),id])?;
            } else if let Some(project) = project {
                create_link(&tx, thread, project)?;
            }
        }
        let project = linked_project(&tx, thread)?
            .map(|id| get_item_from(&tx, &id, "project"))
            .transpose()?
            .flatten();
        let version = get_item_from(&tx, thread, "task")?
            .ok_or(TaskRuntimeError::TaskNotFound)?
            .version;
        let value = json!({"project":project.map(|project|json!({"id":project.id,"name":project.name})),"restricted":false,"thread_version":version});
        tx.commit()?;
        Ok(value)
    }
}
