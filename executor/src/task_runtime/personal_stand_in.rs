//! A single device-owned personal stand-in with reusable, independently configured roles.
use super::*;

pub(super) fn empty_role(id: &str, device: &str) -> Value {
    json!({"id":id,"name":"","enabled":false,"prompt":"","executionDeviceId":device,
        "version":0,"tags":[],"collaboration":{"enabled":false,"allProjects":true,
        "projects":[],"excludedProjects":[],"tags":[]}})
}

fn empty_personal(user: i64, device: &str) -> Value {
    json!({"userId":user,"executionDeviceId":device,"version":0,"autoSelect":true,
        "roles":[empty_role("default", device)]})
}

pub(super) fn personal_key(user: i64) -> String {
    format!("personal-stand-in:{user}")
}

fn bind_personal_device(personal: &mut Value, device: &str) -> bool {
    if device.is_empty() {
        return false;
    }
    let mut changed = personal["executionDeviceId"] != device;
    personal["executionDeviceId"] = json!(device);
    for role in personal["roles"].as_array_mut().into_iter().flatten() {
        changed |= role["executionDeviceId"] != device;
        role["executionDeviceId"] = json!(device);
    }
    changed
}

pub(super) fn read_personal(
    connection: &Connection,
    user: i64,
    device: &str,
) -> Result<Value, TaskRuntimeError> {
    if let Some(row) = get_item_from(connection, &personal_key(user), "personal_stand_in")? {
        return Ok(row.metadata);
    }
    let mut personal = empty_personal(user, device);
    let mut statement = connection.prepare(
        "SELECT metadata FROM loop_items WHERE resource_type='stand_in_settings' AND json_extract(metadata, '$.userId')=?1 ORDER BY id",
    )?;
    let rows = statement.query_map(params![user], |row| row.get::<_, String>(0))?;
    let mut roles = Vec::new();
    for row in rows {
        let mut role: Value = serde_json::from_str(&row?)
            .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        role["name"] = json!(role["name"].as_str().unwrap_or_default());
        role["legacyStandInId"] = role["id"].clone();
        let project = json!({"id":role["projectId"],"store":role["projectStore"]});
        role["collaboration"] = json!({"enabled":true,"allProjects":false,"projects":[project],"excludedProjects":[],"tags":role["tags"]});
        // Preserve project agent permission boundaries when importing old configurations.
        if role["agentId"].is_string() {
            role["agentProject"] = project;
        }
        if roles
            .iter()
            .any(|previous: &Value| previous["id"] == role["id"])
        {
            role["id"] = json!(Uuid::new_v4().to_string());
        }
        role.as_object_mut().unwrap().remove("projectId");
        role.as_object_mut().unwrap().remove("projectStore");
        roles.push(role);
    }
    if !roles.is_empty() {
        personal["executionDeviceId"] = roles[0]["executionDeviceId"].clone();
        personal["roles"] = json!(roles);
    }
    Ok(personal)
}

pub(super) fn write_personal(
    connection: &Connection,
    value: &Value,
) -> Result<(), TaskRuntimeError> {
    let user = value["userId"].as_i64().unwrap();
    connection.execute(
        "INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'personal_stand_in',?2,?3,?3) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at",
        params![personal_key(user),value.to_string(),now()],
    )?;
    connection.execute("DELETE FROM loop_items WHERE resource_type='stand_in_settings' AND json_extract(metadata,'$.userId')=?1", params![user])?;
    Ok(())
}

pub fn role_project_matches(role: &Value, project: &str, store: &str) -> bool {
    let connection = &role["collaboration"];
    let matches = |row: &Value| row["id"] == project && row["store"] == store;
    connection["enabled"] == true
        && !connection["excludedProjects"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(matches))
        && (connection["allProjects"] == true
            || connection["projects"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(matches)))
        && (!role["agentProject"].is_object() || matches(&role["agentProject"]))
}

