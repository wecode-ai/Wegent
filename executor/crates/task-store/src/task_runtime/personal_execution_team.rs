//! Durable execution definitions for personal roles. Group duties remain in the role settings.
use super::*;

const LOCAL_BOT_GRANTS: [&str; 3] = ["skills", "skill_refs", "mcp_servers"];

fn identity_ref(user: i64, role: &str, identity: &Value) -> String {
    // A portable copy may have a new local role id. Recover the original identity
    // inside the destination owner's namespace, without importing its permissions.
    let source = identity["migrationSource"]
        .as_str()
        .and_then(|source| serde_json::from_str::<(String, i64, String)>(source).ok());
    let identity = match source {
        Some((_, owner, id)) if owner == user => json!([user, id]),
        Some((device, owner, id)) => json!([user, device, owner, id]),
        None => json!([user, role]),
    };
    format!(
        "stand-in-team-{:x}",
        Sha256::digest(identity.to_string().as_bytes())
    )
}

pub(super) fn bind(value: &mut Value, user: i64) -> Result<(), TaskRuntimeError> {
    let bind = |role: &str, identity: &mut Value| {
        let expected = identity_ref(user, role, identity);
        match identity.get("teamRef") {
            None | Some(Value::Null) => identity["teamRef"] = json!(expected),
            Some(Value::String(reference)) if reference.starts_with("stand-in-team-") => {
                identity["teamRef"] = json!(expected)
            }
            Some(Value::String(reference))
                if reference == &expected || reference.starts_with("LA-") => {}
            _ => {
                return Err(TaskRuntimeError::Invalid(
                    "Invalid personal Team reference".into(),
                ));
            }
        }
        Ok(())
    };
    if value["primary"].is_object() {
        bind("@primary", &mut value["primary"])?;
    }
    for identity in value["roles"].as_array_mut().into_iter().flatten() {
        let role = identity["id"]
            .as_str()
            .ok_or_else(|| TaskRuntimeError::Invalid("Missing role identity".into()))?
            .to_owned();
        bind(&role, identity)?;
    }
    Ok(())
}

pub(super) fn persist(connection: &Connection, settings: &Value) -> Result<(), TaskRuntimeError> {
    let user = settings["userId"]
        .as_i64()
        .ok_or_else(|| TaskRuntimeError::Invalid("Missing role owner".into()))?;
    for role in stand_in_identities(settings) {
        let reference = role["teamRef"]
            .as_str()
            .ok_or_else(|| TaskRuntimeError::Invalid("Missing role Team reference".into()))?;
        if reference.starts_with("LA-") {
            definition(connection, user, reference)?;
            continue;
        }
        if let Some(existing) = get_item_from(connection, reference, "local_team")? {
            if existing.created_by_user_id != user {
                return Err(TaskRuntimeError::Invalid(
                    "Team belongs to another owner".into(),
                ));
            }
            if existing.metadata["imported"] == true {
                continue;
            }
        }
        let metadata = solo_definition(&role, reference)?;
        write_definition(connection, user, reference, &metadata)?;
    }
    Ok(())
}

fn solo_definition(role: &Value, reference: &str) -> Result<Value, TaskRuntimeError> {
    let runtime = role["model"]["runtime"].as_str().unwrap_or("codex");
    let shell = match runtime {
        "codex" => "Codex",
        "claude_code" => "ClaudeCode",
        _ => {
            return Err(TaskRuntimeError::Invalid(
                "Unsupported personal Team runtime".into(),
            ));
        }
    };
    let bot = json!({"id":format!("{reference}-bot"),"name":role["name"],"shell_type":shell});
    Ok(
        json!({"id":reference,"name":role["name"],"runtime":runtime,"bot":[bot],"collaboration_model":"solo","system_prompt":"","additional_skills":[],"plugins":[]}),
    )
}

fn write_definition(
    connection: &Connection,
    user: i64,
    reference: &str,
    metadata: &Value,
) -> Result<(), TaskRuntimeError> {
    connection.execute("INSERT INTO loop_items(id,resource_type,name,metadata,created_by_user_id,created_at,updated_at) VALUES(?1,'local_team',?2,?3,?4,?5,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,metadata=excluded.metadata,updated_at=excluded.updated_at,version=loop_items.version+1 WHERE loop_items.resource_type='local_team' AND loop_items.created_by_user_id=excluded.created_by_user_id AND loop_items.metadata<>excluded.metadata",
            params![reference,metadata["name"].as_str(),metadata.to_string(),user,now()])?;
    Ok(())
}

