//! A single device-owned personal stand-in with reusable, independently configured roles.
use super::*;

pub(super) fn empty_role(id: &str, device: &str) -> Value {
    json!({"id":id,"name":"","enabled":false,"prompt":"","executionDeviceId":device,
        "version":0,"tags":[],"collaboration":{"enabled":false,"allProjects":true,
        "projects":[],"excludedProjects":[],"tags":[]}})
}

fn empty_personal(user: i64, device: &str) -> Value {
    json!({"userId":user,"executionDeviceId":device,"version":0,"autoSelect":false,
        "roles":[empty_role("default", device)]})
}

fn personal_key(user: i64) -> String {
    format!("personal-stand-in:{user}")
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
    let source = &role["collaboration"];
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
        || source["enabled"].as_bool().is_none()
        || source["allProjects"].as_bool().is_none()
        || !validate_projects(&source["projects"])
        || !validate_projects(&source["excludedProjects"])
        || !source["tags"].as_array().is_some_and(|tags| {
            tags.iter()
                .all(|tag| tag.as_str().is_some_and(|tag| !tag.trim().is_empty()))
        })
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
    super::stand_in::validate_execution_settings(role)
}

impl LocalTaskStore {
    pub fn personal_stand_in(&self, user: i64, device: &str) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(row) = get_item_from(&connection, &personal_key(user), "personal_stand_in")? {
            connection.commit()?;
            return Ok(row.metadata);
        }
        let personal = read_personal(&connection, user, device)?;
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
        let mut ids = HashSet::new();
        for role in roles {
            validate_role(role, device)?;
            if !ids.insert(role["id"].as_str().unwrap()) {
                return Err(TaskRuntimeError::Invalid("duplicate personal role".into()));
            }
        }
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = read_personal(&connection, user, device)?;
        if value["version"] != previous["version"] {
            return Err(TaskRuntimeError::VersionConflict);
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
            role["version"] = json!(version + 1);
            role["enabledAfter"] = before
                .filter(|before| {
                    before["enabled"] == true
                        && role["enabled"] == true
                        && before["collaboration"]["enabled"] == true
                        && role["collaboration"]["enabled"] == true
                })
                .map(|before| before["enabledAfter"].clone())
                .unwrap_or_else(|| json!(now()));
        }
        value["userId"] = json!(user);
        value["version"] = json!(previous["version"].as_i64().unwrap_or(0) + 1);
        write_personal(&connection, &value)?;
        connection.commit()?;
        Ok(value)
    }

    pub fn all_personal_stand_ins(&self) -> Result<Vec<Value>, TaskRuntimeError> {
        let users = {
            let connection = self.connection()?;
            let mut statement = connection.prepare("SELECT DISTINCT json_extract(metadata,'$.userId') FROM loop_items WHERE resource_type='stand_in_settings'")?;
            let users = statement
                .query_map([], |row| row.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            users
        };
        for user in users {
            self.personal_stand_in(user, "")?;
        }
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT metadata FROM loop_items WHERE resource_type='personal_stand_in'")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            serde_json::from_str(&row?)
                .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))
        })
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