pub fn project_role(
    role: &Value,
    user: i64,
    project: &str,
    store: &str,
    auto_select: bool,
) -> Value {
    let mut config = role.clone();
    config["projectId"] = json!(project);
    config["projectStore"] = json!(store);
    config["userId"] = json!(user);
    config["tags"] = role["collaboration"]["tags"].clone();
    config["autoSelect"] = json!(auto_select);
    config["handlingPolicy"] = project_policy(role, project, store);
    config
}

fn validate_projects(value: &Value) -> bool {
    value.as_array().is_some_and(|projects| {
        projects.iter().all(|project| {
            project["id"]
                .as_str()
                .is_some_and(|id| !id.trim().is_empty())
                && matches!(project["store"].as_str(), Some("local" | "cloud"))
        })
    })
}

pub(super) fn validate_role(role: &Value, device: &str) -> Result<(), TaskRuntimeError> {
    let id = role["id"].as_str().unwrap_or_default();
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        || role["name"].as_str().is_none()
        || role["prompt"].as_str().is_none()
        || role["enabled"].as_bool().is_none()
        || role["executionDeviceId"] != device
        || !valid_collaboration(&role["collaboration"])
        || role
            .get("agentId")
            .is_some_and(|id| !id.is_null() && !id.is_string())
        || (role["agentResourceId"].is_number() && role["agentId"].is_string())
        || role
            .get("agentProject")
            .is_some_and(|project| !project.is_null() && !validate_projects(&json!([project])))
        || role
            .get("agentResourceId")
            .is_some_and(|id| !id.is_null() && !id.as_i64().is_some_and(|id| id > 0))
    {
        return Err(TaskRuntimeError::Invalid(
            "invalid personal stand-in role".into(),
        ));
    }
    validate_connections(role)?;
    super::stand_in::validate_execution_settings(role)
}

fn validate_policy(policy: &Value) -> bool {
    policy["automatic"].is_boolean() && policy["askBeforeAct"].is_boolean()
}

fn valid_collaboration(source: &Value) -> bool {
    source["enabled"].is_boolean()
        && source["allProjects"].is_boolean()
        && validate_projects(&source["projects"])
        && validate_projects(&source["excludedProjects"])
        && source["tags"].as_array().is_some_and(|tags| {
            tags.iter()
                .all(|tag| tag.as_str().is_some_and(|tag| !tag.trim().is_empty()))
        })
}

fn validate_connections(role: &Value) -> Result<(), TaskRuntimeError> {
    if role["agentProject"].is_object()
        && role["dingtalk"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty())
    {
        return Err(TaskRuntimeError::Invalid(
            "Project-scoped agents can only receive work from their project".into(),
        ));
    }
    let source = &role["collaboration"];
    let valid = role.get("collaboration").is_none_or(valid_collaboration)
        && source.get("policy").is_none_or(validate_policy)
        && source.get("projectPolicies").is_none_or(|rows| {
            rows.as_array().is_some_and(|rows| {
                let mut ids = HashSet::new();
                rows.len() <= 1000
                    && rows.iter().all(|row| {
                        validate_projects(&json!([row]))
                            && validate_policy(&row["policy"])
                            && ids.insert((row["store"].to_string(), row["id"].to_string()))
                    })
            })
        })
        && role.get("dingtalk").is_none_or(|rows| {
            rows.as_array().is_some_and(|rows| {
                let mut ids = HashSet::new();
                rows.len() <= 1000
                    && rows.iter().all(|row| {
                        row["id"]
                            .as_str()
                            .is_some_and(|id| !id.trim().is_empty() && id.len() <= 512)
                            && row["name"]
                                .as_str()
                                .is_some_and(|name| !name.trim().is_empty() && name.len() <= 512)
                            && row["profile"].as_str().is_some_and(|profile| {
                                !profile.trim().is_empty() && profile.len() <= 512
                            })
                            && matches!(row["kind"].as_str(), Some("group" | "direct"))
                            && validate_policy(&row["policy"])
                            && ids.insert((
                                row["profile"].to_string(),
                                row["kind"].to_string(),
                                row["id"].to_string(),
                            ))
                    })
            })
        });
    if !valid {
        return Err(TaskRuntimeError::Invalid(
            "invalid stand-in connections".into(),
        ));
    }
    Ok(())
}

