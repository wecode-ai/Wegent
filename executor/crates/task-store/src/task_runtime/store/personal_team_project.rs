//! A personal roster supplies definitions. Its mapped project Agents supply execution authority.
use super::personal_stand_in::{project_definition, read_personal, stand_in_team, StandInTeam};
use super::*;
use std::collections::BTreeMap;

const KIND: &str = "personal_team_project_binding";
fn invalid(reason: &str) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(reason.into())
}

fn groups(project: &mut LoopItem) -> Result<&mut Vec<Value>, TaskRuntimeError> {
    project
        .metadata
        .as_object_mut()
        .ok_or_else(|| invalid("Invalid project metadata"))?
        .entry("collaboration_groups")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or_else(|| invalid("Invalid collaboration groups"))
}

fn save_groups(connection: &Connection, project: &LoopItem) -> Result<(), TaskRuntimeError> {
    connection.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.collaboration_groups',json(?1)),version=version+1,updated_at=?2 WHERE id=?3 AND resource_type='project'",
        params![project.metadata["collaboration_groups"].to_string(), now(), project.id])?;
    Ok(())
}

fn project_agent(
    connection: &Connection,
    project: &str,
    id: &str,
    user_id: i64,
) -> Result<LoopItem, TaskRuntimeError> {
    let agent = collaboration::collaboration_agent(connection, project, id)?;
    if agent.id != id
        || agent.status.as_deref() != Some("active")
        || (agent.cloud_project_id.as_deref() != Some(project)
            && !collaboration::has_active_project_team_binding(connection, project, id)?)
    {
        return Err(invalid("Project Agent is not bound to this project"));
    }
    if agent.metadata["visibility"] == "private" && agent.created_by_user_id != user_id {
        return Err(invalid("Private Agent is not shared with this member"));
    }
    Ok(agent)
}

fn source_space(owner: i64, source: &str) -> String {
    format!("personal-team:{owner}:{source}")
}

fn role_refs(settings: &Value) -> HashMap<&str, &str> {
    let device = settings["executionDeviceId"].as_str();
    std::iter::once(("@primary", &settings["primary"]))
        .chain(
            settings["roles"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|role| Some((role["id"].as_str()?, role))),
        )
        .filter_map(|(id, role)| {
            let reference = role["teamRef"].as_str()?;
            let target = role["executionDeviceId"].as_str().or(device);
            (target == device || reference.starts_with("LA-")).then_some((id, reference))
        })
        .collect()
}

fn roster(group: &mut Value, team: &StandInTeam, bindings: &Value) -> bool {
    let mut members = Vec::new();
    for (role, duty) in &team.members {
        let binding = &bindings[role];
        if !binding["agent"].is_string() {
            return false;
        }
        let member = json!({"kind":"agent","id":binding["agent"],"name":binding["name"],"responsibility":duty});
        if role == &team.lead_id {
            group["leader"] = member.clone()
        }
        members.push(member);
    }
    let stage_members: HashSet<_> = members.iter().filter_map(|m| m["id"].as_str()).collect();
    let leader_id = group["leader"]["id"].clone();
    for stage in group["stages"].as_array_mut().into_iter().flatten() {
        if stage["assignee"]["id"]
            .as_str()
            .is_some_and(|id| !stage_members.contains(id) || leader_id == id)
        {
            stage["assignee"] = Value::Null;
        }
    }
    group["name"] = json!(team.name);
    group["members"] = json!(members);
    true
}