pub(in crate::task_runtime::store) fn definition(
    connection: &Connection,
    user: i64,
    reference: &str,
) -> Result<Value, TaskRuntimeError> {
    let unavailable =
        || TaskRuntimeError::Invalid("Personal Team unavailable for this owner".into());
    if reference.starts_with("LA-") {
        let owned: bool=connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM loop_items a WHERE a.id=?1 AND (a.created_by_user_id=?2 OR (a.created_by_user_id=0 AND EXISTS(SELECT 1 FROM loop_items p,json_each(p.metadata,'$.workspaceTeamGrants') g WHERE p.id=?3 AND p.resource_type='personal_stand_in' AND g.value=a.id))))",
            params![reference,user,personal_key(user)], |row|row.get(0))?;
        let row = get_item_from(connection, reference, "chat_agent")?
            .filter(|r| {
                owned
                    && r.cloud_project_id.as_deref() == Some(DEFAULT_WORK_ITEM_PROJECT_ID)
                    && r.status.as_deref() == Some("active")
            })
            .ok_or_else(unavailable)?;
        let mut agent = row.metadata;
        agent["id"] = json!(row.id);
        agent["name"] = json!(row.title.or(row.name));
        return Ok(agent);
    }
    if let Some(row) = get_item_from(connection, reference, "local_team")? {
        return if row.created_by_user_id == user {
            Ok(row.metadata)
        } else {
            Err(unavailable())
        };
    }
    let settings = read_personal(connection, user, "")?;
    let role = stand_in_identities(&settings)
        .into_iter()
        .find(|role| role["teamRef"].as_str() == Some(reference))
        .ok_or_else(unavailable)?;
    solo_definition(&role, reference)
}

/// The transfer carries only executable public role fields. Device grants and
/// credentials must be provisioned separately on the destination.
fn portable(value: &Value) -> Result<Value, TaskRuntimeError> {
    let invalid = || {
        TaskRuntimeError::Invalid(
            "The Team definition contains an unsupported or device-bound capability".into(),
        )
    };
    if ["mcp_servers", "additional_skills", "plugins"]
        .iter()
        .any(|key| match &value[*key] {
            Value::Null => false,
            Value::Array(values) => !values.is_empty(),
            Value::Object(values) => !values.is_empty(),
            _ => true,
        })
    {
        return Err(invalid());
    }
    let bots = value["bot"]
        .as_array()
        .filter(|b| !b.is_empty())
        .ok_or_else(invalid)?;
    let mode = value["collaboration_model"].as_str().unwrap_or("single");
    let mut seen = HashSet::new();
    let mut members = Vec::new();
    for bot in bots {
        let mut fields = bot.as_object().ok_or_else(invalid)?.clone();
        fields.retain(|key, v| {
            !(matches!(key.as_str(), "mcp_servers" | "skills" | "plugins")
                && (v.is_null()
                    || v.as_array().is_some_and(Vec::is_empty)
                    || v.as_object().is_some_and(|o| o.is_empty())))
        });
        if !(bot["id"].as_str().is_some_and(|s| !s.is_empty()) || bot["id"].is_i64())
            || (mode != "pipeline" && !seen.insert(bot["id"].to_string()))
            || !matches!(bot["shell_type"].as_str(), Some("ClaudeCode" | "Codex"))
            || !fields.iter().all(|(key, value)| match key.as_str() {
                "id" => true,
                "requireConfirmation" | "require_confirmation" => value.is_boolean(),
                "contextPassing" | "context_passing" => matches!(
                    value.as_str(),
                    Some("none" | "original_user" | "previous_bot" | "original_and_previous")
                ),
                "name" | "shell_type" | "system_prompt" | "description" | "role" | "prompt"
                | "model_id" | "model_provider" => value.is_string(),
                _ => false,
            })
        {
            return Err(invalid());
        }
        members.push(Value::Object(fields));
    }
    if !matches!(
        mode,
        "single" | "solo" | "coordinate" | "pipeline" | "collaborate" | "route"
    ) {
        return Err(invalid());
    }
    let mut definition = json!({"name":value["name"],"collaboration_model":mode,"bot":members,"system_prompt":value["system_prompt"].as_str().unwrap_or_default()});
    if let Some(policy) = value.get("model_policy").filter(|policy| !policy.is_null()) {
        // Fixed native models are bound to the destination role's device on import.
        crate::task_runtime::runner_routing::validate_policies(
            Some(&json!({"mode":"fixed","environment_id":"destination"})),
            Some(policy),
        )?;
        definition["model_policy"] = policy.clone();
    }
    Ok(definition)
}

