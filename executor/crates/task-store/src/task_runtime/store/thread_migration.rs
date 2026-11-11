//! Explicit forward migration within the device owner's private node store.
use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: String,
    version: i64,
    source_status: Option<String>,
    target_status: Option<String>,
    source_parent: Option<String>,
    target_parent: Option<String>,
    archived: bool,
    historical_owner: bool,
    resources: Vec<Resource>,
    blockers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Resource {
    id: String,
    kind: String,
    owner: Option<String>,
    object_key: Option<String>,
    markdown_object_key: Option<String>,
    chat_object_key: Option<String>,
    manifest_object_key: Option<String>,
    size_bytes: Option<i64>,
    sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Inventory {
    source_project_id: String,
    target_group_id: String,
    source_version: i64,
    target_version: i64,
    next_number: i64,
    entries: Vec<Entry>,
    excluded_restricted_ids: Vec<String>,
    blockers: Vec<String>,
}

fn invalid(message: &str) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(message.to_owned())
}

fn raw_metadata(connection: &Connection, id: &str) -> Result<Value, TaskRuntimeError> {
    let value =
        connection.query_row("SELECT metadata FROM loop_items WHERE id=?1", [id], |row| {
            row.get::<_, Option<String>>(0)
        })?;
    let value: Value = serde_json::from_str(value.as_deref().unwrap_or("{}"))
        .map_err(|_| invalid("Invalid migration metadata"))?;
    if !value.is_object() {
        return Err(invalid("Invalid migration metadata"));
    }
    Ok(value)
}

fn roots(
    connection: &Connection,
    source: &str,
    target: &str,
) -> Result<(LoopItem, LoopItem), TaskRuntimeError> {
    let project = thread_project_links::require_target(connection, source)?;
    let group = chat_groups::local_group(connection, target, true)?;
    let source_metadata = raw_metadata(connection, source)?;
    let group_metadata = raw_metadata(connection, target)?;
    if source_metadata["system_kind"] == "default_work_items"
        || source_metadata["project_store"] == "backend"
        || group_metadata["project_store"] == "backend"
        || project.status.as_deref() != Some("active")
        || task_provider(&project)? != TaskProviderKind::Local
    {
        return Err(invalid(
            "Migration requires an active local collaboration project",
        ));
    }
    Ok((project, group))
}

