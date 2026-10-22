// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The metadata merge of `cloud_project_service.update`.
//!
//! Each branch mirrors the source: a metadata-backed field is only applied
//! when the request set it (`model_fields_set`) and its value is not `None`,
//! and the branch never writes the field's own key back onto the project row
//! (the update `updates.pop`s it after folding it into `metadata_json`).
use chrono::{SecondsFormat, Utc};
use serde_json::{Map, Value};

use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};

use super::provider::{normalize_provider_config, store_provider_config};
use super::request::CloudProjectUpdate;
use crate::board_snapshot::external_provider::ProviderCredential;

/// `MemberStatus.APPROVED`.
const APPROVED: &str = "approved";

/// The outcome of the metadata merge: the new metadata document plus the
/// `resource_members` grant the visibility branch decided to add.
#[derive(Debug)]
pub(super) struct MergeOutcome {
    pub(super) metadata: Map<String, Value>,
    pub(super) grant_role: Option<String>,
}

/// A failure while merging: a source `ValueError`/`HTTPException(422)` the
/// caller renders as 422, or a dependency failure that stays a 500.
#[derive(Debug)]
pub(super) enum MergeError {
    /// A branch raised the source's `ValueError`/`HTTPException(422)`.
    Rejected(String),
    /// A read or write of the merge's rows failed.
    Db(brz_mysql::MysqlError),
}

/// Apply every metadata-backed branch of `CloudProjectUpdate` in source order.
pub(super) async fn merge_metadata<T: MysqlTransaction>(
    transaction: &mut T,
    mut metadata: Map<String, Value>,
    update: &CloudProjectUpdate,
    project_id: i64,
    user_id: i32,
    jwt_key: &str,
) -> Result<MergeOutcome, MergeError> {
    // `project.task_provider` reads the stored metadata, defaulting to local.
    let task_provider = metadata
        .get("task_provider")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "local" | "github" | "gitlab" | "dingtalk_aitable"))
        .unwrap_or("local")
        .to_owned();

    if update.has("tags")
        && let Some(tags) = update.tags.as_ref()
    {
        metadata.insert(
            "tags".to_owned(),
            Value::Array(tags.iter().cloned().map(Value::String).collect()),
        );
    }
    if update.has("card_display")
        && let Some(card_display) = update.card_display.as_ref()
    {
        metadata.insert("card_display".to_owned(), card_display.clone());
    }
    if update.has("board_config")
        && let Some(board_config) = update.board_config.as_ref()
    {
        remove_dropped_board_statuses(transaction, &metadata, board_config, project_id, user_id)
            .await?;
        metadata.insert("board_config".to_owned(), board_config.clone());
    }
    if update.has("ai_automation")
        && let Some(ai_automation) = update.ai_automation.as_ref()
    {
        metadata.insert("ai_automation".to_owned(), ai_automation.clone());
    }
    if update.has("pull_request_automation")
        && let Some(pull_request_automation) = update.pull_request_automation.as_ref()
    {
        metadata.insert(
            "pull_request_automation".to_owned(),
            pull_request_automation.clone(),
        );
    }
    if update.has("workflow_definition")
        && let Some(workflow_definition) = update.workflow_definition.as_ref()
    {
        metadata.insert(
            "workflow_definition".to_owned(),
            workflow_definition.clone(),
        );
    }
    if update.has("execution_environment")
        && let Some(execution_environment) = update.execution_environment.as_ref()
    {
        metadata.insert(
            "execution_environment".to_owned(),
            preparing_execution_environment(
                execution_environment,
                metadata.get("execution_environment"),
            ),
        );
    }
    if update.has("provider_config")
        && let Some(provider_config) = update.provider_config.as_ref()
    {
        let normalized = normalize_provider_config(&task_provider, provider_config)
            .map_err(MergeError::Rejected)?;
        let stored = if task_provider == "local" {
            Map::new()
        } else {
            let current = metadata.get("provider_config").and_then(Value::as_object);
            store_provider_config(&task_provider, &normalized, current, jwt_key)
                .map_err(MergeError::Rejected)?
        };
        metadata.insert("provider_config".to_owned(), Value::Object(stored));
    }
    if let Some(security) = update.default_issue_security.as_deref() {
        if task_provider == "dingtalk_aitable" && security != "open" {
            return Err(MergeError::Rejected(
                "DingTalk table records use DingTalk permissions".to_owned(),
            ));
        }
        metadata.insert(
            "default_issue_security".to_owned(),
            Value::String(security.to_owned()),
        );
    }

    let mut grant_role = None;
    if update.has("visibility") || update.has("public_access") {
        let grant = existing_grant(transaction, project_id).await?;
        let visible = match update.visibility.as_deref() {
            Some(visibility) => visibility != "private",
            None => grant.as_ref().is_some_and(|grant| grant == APPROVED),
        };
        if !visible && update.public_access.is_some() {
            return Err(MergeError::Rejected(
                "Private projects cannot grant public access".to_owned(),
            ));
        }
        if visible {
            grant_role = Some(
                update
                    .public_access
                    .as_ref()
                    .and_then(|grant| grant.get("role"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| grant.clone())
                    .unwrap_or_else(|| "Viewer".to_owned()),
            );
        } else if grant.is_some() {
            // `db.delete(grant)`: drop the approved all-signed-in-users grant
            // so the project becomes private again.
            remove_grant(transaction, project_id).await?;
        }
    }
    Ok(MergeOutcome {
        metadata,
        grant_role,
    })
}

