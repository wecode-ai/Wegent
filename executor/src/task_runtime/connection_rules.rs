//! Private subscriptions and durable deliveries. Only authored publications leave this store.
use super::stand_in_inbox::stand_in_record_key;
use super::stand_in_processing::{rows, write};
use super::*;

const RULE: &str = "connection_rule";
const RUN: &str = "connection_rule_run";
const EVENT: &str = "connection_event";

fn project_rule(rule: &Value) -> Value {
    json!({"id":rule["id"],"name":rule["name"],"prompt":rule["instruction"].as_str().filter(|s|!s.trim().is_empty()).unwrap_or("Process the published Issue and record the result."),
        "triggerType":"event","eventType":"connection.result_published","eventConfig":{"executionTarget":"create_issue"},
        "targetKind":rule["targetKind"],"targetId":rule["targetId"],"enabled":rule["enabled"],"version":rule["version"],"timezone":"UTC","runnerSelection":rule["runnerSelection"],"createdAt":rule["createdAt"],"updatedAt":rule["updatedAt"]})
}

fn update_project_rule(
    connection: &Connection,
    rule: &mut Value,
    remove: bool,
) -> Result<(), TaskRuntimeError> {
    if rule["project"]["store"] != "local" {
        return Ok(());
    }
    let project_id = required(&rule["project"], "id")?.to_owned();
    let project = get_item_from(connection, &project_id, "project")?
        .ok_or(TaskRuntimeError::ProjectNotFound)?;
    let mut metadata = project.metadata.clone();
    let mut rules = metadata["automatic_processing_rules"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let current = rules.iter().find(|row| row["id"] == rule["id"]);
    if !remove
        && current.is_some_and(|current| {
            current["version"] != rule["sharedRuleVersion"]
                || current["eventType"] != "connection.result_published"
        })
    {
        return Err(TaskRuntimeError::VersionConflict);
    }
    if !remove && current.is_none() && rule["sharedRuleVersion"].as_i64().unwrap_or(0) > 0 {
        return Err(TaskRuntimeError::VersionConflict);
    }
    let shared_version = current.and_then(|row| row["version"].as_i64()).unwrap_or(0) + 1;
    rule["sharedRuleVersion"] = json!(shared_version);
    rules.retain(|row| row["id"] != rule["id"]);
    if !remove {
        let mut shared = project_rule(rule);
        shared["version"] = json!(shared_version);
        rules.push(shared);
    }
    local_automation::validate_rules(connection, &project_id, &metadata, &json!(rules))?;
    metadata["automatic_processing_rules"] = json!(rules);
    connection.execute(
        "UPDATE loop_items SET metadata=?1,version=version+1,updated_at=?2 WHERE id=?3",
        params![metadata.to_string(), now(), project_id],
    )?;
    Ok(())
}

fn required<'a>(value: &'a Value, field: &str) -> Result<&'a str, TaskRuntimeError> {
    value[field]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| TaskRuntimeError::Invalid(format!("Connection rule requires {field}")))
}