fn resources(connection: &Connection, thread: &str) -> Result<Vec<Resource>, TaskRuntimeError> {
    let mut statement = connection.prepare(
        "SELECT id,resource_type,cloud_project_id,
                CASE WHEN resource_type IN ('attachment','delivery','delivery_asset') THEN object_key END,
                CASE WHEN resource_type IN ('attachment','delivery','delivery_asset') THEN markdown_object_key END,
                CASE WHEN resource_type IN ('attachment','delivery','delivery_asset') THEN chat_object_key END,
                CASE WHEN resource_type IN ('attachment','delivery','delivery_asset') THEN manifest_object_key END,
                CASE WHEN resource_type IN ('attachment','delivery','delivery_asset') THEN size_bytes END,
                CASE WHEN resource_type IN ('attachment','delivery','delivery_asset') THEN sha256 END
         FROM loop_items WHERE loop_item_id=?1
            OR (parent_id=?1 AND resource_type IN ('issue_receipt','assignment_index'))
            OR delivery_id IN (SELECT id FROM loop_items
                WHERE resource_type='delivery' AND loop_item_id=?1)
         ORDER BY id",
    )?;
    let rows = statement.query_map([thread], |row| {
        Ok(Resource {
            id: row.get(0)?,
            kind: row.get(1)?,
            owner: row.get(2)?,
            object_key: row.get(3)?,
            markdown_object_key: row.get(4)?,
            chat_object_key: row.get(5)?,
            manifest_object_key: row.get(6)?,
            size_bytes: row.get(7)?,
            sha256: row.get(8)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn inventory(
    connection: &Connection,
    source: &str,
    target: &str,
    mapping: &BTreeMap<String, String>,
) -> Result<Inventory, TaskRuntimeError> {
    let (project, group) = roots(connection, source, target)?;
    let mut statement = connection.prepare(
        "SELECT id,parent_id,status,version,deleted_at,created_by_user_id,
                assignee_user_id,assignee_agent_id
         FROM loop_items WHERE resource_type='task' AND cloud_project_id=?1
         ORDER BY sequence_number,id",
    )?;
    let rows = statement
        .query_map([source], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let default_security = project.metadata["board_config"]["default_issue_security"]
        .as_str()
        .unwrap_or("open");
    let mut entries = Vec::new();
    let mut excluded = Vec::new();
    for (id, parent, status, version, archived, creator, assignee, agent) in rows {
        let metadata = raw_metadata(connection, &id)?;
        if metadata["security_level"]
            .as_str()
            .unwrap_or(default_security)
            != "open"
        {
            excluded.push(id);
            continue;
        }
        let target_status = mapping
            .get(status.as_deref().unwrap_or(""))
            .cloned()
            .or_else(|| status.clone());
        let mut blockers = Vec::new();
        if !matches!(
            target_status.as_deref(),
            Some("inbox" | "pending" | "in_progress" | "in_review" | "completed")
        ) {
            blockers.push("explicit_status_mapping_required".into());
        }
        if agent.as_deref().is_some_and(|value| !value.is_empty())
            || metadata
                .get("collaboration_group")
                .is_some_and(|value| !value.is_null())
        {
            blockers.push("execution_resource_mapping_required".into());
        }
        let author = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM loop_item_comments WHERE project_id=?1
              AND task_id=?2 AND sender_type='user' AND sender_id='0'
              AND message_type='text' AND trim(content)!='' AND deleted_at IS NULL)",
            params![source, id],
            |row| row.get::<_, bool>(0),
        )?;
        entries.push(Entry {
            resources: resources(connection, &id)?,
            id,
            source_parent: parent,
            target_parent: None,
            source_status: status,
            target_status,
            version,
            archived: archived.is_some(),
            historical_owner: creator == Some(0) || assignee == Some(0) || author,
            blockers,
        });
    }
    let public: HashSet<_> = entries.iter().map(|entry| entry.id.clone()).collect();
    for entry in &mut entries {
        entry.target_parent = entry
            .source_parent
            .as_ref()
            .filter(|id| public.contains(*id))
            .cloned();
        if let Some(parent) = &entry.source_parent {
            let owned = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM loop_items WHERE id=?1
                  AND resource_type='task' AND cloud_project_id=?2)",
                params![parent, source],
                |row| row.get::<_, bool>(0),
            )?;
            if !owned {
                entry.blockers.push("parent_outside_source_project".into());
            }
        }
    }
    let next_number = group.next_item_number.unwrap_or(0);
    excluded.sort();
    Ok(Inventory {
        source_project_id: source.into(),
        target_group_id: target.into(),
        source_version: project.version,
        target_version: group.version,
        next_number,
        entries,
        excluded_restricted_ids: excluded,
        blockers: if next_number < 1 {
            vec!["target_counter_not_initialized".into()]
        } else {
            Vec::new()
        },
    })
}

fn digest(report: &Inventory, retain: bool) -> Result<String, TaskRuntimeError> {
    let bytes =
        serde_json::to_vec(&(report, retain)).map_err(|error| invalid(&error.to_string()))?;
    Ok(format!("thread-migration:{:x}", Sha256::digest(bytes)))
}

fn move_resources(
    connection: &Connection,
    report: &Inventory,
    entry: &Entry,
) -> Result<(), TaskRuntimeError> {
    for resource in &entry.resources {
        match resource.kind.as_str() {
            "thread_project_link"
            | "stand_in_issue_inbox"
            | "stand_in_issue_event"
            | "automation_run"
            | "workflow_run"
            | "workflow_plan_item"
            | "workspace_cleanup" => continue,
            "comment" | "attachment" | "delivery" | "delivery_asset" | "execution"
            | "collaborator" | "issue_receipt" | "assignment_index" => {}
            _ => {
                return Err(invalid(
                    "Linked resource requires an explicit migration rule",
                ))
            }
        }
        if resource
            .owner
            .as_deref()
            .is_some_and(|owner| !owner.is_empty() && owner != report.source_project_id)
        {
            return Err(invalid("Linked resource belongs to another container"));
        }
        // Local blob keys are globally identified within this private store,
        // independent of the container. Keep bytes and immutable provenance.
        connection.execute(
            "UPDATE loop_items SET cloud_project_id=?1 WHERE id=?2",
            params![report.target_group_id, resource.id],
        )?;
    }
    connection.execute(
        "UPDATE loop_item_comments SET project_id=?1 WHERE project_id=?2 AND task_id=?3",
        params![report.target_group_id, report.source_project_id, entry.id],
    )?;
    connection.execute("UPDATE loop_item_executions SET cloud_project_id=?1 WHERE cloud_project_id=?2 AND loop_item_id=?3",params![report.target_group_id,report.source_project_id,entry.id])?;
    Ok(())
}

fn move_entry(
    connection: &Connection,
    report: &Inventory,
    entry: &Entry,
    number: i64,
    retain: bool,
) -> Result<(), TaskRuntimeError> {
    let mut metadata = raw_metadata(connection, &entry.id)?;
    if !retain {
        metadata.as_object_mut().unwrap().remove("milestone_id");
    }
    connection.execute("UPDATE loop_items SET cloud_project_id=?1,parent_id=?2,sequence_number=?3,status=?4,version=version+1 WHERE id=?5",params![report.target_group_id,entry.target_parent,number,entry.target_status,entry.id])?;
    // A status mapping is structural migration, not a fresh runtime transition.
    // Preserve historical metadata after the standard status-history trigger.
    connection.execute(
        "UPDATE loop_items SET metadata=?1 WHERE id=?2",
        params![metadata.to_string(), entry.id],
    )?;
    chat_groups::initialize_historical_thread(connection, &entry.id, entry.historical_owner)?;
    if retain {
        thread_project_links::create_link(connection, &entry.id, &report.source_project_id)?;
    }
    move_resources(connection, report, entry)
}

fn require_idle(connection: &Connection, thread: &str) -> Result<(), TaskRuntimeError> {
    let active = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM loop_item_executions WHERE loop_item_id=?1
            AND status NOT IN ('completed','failed','cancelled'))
            OR EXISTS(SELECT 1 FROM loop_item_comments WHERE task_id=?1
                AND status IN ('pending','streaming') AND deleted_at IS NULL)",
        [thread],
        |row| row.get::<_, bool>(0),
    )?;
    if active {
        return Err(invalid("Finish active Thread execution before migration"));
    }
    Ok(())
}

