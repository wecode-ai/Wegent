use super::*;

pub fn validate_provider(
    store: ProjectStoreKind,
    provider: TaskProviderKind,
) -> Result<(), TaskRuntimeError> {
    let valid = matches!(
        (store, provider),
        (ProjectStoreKind::Local, TaskProviderKind::Local)
            | (ProjectStoreKind::Local, TaskProviderKind::Github)
            | (ProjectStoreKind::Local, TaskProviderKind::Gitlab)
            | (ProjectStoreKind::Local, TaskProviderKind::DingtalkAitable)
            | (ProjectStoreKind::Backend, TaskProviderKind::Backend)
            | (ProjectStoreKind::Backend, TaskProviderKind::Github)
            | (ProjectStoreKind::Backend, TaskProviderKind::Gitlab)
            | (ProjectStoreKind::Backend, TaskProviderKind::DingtalkAitable)
    );
    valid
        .then_some(())
        .ok_or_else(|| TaskRuntimeError::Invalid("invalid project/provider combination".to_owned()))
}

pub(super) fn project_store_key(store: ProjectStoreKind) -> &'static str {
    match store {
        ProjectStoreKind::Local => "local",
        ProjectStoreKind::Backend => "backend",
    }
}

pub(super) fn task_provider_key(provider: TaskProviderKind) -> &'static str {
    match provider {
        TaskProviderKind::Local => "local",
        TaskProviderKind::Backend => "backend",
        TaskProviderKind::Github => "github",
        TaskProviderKind::Gitlab => "gitlab",
        TaskProviderKind::DingtalkAitable => "dingtalk_aitable",
    }
}

pub(super) fn provider_credential_config(
    connection: &Connection,
    project_store: &str,
    project_id: &str,
) -> Result<Option<serde_json::Value>, TaskRuntimeError> {
    let serialized = connection
        .query_row(
            "SELECT provider_config FROM project_provider_credentials
             WHERE project_store = ?1 AND project_id = ?2",
            params![project_store, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    serialized
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
        .transpose()
}

pub(super) fn list_external_projects(
    connection: &Connection,
) -> Result<Vec<LoopItem>, TaskRuntimeError> {
    let mut statement = connection.prepare(
        "SELECT project_id, descriptor
         FROM external_project_catalog
         WHERE project_store = 'backend'
         ORDER BY updated_at DESC",
    )?;
    let descriptors = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    descriptors
        .into_iter()
        .filter_map(|(project_id, serialized)| {
            let descriptor = match serde_json::from_str::<ProjectDescriptor>(&serialized) {
                Ok(descriptor) => descriptor,
                Err(error) => {
                    eprintln!(
                        "ignoring incompatible cached external project {project_id}: {error}"
                    );
                    return None;
                }
            };
            let provider_config = provider_credential_config(
                connection,
                project_store_key(descriptor.project_store),
                &descriptor.id,
            )
            .map(|config| config.unwrap_or_else(|| json!({})))
            .map(|config| descriptor_loop_item(descriptor, config));
            Some(provider_config)
        })
        .collect()
}

pub(super) fn external_project_from_catalog(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<LoopItem>, TaskRuntimeError> {
    let serialized = connection
        .query_row(
            "SELECT descriptor
             FROM external_project_catalog
             WHERE project_store = 'backend' AND project_id = ?1",
            [project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    serialized
        .map(|serialized| {
            let descriptor = serde_json::from_str::<ProjectDescriptor>(&serialized)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            let provider_config = provider_credential_config(
                connection,
                project_store_key(descriptor.project_store),
                &descriptor.id,
            )?
            .unwrap_or_else(|| json!({}));
            Ok(descriptor_loop_item(descriptor, provider_config))
        })
        .transpose()
}

pub(super) fn descriptor_loop_item(
    project: ProjectDescriptor,
    provider_config: serde_json::Value,
) -> LoopItem {
    LoopItem {
        id: project.id,
        resource_type: "project".to_owned(),
        project_space: "default".to_owned(),
        cloud_project_id: None,
        parent_id: None,
        public_id: project.public_id,
        project_key: Some(project.project_key),
        name: Some(project.name),
        title: None,
        description: project.description,
        created_by_user_id: 0,
        sequence_number: None,
        next_item_number: Some(1),
        status: Some("active".to_owned()),
        priority: None,
        sort_order: 0,
        current_delivery_id: None,
        metadata: json!({
            "project_store": project.project_store,
            "task_provider": project.task_provider,
            "provider_config": provider_config,
            "tags": [],
        }),
        version: project.version,
        created_at: String::new(),
        updated_at: String::new(),
        completed_at: None,
        assignee_agent_id: None,
        assignee_user_id: None,
        execution_id: None,
        execution_state: None,
    }
}

pub(super) fn local_project_metadata(
    task_provider: TaskProviderKind,
    provider_config: Value,
) -> Value {
    json!({
        "project_store": ProjectStoreKind::Local,
        "task_provider": task_provider,
        "provider_config": provider_config,
        "board_config": project_status::default_board_config(),
        "tags": [],
    })
}

pub(super) fn require_parent(
    connection: &Connection,
    project_id: &str,
    parent_id: &str,
    moving_task_id: Option<&str>,
) -> Result<(), TaskRuntimeError> {
    let parent = get_item_from(connection, parent_id, "task")?
        .filter(|item| item.cloud_project_id.as_deref() == Some(project_id))
        .ok_or_else(|| TaskRuntimeError::Invalid("parent task is not in the project".to_owned()))?;
    let mut cursor = Some(parent);
    while let Some(item) = cursor {
        if moving_task_id == Some(item.id.as_str()) {
            return Err(TaskRuntimeError::Invalid(
                "task hierarchy cannot contain a cycle".to_owned(),
            ));
        }
        cursor = match item.parent_id {
            Some(parent_id) => get_item_from(connection, &parent_id, "task")?,
            None => None,
        };
    }
    Ok(())
}

pub(super) fn normalize_project_key(value: Option<&str>, name: &str) -> String {
    let normalized = value.map(ToOwned::to_owned).unwrap_or_else(|| {
        name.chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .take(8)
            .collect()
    });
    let normalized = normalized.trim().to_ascii_uppercase();
    if normalized.len() >= 2 {
        normalized.chars().take(16).collect()
    } else {
        format!("PRJ{}", &Uuid::new_v4().simple().to_string()[..6]).to_ascii_uppercase()
    }
}

pub(super) fn project_key_for_create(
    connection: &Connection,
    requested: Option<&str>,
    name: &str,
) -> Result<String, rusqlite::Error> {
    let base = normalize_project_key(requested, name);
    if requested.is_some() || !project_key_exists(connection, &base)? {
        return Ok(base);
    }
    for sequence in 2_u64.. {
        let suffix = sequence.to_string();
        let stem = base
            .chars()
            .take(16_usize.saturating_sub(suffix.len()))
            .collect::<String>();
        let candidate = format!("{stem}{suffix}");
        if !project_key_exists(connection, &candidate)? {
            return Ok(candidate);
        }
    }
    unreachable!("the project key sequence is unbounded")
}

pub(super) fn project_key_exists(
    connection: &Connection,
    project_key: &str,
) -> Result<bool, rusqlite::Error> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM loop_items WHERE project_key = ?1)",
        [project_key],
        |row| row.get(0),
    )
}
