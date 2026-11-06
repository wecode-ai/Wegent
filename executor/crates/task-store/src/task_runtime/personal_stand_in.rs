//! A single device-owned personal stand-in with reusable, independently configured roles.
use super::*;

pub const DINGTALK_PROVIDER: &str = "@wegent/dsh-connection-dingtalk/dingtalk";
pub const EMAIL_PROVIDER: &str = "@wegent/dsh-connection-runtime/email";

fn implicit_primary() -> Value {
    json!({"enabled":true,"prompt":"","preferences":""})
}

/// Normalize legacy identities and connection policies, reporting whether persistence is needed.
pub(super) fn migrate_personal_settings(value: &mut Value) -> Result<bool, TaskRuntimeError> {
    let mut changed = false;
    let immediate = value["processing"]["mode"] != "silent";
    for identity in value
        .get_mut("roles")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        changed |= migrate_agent_binding(identity)?;
        changed |= migrate_identity_connections(identity)?;
        changed |= migrate_connection_timing(identity, immediate);
    }
    if value["primary"].is_object() {
        changed |= migrate_agent_binding(&mut value["primary"])?;
        changed |= migrate_identity_connections(&mut value["primary"])?;
        changed |= migrate_connection_timing(&mut value["primary"], immediate);
    }
    changed |= value
        .as_object_mut()
        .is_some_and(|fields| fields.remove("processing").is_some());
    Ok(changed)
}

/// Convert inherited project boundaries to explicit grants before removing old references.
pub(super) fn migrate_agent_binding(identity: &mut Value) -> Result<bool, TaskRuntimeError> {
    if let Some(project) = identity
        .get("agentProject")
        .filter(|project| !project.is_null())
    {
        if !validate_projects(&json!([project]))
            || identity
                .get("collaboration")
                .is_some_and(|source| !source.is_object())
        {
            return Err(TaskRuntimeError::Invalid(
                "invalid stand-in agent project".into(),
            ));
        }
        let project = project.clone();
        if let Some(source) = identity.get_mut("collaboration") {
            let selected = source["allProjects"] == true
                || source["projects"].as_array().is_some_and(|rows| {
                    rows.iter()
                        .any(|row| row["id"] == project["id"] && row["store"] == project["store"])
                });
            source["allProjects"] = json!(false);
            source["projects"] = if selected {
                json!([project])
            } else {
                json!([])
            };
        }
    }
    let mut changed = false;
    if let Some(fields) = identity.as_object_mut() {
        for key in ["agentId", "agentResourceId", "agentProject"] {
            changed |= fields.remove(key).is_some();
        }
    }
    Ok(changed)
}

fn migrate_connection_timing(identity: &mut Value, immediate: bool) -> bool {
    fn set_timing(policy: &mut Value, immediate: bool) -> bool {
        let Some(fields) = policy.as_object_mut() else {
            return false;
        };
        if fields.contains_key("immediate") {
            return false;
        }
        fields.insert("immediate".into(), json!(immediate));
        true
    }
    let mut changed = false;
    for connection in identity
        .get_mut("connections")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        changed |= set_timing(&mut connection["policy"], immediate);
    }
    if identity["collaboration"].is_object() {
        if !identity["collaboration"]["policy"].is_object() {
            identity["collaboration"]["policy"] = json!({"automatic":true,"askBeforeAct":false});
            changed = true;
        }
        changed |= set_timing(&mut identity["collaboration"]["policy"], immediate);
        for project in identity["collaboration"]
            .get_mut("projectPolicies")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            changed |= set_timing(&mut project["policy"], immediate);
        }
    }
    changed
}

pub fn immediate_policy(policy: &Value) -> bool {
    policy["immediate"].as_bool().unwrap_or(true)
}

