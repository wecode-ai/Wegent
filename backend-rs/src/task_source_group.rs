// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `get_or_create_task_source_group`
//! (`app/services/chat/task_source_group.py`).
//!
//! API-created tasks are attached to an automatically managed source group.
//! `create_new_task` resolves it inside the task-creation transaction
//! (`params.is_api_call` -> `get_or_create_task_source_group(task_source="api")`)
//! and stores the id on the placeholder Task and Workspace rows.
//!
//! The id is a cache hint, not an authority: a hit is re-read from `projects`
//! with the source-group predicate under `FOR UPDATE`, so a deleted or
//! reconfigured group falls back to the create-or-reuse path. A newly resolved
//! group is cached after the task commits (`after_commit`,
//! `TASK_SOURCE_GROUP_CACHE_TTL`).

use brz_mysql::{Mysql, MysqlRow, MysqlTransaction};
use brz_redis::{SetExpiration, SetOptions};

use crate::projects::PROJECT_COLUMNS;
use crate::task_store::StatementArg;

/// `TASK_SOURCE_GROUP_CACHE_TTL`.
pub(crate) const CACHE_TTL_SECONDS: u64 = 3600;

/// `settings.TASK_SOURCE_GROUP_NAMES` defaults (config.py).
const DEFAULT_API_GROUP_NAME: &str = "API Tasks";
const DEFAULT_DINGTALK_GROUP_NAME: &str = "DingTalk";

/// The source-group resolution failure the route maps to its response.
#[derive(Debug)]
pub(crate) enum SourceGroupError {
    /// `HTTPException(404, "User not found")` inside `_create_or_reuse_group`.
    UserNotFound,
    Mysql(brz_mysql::MysqlError),
}

impl From<brz_mysql::MysqlError> for SourceGroupError {
    fn from(error: brz_mysql::MysqlError) -> Self {
        Self::Mysql(error)
    }
}

/// `get_or_create_task_source_group`: the owner's source group id.
pub(crate) async fn get_or_create_task_source_group<M, R>(
    mysql: &M,
    redis: Option<&R>,
    user_id: i64,
    client_origin: &str,
    task_source: &str,
) -> Result<i64, SourceGroupError>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let cache_key = cache_key(task_source, client_origin, user_id);
    let hint = match redis {
        Some(redis) => cached_id(redis, &cache_key).await,
        None => None,
    };
    if let Some(cached_id) = hint {
        // The ID is only a lookup hint: groups can be deleted or reconfigured.
        // The source takes the row lock in its request session; `brz-mysql`'s
        // read pool rejects `FOR UPDATE`, so the locking read runs on a writer
        // transaction.
        let group_id = mysql
            .with_transaction(async |transaction| {
                source_group(
                    transaction,
                    user_id,
                    client_origin,
                    task_source,
                    Some(cached_id),
                )
                .await
            })
            .await?;
        if let Some(group_id) = group_id {
            return Ok(group_id);
        }
    }

    let group_id = create_or_reuse_group(mysql, user_id, client_origin, task_source).await?;
    if let Some(redis) = redis {
        // `after_commit`'s `cache_manager.set_from_sync(key, group_id, expire=3600)`;
        // cache delivery never turns a committed task into a failed request.
        let options =
            SetOptions::default().with_expiration(SetExpiration::Seconds(CACHE_TTL_SECONDS));
        if let Err(error) = redis
            .set_with(cache_key.as_str(), group_id.to_string(), options)
            .await
        {
            tracing::warn!(%error, "failed to cache the committed task source group");
        }
    }
    Ok(group_id)
}

/// `task_source_group:{task_source}:{client_origin}:{user_id}`.
fn cache_key(task_source: &str, client_origin: &str, user_id: i64) -> String {
    format!("task_source_group:{task_source}:{client_origin}:{user_id}")
}

/// `cache_manager.get_sync`: `orjson` integers decode to their ASCII digits;
/// anything else (`None`, a bool, a string) is not a usable hint.
async fn cached_id<R: brz_redis::Redis>(redis: &R, key: &str) -> Option<i64> {
    let value = redis.get::<_, String>(key).await.ok().flatten()?;
    value.parse::<i64>().ok().filter(|id| *id > 0)
}

/// `_source_groups_query(...).with_for_update().first()`: the active source
/// group for the owner, optionally narrowed to a cached id.
async fn source_group<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    client_origin: &str,
    task_source: &str,
    group_id: Option<i64>,
) -> brz_mysql::MysqlResult<Option<i64>> {
    let sql = source_group_sql(group_id.is_some());
    let mut args = vec![
        StatementArg::Int(user_id),
        StatementArg::Str(client_origin.to_string()),
        StatementArg::Str(task_source.to_string()),
    ];
    if let Some(group_id) = group_id {
        args.push(StatementArg::Int(group_id));
    }
    let row: Option<MysqlRow> = transaction.fetch_optional(sql.as_str(), args).await?;
    Ok(row.and_then(|row| row.get_required("projects_id").ok()))
}

/// The recorded `_source_groups_query(...).with_for_update().first()`
/// statement: the source-group predicate over the owner and client origin,
/// optionally narrowed to the cached id.
fn source_group_sql(with_id: bool) -> String {
    let id_predicate = if with_id { " AND projects.id = ?" } else { "" };
    format!(
        "SELECT {PROJECT_COLUMNS} \nFROM projects \n\
         WHERE projects.user_id = ? AND projects.client_origin = ? \
         AND projects.is_active = true \
         AND CASE JSON_EXTRACT(projects.config, '$.\"taskSource\"') \
         WHEN 'null' THEN NULL \
         ELSE JSON_UNQUOTE(JSON_EXTRACT(projects.config, '$.\"taskSource\"')) END = ?\
         {id_predicate} \n LIMIT 1 FOR UPDATE"
    )
}

