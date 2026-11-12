//! Private local groups share the node store, never the project catalog or cloud grants.
use super::*;

pub(super) fn work_container_from(
    connection: &Connection,
    id: &str,
) -> Result<Option<LoopItem>, rusqlite::Error> {
    if let Some(project) = get_item_from(connection, id, "project")? {
        return Ok(Some(project));
    }
    get_item_from(connection, id, "chat_group")?
        .map(unified_group)
        .transpose()
}

fn unified_group(mut group: LoopItem) -> Result<LoopItem, rusqlite::Error> {
    group.metadata["board_config"] =
        project_status::group_board_config(&group.metadata["board_config"])
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    Ok(group)
}

pub(super) fn local_group(
    connection: &Connection,
    id: &str,
    write: bool,
) -> Result<LoopItem, TaskRuntimeError> {
    let group =
        get_item_from(connection, id, "chat_group")?.ok_or(TaskRuntimeError::ProjectNotFound)?;
    if write && group.status.as_deref() != Some("active") {
        return Err(TaskRuntimeError::Invalid("Chat group is archived".into()));
    }
    Ok(unified_group(group)?)
}
fn participant_key(thread: &str) -> String {
    format!("thread-participant:{thread}:0")
}
fn joined(connection: &Connection, thread: &str) -> Result<bool, TaskRuntimeError> {
    Ok(connection.query_row("SELECT 1 FROM loop_items WHERE id=?1 AND parent_id=?2 AND resource_type='thread_participant' AND user_id=0 AND status='active' AND deleted_at IS NULL",params![participant_key(thread),thread],|row|row.get::<_,i64>(0)).optional()?.is_some())
}

pub(super) fn annotate_threads(
    connection: &Connection,
    items: &mut [LoopItem],
) -> Result<(), TaskRuntimeError> {
    let containers: HashSet<String> = items
        .iter()
        .filter_map(|item| item.cloud_project_id.clone())
        .collect();
    for container in containers {
        let Some(group) = get_item_from(connection, &container, "chat_group")? else {
            continue;
        };
        let mut statement = connection.prepare(
            "SELECT p.parent_id FROM loop_items p
             JOIN loop_items t ON t.id=p.parent_id
             WHERE p.resource_type='thread_participant' AND p.user_id=0
               AND p.status='active' AND p.deleted_at IS NULL
               AND t.resource_type='task' AND t.cloud_project_id=?1",
        )?;
        let joined = statement
            .query_map([&container], |row| row.get::<_, String>(0))?
            .collect::<Result<HashSet<_>, _>>()?;
        let status = group.status.as_deref().unwrap_or("active");
        for item in items
            .iter_mut()
            .filter(|item| item.cloud_project_id.as_deref() == Some(container.as_str()))
        {
            let active = joined.contains(&item.id);
            item.thread_context = Some(super::super::model::ThreadReadContext {
                group_id: container.clone(),
                group_name: group.name.clone().unwrap_or_else(|| container.clone()),
                joined: active,
                can_join: !active && status == "active",
                group_status: status.to_owned(),
            });
        }
    }
    Ok(())
}
fn participate(
    connection: &Connection,
    thread: &str,
    active: bool,
    notifications: Option<&str>,
) -> Result<(), TaskRuntimeError> {
    let existing = connection.query_row(
        "SELECT resource_type,parent_id,user_id,metadata,deleted_at FROM loop_items WHERE id=?1",
        [participant_key(thread)],
        |row| Ok((row.get::<_,String>(0)?, row.get::<_,Option<String>>(1)?, row.get::<_,Option<i64>>(2)?, row.get::<_,Option<String>>(3)?, row.get::<_,Option<String>>(4)?)),
    ).optional()?;
    let mut metadata = if let Some((kind, parent, user, metadata, deleted)) = existing {
        if kind != "thread_participant"
            || parent.as_deref() != Some(thread)
            || user != Some(0)
            || deleted.is_some()
        {
            return Err(TaskRuntimeError::Invalid(
                "Participant identity collision".into(),
            ));
        }
        serde_json::from_str::<Value>(metadata.as_deref().unwrap_or("{}"))
            .map_err(|_| TaskRuntimeError::Invalid("Invalid participant metadata".into()))?
    } else {
        json!({})
    };
    if !metadata.is_object() {
        return Err(TaskRuntimeError::Invalid(
            "Invalid participant metadata".into(),
        ));
    }
    if let Some(mode) = notifications {
        metadata["notifications"] = json!(mode)
    } else if metadata.get("notifications").is_none() {
        metadata["notifications"] = json!("all")
    }
    connection.execute("INSERT INTO loop_items(id,resource_type,project_space,parent_id,user_id,status,metadata,version,created_at,updated_at) VALUES(?1,'thread_participant','default',?2,0,?3,?4,1,?5,?5) ON CONFLICT(id) DO UPDATE SET status=excluded.status,metadata=excluded.metadata,version=loop_items.version+1,updated_at=excluded.updated_at",params![participant_key(thread),thread,if active{"active"}else{"left"},metadata.to_string(),now()])?;
    Ok(())
}