fn migrate_identity_connections(identity: &mut Value) -> Result<bool, TaskRuntimeError> {
    let Some(object) = identity.as_object_mut() else {
        return Ok(false);
    };
    if object.contains_key("dingtalk") && object.contains_key("connections") {
        return Err(TaskRuntimeError::Invalid(
            "conflicting connection formats".into(),
        ));
    }
    let Some(mut legacy) = object.remove("dingtalk") else {
        return Ok(false);
    };
    let rows = legacy
        .as_array_mut()
        .ok_or_else(|| TaskRuntimeError::Invalid("invalid legacy connections".into()))?;
    for source in rows {
        if !source.is_object() {
            return Err(TaskRuntimeError::Invalid(
                "invalid legacy connection".into(),
            ));
        }
        source["providerId"] = json!(DINGTALK_PROVIDER);
    }
    object.insert("connections".into(), legacy);
    Ok(true)
}

pub fn source_provider(source: &Value) -> &str {
    // Historical work/source records retain their identity and are read without re-keying.
    source["providerId"].as_str().unwrap_or(DINGTALK_PROVIDER)
}

pub fn source_namespace(source: &Value) -> Value {
    if source_provider(source) == DINGTALK_PROVIDER {
        source["profile"].clone()
    } else {
        let mut namespace =
            json!({"providerId":source_provider(source),"profile":source["profile"]});
        if let Some(transport) = source.get("transport") {
            namespace["transport"] = transport.clone();
        }
        namespace
    }
}

/// Collection partitions are provider-owned cursors, never resource permissions.
pub fn source_collection_namespace(source: &Value) -> Value {
    let namespace = source_namespace(source);
    match source.get("collectionKey") {
        Some(key) => json!({"source":namespace,"collectionKey":key}),
        None => namespace,
    }
}

pub fn connection_memory_scope(source: &Value) -> Value {
    if source_provider(source) == DINGTALK_PROVIDER {
        json!({"kind":"dingtalk","id":source["id"],"profile":source["profile"],"conversationKind":source["kind"]})
    } else {
        json!({"kind":"connection","providerId":source_provider(source),"id":source["id"],"profile":source["profile"],"resourceKind":source["kind"]})
    }
}

pub(super) fn empty_role(id: &str, device: &str) -> Value {
    json!({"id":id,"name":"","enabled":false,"prompt":"","executionDeviceId":device,
        "version":0,"tags":[],"collaboration":{"enabled":false,"allProjects":true,
        "projects":[],"excludedProjects":[],"tags":[]}})
}