/// Fork the currently referenced local definition within the settings save transaction.
pub(super) fn copy_referenced_role(
    connection: &Connection,
    user: i64,
    device: &str,
    role_id: &str,
    settings: &mut Value,
    copy_prompt: Option<bool>,
) -> Result<(), TaskRuntimeError> {
    let invalid = || TaskRuntimeError::Invalid("Referenced assistant Team changed".into());
    let previous = read_personal(connection, user, device)?;
    let before = stand_in_identities(&previous)
        .into_iter()
        .find(|role| role["id"] == role_id && role["executionDeviceId"] == device)
        .ok_or_else(invalid)?;
    let source = before["teamRef"]
        .as_str()
        .filter(|r| r.starts_with("LA-"))
        .ok_or_else(invalid)?;
    let role = if role_id == "@primary" {
        &mut settings["primary"]
    } else {
        settings["roles"]
            .as_array_mut()
            .and_then(|roles| roles.iter_mut().find(|r| r["id"] == role_id))
            .ok_or_else(invalid)?
    };
    if role["teamRef"] != source {
        return Err(invalid());
    }
    let reference = identity_ref(user, role_id, &before);
    let mut team = definition(connection, user, source)?;
    team["id"] = json!(reference);
    team["imported"] = json!(true);
    apply_identity_edit(&mut team, &before, role, copy_prompt);
    role["prompt"] = json!(team["system_prompt"].as_str().unwrap_or_default());
    write_definition(connection, user, &reference, &team)?;
    role["teamRef"] = json!(reference);
    Ok(())
}

fn apply_identity_edit(team: &mut Value, before: &Value, role: &Value, edit_prompt: Option<bool>) {
    if before["name"] != role["name"] && role["name"].is_string() {
        team["name"] = role["name"].clone();
    }
    if edit_prompt.unwrap_or(before["prompt"] != role["prompt"]) {
        team["system_prompt"] = role["prompt"].clone();
    }
}

/// Keep subsequent edits on an owned multi-Bot definition without rebuilding it as Solo.
pub(super) fn update_owned_definition(
    connection: &Connection,
    user: i64,
    before: &Value,
    role: &Value,
) -> Result<(), TaskRuntimeError> {
    if before["prompt"] == role["prompt"] && before["name"] == role["name"] {
        return Ok(());
    }
    let Some(reference) = role["teamRef"]
        .as_str()
        .filter(|r| r.starts_with("stand-in-team-") && before["teamRef"] == *r)
    else {
        return Ok(());
    };
    let Some(record) = get_item_from(connection, reference, "local_team")? else {
        return Ok(());
    };
    if record.created_by_user_id == user && record.metadata["imported"] == true {
        let mut team = record.metadata;
        apply_identity_edit(&mut team, before, role, None);
        write_definition(connection, user, reference, &team)?;
    }
    Ok(())
}

pub(super) fn owned_role_reference(
    user: i64,
    device: &str,
    settings: &Value,
    role_id: &str,
) -> Result<String, TaskRuntimeError> {
    let unavailable =
        || TaskRuntimeError::Invalid("Personal Team unavailable for this role and device".into());
    let role = stand_in_identities(settings)
        .into_iter()
        .find(|role| role["id"] == role_id && role["executionDeviceId"] == device)
        .ok_or_else(unavailable)?;
    let reference = identity_ref(user, role_id, &role);
    if role["teamRef"] != reference {
        return Err(unavailable());
    }
    Ok(reference)
}