/// The stored `status` of the project's all-signed-in-users grant, when one
/// exists (`db.query(ResourceMember).filter(...).one_or_none()`).
async fn existing_grant<T: MysqlTransaction>(
    transaction: &mut T,
    project_id: i64,
) -> Result<Option<String>, MergeError> {
    #[derive(Debug, FromMysqlRow)]
    struct GrantRow {
        #[mysql(rename = "resource_members_status")]
        status: Option<String>,
    }
    let project_id = project_id.to_string();
    let row: Option<GrantRow> = transaction
        .fetch_optional(
            super::statements::grant_select_sql(),
            (project_id.as_str(),),
        )
        .await
        .map_err(MergeError::Db)?;
    Ok(row.and_then(|row| row.status))
}

async fn remove_grant<T: MysqlTransaction>(
    transaction: &mut T,
    project_id: i64,
) -> Result<(), MergeError> {
    let project_id = project_id.to_string();
    transaction
        .execute(
            "DELETE FROM resource_members WHERE resource_members.resource_type = 'CloudProject' \
             AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'authenticated_users' \
             AND resource_members.entity_id = '*'",
            (project_id.as_str(),),
        )
        .await
        .map_err(MergeError::Db)?;
    Ok(())
}

/// The `board_config` drop branch: every Issue still on a removed status is
/// reset to no status, logged into its own `status_history`, and versioned.
async fn remove_dropped_board_statuses<T: MysqlTransaction>(
    transaction: &mut T,
    metadata: &Map<String, Value>,
    board_config: &Value,
    project_id: i64,
    user_id: i32,
) -> Result<(), MergeError> {
    let previous = metadata.get("board_config").and_then(Value::as_object);
    let previous_statuses = previous
        .and_then(|config| config.get("statuses"))
        .and_then(Value::as_array);
    let previous_ids: std::collections::BTreeSet<String> = previous_statuses
        .into_iter()
        .flatten()
        .filter_map(|status| status.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    let next_ids: std::collections::BTreeSet<String> = board_config
        .get("statuses")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|status| status.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    let removed: Vec<String> = previous_ids.difference(&next_ids).cloned().collect();
    if removed.is_empty() {
        return Ok(());
    }

    let statuses = metadata_board_statuses(metadata);
    let project_id_text = project_id.to_string();
    let placeholders = vec!["?"; removed.len()].join(", ");
    let sql = format!(
        "SELECT loop_items.id AS loop_items_id, loop_items.status AS loop_items_status, \
         loop_items.version AS loop_items_version, loop_items.completed_at AS loop_items_completed_at, \
         loop_items.metadata AS loop_items_metadata \n\
         FROM loop_items \n\
         WHERE loop_items.cloud_project_id = ? AND loop_items.status IN ({placeholders}) \
         AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
             ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))"
    );
    #[derive(Debug, FromMysqlRow)]
    struct AffectedRow {
        #[mysql(rename = "loop_items_id")]
        id: String,
        #[mysql(rename = "loop_items_status")]
        status: Option<String>,
        #[mysql(rename = "loop_items_version")]
        version: i64,
        #[mysql(rename = "loop_items_completed_at")]
        completed_at: Option<chrono::NaiveDateTime>,
        #[mysql(rename = "loop_items_metadata")]
        metadata: Option<Json<brz_json::OpaqueJson>>,
    }
    let mut args: Vec<String> = Vec::with_capacity(removed.len() + 1);
    args.push(project_id_text);
    args.extend(removed.iter().cloned());
    let rows: Vec<AffectedRow> = transaction
        .fetch_all(sql, args)
        .await
        .map_err(MergeError::Db)?;

    for row in rows {
        let mut item_metadata = row
            .metadata
            .map(|json| json.0.to_value())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        let from_status = row.status.unwrap_or_default();
        write_status_change(
            &mut item_metadata,
            &statuses,
            &from_status,
            "",
            "status_removed",
            Some(user_id),
        );
        // `item.metadata_json`, `item.status`, `item.version` and (only when it
        // held a value) `item.completed_at` are the changed ORM attributes;
        // `updated_at` follows from the column's `onupdate`.
        let mut assignments = vec!["status=?", "metadata=?", "version=?", "updated_at=now()"];
        let clear_completed_at = row.completed_at.is_some();
        if clear_completed_at {
            assignments.push("completed_at=?");
        }
        let statement = format!(
            "UPDATE loop_items SET {} WHERE loop_items.id = ?",
            assignments.join(", ")
        );
        let metadata_json = crate::json_compat::python_json_value(&Value::Object(item_metadata));
        let version = row.version + 1;
        if clear_completed_at {
            transaction
                .execute(
                    statement,
                    (
                        "",
                        metadata_json.as_str(),
                        version,
                        Option::<chrono::NaiveDateTime>::None,
                        row.id.as_str(),
                    ),
                )
                .await
                .map_err(MergeError::Db)?;
        } else {
            transaction
                .execute(
                    statement,
                    ("", metadata_json.as_str(), version, row.id.as_str()),
                )
                .await
                .map_err(MergeError::Db)?;
        }
    }
    Ok(())
}