impl LocalTaskStore {
    pub fn adopt_personal_project_team(
        &self,
        owner: i64,
        device: &str,
        project_id: &str,
        wanted: &Value,
        mapping: &BTreeMap<String, String>,
    ) -> Result<(), TaskRuntimeError> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut project = get_item_from(&tx, project_id, "project")?
            .filter(|p| {
                p.status.as_deref() == Some("active")
                    && p.metadata["project_store"] == "local"
                    && (p.created_by_user_id == 0 || p.created_by_user_id == owner)
            })
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let settings = read_personal(&tx, owner, device)?;
        let team = stand_in_team(&settings, wanted["id"].as_str().unwrap_or(""))
            .ok_or_else(|| invalid("Personal team is unavailable on this device"))?;
        if settings["executionDeviceId"] != device
            || wanted
                != &json!({"id":team.id,"name":team.name,"leadId":team.lead_id,"members":team.members})
            || !mapping.keys().eq(team.members.keys())
            || mapping.values().collect::<HashSet<_>>().len() != mapping.len()
        {
            return Err(invalid("Personal team or member mapping has changed"));
        }
        let refs = role_refs(&settings);
        let mut bindings = serde_json::Map::new();
        for (role, id) in mapping {
            if team.member_routes.contains_key(role) {
                return Err(invalid("The personal member runs on a different device"));
            }
            let reference = refs
                .get(role.as_str())
                .copied()
                .ok_or_else(|| invalid("Personal member has no local Team"))?;
            let agent = project_agent(&tx, project_id, id, owner)?;
            if reference.starts_with("LA-") {
                personal_stand_in::definition(&tx, owner, reference)?;
                if reference != id {
                    return Err(invalid(
                        "Project Agent must reference the selected local Team",
                    ));
                }
            } else {
                project_definition(&tx, owner, reference, &agent.metadata)?;
            }
            bindings.insert(role.clone(),json!({"agent":id,"reference":reference,"name":agent.metadata["display_name"].as_str().or(agent.name.as_deref()).unwrap_or(id)}));
        }
        let space = source_space(owner, &team.id);
        let prior:Option<String>=tx.query_row("SELECT id FROM loop_items WHERE project_space=?1 AND resource_type=?2 AND cloud_project_id=?3",params![space,KIND,project_id],|r|r.get(0)).optional()?;
        let id = prior.unwrap_or_else(|| format!("local-group-{}", Uuid::new_v4()));
        let bindings = Value::Object(bindings);
        let previous = get_item_from(&tx, &id, KIND)?;
        let list = groups(&mut project)?;
        if list.iter().any(|g| g["name"] == team.name && g["id"] != id) {
            return Err(invalid("Project group name is already used"));
        }
        let index = list.iter().position(|g| g["id"] == id);
        let mut group=index.map(|i|list[i].clone()).unwrap_or_else(||json!({
            "id":id,"workspace_id":"wework-local-workspace","owner_type":"project","owner_id":project_id,
            "description":"","instructions":"","coordination_mode":"manager","stages":[],"execution_requirements":{"required_tags":[]},
            "created_by_user_id":owner,"created_at":now(),"version":0,"personal_team_managed":true
        }));
        roster(&mut group, &team, &bindings);
        group["binding_required"] = json!(false);
        if index.is_some_and(|i| list[i] == group)
            && previous
                .as_ref()
                .is_some_and(|row| row.metadata == bindings)
        {
            return Ok(());
        }
        group["version"] = json!(group["version"].as_u64().unwrap_or(0) + 1);
        group["updated_at"] = json!(now());
        if let Some(i) = index {
            list[i] = group
        } else {
            list.push(group)
        }
        tx.execute("INSERT INTO loop_items(id,resource_type,cloud_project_id,name,created_by_user_id,metadata,created_at,updated_at,project_space) VALUES(?1,?2,?3,?4,?5,?6,?7,?7,?8) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",params![id,KIND,project_id,team.id,owner,bindings.to_string(),now(),space])?;
        save_groups(&tx, &project)?;
        tx.commit()?;
        Ok(())
    }
}

