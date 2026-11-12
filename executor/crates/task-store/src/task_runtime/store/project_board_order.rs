//! Project presentation order is independent of owning-group sibling order.
use super::*;
use crate::task_runtime::model::TaskPosition;

const ORDER_KEY: &str = "board_item_order";

pub(super) fn rank(project: &LoopItem, item: &LoopItem) -> i64 {
    project.metadata[ORDER_KEY][&item.id]
        .as_i64()
        .filter(|value| *value >= 0)
        .unwrap_or(item.sort_order)
}

pub(super) fn move_task(
    connection: &Connection,
    project_id: &str,
    task_id: &str,
    parent_id: Option<&str>,
    position: &TaskPosition,
) -> Result<(), TaskRuntimeError> {
    let project = thread_project_links::require_target(connection, project_id)?;
    if project.status.as_deref() != Some("active") {
        return Err(TaskRuntimeError::Invalid(
            "Ordering project is unavailable".into(),
        ));
    }
    let moving =
        get_item_from(connection, task_id, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
    let owner = moving
        .cloud_project_id
        .as_deref()
        .ok_or(TaskRuntimeError::TaskNotFound)?;
    if owner != project_id {
        chat_groups::local_group(connection, owner, true)?;
    }
    let mut statement = connection.prepare(&format!(
        "SELECT id FROM loop_items WHERE resource_type='task' AND {} AND deleted_at IS NULL
         AND ((?3 IS NULL AND (parent_id IS NULL OR parent_id='')) OR parent_id=?3)",
        thread_project_links::project_task_scope("loop_items")
    ))?;
    let ids = statement
        .query_map(params![project_id, true, parent_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut siblings = ids
        .into_iter()
        .map(|id| get_item_from(connection, &id, "task"))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if !siblings.iter().any(|item| item.id == task_id) {
        return Err(TaskRuntimeError::Invalid(
            "Moving item is not classified in this project".into(),
        ));
    }
    for item in &siblings {
        if let Some(group) = item
            .cloud_project_id
            .as_deref()
            .filter(|owner| *owner != project_id)
        {
            chat_groups::local_group(connection, group, false)?;
        }
    }
    siblings.sort_by(|a, b| {
        rank(&project, a)
            .cmp(&rank(&project, b))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    siblings.retain(|item| item.id != task_id);
    let index = match position.before_item_id.as_deref() {
        Some(anchor) => siblings
            .iter()
            .position(|item| item.id == anchor)
            .ok_or_else(|| {
                TaskRuntimeError::Invalid(
                    "Position anchor is not an authorized project sibling".into(),
                )
            })?,
        None => siblings.len(),
    };
    siblings.insert(index, moving);
    let mut ranks = project.metadata[ORDER_KEY]
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (rank, item) in siblings.iter().enumerate() {
        ranks.insert(item.id.clone(), json!(rank));
    }
    connection.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.board_item_order',json(?2)),version=version+1,updated_at=?3 WHERE id=?1 AND resource_type='project'",
        params![project_id, Value::Object(ranks).to_string(), now()])?;
    Ok(())
}