/// Configure grants only on the selected owner's device-local role Team.
pub(super) fn replace_bot_grants(
    connection: &Connection,
    user: i64,
    reference: &str,
    input: &Value,
) -> Result<(), TaskRuntimeError> {
    let invalid =
        || TaskRuntimeError::Invalid("Invalid personal Bot grants or Team identity".into());
    let mut definition = definition(connection, user, reference)?;
    let bots = definition["bot"].as_array_mut().ok_or_else(invalid)?;
    let grants = input["botGrants"].as_array().ok_or_else(invalid)?;
    let mut entries = std::collections::HashMap::new();
    for grant in grants {
        let id = grant.get("id").ok_or_else(invalid)?.to_string();
        if entries.insert(id, grant).is_some()
            || !grant
                .as_object()
                .ok_or_else(invalid)?
                .iter()
                .all(|(key, v)| match key.as_str() {
                    "id" => v.is_string() || v.is_i64(),
                    "skills" => v.as_array().is_some_and(|v| v.iter().all(Value::is_string)),
                    "skill_refs" | "mcp_servers" => v.is_object(),
                    _ => false,
                })
        {
            return Err(invalid());
        }
    }
    let mut used = HashSet::new();
    for bot in bots {
        used.insert(bot["id"].to_string());
        let grant = entries.get(&bot["id"].to_string()).ok_or_else(invalid)?;
        let fields = bot.as_object_mut().ok_or_else(invalid)?;
        for key in LOCAL_BOT_GRANTS {
            if let Some(v) = grant.get(key) {
                fields.insert(key.into(), v.clone());
            } else {
                fields.remove(key);
            }
        }
        fields.insert("native_capability_scope".into(), json!("bot"));
    }
    if used.len() != entries.len() {
        return Err(invalid());
    }
    definition["imported"] = json!(true);
    write_definition(connection, user, reference, &definition)
}

pub(super) fn import_transfer(
    connection: &Connection,
    user: i64,
    settings: &mut Value,
) -> Result<(), TaskRuntimeError> {
    let Some(input) = settings
        .as_object_mut()
        .and_then(|o| o.remove("transferredTeamDefinition"))
    else {
        return Ok(());
    };
    let role = settings["roles"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["id"] == input["roleId"] && r["migrationSource"].is_string())
        .ok_or_else(|| {
            TaskRuntimeError::Invalid("Transferred role has no source identity".into())
        })?;
    let reference = identity_ref(user, role["id"].as_str().unwrap_or_default(), role);
    if role["teamRef"] != reference {
        return Err(TaskRuntimeError::Invalid(
            "Transferred Team identity is invalid".into(),
        ));
    }
    let mut metadata = portable(&input["definition"])?;
    metadata["id"] = json!(reference);
    metadata["runtime"] = json!(if metadata["bot"][0]["shell_type"] == "ClaudeCode" {
        "claude_code"
    } else {
        "codex"
    });
    if metadata["model_policy"].is_object() {
        metadata["execution_policy"] =
            json!({"mode":"fixed","environment_id":role["executionDeviceId"]});
    }
    metadata["imported"] = json!(true);
    write_definition(connection, user, &reference, &metadata)
}