pub(super) fn protect_update(
    connection: &Connection,
    project_id: &str,
    old_groups: &Value,
    next: &Value,
) -> Result<(), TaskRuntimeError> {
    let previous: HashMap<_, _> = old_groups
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| Some((g["id"].as_str()?, g)))
        .collect();
    let supplied: HashSet<_> = next
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| g["id"].as_str())
        .collect();
    for group in next.as_array().into_iter().flatten() {
        let old = group["id"].as_str().and_then(|id| previous.get(id));
        if old.is_some_and(|g| g["personal_team_managed"] == true)
            || group["personal_team_managed"] == true
        {
            if !old.is_some_and(|g| {
                [
                    "personal_team_managed",
                    "binding_required",
                    "name",
                    "members",
                    "leader",
                    "owner_type",
                    "owner_id",
                    "created_by_user_id",
                ]
                .iter()
                .all(|key| g[key] == group[key])
            }) {
                return Err(invalid(
                    "Update the source assistant team or its project bindings to change the roster",
                ));
            }
        }
    }
    for (id, group) in previous {
        if group["personal_team_managed"] == true && !supplied.contains(id) {
            connection.execute(
                "DELETE FROM loop_items WHERE id=?1 AND resource_type=?2 AND cloud_project_id=?3",
                params![id, KIND, project_id],
            )?;
        }
    }
    Ok(())
}

pub(super) fn definition_for_claim(
    connection: &Connection,
    execution: &LocalExecution,
) -> Result<Option<Value>, TaskRuntimeError> {
    let Some(group_id) = execution
        .execution_payload
        .as_ref()
        .and_then(|p| p.pointer("/collaboration_group/id"))
        .and_then(Value::as_str)
    else {
        return Ok(None);
    };
    let Some(binding) = get_item_from(connection, group_id, KIND)? else {
        if execution
            .execution_payload
            .as_ref()
            .is_some_and(|p| p["collaboration_group"]["personal_team_managed"] == true)
        {
            return Err(invalid("Project team binding was removed"));
        }
        return Ok(None);
    };
    if binding.cloud_project_id.as_deref() != Some(execution.cloud_project_id.as_str()) {
        return Err(invalid("Team is not bound to this project"));
    }
    let project = get_item_from(connection, &execution.cloud_project_id, "project")?
        .ok_or(TaskRuntimeError::ProjectNotFound)?;
    collaboration::collaboration_group(&project, group_id)?;
    let agent = project_agent(
        connection,
        &execution.cloud_project_id,
        &execution.agent_id,
        execution.assigner_user_id,
    )?;
    let (role, member) = binding
        .metadata
        .as_object()
        .and_then(|map| map.iter().find(|(_, m)| m["agent"] == execution.agent_id))
        .ok_or_else(|| invalid("Project team member is no longer bound"))?;
    let settings = read_personal(connection, binding.created_by_user_id, "")?;
    let source = stand_in_team(&settings, binding.name.as_deref().unwrap_or(""))
        .ok_or_else(|| invalid("Source team was removed"))?;
    if !source.members.contains_key(role)
        || source.member_routes.contains_key(role)
        || !source
            .members
            .keys()
            .all(|r| binding.metadata.get(r).is_some())
    {
        return Err(invalid("Source team requires new project bindings"));
    }
    let reference = member["reference"]
        .as_str()
        .ok_or_else(|| invalid("Missing Team reference"))?;
    if role_refs(&settings).get(role.as_str()).copied() != Some(reference) {
        return Err(invalid("Source Team binding changed"));
    }
    if reference == execution.agent_id {
        personal_stand_in::definition(connection, binding.created_by_user_id, reference)?;
        return Ok(None);
    }
    project_definition(
        connection,
        binding.created_by_user_id,
        reference,
        &agent.metadata,
    )
    .map(Some)
}

fn team_rows(settings: &Value) -> HashMap<&str, &Value> {
    settings["teams"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|team| Some((team["id"].as_str()?, team)))
        .collect()
}