pub fn stand_in_identities(settings: &Value) -> Vec<Value> {
    let mut identities = settings["roles"].as_array().cloned().unwrap_or_default();
    if settings["primary"].is_object() {
        let mut primary = settings["primary"].clone();
        primary["id"] = json!("@primary");
        primary["name"] = json!("我的分身");
        identities.push(primary);
    }
    for identity in &mut identities {
        identity["userId"] = settings["userId"].clone();
        identity["executionDeviceId"] = settings["executionDeviceId"].clone();
        identity["personalVersion"] = settings["version"].clone();
        identity["sharedPreferences"] = settings["primary"]["preferences"].clone();
    }
    identities
}

pub fn dingtalk_connection<'a>(identity: &'a Value, source: &Value) -> Option<&'a Value> {
    identity["dingtalk"].as_array()?.iter().find(|row| {
        row["id"] == source["id"]
            && row["profile"] == source["profile"]
            && row["kind"] == source["kind"]
    })
}

pub fn project_policy(role: &Value, project: &str, store: &str) -> Value {
    role["collaboration"]["projectPolicies"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["id"] == project && row["store"] == store)
        })
        .map(|row| row["policy"].clone())
        .or_else(|| role["collaboration"].get("policy").cloned())
        .unwrap_or_else(|| json!({"automatic":role["enabled"] == true,"askBeforeAct":false}))
}

