//! Durable execution definitions for personal roles. Group duties remain in the role settings.
use super::*;

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
        let metadata = json!({"id":reference,"name":role["name"],"runtime":runtime,"bot":[bot],"collaboration_model":"solo","system_prompt":"","additional_skills":[],"plugins":[]});
        write_definition(connection, user, reference, &metadata)?;
    }
    Ok(())
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

fn definition(
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
    Ok(get_item_from(connection, reference, "local_team")?
        .filter(|r| r.created_by_user_id == user)
        .ok_or_else(unavailable)?
        .metadata)
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
        let value = self.personal_execution_team(
            user,
            role["teamRef"]
                .as_str()
                .ok_or_else(|| TaskRuntimeError::Invalid("Role has no Team".into()))?,
        )?;
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
        let mut metadata = portable(
            &json!({"name":team["metadata"]["displayName"],"bot":bots,"collaboration_model":team["spec"]["collaborationModel"]}),
        )?;
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
        let mut source = json!({"roleId":"review","team":{"metadata":{"name":"review","namespace":"personal-assistant","displayName":"Review"},"spec":{"collaborationModel":"pipeline"}},
            "bot":{"spec":{"execution_policy":{"mode":"user_select"},"model_policy":{"mode":"user_select"}}},
            "members":[member("research",true),member("review",false)]});
        let reference = store.import_account_execution_team(7, &source).unwrap();
        drop(store);
        let reopened = LocalTaskStore::open(&path).unwrap();
        let saved = reopened.personal_execution_team(7, &reference).unwrap();
        assert_eq!(saved["bot"][0]["requireConfirmation"], true);
        assert_eq!(saved["bot"][1]["system_prompt"], "Work as review");
        assert_eq!(saved["collaboration_model"], "pipeline");
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