fn empty_personal(user: i64, device: &str) -> Value {
    json!({"userId":user,"executionDeviceId":device,"version":0,
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

/// Read the account document or project-era rows and normalize their legacy configuration.
pub(super) fn read_personal(
    connection: &Connection,
    user: i64,
    device: &str,
) -> Result<Value, TaskRuntimeError> {
    if let Some(row) = get_item_from(connection, &personal_key(user), "personal_stand_in")? {
        let mut settings = row.metadata;
        if let Some(fields) = settings.as_object_mut() {
            fields.remove("autoSelect");
            fields.remove("selectionErrors");
        }
        migrate_personal_settings(&mut settings)?;
        return Ok(settings);
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
    migrate_personal_settings(&mut personal)?;
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

/// Check effective project intake grants after legacy references have been normalized.
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
}

pub fn project_role(role: &Value, user: i64, project: &str, store: &str) -> Value {
    let mut config = role.clone();
    config["projectId"] = json!(project);
    config["projectStore"] = json!(store);
    config["userId"] = json!(user);
    config["tags"] = role["collaboration"]["tags"].clone();
    config["handlingPolicy"] = project_policy(role, project, store);
    if let Some(boundary) = role["projectBoundaries"].as_array().and_then(|rows| {
        rows.iter()
            .find(|row| row["id"] == project && row["store"] == store)
    }) {
        config["enabledAfter"] = boundary["enabledAfter"].clone();
    }
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

/// Validate a normalized independent role and its execution and connection settings.
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
    {
        return Err(TaskRuntimeError::Invalid(
            "invalid personal stand-in role".into(),
        ));
    }
    validate_connections(role)?;
    super::stand_in::validate_execution_settings(role)
}

fn validate_policy(policy: &Value) -> bool {
    policy["automatic"].is_boolean()
        && policy["askBeforeAct"].is_boolean()
        && policy.get("immediate").map_or(true, Value::is_boolean)
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

/// Validate source identities, handling policies and project scopes before persistence.
fn validate_connections(role: &Value) -> Result<(), TaskRuntimeError> {
    if role
        .get("calendar")
        .is_some_and(|calendar| !validate_policy(&calendar["policy"]))
    {
        return Err(TaskRuntimeError::Invalid(
            "invalid stand-in calendar policy".into(),
        ));
    }
    if role.get("dingtalk").is_some() {
        return Err(TaskRuntimeError::Invalid(
            "conflicting connection formats".into(),
        ));
    }
    let source = &role["collaboration"];
    let valid = role.get("collaboration").map_or(true, valid_collaboration)
        && source.get("policy").map_or(true, validate_policy)
        && source.get("projectPolicies").map_or(true, |rows| {
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
        && role.get("connections").map_or(true, |rows| {
            rows.as_array().is_some_and(|rows| {
                let mut ids = HashSet::new();
                rows.len() <= 1000
                    && rows.iter().all(|row| {
                        let all = row["scope"] == "all";
                        row["id"]
                            .as_str()
                            .is_some_and(|id| !id.trim().is_empty() && id.len() <= 512)
                            && row["name"]
                                .as_str()
                                .is_some_and(|name| !name.trim().is_empty() && name.len() <= 512)
                            && row["profile"].as_str().is_some_and(|profile| {
                                !profile.trim().is_empty() && profile.len() <= 512
                            })
                            && row["providerId"]
                                .as_str()
                                .is_some_and(|id| !id.is_empty() && id.len() <= 256)
                            && row["kind"]
                                .as_str()
                                .is_some_and(|kind| !kind.is_empty() && kind.len() <= 128)
                            && row.get("collectionKey").map_or(true, |key| {
                                key.as_str().is_some_and(|key| {
                                    !key.is_empty() && key.trim() == key && key.len() <= 256
                                })
                            })
                            && row.get("configurationSummary").map_or(true, |summary| {
                                summary.as_str().is_some_and(|text| {
                                    !text.trim().is_empty() && text.len() <= 4096
                                })
                            })
                            && (all || row.get("scope").is_none())
                            && (all == (row["id"] == "*"))
                            && !rows.iter().any(|other| {
                                other["providerId"] == row["providerId"]
                                    && other["profile"] == row["profile"]
                                    && other["kind"] == row["kind"]
                                    && other["id"] != row["id"]
                                    && (all || other["scope"] == "all")
                            })
                            && validate_policy(&row["policy"])
                            && (!source_provider(row).starts_with("@wegent/dsh-connection-git/")
                                || row["policy"]["askBeforeAct"] == true)
                            && ids.insert((
                                row["providerId"].to_string(),
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
        primary["version"] = settings["version"].clone();
        identities.push(primary);
    }
    for identity in &mut identities {
        identity["userId"] = settings["userId"].clone();
        identity["executionDeviceId"] = settings["executionDeviceId"].clone();
        identity["sharedPreferences"] = settings["primary"]["preferences"].clone();
    }
    identities
}

pub fn stand_in_connection<'a>(identity: &'a Value, source: &Value) -> Option<&'a Value> {
    identity["connections"].as_array()?.iter().find(|row| {
        (row["id"] == source["id"]
            || (row["scope"] == "all"
                && row["id"] == "*"
                && source["id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty() && id != "*")))
            && source_provider(row) == source_provider(source)
            && row["profile"] == source["profile"]
            && row["kind"] == source["kind"]
            && row["transport"] == source["transport"]
    })
}

/// Intake must still belong to the currently configured collection partition.
pub fn stand_in_collection_connection<'a>(
    identity: &'a Value,
    source: &Value,
) -> Option<&'a Value> {
    stand_in_connection(identity, source)
        .filter(|connection| connection.get("collectionKey") == source.get("collectionKey"))
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
    pub fn materialize_implicit_primary(
        &self,
        user: i64,
        device: &str,
    ) -> Result<Option<Value>, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut previous = read_personal(&connection, user, device)?;
        bind_personal_device(&mut previous, device);
        if previous["primary"].is_object() {
            return Ok(None);
        }
        // Persist the UI's implicit default without editing any identity or its version.
        let mut initialized = previous.clone();
        initialized["primary"] = implicit_primary();
        write_personal(&connection, &initialized)?;
        connection.commit()?;
        Ok(Some(previous))
    }

    pub fn restore_implicit_primary(
        &self,
        user: i64,
        device: &str,
        previous: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_personal(&connection, user, device)?;
        let mut expected = previous.clone();
        expected["primary"] = implicit_primary();
        if current != expected {
            return Err(TaskRuntimeError::VersionConflict);
        }
        // Compare the entire snapshot so compensation never overwrites a concurrent edit.
        write_personal(&connection, previous)?;
        connection.commit()?;
        Ok(())
    }

    /// Transactionally migrate stored settings and bind them to their owning Executor identity.
    pub fn personal_stand_in(&self, user: i64, device: &str) -> Result<Value, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(row) = get_item_from(&connection, &personal_key(user), "personal_stand_in")? {
            let mut personal = row.metadata;
            // Device-owned settings follow their Executor, not a stale desktop identity.
            let migrated = migrate_personal_settings(&mut personal)?;
            if bind_personal_device(&mut personal, device) || migrated {
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

    pub fn validate_personal_stand_in_settings(
        &self,
        user: i64,
        device: &str,
        value: Value,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let transaction = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = self
            .save_personal_stand_in_on(&transaction, user, device, value)
            .map(|_| ());
        transaction.rollback()?;
        result
    }

    /// Normalize and atomically save an account draft with version, connection and intake checks.
    pub(super) fn save_personal_stand_in_on(
        &self,
        connection: &Connection,
        user: i64,
        device: &str,
        mut value: Value,
    ) -> Result<Value, TaskRuntimeError> {
        migrate_personal_settings(&mut value)?;
        if let Some(object) = value.as_object_mut() {
            object.remove("selectionErrors");
            object.remove("autoSelect");
        }
        let roles = value["roles"]
            .as_array()
            .filter(|roles| roles.len() <= 100)
            .ok_or_else(|| {
                TaskRuntimeError::Invalid(
                    "personal roles must be an array of at most 100 roles".into(),
                )
            })?;
        if value["executionDeviceId"] != device {
            return Err(TaskRuntimeError::Invalid(
                "settings.executionDeviceId must match the current profile device".into(),
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
            stamp_stand_in_connections(&mut value["primary"], &previous["primary"]);
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
            stamp_stand_in_connections(role, before.unwrap_or(&Value::Null));
            role["version"] = json!(version + 1);
            stamp_project_enabled(role, before.unwrap_or(&Value::Null));
        }
        value["userId"] = json!(user);
        value["version"] = json!(previous["version"].as_i64().unwrap_or(0) + 1);
        write_personal(connection, &value)?;
        super::stand_in_inbox::queue_removed_git_connections(connection, user, &previous, &value)?;
        super::stand_in_processing::update_processing_configuration(
            connection, user, &previous, &value,
        )?;
        super::stand_in_telemetry::configuration_changes(connection, user, &previous, &value);
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
}

pub(super) fn stamp_stand_in_connections(identity: &mut Value, previous: &Value) {
    let preserve = identity["enabled"] == previous["enabled"];
    for source in identity
        .get_mut("connections")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let before = previous["connections"].as_array().and_then(|rows| {
            rows.iter().find(|row| {
                row["id"] == source["id"]
                    && source_provider(row) == source_provider(source)
                    && row["kind"] == source["kind"]
                    && row["profile"] == source["profile"]
                    && row["generation"] == source["generation"]
                    && row["subscriptionId"] == source["subscriptionId"]
                    && row["transport"] == source["transport"]
                    && row.get("collectionKey") == source.get("collectionKey")
            })
        });
        source["enabledAfter"] = before
            .filter(|_| preserve)
            .and_then(|source| source.get("enabledAfter"))
            .cloned()
            .unwrap_or_else(|| json!(now()));
    }
}

pub(super) fn stamp_project_enabled(identity: &mut Value, previous: &Value) {
    let preserve = identity["enabled"] == previous["enabled"]
        && identity["collaboration"]["enabled"] == previous["collaboration"]["enabled"];
    let enabled_at = json!(now());
    // Explicit projects keep their own boundary when the catch-all scope changes.
    let mut projects = Vec::new();
    for source in [identity as &Value, previous] {
        for rows in [
            &source["collaboration"]["projects"],
            &source["collaboration"]["excludedProjects"],
            &source["projectBoundaries"],
        ] {
            for row in rows.as_array().into_iter().flatten() {
                let project = json!({"id":row["id"],"store":row["store"]});
                if !projects.contains(&project) {
                    projects.push(project);
                }
            }
        }
    }
    let boundaries: Vec<Value> = projects
        .into_iter()
        .filter_map(|mut project| {
            let id = project["id"].as_str()?;
            let store = project["store"].as_str()?;
            if !role_project_matches(identity, id, store) {
                return None;
            }
            project["enabledAfter"] = if preserve && role_project_matches(previous, id, store) {
                project_role(previous, 0, id, store)["enabledAfter"]
                    .as_str()
                    .map(|time| json!(time))
                    .unwrap_or_else(|| enabled_at.clone())
            } else {
                enabled_at.clone()
            };
            Some(project)
        })
        .collect();
    identity["enabledAfter"] = if preserve
        && !(identity["collaboration"]["allProjects"] == true
            && previous["collaboration"]["allProjects"] != true)
    {
        previous["enabledAfter"]
            .as_str()
            .map(|time| json!(time))
            .unwrap_or_else(|| enabled_at.clone())
    } else {
        enabled_at
    };
    identity["projectBoundaries"] = json!(boundaries);
}

#[cfg(test)]
#[path = "project_intake_boundary_tests.rs"]
mod project_intake_boundary_tests;

#[cfg(test)]
mod email_policy_tests {
    use super::*;

    #[test]
    fn git_cli_and_webhook_sources_keep_separate_checkpoints_and_bindings() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let webhook = json!({"providerId":"@wegent/dsh-connection-git/github","kind":"repository","id":"42","profile":"account"});
        let mut cli = webhook.clone();
        cli["transport"] = json!("cli");
        store
            .save_stand_in_source(7, &webhook, &json!({"checkpoint":{"sequence":5}}))
            .unwrap();
        store
            .save_stand_in_source(7, &cli, &json!({"checkpoint":{"activityPage":2}}))
            .unwrap();
        assert_eq!(
            store.stand_in_source(7, &webhook).unwrap()["checkpoint"]["sequence"],
            5
        );
        assert_eq!(
            store.stand_in_source(7, &cli).unwrap()["checkpoint"]["activityPage"],
            2
        );
        let role = json!({"connections":[cli.clone()]});
        assert!(stand_in_connection(&role, &cli).is_some());
        assert!(stand_in_connection(&role, &webhook).is_none());
    }

    #[test]
    fn collection_partition_changes_start_a_new_receiving_boundary() {
        let source = json!({"providerId":"example/events","profile":"account","kind":"resource","id":"shared","enabledAfter":"2020-01-01T00:00:00Z","collectionKey":"first"});
        let previous = json!({"enabled":true,"connections":[source]});
        let mut unchanged = previous.clone();
        stamp_stand_in_connections(&mut unchanged, &previous);
        assert_eq!(
            unchanged["connections"][0]["enabledAfter"],
            source["enabledAfter"]
        );
        let mut changed = previous.clone();
        changed["connections"][0]["collectionKey"] = json!("second");
        stamp_stand_in_connections(&mut changed, &previous);
        assert_ne!(
            changed["connections"][0]["enabledAfter"],
            source["enabledAfter"]
        );
        changed["connections"][0]
            .as_object_mut()
            .unwrap()
            .remove("collectionKey");
        stamp_stand_in_connections(&mut changed, &previous);
        assert_ne!(
            changed["connections"][0]["enabledAfter"],
            source["enabledAfter"]
        );
    }

    #[test]
    fn connection_collection_metadata_is_bounded_and_persisted_without_interpreting_provider_config(
    ) {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"][0]["connections"] = json!([{
            "providerId":"example/events","profile":"account","kind":"resource",
            "id":"shared","name":"Shared","collectionKey":"selected:v1",
            "configurationSummary":"Selected object 42", "providerOwned":{"objects":[42]},
            "policy":{"automatic":true,"askBeforeAct":true}
        }]);
        let saved = store.save_personal_stand_in(7, "mac", settings).unwrap();
        assert_eq!(
            saved["roles"][0]["connections"][0]["providerOwned"],
            json!({"objects":[42]})
        );
        assert_eq!(
            saved["roles"][0]["connections"][0]["collectionKey"],
            "selected:v1"
        );
        for invalid in [
            Value::Null,
            json!(7),
            json!(""),
            json!(" "),
            json!(" padded "),
            json!("x".repeat(257)),
        ] {
            let mut changed = saved.clone();
            changed["roles"][0]["connections"][0]["collectionKey"] = invalid;
            assert!(store.save_personal_stand_in(7, "mac", changed).is_err());
        }
        for invalid in [Value::Null, json!(7), json!(" "), json!("x".repeat(4097))] {
            let mut changed = saved.clone();
            changed["roles"][0]["connections"][0]["configurationSummary"] = invalid;
            assert!(store.save_personal_stand_in(7, "mac", changed).is_err());
        }
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), saved);
    }

    #[test]
    fn git_connection_save_preflight_never_commits_the_draft() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let original = store.personal_stand_in(7, "mac").unwrap();
        let mut draft = original.clone();
        draft["primary"] =
            json!({"enabled":false,"prompt":"","preferences":"Draft only","connections":[]});
        store
            .validate_personal_stand_in_settings(7, "mac", draft.clone())
            .unwrap();
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), original);
        let saved = store
            .save_personal_stand_in(7, "mac", draft.clone())
            .unwrap();
        assert!(matches!(
            store.validate_personal_stand_in_settings(7, "mac", draft),
            Err(TaskRuntimeError::VersionConflict)
        ));
        assert_eq!(store.personal_stand_in(7, "mac").unwrap(), saved);
    }
    #[test]
    fn git_takeover_resets_collection_stamp_but_ordinary_saves_preserve_it() {
        let previous = json!({"enabled":true,"connections":[{"providerId":"@wegent/dsh-connection-git/github","profile":"account","id":"repo","kind":"repository","subscriptionId":"receiver","generation":"old","enabledAfter":"2026-01-01T00:00:00Z"}]});
        let mut unchanged = previous.clone();
        stamp_stand_in_connections(&mut unchanged, &previous);
        assert_eq!(
            unchanged["connections"][0]["enabledAfter"],
            previous["connections"][0]["enabledAfter"]
        );
        let mut takeover = previous.clone();
        takeover["connections"][0]["generation"] = json!("new");
        stamp_stand_in_connections(&mut takeover, &previous);
        assert_ne!(
            takeover["connections"][0]["enabledAfter"],
            previous["connections"][0]["enabledAfter"]
        );
    }
    #[test]
    fn email_connections_accept_explicit_confirmation_or_continuous_authorization() {
        let mut role = json!({"connections":[{"providerId":EMAIL_PROVIDER,"profile":"account","kind":"inbox","id":"INBOX","name":"Mailbox","policy":{"automatic":true,"askBeforeAct":true}}]});
        assert!(validate_connections(&role).is_ok());
        role["connections"][0]["policy"]["askBeforeAct"] = json!(false);
        assert!(validate_connections(&role).is_ok());
        for invalid in [Value::Null, json!("false"), json!(0)] {
            role["connections"][0]["policy"]["askBeforeAct"] = invalid;
            assert!(validate_connections(&role).is_err());
        }
        role["connections"][0]["policy"] = json!({"automatic":true});
        assert!(validate_connections(&role).is_err());
        role["connections"][0]["policy"] = json!({"automatic":"true","askBeforeAct":false});
        assert!(validate_connections(&role).is_err());
    }
    #[test]
    fn git_sources_cannot_disable_native_external_write_confirmation() {
        for provider in [
            "@wegent/dsh-connection-git/github",
            "@wegent/dsh-connection-git/gitlab",
        ] {
            let mut role = json!({"connections":[{"providerId":provider,"profile":"account","kind":"personal","id":"personal","name":"Personal events","policy":{"automatic":true,"askBeforeAct":true}}]});
            assert!(validate_connections(&role).is_ok());
            role["connections"][0]["policy"]["askBeforeAct"] = json!(false);
            assert!(validate_connections(&role).is_err());
        }
    }
}