/// Project execution uses the source topology and the project's live Bot grants.
pub(in crate::task_runtime::store) fn project_definition(
    connection: &Connection,
    user: i64,
    reference: &str,
    project_agent: &Value,
) -> Result<Value, TaskRuntimeError> {
    let source = definition(connection, user, reference)?;
    let project_bots = project_agent["bot"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let by_id: std::collections::HashMap<_, _> = project_bots
        .iter()
        .map(|bot| (bot["id"].to_string(), bot))
        .collect();
    let mut bots = source["bot"].clone();
    for bot in bots.as_array_mut().into_iter().flatten() {
        if let Some(fields) = bot.as_object_mut() {
            fields.retain(|key, _| {
                matches!(
                    key.as_str(),
                    "id" | "name"
                        | "shell_type"
                        | "system_prompt"
                        | "description"
                        | "role"
                        | "prompt"
                        | "requireConfirmation"
                        | "require_confirmation"
                        | "contextPassing"
                        | "context_passing"
                )
            });
        }
    }
    let mut result = portable(
        &json!({"name":source["name"],"system_prompt":source["system_prompt"],"collaboration_model":source["collaboration_model"],"bot":bots}),
    )?;
    let runtime = if result["bot"][0]["shell_type"] == "ClaudeCode" {
        "claude_code"
    } else {
        "codex"
    };
    if crate::task_runtime::store::record_rows::project_agent_runtime(project_agent) != runtime {
        return Err(TaskRuntimeError::Invalid(
            "Choose a project Agent with the source Team runtime".into(),
        ));
    }
    for (index, bot) in result["bot"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .enumerate()
    {
        // A solo project Agent owns its lead Bot's grants. Additional Bots can
        // only receive grants already belonging to their exact project Bot.
        let authorized =
            by_id
                .get(&bot["id"].to_string())
                .copied()
                .or_else(|| match project_bots {
                    [lead] if index == 0 => Some(lead),
                    _ => None,
                });
        if let Some(grants) = authorized {
            bot["native_capability_scope"] = json!("bot");
            for key in [
                "mcp_servers",
                "mcpServers",
                "plugins",
                "skills",
                "preload_skills",
                "skill_refs",
                "capability_mode",
                "native_capability_scope",
            ] {
                if let Some(value) = grants.get(key) {
                    bot[key] = value.clone()
                }
            }
        }
    }
    Ok(result)
}

impl LocalTaskStore {
    pub fn portable_personal_team(
        &self,
        user: i64,
        device: &str,
        role_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let settings = self.personal_stand_in(user, device)?;
        let role = stand_in_identities(&settings)
            .into_iter()
            .find(|r| r["id"] == role_id)
            .ok_or_else(|| TaskRuntimeError::Invalid("Unknown source role".into()))?;
        let reference = role["teamRef"]
            .as_str()
            .ok_or_else(|| TaskRuntimeError::Invalid("Role has no Team".into()))?;
        let mut value = self.personal_execution_team(user, reference)?;
        if reference.starts_with("stand-in-team-") {
            for bot in value["bot"].as_array_mut().into_iter().flatten() {
                if bot["native_capability_scope"] == "bot" {
                    let fields = bot.as_object_mut().expect("locally provisioned Bot");
                    fields.remove("native_capability_scope");
                    for key in LOCAL_BOT_GRANTS {
                        fields.remove(key);
                    }
                }
            }
        }
        portable(&value)
    }

    pub fn bindable_personal_teams(
        &self,
        user: i64,
        workspace_owner: bool,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut query=connection.prepare("SELECT id,COALESCE(json_extract(metadata,'$.display_name'),title,name) FROM loop_items WHERE resource_type='chat_agent' AND cloud_project_id=?1 AND (created_by_user_id=?2 OR (created_by_user_id=0 AND ?3)) AND status='active' AND deleted_at IS NULL ORDER BY created_at,id")?;
        let rows = query.query_map(
            params![DEFAULT_WORK_ITEM_PROJECT_ID, user, workspace_owner],
            |row| Ok(json!({"id":row.get::<_,String>(0)?,"name":row.get::<_,String>(1)?})),
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn import_account_execution_team(
        &self,
        user: i64,
        definition: &Value,
    ) -> Result<String, TaskRuntimeError> {
        let invalid = || TaskRuntimeError::Invalid("Invalid account assistant definition".into());
        let role = definition["roleId"].as_str().ok_or_else(invalid)?;
        let team = &definition["team"];
        let name = team["metadata"]["name"].as_str().ok_or_else(invalid)?;
        let namespace = team["metadata"]["namespace"].as_str().ok_or_else(invalid)?;
        let members = definition["members"].as_array().ok_or_else(invalid)?;
        let mut bots = Vec::with_capacity(members.len());
        for entry in members {
            let bot = &entry["bot"];
            let member = &entry["member"];
            let mut compiled = json!({"id":bot["metadata"]["name"],"name":bot["metadata"]["displayName"],"shell_type":bot["spec"]["shellRef"]["name"],"system_prompt":entry["ghost"]["spec"]["systemPrompt"]});
            for key in ["role", "prompt", "requireConfirmation", "contextPassing"] {
                if let Some(value) = member.get(key) {
                    compiled[key] = value.clone();
                }
            }
            bots.push(compiled);
        }
        let reference = format!(
            "account-team-{:x}",
            Sha256::digest(json!([user, role, namespace, name]).to_string().as_bytes())
        );
        let mut metadata = portable(&json!({
            "name": team["metadata"]["displayName"],
            "bot": bots,
            "collaboration_model": team["spec"]["collaborationModel"],
            "system_prompt": team["spec"]["systemPrompt"]
        }))?;
        metadata["id"] = json!(reference);
        metadata["accountRoleId"] = json!(role);
        metadata["accountTeam"] = team["metadata"].clone();
        metadata["runtime"] = json!(if metadata["bot"][0]["shell_type"] == "ClaudeCode" {
            "claude_code"
        } else {
            "codex"
        });
        for key in ["model_policy", "execution_policy"] {
            metadata[key] = definition["bot"]["spec"][key].clone();
        }
        write_definition(&*self.connection()?, user, &reference, &metadata)?;
        Ok(reference)
    }

    pub fn owned_personal_role_team(
        &self,
        user: i64,
        device: &str,
        role_id: &str,
    ) -> Result<Value, TaskRuntimeError> {
        let connection = self.connection()?;
        let settings = read_personal(&connection, user, device)?;
        let reference = owned_role_reference(user, device, &settings, role_id)?;
        definition(&connection, user, &reference)
    }

    pub fn personal_execution_team(
        &self,
        user: i64,
        reference: &str,
    ) -> Result<Value, TaskRuntimeError> {
        definition(&*self.connection()?, user, reference)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_an_older_personal_role_resolves_its_team_without_persisting_it() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "device").unwrap();
        settings["roles"] = json!([empty_role("review", "device")]);
        let saved = store.save_personal_stand_in(7, "device", settings).unwrap();
        let reference = saved["roles"][0]["teamRef"].as_str().unwrap();
        let expected = store.personal_execution_team(7, reference).unwrap();
        let before = {
            let conn = store.connection().unwrap();
            conn.execute("DELETE FROM loop_items WHERE id=?1", [reference])
                .unwrap();
            conn.execute("UPDATE loop_items SET metadata=json_remove(metadata,'$.roles[0].teamRef') WHERE id=?1",[personal_key(7)]).unwrap();
            conn.total_changes()
        };
        let projected = store.personal_stand_in(7, "device").unwrap();
        assert_eq!(projected["roles"][0]["teamRef"], reference);
        assert_eq!(
            store.personal_execution_team(7, reference).unwrap(),
            expected
        );
        assert!(store.personal_execution_team(8, reference).is_err());
        assert_eq!(store.connection().unwrap().total_changes(), before);
    }

    #[test]
    fn older_role_editor_preserves_the_selected_team_until_explicitly_reset() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let agent = store
            .create_chat_agent(
                DEFAULT_WORK_ITEM_PROJECT_ID,
                serde_json::from_value(
                    json!({"name":"reviewer","runtime":"codex","created_by_user_id":7}),
                )
                .unwrap(),
            )
            .unwrap();
        let mut settings = store.personal_stand_in(7, "device").unwrap();
        let mut role = empty_role("review", "device");
        role["teamRef"] = json!(agent.id);
        settings["roles"] = json!([role]);
        let mut older = store.save_personal_stand_in(7, "device", settings).unwrap();
        older["roles"][0].as_object_mut().unwrap().remove("teamRef");
        older["roles"][0]["name"] = json!("Renamed by older client");
        let mut edited = store.save_personal_stand_in(7, "device", older).unwrap();
        assert_eq!(edited["roles"][0]["teamRef"], agent.id);
        edited["roles"][0]["teamRef"] = Value::Null;
        let reset = store.save_personal_stand_in(7, "device", edited).unwrap();
        assert_ne!(reset["roles"][0]["teamRef"], agent.id);
        assert!(reset["roles"][0]["teamRef"]
            .as_str()
            .unwrap()
            .starts_with("stand-in-team-"));
    }

    #[test]
    fn copying_an_assistant_team_saves_the_edit_and_preserves_its_source() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let source = store.create_chat_agent(DEFAULT_WORK_ITEM_PROJECT_ID,
            serde_json::from_value(json!({"name":"Reviewer","runtime":"codex","created_by_user_id":7,
                "system_prompt":"Shared instructions","mcp_servers":{"tools":{"url":"https://example.invalid/mcp"}}})).unwrap()).unwrap();
        let mut settings = store.personal_stand_in(7, "device").unwrap();
        let mut role = empty_role("review", "device");
        role["teamRef"] = json!(source.id);
        settings["roles"] = json!([role]);
        let mut settings = store.save_personal_stand_in(7, "device", settings).unwrap();
        let original = store.personal_execution_team(7, &source.id).unwrap();
        let save_copy = |settings, copy_prompt| {
            store.save_verified_personal_settings(
                7,
                "device",
                None,
                settings,
                VerifiedPersonalSettings {
                    copy_team_role_id: Some("review"),
                    copy_team_prompt: copy_prompt,
                    ..Default::default()
                },
            )
        };
        // An explicitly cleared Team prompt can equal the old role's empty prompt.
        let cleared = save_copy(settings.clone(), Some(true)).unwrap();
        let cleared_ref = cleared["roles"][0]["teamRef"].as_str().unwrap();
        assert_eq!(
            store.personal_execution_team(7, cleared_ref).unwrap()["system_prompt"],
            ""
        );
        settings["version"] = cleared["version"].clone();
        let mut settings = store.save_personal_stand_in(7, "device", settings).unwrap();
        settings["roles"][0]["prompt"] = json!("Independent review");
        let mut stale = settings.clone();
        stale["version"] = json!(-1);
        assert!(save_copy(stale, None).is_err());
        assert_eq!(
            store.personal_stand_in(7, "device").unwrap()["roles"][0]["teamRef"],
            source.id
        );
        let saved = save_copy(settings, None).unwrap();
        let reference = saved["roles"][0]["teamRef"].as_str().unwrap();
        assert_ne!(reference, source.id);
        let copied = store.personal_execution_team(7, reference).unwrap();
        assert_eq!(copied["bot"], original["bot"]);
        assert_eq!(copied["system_prompt"], "Independent review");
        let mut edited = saved.clone();
        edited["roles"][0]["prompt"] = json!("Second independent review");
        let edited = store.save_personal_stand_in(7, "device", edited).unwrap();
        assert_eq!(edited["roles"][0]["teamRef"], reference);
        let second = store.personal_execution_team(7, reference).unwrap();
        assert_eq!(second["system_prompt"], "Second independent review");
        assert_eq!(second["bot"], original["bot"]);
        assert_eq!(
            store.personal_execution_team(7, &source.id).unwrap(),
            original
        );
    }

    #[test]
    fn account_team_refresh_keeps_identity_and_order_across_restart() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let member = |name: &str, confirm: bool| {
            json!({
                "member":{"role":"worker","requireConfirmation":confirm,"contextPassing":"previous_bot"},
                "bot":{"metadata":{"name":name,"displayName":name},"spec":{"shellRef":{"name":"Codex"}}},
                "ghost":{"spec":{"systemPrompt":format!("Work as {name}")}}
            })
        };
        let mut source = json!({"roleId":"review","team":{"metadata":{"name":"review","namespace":"personal-assistant","displayName":"Review"},"spec":{"collaborationModel":"pipeline","systemPrompt":"Team-wide review policy"}},
            "bot":{"spec":{"execution_policy":{"mode":"user_select"},"model_policy":{"mode":"user_select"}}},
            "members":[member("research",true),member("review",false)]});
        let reference = store.import_account_execution_team(7, &source).unwrap();
        drop(store);
        let reopened = LocalTaskStore::open(&path).unwrap();
        let saved = reopened.personal_execution_team(7, &reference).unwrap();
        assert_eq!(saved["bot"][0]["requireConfirmation"], true);
        assert_eq!(saved["bot"][1]["system_prompt"], "Work as review");
        assert_eq!(saved["collaboration_model"], "pipeline");
        assert_eq!(saved["system_prompt"], "Team-wide review policy");
        assert!(reopened.personal_execution_team(8, &reference).is_err());
        source["members"].as_array_mut().unwrap().reverse();
        assert_eq!(
            reopened.import_account_execution_team(7, &source).unwrap(),
            reference
        );
        assert_eq!(
            reopened.personal_execution_team(7, &reference).unwrap()["bot"][0]["id"],
            "review"
        );
    }

    #[test]
    fn owner_grants_commit_atomically_and_stay_on_the_source_device() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "target").unwrap();
        settings["roles"] = json!([empty_role("review", "target")]);
        let saved = store.save_personal_stand_in(7, "target", settings).unwrap();
        let reference = saved["roles"][0]["teamRef"].as_str().unwrap();
        let id = store.personal_execution_team(7, reference).unwrap()["bot"][0]["id"].clone();
        let grant = json!({"id":id,"skills":["check"],"skill_refs":{"check":{"skill_id":12}},
            "mcp_servers":{"check":{"url":"https://example.invalid/mcp","headers":{"X-Test":"private"}}}});
        let save = |value: Value, grants: Value| {
            store.save_verified_personal_settings(
                7,
                "target",
                None,
                value,
                VerifiedPersonalSettings {
                    workspace_owner: true,
                    owned_team: Some(&json!({"roleId":"review","botGrants":grants})),
                    ..Default::default()
                },
            )
        };
        for invalid in [json!([grant, grant]), json!([{"id":"missing"}])] {
            assert!(save(saved.clone(), invalid).is_err());
            assert_eq!(
                store.personal_stand_in(7, "target").unwrap()["version"],
                saved["version"]
            );
        }
        let current = save(saved, json!([grant])).unwrap();
        let reference = current["roles"][0]["teamRef"].as_str().unwrap();
        assert_eq!(
            store.personal_execution_team(7, reference).unwrap()["bot"][0]["skill_refs"]["check"]
                ["skill_id"],
            12
        );
        assert!(store.personal_execution_team(8, reference).is_err());
        let exported = store.portable_personal_team(7, "target", "review").unwrap();
        assert_eq!(exported["bot"][0]["id"], id);
        for key in [
            "skills",
            "mcp_servers",
            "skill_refs",
            "native_capability_scope",
        ] {
            assert!(exported["bot"][0].get(key).is_none());
        }
        assert!(!exported.to_string().contains("private"));
        let mut injected = exported;
        injected["bot"][0]["mcp_servers"] = grant["mcp_servers"].clone();
        assert!(portable(&injected).is_err());
    }

    #[test]
    fn imported_definition_preserves_bot_order_across_save_and_reopen() {
        for mode in ["coordinate", "route", "collaborate"] {
            assert_portable_team_round_trip(mode);
        }
    }

    fn assert_portable_team_round_trip(mode: &str) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tasks.sqlite");
        let store = LocalTaskStore::open(&path).unwrap();
        let mut settings = store.personal_stand_in(7, "target").unwrap();
        let mut role = empty_role("copy", "target");
        role["migrationSource"] = json!("[\"source\",7,\"original\"]");
        settings["roles"] = json!([role]);
        let definition = json!({"name":"Review","collaboration_model":mode,"model_policy":{"mode":"fixed","model":{"runtime":"codex","provider":"native","model_id":"review-model"}},"bot":[
            {"id":"lead","name":"Lead","shell_type":"Codex"},
            {"id":"reader","name":"Reader","shell_type":"Codex","system_prompt":"Check the evidence"}
        ]});
        settings["transferredTeamDefinition"] = json!({"roleId":"copy","definition":definition});
        let saved = store.save_personal_stand_in(7, "target", settings).unwrap();
        let team = saved["roles"][0]["teamRef"].as_str().unwrap();
        let resolved = store.personal_execution_team(7, team).unwrap();
        assert_eq!(resolved["bot"], definition["bot"]);
        assert!(store.personal_execution_team(8, team).is_err());
        store
            .save_personal_stand_in(7, "target", saved.clone())
            .unwrap();
        drop(store);
        let reopened = LocalTaskStore::open(path).unwrap();
        let exported = reopened
            .portable_personal_team(7, "target", "copy")
            .unwrap();
        assert_eq!(exported["bot"], definition["bot"]);
        assert_eq!(exported["model_policy"], definition["model_policy"]);
        assert_eq!(exported["collaboration_model"], mode);
    }
}