/// `project_board_statuses(project)`: the project's `(id, name)` columns,
/// falling back to the default board when the stored metadata has none.
fn metadata_board_statuses(metadata: &Map<String, Value>) -> Vec<(String, String)> {
    let raw = metadata
        .get("board_config")
        .and_then(Value::as_object)
        .and_then(|config| config.get("statuses"))
        .and_then(Value::as_array);
    let Some(raw) = raw else {
        return default_board_statuses();
    };
    raw.iter()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let id = object.get("id")?.as_str()?;
            if id.is_empty() {
                return None;
            }
            let name = object.get("name").and_then(Value::as_str).unwrap_or("");
            Some((id.to_owned(), name.to_owned()))
        })
        .collect()
}

fn default_board_statuses() -> Vec<(String, String)> {
    [
        ("inbox", "收集箱"),
        ("pending", "待开始"),
        ("in_progress", "进行中"),
        ("in_review", "待确认"),
        ("completed", "已完成"),
    ]
    .into_iter()
    .map(|(id, name)| (id.to_owned(), name.to_owned()))
    .collect()
}

/// `write_status_change`: append one transition to `metadata["status_history"]`
/// in place.
fn write_status_change(
    metadata: &mut Map<String, Value>,
    statuses: &[(String, String)],
    from_status: &str,
    to_status: &str,
    trigger: &str,
    by_user_id: Option<i32>,
) {
    let mut history = metadata
        .get("status_history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let status_name = |status: &str| -> String {
        if status.is_empty() {
            return String::new();
        }
        statuses
            .iter()
            .find(|(id, _)| id == status)
            .map(|(_, name)| name.clone())
            .unwrap_or_default()
    };
    let mut entry = Map::new();
    entry.insert(
        "from_status".to_owned(),
        Value::String(from_status.to_owned()),
    );
    entry.insert(
        "from_status_name".to_owned(),
        Value::String(status_name(from_status)),
    );
    entry.insert("to_status".to_owned(), Value::String(to_status.to_owned()));
    entry.insert(
        "to_status_name".to_owned(),
        Value::String(status_name(to_status)),
    );
    entry.insert("trigger".to_owned(), Value::String(trigger.to_owned()));
    entry.insert(
        "by_user_id".to_owned(),
        by_user_id.map_or(Value::Null, Value::from),
    );
    entry.insert(
        "at".to_owned(),
        Value::String(Utc::now().to_rfc3339_opts(SecondsFormat::Micros, false)),
    );
    history.push(Value::Object(entry));
    metadata.insert("status_history".to_owned(), Value::Array(history));
}