impl LocalTaskStore {
    pub(super) fn thread_migration_request(
        &self,
        method: &str,
        input: Value,
    ) -> Result<Value, TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(if method == "migration.apply" {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        })?;
        if method == "migration.inspect" {
            let mapping: BTreeMap<String, String> =
                serde_json::from_value(input.get("status_map").cloned().unwrap_or(json!({})))
                    .map_err(|error| invalid(&error.to_string()))?;
            let report = inventory(
                &tx,
                input["source_project_id"].as_str().unwrap_or_default(),
                input["target_group_id"].as_str().unwrap_or_default(),
                &mapping,
            )?;
            return Ok(json!({"inventory":report}));
        }
        let report: Inventory = serde_json::from_value(input["inventory"].clone())
            .map_err(|error| invalid(&error.to_string()))?;
        let retain = input["retain_source_project"]
            .as_bool()
            .ok_or_else(|| invalid("Choose project classification explicitly"))?;
        roots(&tx, &report.source_project_id, &report.target_group_id)?;
        let checkpoint = digest(&report, retain)?;
        let existing: Option<(String,Option<String>,Option<String>,Option<String>,Option<String>)> = tx.query_row(
            "SELECT resource_type,parent_id,cloud_project_id,metadata,status FROM loop_items WHERE id=?1", [&checkpoint],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).optional()?;
        let marker = json!({"inventory_id":checkpoint,"thread_ids":report.entries.iter().map(|entry|&entry.id).collect::<Vec<_>>(),"retain_source_project":retain});
        let marker = marker.to_string();
        if let Some((kind, parent, source, metadata, status)) = existing {
            if kind != "thread_migration"
                || parent.as_deref() != Some(&report.target_group_id)
                || source.as_deref() != Some(&report.source_project_id)
                || metadata.as_deref() != Some(marker.as_str())
                || status.as_deref() != Some("completed")
            {
                return Err(invalid("Migration checkpoint identity collision"));
            }
            return Ok(json!({"checkpoint_id":checkpoint,"replayed":true}));
        }
        let mapping = report
            .entries
            .iter()
            .filter_map(|entry| {
                entry.target_status.as_ref().map(|status| {
                    (
                        entry.source_status.clone().unwrap_or_default(),
                        status.clone(),
                    )
                })
            })
            .collect();
        if inventory(
            &tx,
            &report.source_project_id,
            &report.target_group_id,
            &mapping,
        )? != report
            || !report.blockers.is_empty()
            || report
                .entries
                .iter()
                .any(|entry| !entry.blockers.is_empty())
        {
            return Err(invalid(
                "Migration inventory changed or has unresolved blockers",
            ));
        }
        for entry in &report.entries {
            require_idle(&tx, &entry.id)?;
        }
        let end_number = report
            .next_number
            .checked_add(report.entries.len() as i64)
            .ok_or_else(|| invalid("Target Thread counter is exhausted"))?;
        for (offset, entry) in report.entries.iter().enumerate() {
            move_entry(
                &tx,
                &report,
                entry,
                report.next_number + offset as i64,
                retain,
            )?;
        }
        let moved: HashSet<_> = report.entries.iter().map(|entry| &entry.id).collect();
        for id in &report.excluded_restricted_ids {
            let parent: Option<String> = tx.query_row(
                "SELECT parent_id FROM loop_items WHERE id=?1",
                [id],
                |row| row.get(0),
            )?;
            if parent.as_ref().is_some_and(|value| moved.contains(value)) {
                tx.execute(
                    "UPDATE loop_items SET parent_id=NULL,version=version+1 WHERE id=?1",
                    [id],
                )?;
            }
        }
        tx.execute(
            "UPDATE loop_items SET next_item_number=?1,version=version+1 WHERE id=?2",
            params![end_number, report.target_group_id],
        )?;
        tx.execute("INSERT INTO loop_items(id,resource_type,parent_id,cloud_project_id,status,metadata,created_by_user_id,created_at,updated_at) VALUES(?1,'thread_migration',?2,?3,'completed',?4,0,?5,?5)",params![checkpoint,report.target_group_id,report.source_project_id,marker.to_string(),now()])?;
        tx.commit()?;
        Ok(json!({"checkpoint_id":checkpoint,"replayed":false}))
    }
}