/// What one create-or-reuse transaction decided.
enum CreateOutcome {
    Reused(i64),
    Created(i64),
    MissingOwner,
}

/// `_create_or_reuse_group`: lock the owner row, reuse an existing group, or
/// insert the source group after the owner's current maximum sort order.
async fn create_or_reuse_group<M: Mysql>(
    mysql: &M,
    user_id: i64,
    client_origin: &str,
    task_source: &str,
) -> Result<i64, SourceGroupError> {
    let outcome = mysql
        .with_transaction(async |transaction| {
            create_in_transaction(transaction, user_id, client_origin, task_source).await
        })
        .await?;
    match outcome {
        CreateOutcome::Reused(group_id) | CreateOutcome::Created(group_id) => Ok(group_id),
        CreateOutcome::MissingOwner => Err(SourceGroupError::UserNotFound),
    }
}

async fn create_in_transaction<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    client_origin: &str,
    task_source: &str,
) -> brz_mysql::MysqlResult<CreateOutcome> {
    // Serialize creation even when no group exists yet.
    let owner: Option<MysqlRow> = transaction
        .fetch_optional(
            "SELECT users.id AS users_id \nFROM users \nWHERE users.id = ? \n LIMIT 1 FOR UPDATE",
            (user_id,),
        )
        .await?;
    if owner.is_none() {
        return Ok(CreateOutcome::MissingOwner);
    }

    if let Some(group_id) =
        source_group(transaction, user_id, client_origin, task_source, None).await?
    {
        return Ok(CreateOutcome::Reused(group_id));
    }

    let max_row: Option<MysqlRow> = transaction
        .fetch_optional(
            "SELECT max(projects.sort_order) AS max_1 \nFROM projects \n\
             WHERE projects.user_id = ? AND projects.client_origin = ? \
             AND projects.is_active = true",
            (user_id, client_origin),
        )
        .await?;
    let max_sort_order = max_row
        .and_then(|row| row.get::<i64>("max_1").ok().flatten())
        .unwrap_or(0)
        + 1;

    // `orjson`-compatible JSON via the source's `json.dumps` rendering
    // (`{"taskSource": "api"}`): SQLAlchemy's JSON column serializer.
    let config = format!("{{\"taskSource\": \"{task_source}\"}}");
    let execution = transaction
        .execute(
            "INSERT INTO projects (user_id, client_origin, name, description, color, \
             config, sort_order, is_expanded, is_active, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now(), now())",
            (
                StatementArg::Int(user_id),
                StatementArg::Str(client_origin.to_string()),
                StatementArg::Str(group_name(task_source)),
                StatementArg::Str(String::new()),
                StatementArg::Str(String::new()),
                StatementArg::Str(config),
                StatementArg::Int(max_sort_order),
                StatementArg::Int(0),
                StatementArg::Int(1),
            ),
        )
        .await?;
    Ok(CreateOutcome::Created(execution.last_insert_id as i64))
}

/// `settings.TASK_SOURCE_GROUP_NAMES[task_source]`: the deployment may override
/// the names with a JSON object; unknown sources keep their own name.
fn group_name(task_source: &str) -> String {
    group_name_from(
        std::env::var("TASK_SOURCE_GROUP_NAMES").ok().as_deref(),
        task_source,
    )
}

fn group_name_from(configured: Option<&str>, task_source: &str) -> String {
    if let Some(raw) = configured
        && let Ok(serde_json::Value::Object(names)) = serde_json::from_str::<serde_json::Value>(raw)
        && let Some(serde_json::Value::String(name)) = names.get(task_source)
        && !name.trim().is_empty()
    {
        return name.trim().to_string();
    }
    match task_source {
        "api" => DEFAULT_API_GROUP_NAME.to_string(),
        "dingtalk" => DEFAULT_DINGTALK_GROUP_NAME.to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_matches_the_source_format() {
        assert_eq!(
            cache_key("api", "frontend", 6582),
            "task_source_group:api:frontend:6582"
        );
    }

    #[test]
    fn source_group_sql_matches_the_recorded_statement() {
        // Recorded (case e5c837d8): the cached-id read narrows the same
        // predicate and takes the row lock.
        let sql = source_group_sql(true);
        assert!(sql.contains("WHERE projects.user_id = ? AND projects.client_origin = ?"));
        assert!(sql.contains(
            "CASE JSON_EXTRACT(projects.config, '$.\"taskSource\"') WHEN 'null' THEN NULL"
        ));
        assert!(sql.ends_with(" AND projects.id = ? \n LIMIT 1 FOR UPDATE"));
        assert!(!source_group_sql(false).contains("projects.id = ?"));
    }

    #[test]
    fn default_group_names_match_the_settings_defaults() {
        assert_eq!(group_name_from(None, "api"), "API Tasks");
        assert_eq!(group_name_from(None, "dingtalk"), "DingTalk");
        assert_eq!(
            group_name_from(
                Some(r#"{"api": "API Tasks (prod)", "dingtalk": "DingTalk"}"#),
                "api"
            ),
            "API Tasks (prod)"
        );
        assert_eq!(group_name_from(Some("not json"), "api"), "API Tasks");
    }
}