pub(super) fn initialize_thread(
    connection: &Connection,
    container: &LoopItem,
    thread: &str,
) -> Result<(), TaskRuntimeError> {
    if container.resource_type != "chat_group" {
        return Ok(());
    }
    participate(connection, thread, true, Some("all"))?;
    lifecycle(connection, container, thread, "created")
}

pub(super) fn initialize_historical_thread(
    connection: &Connection,
    thread: &str,
    historical_owner: bool,
) -> Result<(), TaskRuntimeError> {
    let existing = connection
        .query_row(
            "SELECT resource_type,parent_id,user_id FROM loop_items WHERE id=?1",
            [participant_key(thread)],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()?;
    if let Some((kind, parent, user)) = existing {
        if kind != "thread_participant" || parent.as_deref() != Some(thread) || user != Some(0) {
            return Err(TaskRuntimeError::Invalid(
                "Participant identity collision".into(),
            ));
        }
        // Existing preferences, including archived or left records, are facts.
        return Ok(());
    }
    if historical_owner {
        participate(connection, thread, true, None)?;
    }
    Ok(())
}
pub(super) fn lifecycle(
    connection: &Connection,
    container: &LoopItem,
    thread: &str,
    event: &str,
) -> Result<(), TaskRuntimeError> {
    if container.resource_type != "chat_group" {
        return Ok(());
    }
    let item = get_item_from(connection, thread, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
    let client_id = format!("thread-lifecycle:{thread}:{}:{event}", item.version);
    let exists=connection.query_row("SELECT 1 FROM loop_item_comments WHERE project_id=?1 AND task_id='' AND client_message_id=?2",params![container.id,client_id],|row|row.get::<_,i64>(0)).optional()?.is_some();
    if !exists {
        insert_comment(
            connection,
            &LocalCommentCreate {
                project_id: container.id.clone(),
                task_id: String::new(),
                client_message_id: Some(client_id),
                sender_type: "system".into(),
                sender_id: "0".into(),
                sender_name: String::new(),
                content: item.title.clone().unwrap_or_default(),
                metadata: json!({"event_type":event,"thread_id":thread,"thread_status":item.status,"thread_version":item.version}),
                reply_to_message_id: None,
            },
            "completed",
        )?;
    }
    Ok(())
}

pub(super) fn require_participation(
    connection: &Connection,
    container: &str,
    thread: &str,
    execute: bool,
) -> Result<(), TaskRuntimeError> {
    let owner =
        work_container_from(connection, container)?.ok_or(TaskRuntimeError::ProjectNotFound)?;
    let item = get_item_from(connection, thread, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
    if item.cloud_project_id.as_deref() != Some(container) {
        return Err(TaskRuntimeError::TaskNotFound);
    }
    if owner.resource_type == "project" {
        return Ok(());
    }
    local_group(connection, container, true)?;
    if !joined(connection, thread)? {
        return Err(TaskRuntimeError::Invalid(
            "Join the Thread before participating".into(),
        ));
    }
    if execute
        && matches!(
            item.status.as_deref(),
            Some("completed" | "cancelled" | "archived")
        )
    {
        return Err(TaskRuntimeError::Invalid(
            "Reopen the Thread before starting an execution".into(),
        ));
    }
    Ok(())
}
fn view(group: LoopItem) -> Value {
    json!({"id":group.id,"project_key":group.project_key,"name":group.name,"description":group.description,"status":group.status,"version":group.version,"role":"Owner","created_by_user_id":0,"created_at":group.created_at,"updated_at":group.updated_at,"configuration":{"board_config":group.metadata["board_config"],"board_views":group.metadata["board_views"],"card_display":group.metadata["card_display"],"tags":group.metadata["tags"],"collaboration_groups":group.metadata.get("collaboration_groups").cloned().unwrap_or(json!([])),"automatic_processing_rules":group.metadata.get("automatic_processing_rules").cloned().unwrap_or(json!([])),"execution_environment":group.metadata.get("execution_environment").cloned().unwrap_or(json!({}))}})
}
fn ids(
    connection: &Connection,
    kind: &str,
    parent: Option<&str>,
) -> Result<Vec<String>, TaskRuntimeError> {
    let mut statement=connection.prepare("SELECT id FROM loop_items WHERE resource_type=?1 AND deleted_at IS NULL AND (?2 IS NULL OR cloud_project_id=?2) ORDER BY updated_at DESC,id")?;
    let rows = statement.query_map(params![kind, parent], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}
impl LocalTaskStore {
    pub fn is_private_chat_group(&self, id: &str) -> Result<bool, TaskRuntimeError> {
        let connection = self.connection()?;
        let row = connection.query_row(
            "SELECT metadata,deleted_at FROM loop_items WHERE id=?1 AND resource_type='chat_group'",
            [id], |row| Ok((row.get::<_,Option<String>>(0)?,row.get::<_,Option<String>>(1)?)),
        ).optional()?;
        let Some((metadata, deleted)) = row else {
            return Ok(false);
        };
        let metadata: Value = serde_json::from_str(metadata.as_deref().unwrap_or("{}"))
            .map_err(|_| TaskRuntimeError::Invalid("Invalid group source metadata".into()))?;
        if !metadata.is_object() {
            return Err(TaskRuntimeError::Invalid(
                "Invalid group source metadata".into(),
            ));
        }
        if metadata["project_store"] == "backend" {
            return Ok(false);
        }
        if deleted.is_some() {
            return Err(TaskRuntimeError::ProjectNotFound);
        }
        Ok(true)
    }

    pub(crate) fn require_work_content_write(
        &self,
        container_id: &str,
        thread_id: Option<&str>,
    ) -> Result<(), TaskRuntimeError> {
        let container = self.get_work_container(container_id)?;
        if container.resource_type == "chat_group" {
            let connection = self.connection()?;
            local_group(&connection, container_id, true)?;
            if let Some(thread_id) = thread_id {
                require_participation(&connection, container_id, thread_id, false)?;
            }
        }
        Ok(())
    }

    pub fn get_work_container(&self, id: &str) -> Result<LoopItem, TaskRuntimeError> {
        let connection = self.connection()?;
        if let Some(container) = work_container_from(&connection, id)? {
            return Ok(container);
        }
        drop(connection);
        self.get_project(id)
    }
    pub fn chat_group_request(
        &self,
        method: &str,
        input: Value,
    ) -> Result<Value, TaskRuntimeError> {
        match method {
            "migration.inspect" | "migration.apply" => self.thread_migration_request(method, input),
            "participants.invite" => {
                let ids = input["user_ids"]
                    .as_array()
                    .ok_or_else(|| TaskRuntimeError::Invalid("Invalid participants".into()))?;
                if ids.is_empty() || ids.iter().any(|id| id.as_i64() != Some(0)) {
                    return Err(TaskRuntimeError::Invalid(
                        "Only the device owner can participate in a local group".into(),
                    ));
                }
                let mut update = input;
                update["joined"] = json!(true);
                update.as_object_mut().unwrap().remove("notifications");
                self.chat_group_request("participation.update", update)
            }
            "project_link.get" | "project_link.update" => {
                self.thread_project_link_request(method, input)
            }
            "members.add" | "members.remove" => Err(TaskRuntimeError::Invalid(
                "Local groups are private to this device; use a cloud group to invite members"
                    .into(),
            )),
            "navigation" => {
                let connection = self.connection()?;
                let mut statement = connection.prepare("SELECT t.id,t.cloud_project_id,t.title,t.status FROM loop_items t JOIN loop_items g ON g.id=t.cloud_project_id AND g.resource_type='chat_group' AND g.status='active' AND g.deleted_at IS NULL JOIN loop_items p ON p.parent_id=t.id AND p.resource_type='thread_participant' AND p.user_id=0 AND p.status='active' AND p.deleted_at IS NULL WHERE t.resource_type='task' AND t.deleted_at IS NULL AND COALESCE(t.status,'') NOT IN ('completed','cancelled','archived') ORDER BY t.updated_at DESC,t.id")?;
                let rows = statement.query_map([], |row| Ok(json!({"id":row.get::<_,String>(0)?,"group_id":row.get::<_,String>(1)?,"title":row.get::<_,Option<String>>(2)?,"status":row.get::<_,Option<String>>(3)?})))?;
                Ok(json!({"items":rows.collect::<Result<Vec<_>,_>>()?}))
            }
            "list" => {
                let connection = self.connection()?;
                let groups = ids(&connection, "chat_group", None)?
                    .iter()
                    .map(|id| local_group(&connection, id, false).map(view))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(
                    json!({"items":groups.into_iter().filter(|g|g["status"]=="active").collect::<Vec<_>>()}),
                )
            }
            "create" => {
                let name = input["name"].as_str().unwrap_or_default().trim();
                validate_name(name, "group name")?;
                if input["member_ids"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id.as_i64() != Some(0)))
                {
                    return Err(TaskRuntimeError::Invalid(
                        "Shared groups require a cloud connection".into(),
                    ));
                }
                let id = Uuid::new_v4().to_string();
                let at = now();
                let mut connection = self.connection()?;
                let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                tx.execute("INSERT INTO loop_items(id,resource_type,project_space,project_key,name,description,status,next_item_number,metadata,created_by_user_id,version,created_at,updated_at) VALUES(?1,'chat_group','default',?2,?3,?4,'active',1,?5,0,1,?6,?6)",params![id,format!("G{}",&Uuid::new_v4().simple().to_string()[..10]),name,input["description"].as_str().unwrap_or_default(),json!({"task_provider":"local"}).to_string(),at])?;
                tx.commit()?;
                let group = local_group(&connection, &id, false)?;
                Ok(
                    json!({"group":view(group),"members":[{"user_id":0,"name":"Me","role":"Owner"}]}),
                )
            }
            "get" | "members" => {
                let connection = self.connection()?;
                let id = input["group_id"].as_str().unwrap_or_default();
                let group = local_group(&connection, id, false)?;
                let members = json!([{"user_id":0,"name":"Me","role":"Owner"}]);
                Ok(if method == "members" {
                    json!({"items":members})
                } else {
                    json!({"group":view(group),"members":members})
                })
            }
            "update" => {
                let id = input["group_id"].as_str().unwrap_or_default();
                let name = input["name"].as_str().unwrap_or_default().trim();
                validate_name(name, "group name")?;
                let status = input["status"].as_str().unwrap_or_default();
                if !matches!(status, "active" | "archived") {
                    return Err(TaskRuntimeError::Invalid("Invalid group state".into()));
                }
                let mut connection = self.connection()?;
                let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let mut group = local_group(&tx, id, false)?;
                if let Some(configuration) = input.get("configuration") {
                    group_configuration::apply(&tx, &mut group, configuration)?;
                }
                if status=="archived"&&tx.query_row("SELECT COUNT(*) FROM loop_item_executions WHERE cloud_project_id=?1 AND status NOT IN ('completed','failed','cancelled')",[id],|r|r.get::<_,i64>(0))?>0{return Err(TaskRuntimeError::Invalid("Stop active executions before archiving the group".into()))}
                let changed=tx.execute("UPDATE loop_items SET name=?1,description=?2,status=?3,version=version+1,updated_at=?4,metadata=?7 WHERE id=?5 AND resource_type='chat_group' AND version=?6",params![name,input["description"].as_str().unwrap_or_default(),status,now(),id,input["version"].as_i64().unwrap_or(0),group.metadata.to_string()])?;
                if changed != 1 {
                    return Err(TaskRuntimeError::VersionConflict);
                }
                tx.commit()?;
                Ok(json!({"group":view(local_group(&connection,id,false)?)}))
            }
            "participation.get" | "participation.update" => {
                let thread = input["thread_id"].as_str().unwrap_or_default();
                let mut connection = self.connection()?;
                let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let item =
                    get_item_from(&tx, thread, "task")?.ok_or(TaskRuntimeError::TaskNotFound)?;
                let group = item
                    .cloud_project_id
                    .as_deref()
                    .ok_or(TaskRuntimeError::ProjectNotFound)?;
                let group = local_group(&tx, group, method.ends_with("update"))?;
                if method.ends_with("update") {
                    let mode = input["notifications"].as_str();
                    if (!input["notifications"].is_null() && mode.is_none())
                        || mode.is_some_and(|mode| !matches!(mode, "all" | "muted"))
                    {
                        return Err(TaskRuntimeError::Invalid(
                            "Invalid notification preference".into(),
                        ));
                    }
                    participate(
                        &tx,
                        thread,
                        input["joined"].as_bool().unwrap_or(false),
                        mode,
                    )?
                }
                let active = joined(&tx, thread)?;
                let notifications =
                    get_item_from(&tx, &participant_key(thread), "thread_participant")?
                        .and_then(|participant| {
                            participant.metadata["notifications"]
                                .as_str()
                                .map(str::to_owned)
                        })
                        .unwrap_or_else(|| "all".into());
                let participants = if active {
                    json!([{"user_id":0,"name":"Me","notifications":notifications}])
                } else {
                    json!([])
                };
                let result = json!({"current_user_id":0,"participants":participants,"joined":active,"can_comment":active&&group.status.as_deref()==Some("active"),"show_in_sidebar":active&&group.status.as_deref()==Some("active")&&!matches!(item.status.as_deref(),Some("completed"|"cancelled"|"archived"))});
                tx.commit()?;
                Ok(result)
            }
            _ => Err(TaskRuntimeError::Invalid("Unknown group operation".into())),
        }
    }
}