/// `preparing_execution_environment(definition, previous)`: pin the canonical
/// fingerprint and keep the prepared devices when the configuration is
/// unchanged.
pub(super) fn preparing_execution_environment(
    definition: &Value,
    previous: Option<&Value>,
) -> Value {
    let fingerprint = execution_environment_fingerprint(definition);
    let devices = if previous
        .and_then(Value::as_object)
        .and_then(|previous| previous.get("fingerprint"))
        .and_then(Value::as_str)
        == Some(fingerprint.as_str())
    {
        previous
            .and_then(Value::as_object)
            .and_then(|previous| previous.get("devices"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    } else {
        Map::new()
    };
    let mut dump = definition.as_object().cloned().unwrap_or_default();
    dump.insert("fingerprint".to_owned(), Value::String(fingerprint));
    dump.insert("devices".to_owned(), Value::Object(devices));
    Value::Object(dump)
}

/// `execution_environment_fingerprint(definition)`: the SHA-256 of the
/// canonical repositories/setup-steps document, rendered with sorted keys and
/// Python's `json.dumps(ensure_ascii=False)` separators.
fn execution_environment_fingerprint(definition: &Value) -> String {
    use sha2::{Digest, Sha256};

    let text = |value: &Value, key: &str| -> String {
        value
            .get(key)
            .map(python_text)
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let mut repositories = Vec::new();
    for repository in definition
        .get("repositories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|repository| repository.is_object())
    {
        // Python `sort_keys=True` orders the repository keys alphabetically.
        let mut entry = Map::new();
        entry.insert("name".to_owned(), Value::String(text(repository, "name")));
        entry.insert("path".to_owned(), Value::String(text(repository, "path")));
        entry.insert(
            "primary".to_owned(),
            Value::Bool(
                repository
                    .get("primary")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
        );
        entry.insert("ref".to_owned(), Value::String(text(repository, "ref")));
        entry.insert("url".to_owned(), Value::String(text(repository, "url")));
        repositories.push(Value::Object(entry));
    }
    let mut setup_steps = Vec::new();
    for step in definition
        .get("setup_steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|step| step.is_object())
    {
        let command = text(step, "command");
        if command.is_empty() {
            continue;
        }
        let mut entry = Map::new();
        entry.insert("command".to_owned(), Value::String(command));
        entry.insert(
            "working_directory".to_owned(),
            Value::String(text(step, "working_directory")),
        );
        setup_steps.push(Value::Object(entry));
    }
    let mut canonical = Map::new();
    canonical.insert("repositories".to_owned(), Value::Array(repositories));
    canonical.insert("setup_steps".to_owned(), Value::Array(setup_steps));

    let mut hasher = Sha256::new();
    hasher.update(crate::json_compat::python_json_value_no_ascii(
        &Value::Object(canonical),
    ));
    format!("{:x}", hasher.finalize())
}

/// Python `str(value or "")` for the fingerprint inputs.
fn python_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(true) => "True".to_owned(),
        Value::Bool(false) => "False".to_owned(),
        other => other.to_string(),
    }
}

/// `decrypt_provider_token` accepts the stored envelope; the credential type
/// is re-exported here so the update module can validate a preserved
/// credential without reaching into the board-snapshot module.
#[allow(dead_code, reason = "pins the shared credential envelope type")]
pub(super) type StoredCredential = ProviderCredential;

#[cfg(test)]
#[path = "metadata_tests.rs"]
mod tests;