pub(crate) fn matches_condition(condition: &Value, event: &Value) -> bool {
    condition["contains"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map_or(true, |query| {
            event["text"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase()
                .contains(&query.to_lowercase())
        })
        && condition["senderId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map_or(true, |sender| event["senderId"] == sender)
}

fn validate_rule_fields(rule: &Value) -> Result<(), TaskRuntimeError> {
    required(rule, "id")?;
    required(rule, "name")?;
    required(rule, "eventType")?;
    required(rule, "targetId")?;
    for key in ["providerId", "id", "profile", "kind", "name"] {
        required(&rule["source"], key)?;
    }
    required(&rule["publication"], "title")?;
    required(&rule["publication"], "instruction")?;
    required(&rule["project"], "id")?;
    if rule["name"]
        .as_str()
        .is_some_and(|s| s.chars().count() > 100)
        || rule["publication"]["title"]
            .as_str()
            .is_some_and(|s| s.chars().count() > 255)
        || !rule["enabled"].is_boolean()
        || rule
            .get("instruction")
            .is_some_and(|v| !v.is_null() && !v.is_string())
        || !valid_condition(&rule["condition"])
    {
        return Err(TaskRuntimeError::Invalid(
            "Invalid connection rule fields".into(),
        ));
    }
    if !matches!(rule["project"]["store"].as_str(), Some("local" | "cloud"))
        || !matches!(
            rule["targetKind"].as_str(),
            Some("human" | "agent" | "collaboration_group")
        )
    {
        return Err(TaskRuntimeError::Invalid(
            "Invalid connection rule target".into(),
        ));
    }
    Ok(())
}

impl LocalTaskStore {
    pub fn check_connection_rule(
        &self,
        user: i64,
        device: &str,
        rule: &Value,
    ) -> Result<(), TaskRuntimeError> {
        validate_rule_fields(rule)?;
        let connection = self.connection()?;
        let current =
            get_item_from(&connection, required(rule, "id")?, RULE)?.map(|row| row.metadata);
        if current
            .as_ref()
            .is_some_and(|row| row["userId"] != user || row["deviceId"] != device)
        {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        let version = current
            .as_ref()
            .and_then(|row| row["version"].as_i64())
            .unwrap_or(0);
        if rule["version"].as_i64() != Some(version) {
            return Err(TaskRuntimeError::VersionConflict);
        }
        Ok(())
    }
    pub fn connection_rules(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        rows(&*self.connection()?, RULE, user)
    }

    pub fn connection_rule_view(&self, mut rule: Value) -> Result<Value, TaskRuntimeError> {
        if rule["project"]["store"] == "local" {
            if let Some(project) = get_item_from(
                &*self.connection()?,
                required(&rule["project"], "id")?,
                "project",
            )? {
                if let Some(shared) = project.metadata["automatic_processing_rules"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|row| row["id"] == rule["id"])
                {
                    for field in [
                        "name",
                        "targetKind",
                        "targetId",
                        "runnerSelection",
                        "enabled",
                    ] {
                        rule[field] = shared[field].clone();
                    }
                    rule["instruction"] = shared["prompt"].clone();
                    rule["sharedRuleVersion"] = shared["version"].clone();
                }
            }
        }
        Ok(rule)
    }

    pub fn connection_rule_users(&self) -> Result<Vec<i64>, TaskRuntimeError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT DISTINCT json_extract(metadata,'$.userId') FROM loop_items WHERE resource_type='connection_rule'")?;
        let users = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(users)
    }

    pub fn save_connection_rule(
        &self,
        user: i64,
        device: &str,
        mut rule: Value,
    ) -> Result<Value, TaskRuntimeError> {
        validate_rule_fields(&rule)?;
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = required(&rule, "id")?.to_owned();
        let previous = get_item_from(&connection, &id, RULE)?.map(|row| row.metadata);
        if previous
            .as_ref()
            .is_some_and(|row| row["userId"] != user || row["deviceId"] != device)
        {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        let version = previous
            .as_ref()
            .and_then(|row| row["version"].as_i64())
            .unwrap_or(0);
        if rule["version"].as_i64() != Some(version) {
            return Err(TaskRuntimeError::VersionConflict);
        }
        if previous.is_none() {
            rule["sharedRuleVersion"] = Value::Null;
        }
        rule["version"] = json!(version + 1);
        rule["userId"] = json!(user);
        rule["deviceId"] = json!(device);
        rule["createdAt"] = previous
            .as_ref()
            .map(|row| row["createdAt"].clone())
            .unwrap_or_else(|| json!(now()));
        rule["updatedAt"] = json!(now());
        update_project_rule(&connection, &mut rule, false)?;
        write(&connection, RULE, &rule)?;
        // A changed rule must not publish a result produced under an older instruction.
        for mut run in rows(&connection, RUN, user)?.into_iter().filter(|run| {
            run["ruleId"] == id && run["status"] != "published" && run["receiptId"].is_null()
        }) {
            run["status"] = json!("cancelled");
            write(&connection, RUN, &run)?;
        }
        connection.commit()?;
        Ok(rule)
    }

    pub fn remove_connection_rule(
        &self,
        user: i64,
        id: &str,
        version: i64,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rule = get_item_from(&connection, id, RULE)?
            .filter(|row| row.metadata["userId"] == user)
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        if rule.metadata["version"] != version {
            return Err(TaskRuntimeError::VersionConflict);
        }
        update_project_rule(&connection, &mut rule.metadata.clone(), true)?;
        connection.execute(
            "DELETE FROM loop_items WHERE id=?1 AND resource_type=?2",
            params![id, RULE],
        )?;
        for mut run in rows(&connection, RUN, user)?.into_iter().filter(|run| {
            run["ruleId"] == id && run["status"] != "published" && run["receiptId"].is_null()
        }) {
            run["status"] = json!("cancelled");
            write(&connection, RUN, &run)?;
        }
        connection.commit()?;
        Ok(())
    }

    pub fn enqueue_connection_rule(
        &self,
        user: i64,
        rule: &Value,
        source: &Value,
        event: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current =
            get_item_from(&connection, required(rule, "id")?, RULE)?.map(|row| row.metadata);
        if !current.is_some_and(|current| {
            current["userId"] == user
                && current["enabled"] == true
                && current["version"] == rule["version"]
        }) {
            return Ok(());
        }
        if event["eventType"] != rule["eventType"] || !matches_condition(&rule["condition"], event)
        {
            return Ok(());
        }
        let id = stand_in_record_key(
            "connection-run",
            &json!([
                user,
                rule["id"],
                source["providerId"],
                source["profile"],
                source["kind"],
                source["id"],
                event["id"]
            ]),
        );
        if get_item_from(&connection, &id, RUN)?.is_none() {
            let event_id = stand_in_record_key(
                "connection-event",
                &json!([
                    user,
                    source["providerId"],
                    source["profile"],
                    source["kind"],
                    source["id"],
                    event["id"]
                ]),
            );
            if get_item_from(&connection, &event_id, EVENT)?.is_none() {
                write(
                    &connection,
                    EVENT,
                    &json!({"id":event_id,"userId":user,"source":source,"event":event}),
                )?;
            }
            write(
                &connection,
                RUN,
                &json!({"id":id,"userId":user,"ruleId":rule["id"],"ruleVersion":rule["version"],"eventId":event_id,"status":"pending","createdAt":now()}),
            )?;
        }
        connection.commit()?;
        Ok(())
    }

    pub fn connection_rule_runs(&self, user: i64) -> Result<Vec<Value>, TaskRuntimeError> {
        rows(&*self.connection()?, RUN, user)
    }

    pub fn connection_rule_event(&self, user: i64, run: &Value) -> Result<Value, TaskRuntimeError> {
        get_item_from(&*self.connection()?, required(run, "eventId")?, EVENT)?
            .filter(|row| row.metadata["userId"] == user)
            .map(|row| row.metadata["event"].clone())
            .ok_or(TaskRuntimeError::TaskNotFound)
    }

    pub fn save_connection_rule_run(&self, user: i64, run: &Value) -> Result<(), TaskRuntimeError> {
        let connection = self.connection()?;
        let current = get_item_from(&connection, required(run, "id")?, RUN)?
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        if current.metadata["userId"] != user || run["userId"] != user {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        if matches!(
            current.metadata["status"].as_str(),
            Some("published" | "cancelled")
        ) {
            return Ok(());
        }
        write(&connection, RUN, run)
    }

    pub fn publish_connection_rule_locally(
        &self,
        user: i64,
        rule: &Value,
        run: &Value,
        publication: &Value,
    ) -> Result<(), TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = get_item_from(&connection, required(rule, "id")?, RULE)?
            .ok_or(TaskRuntimeError::TaskNotFound)?
            .metadata;
        if current["userId"] != user
            || current["enabled"] != true
            || current["version"] != run["ruleVersion"]
        {
            return Err(TaskRuntimeError::VersionConflict);
        }
        let mut run = get_item_from(&connection, required(run, "id")?, RUN)?
            .ok_or(TaskRuntimeError::TaskNotFound)?
            .metadata;
        if run["status"] != "pending" {
            return Ok(());
        }
        let project_id = required(&rule["project"], "id")?;
        let project = get_item_from(&connection, project_id, "project")?
            .ok_or(TaskRuntimeError::ProjectNotFound)?;
        let input = serde_json::from_value(json!({
            "title": publication["title"],
            "description": publication["description"],
            "status": project_status::initial_status(&project.metadata)?,
            "tags": ["automation"],
        }))
        .map_err(|error| TaskRuntimeError::Invalid(error.to_string()))?;
        let shared_rule = project.metadata["automatic_processing_rules"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["id"] == current["id"] && row["enabled"] == true)
            .ok_or_else(|| TaskRuntimeError::Invalid("Project rule is no longer enabled".into()))?;
        let task = Self::create_task_on(&connection, project_id, input, None, None, false)?;
        // Dispatch uses the same target validation and durable queue as other project rules.
        let result =
            local_automation::run_for_issue(&connection, &project, &task.id, shared_rule, "event")?;
        run["status"] = json!("published");
        run["error"] = Value::Null;
        run["issueId"] = json!(task.id);
        run["projectRunId"] = result["id"].clone();
        write(&connection, RUN, &run)?;
        connection.commit()?;
        Ok(())
    }
}

pub(crate) fn valid_condition(condition: &Value) -> bool {
    condition.is_null()
        || condition.as_object().is_some_and(|fields| {
            fields.iter().all(|(key, value)| {
                matches!(key.as_str(), "contains" | "senderId")
                    && value.as_str().is_some_and(|s| s.len() <= 2000)
            })
        })
}