impl LocalTaskStore {
    pub fn personal_stand_in(&self, user: i64, device: &str) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(row) = get_item_from(&connection, &personal_key(user), "personal_stand_in")? {
            let mut personal = row.metadata;
            // Device-owned settings follow their Executor, not a stale desktop identity.
            if bind_personal_device(&mut personal, device) {
                write_personal(&connection, &personal)?;
            }
            connection.commit()?;
            return Ok(personal);
        }
        let mut personal = read_personal(&connection, user, device)?;
        bind_personal_device(&mut personal, device);
        // Migrate old rows atomically, without changing their enable timestamps or versions.
        if personal["roles"].as_array().is_some_and(|roles| {
            roles
                .iter()
                .any(|role| role["version"].as_i64().unwrap_or(0) > 0)
        }) {
            write_personal(&connection, &personal)?;
        }
        connection.commit()?;
        Ok(personal)
    }

    pub fn save_personal_stand_in(
        &self,
        user: i64,
        device: &str,
        value: Value,
    ) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let saved = self.save_personal_stand_in_on(&connection, user, device, value)?;
        connection.commit()?;
        Ok(saved)
    }

    pub(super) fn save_personal_stand_in_on(
        &self,
        connection: &Connection,
        user: i64,
        device: &str,
        mut value: Value,
    ) -> Result<Value, TaskRuntimeError> {
        if let Some(object) = value.as_object_mut() {
            object.remove("selectionErrors");
        }
        for role in value["roles"].as_array_mut().into_iter().flatten() {
            if role["agentId"].is_string()
                && role["agentProject"].is_object()
                && role["collaboration"].is_object()
            {
                role["collaboration"]["allProjects"] = json!(false);
                role["collaboration"]["projects"] = json!([role["agentProject"]]);
                role["collaboration"]["excludedProjects"] = json!([]);
            }
        }
        let roles = value["roles"]
            .as_array()
            .filter(|roles| !roles.is_empty() && roles.len() <= 100)
            .ok_or_else(|| {
                TaskRuntimeError::Invalid("at least one personal role is required".into())
            })?;
        if value["autoSelect"].as_bool().is_none() || value["executionDeviceId"] != device {
            return Err(TaskRuntimeError::Invalid(
                "invalid personal stand-in settings".into(),
            ));
        }
        if let Some(primary) = value.get("primary") {
            if !primary["enabled"].is_boolean()
                || !primary["prompt"].is_string()
                || !primary["preferences"].is_string()
            {
                return Err(TaskRuntimeError::Invalid("invalid primary stand-in".into()));
            }
            validate_connections(primary)?;
        }
        let mut ids = HashSet::new();
        for role in roles {
            validate_role(role, device)?;
            if !ids.insert(role["id"].as_str().unwrap()) {
                return Err(TaskRuntimeError::Invalid("duplicate personal role".into()));
            }
        }
        let previous = read_personal(connection, user, device)?;
        if value["version"] != previous["version"] {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if value["primary"].is_object() {
            stamp_dingtalk_connections(&mut value["primary"], &previous["primary"]);
            stamp_project_enabled(&mut value["primary"], &previous["primary"]);
        }
        for role in value["roles"].as_array_mut().unwrap() {
            let before = previous["roles"]
                .as_array()
                .unwrap()
                .iter()
                .find(|before| before["id"] == role["id"]);
            let version = before
                .and_then(|before| before["version"].as_i64())
                .unwrap_or(0);
            stamp_dingtalk_connections(role, before.unwrap_or(&Value::Null));
            role["version"] = json!(version + 1);
            stamp_project_enabled(role, before.unwrap_or(&Value::Null));
        }
        value["userId"] = json!(user);
        value["version"] = json!(previous["version"].as_i64().unwrap_or(0) + 1);
        write_personal(connection, &value)?;
        Ok(value)
    }

    pub fn all_personal_stand_ins(&self, device: &str) -> Result<Vec<Value>, TaskRuntimeError> {
        let users = {
            let connection = self.connection()?;
            let mut statement = connection.prepare("SELECT DISTINCT json_extract(metadata,'$.userId') FROM loop_items WHERE resource_type IN ('stand_in_settings','personal_stand_in')")?;
            let users = statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            users
        };
        users
            .into_iter()
            .map(|user| self.personal_stand_in(user, device))
            .collect()
    }

    pub fn stand_in_selection_errors(
        &self,
        user: i64,
        version: &Value,
    ) -> Result<Vec<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT metadata FROM loop_items WHERE resource_type='stand_in_decision' AND json_extract(metadata,'$.userId')=?1 AND json_extract(metadata,'$.error') IS NOT NULL ORDER BY updated_at DESC LIMIT 20")?;
        let rows = statement.query_map(params![user], |row| row.get::<_, String>(0))?;
        let mut errors = Vec::new();
        for row in rows {
            let value: Value = serde_json::from_str(&row?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
            if value["version"] == *version {
                errors.push(value);
            }
        }
        Ok(errors)
    }

    pub fn stand_in_decision(&self, id: &str) -> Result<Option<Value>, TaskRuntimeError> {
        let connection = self.connection()?;
        Ok(get_item_from(&connection, id, "stand_in_decision")?.map(|row| row.metadata))
    }

    pub fn save_stand_in_decision(&self, id: &str, value: &Value) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        connection.execute("INSERT INTO loop_items (id,resource_type,metadata,created_at,updated_at) VALUES (?1,'stand_in_decision',?2,?3,?3) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,updated_at=excluded.updated_at", params![id,value.to_string(),now()])?;
        Ok(())
    }
}

fn stamp_dingtalk_connections(identity: &mut Value, previous: &Value) {
    let enabled = identity["enabled"] == true && previous["enabled"] == true;
    for source in identity
        .get_mut("dingtalk")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let before = previous["dingtalk"].as_array().and_then(|rows| {
            rows.iter().find(|row| {
                row["id"] == source["id"]
                    && row["kind"] == source["kind"]
                    && row["profile"] == source["profile"]
            })
        });
        source["enabledAfter"] = before
            .filter(|_| enabled)
            .and_then(|source| source.get("enabledAfter"))
            .cloned()
            .unwrap_or_else(|| json!(now()));
    }
}

fn stamp_project_enabled(identity: &mut Value, previous: &Value) {
    identity["enabledAfter"] = if previous["enabled"] == true
        && identity["enabled"] == true
        && previous["collaboration"]["enabled"] == true
        && identity["collaboration"]["enabled"] == true
    {
        previous["enabledAfter"]
            .as_str()
            .map(|time| json!(time))
            .unwrap_or_else(|| json!(now()))
    } else {
        json!(now())
    };
}