pub(super) fn refresh_changed_sources(
    connection: &Connection,
    before: &Value,
    settings: &Value,
) -> Result<(), TaskRuntimeError> {
    let before_teams = team_rows(before);
    let teams = team_rows(settings);
    if before_teams.is_empty() && teams.is_empty() {
        return Ok(());
    }
    let prior_refs = role_refs(before);
    let refs = role_refs(settings);
    let owner = settings["userId"]
        .as_i64()
        .ok_or_else(|| invalid("Missing personal owner"))?;
    for id in before_teams
        .keys()
        .chain(teams.keys().filter(|id| !before_teams.contains_key(**id)))
    {
        let old = before_teams.get(id);
        let current = teams.get(id);
        if let (Some(old), Some(current)) = (old, current) {
            if ["name", "leadId", "members", "memberRoutes"]
                .iter()
                .all(|key| old[key] == current[key])
                && current["members"]
                    .as_object()
                    .into_iter()
                    .flat_map(|m| m.keys())
                    .all(|role| prior_refs.get(role.as_str()) == refs.get(role.as_str()))
            {
                continue;
            }
        }
        let team =
            current.and_then(|row| serde_json::from_value::<StandInTeam>((**row).clone()).ok());
        refresh_bindings(connection, &source_space(owner, id), team.as_ref(), &refs)?;
    }
    Ok(())
}

fn refresh_bindings(
    connection: &Connection,
    space: &str,
    source: Option<&StandInTeam>,
    refs: &HashMap<&str, &str>,
) -> Result<(), TaskRuntimeError> {
    let mut query=connection.prepare("SELECT id,cloud_project_id,metadata FROM loop_items WHERE project_space=?1 AND resource_type=?2 AND deleted_at IS NULL")?;
    let rows = query
        .query_map(params![space, KIND], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(query);
    for (id, project_id, metadata) in rows {
        let Some(mut project) = get_item_from(connection, &project_id, "project")? else {
            continue;
        };
        let list = groups(&mut project)?;
        let Some(index) = list.iter().position(|g| g["id"] == id) else {
            continue;
        };
        let mut binding: Value =
            serde_json::from_str(&metadata).map_err(|e| invalid(&e.to_string()))?;
        let agents = binding
            .as_object_mut()
            .ok_or_else(|| invalid("Invalid project Team binding"))?;
        let old_count = agents.len();
        agents.retain(|role, member| {
            source.is_some_and(|team| {
                team.members.contains_key(role) && !team.member_routes.contains_key(role)
            }) && refs
                .get(role.as_str())
                .is_some_and(|r| member["reference"] == *r)
        });
        if agents.len() != old_count {
            connection.execute(
                "UPDATE loop_items SET metadata=?1,updated_at=?2 WHERE id=?3 AND resource_type=?4",
                params![binding.to_string(), now(), id, KIND],
            )?;
        }
        let mut group = list[index].clone();
        let ready = source.is_some_and(|team| {
            !list.iter().any(|g| g["name"] == team.name && g["id"] != id)
                && team.member_routes.is_empty()
                && team.members.keys().all(|r| {
                    refs.get(r.as_str())
                        .is_some_and(|reference| binding[r]["reference"] == *reference)
                })
                && roster(&mut group, team, &binding)
        });
        group["binding_required"] = json!(!ready);
        if group != list[index] {
            group["version"] = json!(group["version"].as_u64().unwrap_or(0) + 1);
            group["updated_at"] = json!(now());
            list[index] = group;
            save_groups(connection, &project)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_private_source_executes_as_bound_project_agent_and_tracks_roster() {
        let (_directory, store, project, agent, _issue, catalog) =
            super::super::runner_routing_tests::setup();
        store.update_chat_agent(&project.id,&agent.id,serde_json::from_value(json!({"version":agent.version,"mcp_servers":{"project-evidence":{"url":"https://project.invalid/tools"}}})).unwrap()).unwrap();
        let device = "runner-a";
        let mut settings = store.personal_stand_in(7, device).unwrap();
        let team = json!({"id":Uuid::new_v4().to_string(),"name":"QA","leadId":"review","members":{"review":"review"}});
        let mut role = personal_stand_in::empty_role("review", device);
        role["migrationSource"] = json!("[\"source\",7,\"original\"]");
        settings["roles"] = json!([role]);
        settings["transferredTeamDefinition"] = json!({"roleId":"review","definition":{
            "name":"Independent verifier","collaboration_model":"pipeline","system_prompt":"Check delivery evidence.",
            "bot":[{"id":"writer","name":"Writer","shell_type":"Codex"},{"id":"judge","name":"Judge","shell_type":"Codex","system_prompt":"Check tests"}]
        }});
        settings["teams"] = json!([team]);
        let profile = store.save_personal_stand_in(7, device, settings).unwrap();
        let reference = profile["roles"][0]["teamRef"].as_str().unwrap();
        let grants = json!({"roleId":"review","botGrants":[{"id":"writer","mcp_servers":{"private-only":{"url":"https://personal.invalid/tools"}}},{"id":"judge"}]});
        store
            .save_verified_personal_settings(
                7,
                device,
                None,
                profile.clone(),
                personal_stand_in::VerifiedPersonalSettings {
                    workspace_owner: true,
                    owned_team: Some(&grants),
                    ..Default::default()
                },
            )
            .unwrap();
        let expected = store.portable_personal_team(7, device, "review").unwrap();
        let mapping = BTreeMap::from([("review".into(), agent.id.clone())]);
        // Older project Agent rows have no runtime. Their ordinary execution runtime is Codex.
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_items SET metadata=json_remove(metadata,'$.runtime') WHERE id=?1",
                [&agent.id],
            )
            .unwrap();
        let visibility = |value: &str| {
            let current = get_item_from(&store.connection().unwrap(), &agent.id, "chat_agent")
                .unwrap()
                .unwrap();
            store
                .update_chat_agent(
                    &project.id,
                    &agent.id,
                    serde_json::from_value(json!({
                        "version":current.version,"visibility":value
                    }))
                    .unwrap(),
                )
                .unwrap();
        };
        assert!(store
            .adopt_personal_project_team(8, device, &project.id, &team, &mapping)
            .is_err());
        visibility("private");
        assert!(matches!(
            store.adopt_personal_project_team(7, device, &project.id, &team, &mapping),
            Err(TaskRuntimeError::Invalid(message)) if message == "Private Agent is not shared with this member"
        ));
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_items SET created_by_user_id=7 WHERE id=?1",
                [&agent.id],
            )
            .unwrap();
        store
            .adopt_personal_project_team(7, device, &project.id, &team, &mapping)
            .unwrap();
        let adopted = store.get_project(&project.id).unwrap();
        let group = &adopted.metadata["collaboration_groups"][0];
        assert_eq!(group["personal_team_managed"], true);
        assert_eq!(group["leader"]["id"], agent.id);
        assert!(!group.to_string().contains(reference));
        store
            .adopt_personal_project_team(7, device, &project.id, &team, &mapping)
            .unwrap();
        assert_eq!(
            store.get_project(&project.id).unwrap().version,
            adopted.version
        );
        let mut edited = adopted.metadata["collaboration_groups"].clone();
        edited[0]["description"] = json!("Release");
        let updated = store
            .update_project(
                &project.id,
                ProjectUpdate {
                    version: adopted.version,
                    collaboration_groups: Some(edited.clone()),
                    ..Default::default()
                },
            )
            .unwrap();
        edited[0]["leader"]["responsibility"] = json!("changed");
        assert!(store
            .update_project(
                &project.id,
                ProjectUpdate {
                    version: updated.version,
                    collaboration_groups: Some(edited),
                    ..Default::default()
                }
            )
            .is_err());
        visibility("creator_admin");
        let queued = store
            .create_task(
                &project.id,
                serde_json::from_value(
                    json!({"title":"Recheck access","assignee_group_id":group["id"]}),
                )
                .unwrap(),
            )
            .unwrap();
        visibility("private");
        assert!(matches!(
            store.claim_next_execution_with_catalog(Some(device), "instance", 300, Some(&catalog)),
            Err(TaskRuntimeError::Invalid(message)) if message == "Private Agent is not shared with this member"
        ));
        let status: (i64, String) = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT assigner_user_id,status FROM loop_item_executions WHERE loop_item_id=?1",
                [&queued.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, (0, "waiting_runtime".to_owned()));
        visibility("creator_admin");
        store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Check","assignee_group_id":group["id"]}))
                    .unwrap(),
            )
            .unwrap();
        let claimed = store
            .claim_next_execution_with_catalog(Some(device), "instance", 300, Some(&catalog))
            .unwrap()
            .unwrap();
        assert_eq!(claimed.agent_id, agent.id);
        let payload = claimed.execution_payload.unwrap();
        let request = &payload["executionRequest"];
        assert!(
            serde_json::from_value::<crate::protocol::ExecutionRequest>(request.clone())
                .unwrap()
                .project_group_execution()
        );
        assert_eq!(request["team_ref"], agent.id);
        assert_eq!(request["bot"][0]["id"], expected["bot"][0]["id"]);
        assert_eq!(request["bot"][1], expected["bot"][1]);
        assert!(request["bot"][0]["mcp_servers"]["project-evidence"].is_object());
        assert_eq!(
            request["system_prompt"]
                .as_str()
                .unwrap()
                .matches("Check delivery evidence.")
                .count(),
            1
        );
        assert!(!request.to_string().contains("private-only"));
        assert_eq!(payload["origin"]["type"], "issue_dispatch");
        assert_eq!(payload["origin"]["managerAgentId"], agent.id);
        assert_eq!(payload["additionalSkills"], json!(["review"]));
        let mut changed = store.personal_stand_in(7, device).unwrap();
        changed["teams"][0]["members"]["new-role"] = json!("test");
        store.save_personal_stand_in(7, device, changed).unwrap();
        let refreshed = store.get_project(&project.id).unwrap();
        assert_eq!(
            refreshed.metadata["collaboration_groups"][0]["binding_required"],
            true
        );
        assert!(
            collaboration::collaboration_group(&refreshed, group["id"].as_str().unwrap()).is_err()
        );
    }

    #[test]
    fn workspace_role_requires_exact_authorized_project_team() {
        let (_dir, store, project, other, _issue, _catalog) =
            super::super::runner_routing_tests::setup();
        let device = "runner-a";
        let workspace = store
            .create_chat_agent(
                DEFAULT_WORK_ITEM_PROJECT_ID,
                serde_json::from_value(json!({"name":"QA","created_by_user_id":0})).unwrap(),
            )
            .unwrap();
        let mut settings = store.personal_stand_in(0, device).unwrap();
        let mut role = personal_stand_in::empty_role("review", device);
        role["teamRef"] = json!(workspace.id);
        settings["roles"] = json!([role]);
        let team = json!({"id":Uuid::new_v4().to_string(),"name":"Review","leadId":"review","members":{"review":"check"}});
        settings["teams"] = json!([team]);
        store.save_personal_stand_in(0, device, settings).unwrap();
        let mapping = BTreeMap::from([("review".into(), workspace.id.clone())]);
        assert!(store
            .adopt_personal_project_team(0, device, &project.id, &team, &mapping)
            .is_err());
        store.bind_chat_agent(&project.id, &workspace.id).unwrap();
        assert!(store
            .adopt_personal_project_team(
                0,
                device,
                &project.id,
                &team,
                &BTreeMap::from([("review".into(), other.id)])
            )
            .is_err());
        store
            .adopt_personal_project_team(0, device, &project.id, &team, &mapping)
            .unwrap();
        assert_eq!(
            store.get_project(&project.id).unwrap().metadata["collaboration_groups"][0]["leader"]
                ["id"],
            workspace.id
        );
    }
}
