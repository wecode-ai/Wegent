//! Idempotent historical participation references over existing project sources.

use std::collections::{BTreeMap, BTreeSet};

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlTransaction};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::loop_repository::LoopItemRepository;
use super::{auth::FlexibleUser, handler::require_item_access, http_error::HttpError};
use crate::cloud_projects::members::has_permission;
use crate::{http_compat::FastApiError, state::AppState};

#[derive(Clone, Debug, FromMysqlRow)]
struct ParticipationSource {
    source_kind: String,
    source_id: String,
    owner_user_id: i32,
    conversation_id: Option<String>,
    role_id: Option<String>,
    device_id: Option<String>,
    task_id: Option<String>,
    backend_task_id: Option<i64>,
    available: i32,
    source_created_at: NaiveDateTime,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ParticipationReference {
    kind: String,
    id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AssistantParticipation {
    id: String,
    project_id: String,
    issue_id: String,
    owner_user_id: i32,
    owner_display_name: Option<String>,
    role_id: String,
    endpoint_ref: String,
    conversation_id: Option<String>,
    source: ParticipationReference,
    workroom_ref: Option<ParticipationReference>,
    trace_ref: Option<String>,
    history_state: String,
    audit_source: String,
}

#[brz_http_server::get("/api/v1/loop-items/:item_id/assistant-participations")]
async fn list_assistant_participations(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] user: FlexibleUser,
) -> Result<Vec<AssistantParticipation>, FastApiError> {
    let item = accessible_item(state, item_id, user.id).await?;
    participation_snapshot(state, &item, user.id)
        .await
        .map(|(records, _)| records)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParticipationWorkroom {
    participation: AssistantParticipation,
    #[serde(flatten)]
    target: ParticipationTarget,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParticipationTarget {
    runtime_address: Option<Value>,
    backend_task: Option<BackendTaskSource>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendTaskSource {
    task_id: i64,
    execution_url: String,
}

#[brz_http_server::get("/api/v1/loop-items/:item_id/assistant-participations/:participation_id")]
async fn read_assistant_participation(
    #[inject(state)] state: &AppState,
    item_id: &str,
    participation_id: &str,
    #[auth] user: FlexibleUser,
) -> Result<ParticipationWorkroom, FastApiError> {
    let item = accessible_item(state, item_id, user.id).await?;
    let (records, addresses) = participation_snapshot(state, &item, user.id).await?;
    if let Some(participation) = records
        .into_iter()
        .find(|record| record.id == participation_id)
    {
        let target = addresses
            .get(participation_id)
            .filter(|(owner, _)| *owner == user.id)
            .map(|(_, target)| target.clone())
            .unwrap_or_default();
        return Ok(ParticipationWorkroom {
            participation,
            target,
        });
    }
    Err(HttpError::todo_not_found().into())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackfillRequest {
    #[serde(default = "default_dry_run")]
    dry_run: bool,
}

fn default_dry_run() -> bool {
    true
}

impl Default for BackfillRequest {
    fn default() -> Self {
        Self { dry_run: true }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackfillResponse {
    dry_run: bool,
    created: usize,
    existing: usize,
    items: Vec<AssistantParticipation>,
}

#[brz_http_server::post("/api/v1/loop-items/:item_id/assistant-participations/backfill")]
async fn backfill_assistant_participations(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] user: FlexibleUser,
    body: Value,
) -> Result<BackfillResponse, FastApiError> {
    let request: BackfillRequest = serde_json::from_value(body).map_err(|_| {
        FastApiError::detail(
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid backfill body",
        )
    })?;
    backfill_item(state, user.id, item_id, request.dry_run).await
}

async fn backfill_item(
    state: &AppState,
    user_id: i32,
    item_id: &str,
    dry_run: bool,
) -> Result<BackfillResponse, FastApiError> {
    let item = accessible_item(state, item_id, user_id).await?;
    let role = project_role(state, item_id, user_id).await?;
    let owners = if has_permission(&role, "Maintainer") {
        source_owner_ids(&state.mysql, &item.cloud_project_id, item_id)
            .await
            .map_err(HttpError::internal)?
    } else {
        vec![user_id]
    };
    let mut sources = Vec::new();
    for owner in &owners {
        sources.extend(
            participation_sources(&state.mysql, &item.cloud_project_id, item_id, *owner)
                .await
                .map_err(HttpError::internal)?,
        );
    }
    let names = owner_names(&state.mysql, &owners.into_iter().collect::<BTreeSet<_>>())
        .await
        .map_err(HttpError::internal)?;
    verify_managed_sources(state, &mut sources).await?;
    let pairs = project_source_pairs(
        &item.cloud_project_id,
        item_id,
        sources.clone(),
        &names,
        user_id,
    );
    let items = pairs
        .iter()
        .map(|(_, participation)| participation.clone())
        .collect::<Vec<_>>();
    if dry_run {
        let existing = existing_participation_count(&state.mysql, &items)
            .await
            .map_err(HttpError::internal)?;
        return Ok(BackfillResponse {
            dry_run: true,
            created: items.len() - existing,
            existing,
            items,
        });
    }
    let (created, existing) = state
        .mysql
        .with_transaction(async |tx| {
            let mut created = 0;
            let mut existing = 0;
            for (source, participation) in &pairs {
                // Persist canonical references, independently of the backfill caller.
                let canonical = participation_from_source(&item.cloud_project_id, item_id, source, &names, source.owner_user_id);
                let metadata = json!({
                    "project_id": participation.project_id,
                    "issue_id": participation.issue_id,
                    "owner_user_id": participation.owner_user_id,
                    "owner_display_name": participation.owner_display_name,
                    "role_id": participation.role_id,
                    "endpoint_ref": participation.endpoint_ref,
                    "conversation_id": canonical.conversation_id,
                    "source": participation.source,
                    "workroom_ref": participation.workroom_ref,
                    "trace_ref": participation.trace_ref,
                    "history_state": participation.history_state,
                    "audit_source": participation.audit_source,
                    "source_created_at": source.source_created_at.format("%Y-%m-%dT%H:%M:%S%.f").to_string(),
                });
                let present: Option<(String, Json<Value>)> = tx
                    .fetch_optional(
                        "SELECT id,metadata FROM loop_items WHERE id=? AND resource_type='assistant_participation'",
                        (participation.id.as_str(),),
                    )
                    .await?;
                if let Some((_, Json(mut stored))) = present {
                    let state_changed =
                        stored.get("history_state").and_then(Value::as_str)
                            != Some(participation.history_state.as_str())
                            || stored
                                .get("trace_ref")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                != participation.trace_ref;
                    if state_changed {
                        stored["history_state"] = json!(participation.history_state);
                        stored["trace_ref"] = json!(participation.trace_ref);
                        tx.execute(
                            "UPDATE loop_items SET metadata=?, version=version+1, updated_at=UTC_TIMESTAMP(6) WHERE id=? AND resource_type='assistant_participation'",
                            (Json(stored), participation.id.as_str()),
                        )
                        .await?;
                    }
                    existing += 1;
                } else {
                    crate::background_jobs::project::store::insert_once(
                        tx,
                        "assistant_participation",
                        json!({
                            "id": participation.id,
                            "cloud_project_id": participation.project_id,
                            "loop_item_id": participation.issue_id,
                            "user_id": participation.owner_user_id,
                            "title": format!("{} participation", source.source_kind),
                            "status": "active",
                            "metadata": metadata,
                        }),
                    )
                    .await?;
                    created += 1;
                }
            }
            Ok((created, existing))
        })
        .await
        .map_err(HttpError::internal)?;
    Ok(BackfillResponse {
        dry_run: false,
        created,
        existing,
        items,
    })
}

#[brz_http_server::post("/api/v1/cloud-projects/:project_id/assistant-participations/backfill")]
async fn backfill_project_assistant_participations(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] user: FlexibleUser,
    body: Value,
) -> Result<BackfillResponse, FastApiError> {
    let request: BackfillRequest = serde_json::from_value(body).map_err(|_| {
        FastApiError::detail(
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid backfill body",
        )
    })?;
    let access = crate::cloud_projects::project_access(
        &state.mysql,
        crate::cloud_projects::parse_project_id(project_id)?,
        user.id,
    )
    .await
    .map_err(HttpError::internal)?
    .ok_or_else(HttpError::cloud_project_not_found)?;
    let role = crate::cloud_projects::role_for_priority(access.1)
        .ok_or_else(HttpError::insufficient_permission)?;
    if !has_permission(role, "Maintainer") {
        return Err(HttpError::insufficient_permission().into());
    }
    #[derive(FromMysqlRow)]
    struct Issue {
        id: String,
    }
    let issues: Vec<Issue> = state
        .mysql
        .fetch_all(
            "SELECT id FROM loop_items WHERE resource_type='task' AND cloud_project_id=? \
             AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) \
             ORDER BY sequence_number,id",
            (project_id,),
        )
        .await
        .map_err(HttpError::internal)?;
    let mut response = BackfillResponse {
        dry_run: request.dry_run,
        created: 0,
        existing: 0,
        items: Vec::new(),
    };
    for issue in issues {
        let result = backfill_item(state, user.id, &issue.id, request.dry_run).await?;
        response.created += result.created;
        response.existing += result.existing;
        response.items.extend(result.items);
    }
    Ok(response)
}

async fn project_role(
    state: &AppState,
    item_id: &str,
    user_id: i32,
) -> Result<String, FastApiError> {
    let item = LoopItemRepository::new(&state.mysql)
        .get_task_item_entity(item_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::todo_not_found)?;
    let project_id = item
        .cloud_project_id
        .parse::<i64>()
        .map_err(|_| HttpError::cloud_project_not_found())?;
    let access = crate::cloud_projects::project_access(&state.mysql, project_id, user_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;
    crate::cloud_projects::role_for_priority(access.1)
        .map(str::to_string)
        .ok_or_else(|| HttpError::insufficient_permission().into())
}

async fn source_owner_ids<M: Mysql>(
    mysql: &M,
    project: &str,
    issue: &str,
) -> MysqlResult<Vec<i32>> {
    #[derive(FromMysqlRow)]
    struct Owner {
        owner_user_id: i32,
    }
    let rows: Vec<Owner> = mysql
        .fetch_all(
            "SELECT DISTINCT task_user_id AS owner_user_id FROM loop_items \
               WHERE resource_type='execution' AND cloud_project_id=? AND loop_item_id=? AND task_user_id>0 \
             UNION \
             SELECT DISTINCT executor_owner_user_id FROM loop_item_executions \
               WHERE cloud_project_id=? AND loop_item_id=? AND executor_owner_user_id>0 \
             UNION \
             SELECT DISTINCT COALESCE( \
               CASE WHEN JSON_TYPE(JSON_EXTRACT(m.metadata,'$.stand_in.user_id'))='INTEGER' \
                 THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.stand_in.user_id')) AS SIGNED) END, \
               a.created_by_user_id, CAST(t.sender_id AS SIGNED)) AS owner_user_id \
               FROM project_chat_messages m \
               LEFT JOIN project_chat_messages t ON t.message_id=m.trigger_message_id \
                 AND t.project_id=m.project_id AND t.task_id=m.task_id AND t.sender_type='user' \
               LEFT JOIN loop_items a ON a.id=m.agent_id AND a.cloud_project_id=m.project_id \
                 AND a.resource_type='chat_agent' \
               WHERE m.project_id=? AND m.task_id=? AND m.sender_type='agent' \
                 AND COALESCE( \
                   CASE WHEN JSON_TYPE(JSON_EXTRACT(m.metadata,'$.stand_in.user_id'))='INTEGER' \
                     THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.stand_in.user_id')) AS SIGNED) END, \
                   a.created_by_user_id, CAST(t.sender_id AS SIGNED), 0) > 0 \
             ORDER BY owner_user_id",
            (project, issue, project, issue, project, issue),
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.owner_user_id).collect())
}

async fn existing_participation_count<M: Mysql>(
    mysql: &M,
    items: &[AssistantParticipation],
) -> MysqlResult<usize> {
    if items.is_empty() {
        return Ok(0);
    }
    #[derive(FromMysqlRow)]
    struct Count {
        count: i64,
    }
    let placeholders = vec!["?"; items.len()].join(",");
    let args = items
        .iter()
        .map(|item| crate::sql_support::StatementArg::Str(item.id.clone()))
        .collect::<Vec<_>>();
    let row: Count = mysql
        .fetch_one(
            format!(
                "SELECT COUNT(*) AS count FROM loop_items WHERE resource_type='assistant_participation' AND id IN ({placeholders})"
            ),
            args,
        )
        .await?;
    Ok(row.count as usize)
}

async fn accessible_item(
    state: &AppState,
    item_id: &str,
    user_id: i32,
) -> Result<super::loop_repository::TaskItemFullRow, FastApiError> {
    super::assignments::ensure_shadow(state, item_id, user_id).await?;
    let item = LoopItemRepository::new(&state.mysql)
        .get_task_item_entity(item_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::todo_not_found)?;
    require_item_access(state, &item, user_id).await?;
    Ok(item)
}

async fn participation_sources<M: Mysql>(
    mysql: &M,
    project: &str,
    issue: &str,
    owner: i32,
) -> MysqlResult<Vec<ParticipationSource>> {
    // Declare one text type for each UNION column. Historical table and connection
    // collations may differ. UNION ALL preserves every identifier without comparing
    // it; a text collation also keeps the driver from treating strings as bytes.
    mysql
        .fetch_all(
            "SELECT CONVERT('binding' USING utf8mb4) COLLATE utf8mb4_unicode_ci AS source_kind, \
               CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS source_id, task_user_id AS owner_user_id, \
               CONVERT(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.stand_in_conversation_id')),'null'), task_id) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS conversation_id, \
               CAST(NULL AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS role_id, \
               CONVERT(device_id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS device_id, \
               CONVERT(task_id USING utf8mb4) COLLATE utf8mb4_unicode_ci AS task_id, \
               CASE WHEN device_id<>'' AND task_id<>'' THEN 1 ELSE 0 END AS available, created_at AS source_created_at, NULLIF(backend_task_id,0) AS backend_task_id \
             FROM loop_items WHERE resource_type='execution' AND cloud_project_id=? \
               AND loop_item_id=? AND task_user_id=? \
               AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) \
             UNION ALL \
             SELECT 'execution', CAST(id AS CHAR), executor_owner_user_id, NULL, \
               COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(execution_payload,'$.origin_context.standInId')),'null'), \
                 NULLIF(JSON_UNQUOTE(JSON_EXTRACT(execution_payload,'$.dispatch_request.standInId')),'null')) AS role_id, \
               runtime_device_id, runtime_task_id, \
               CASE WHEN runtime_device_id<>'' AND runtime_task_id<>'' THEN 1 ELSE 0 END AS available, created_at, NULLIF(backend_task_id,0) \
             FROM loop_item_executions WHERE cloud_project_id=? AND loop_item_id=? \
               AND executor_owner_user_id=? \
             UNION ALL \
             SELECT 'message', m.message_id, ?, NULLIF(m.runtime_task_id,'') AS conversation_id, \
               NULLIF(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.stand_in.role_id')),'null') AS role_id, \
               m.runtime_device_id, m.runtime_task_id, \
               CASE WHEN m.runtime_device_id<>'' AND m.runtime_task_id<>'' THEN 1 ELSE 0 END AS available, m.created_at, \
               CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.backend_task_id')),'null') AS SIGNED) \
             FROM project_chat_messages m \
               LEFT JOIN project_chat_messages t ON t.message_id=m.trigger_message_id \
                 AND t.project_id=m.project_id AND t.task_id=m.task_id AND t.sender_type='user' \
               LEFT JOIN loop_items a ON a.id=m.agent_id AND a.cloud_project_id=m.project_id \
                 AND a.resource_type='chat_agent' \
             WHERE m.project_id=? AND m.task_id=? \
               AND (m.deleted_at IS NULL OR m.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) \
               AND m.sender_type='agent' AND COALESCE( \
                   CASE WHEN JSON_TYPE(JSON_EXTRACT(m.metadata,'$.stand_in.user_id'))='INTEGER' \
                     THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.stand_in.user_id')) AS UNSIGNED) END, \
                   a.created_by_user_id, CAST(t.sender_id AS UNSIGNED))=?",
            (
                project,
                issue,
                owner,
                project,
                issue,
                owner,
                owner,
                project,
                issue,
                owner,
            ),
        )
        .await
}

async fn owner_names<M: Mysql>(
    mysql: &M,
    owners: &BTreeSet<i32>,
) -> MysqlResult<BTreeMap<i32, String>> {
    if owners.is_empty() {
        return Ok(BTreeMap::new());
    }
    #[derive(FromMysqlRow)]
    struct User {
        id: i32,
        user_name: String,
    }
    let placeholders = vec!["?"; owners.len()].join(",");
    let args = owners
        .iter()
        .map(|id| crate::sql_support::StatementArg::Int(i64::from(*id)))
        .collect::<Vec<_>>();
    let rows: Vec<User> = mysql
        .fetch_all(
            format!("SELECT id,user_name FROM users WHERE id IN ({placeholders})"),
            args,
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|user| (user.id, user.user_name))
        .collect())
}

async fn participation_snapshot(
    state: &AppState,
    item: &super::loop_repository::TaskItemFullRow,
    viewer_user_id: i32,
) -> Result<
    (
        Vec<AssistantParticipation>,
        BTreeMap<String, (i32, ParticipationTarget)>,
    ),
    FastApiError,
> {
    let owners = source_owner_ids(&state.mysql, &item.cloud_project_id, &item.id)
        .await
        .map_err(HttpError::internal)?;
    let stored = stored_participations(&state.mysql, &item.cloud_project_id, &item.id)
        .await
        .map_err(HttpError::internal)?;
    let mut sources = Vec::new();
    for owner in &owners {
        sources.extend(
            participation_sources(&state.mysql, &item.cloud_project_id, &item.id, *owner)
                .await
                .map_err(HttpError::internal)?,
        );
    }
    let owner_ids = owners
        .into_iter()
        .chain(stored.iter().map(|record| record.owner_user_id))
        .collect::<BTreeSet<_>>();
    let names = owner_names(&state.mysql, &owner_ids)
        .await
        .map_err(HttpError::internal)?;
    verify_managed_sources(state, &mut sources).await?;
    let dynamic = project_source_pairs(
        &item.cloud_project_id,
        &item.id,
        sources,
        &names,
        viewer_user_id,
    );
    let mut records = stored
        .into_iter()
        .map(|record| (record.id.clone(), record))
        .collect::<BTreeMap<_, _>>();
    let mut addresses = BTreeMap::new();
    for (source, participation) in dynamic {
        addresses.insert(
            participation.id.clone(),
            (source.owner_user_id, participation_target(&source)),
        );
        records.insert(participation.id.clone(), participation);
    }
    for record in records.values_mut() {
        if let Some(name) = names.get(&record.owner_user_id) {
            record.owner_display_name = Some(name.clone());
        }
        record.history_state = match addresses.get(&record.id) {
            None => "history-unavailable".into(),
            Some((owner, target))
                if target.runtime_address.is_some() || target.backend_task.is_some() =>
            {
                if *owner == viewer_user_id {
                    "unverified".into()
                } else {
                    "restricted".into()
                }
            }
            Some(_) => "history-unavailable".into(),
        };
        hide_private_conversation(record, viewer_user_id);
    }
    Ok((records.into_values().collect(), addresses))
}

async fn stored_participations<M: Mysql>(
    mysql: &M,
    project: &str,
    issue: &str,
) -> MysqlResult<Vec<AssistantParticipation>> {
    #[derive(FromMysqlRow)]
    struct Row {
        id: String,
        metadata: Json<Value>,
    }
    let rows: Vec<Row> = mysql
        .fetch_all(
            "SELECT id,COALESCE(metadata,JSON_OBJECT()) AS metadata FROM loop_items \
             WHERE resource_type='assistant_participation' AND cloud_project_id=? AND loop_item_id=? \
               AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) \
             ORDER BY id",
            (project, issue),
        )
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| stored_participation(&row.id, &row.metadata.0, project, issue))
        .collect())
}

fn stored_participation(
    id: &str,
    metadata: &Value,
    project: &str,
    issue: &str,
) -> Option<AssistantParticipation> {
    if metadata["project_id"].as_str()? != project || metadata["issue_id"].as_str()? != issue {
        return None;
    }
    let source =
        serde_json::from_value::<ParticipationReference>(metadata.get("source")?.clone()).ok()?;
    let workroom_ref = metadata
        .get("workroom_ref")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok());
    Some(AssistantParticipation {
        id: id.to_string(),
        project_id: project.to_string(),
        issue_id: issue.to_string(),
        owner_user_id: i32::try_from(metadata["owner_user_id"].as_i64()?).ok()?,
        owner_display_name: metadata["owner_display_name"].as_str().map(str::to_string),
        role_id: metadata["role_id"].as_str()?.to_string(),
        endpoint_ref: metadata["endpoint_ref"].as_str()?.to_string(),
        conversation_id: metadata["conversation_id"].as_str().map(str::to_string),
        source,
        workroom_ref,
        trace_ref: metadata["trace_ref"].as_str().map(str::to_string),
        history_state: "history-unavailable".into(),
        audit_source: metadata["audit_source"]
            .as_str()
            .unwrap_or("unknown")
            .to_string(),
    })
}

fn hide_private_conversation(record: &mut AssistantParticipation, viewer: i32) {
    if record.owner_user_id != viewer {
        record.conversation_id = None;
    }
}

fn project_source_pairs(
    project: &str,
    issue: &str,
    sources: Vec<ParticipationSource>,
    names: &BTreeMap<i32, String>,
    viewer_user_id: i32,
) -> Vec<(ParticipationSource, AssistantParticipation)> {
    let mut records = BTreeMap::new();
    for source in sources {
        let participation =
            participation_from_source(project, issue, &source, names, viewer_user_id);
        records
            .entry(participation.id.clone())
            .or_insert((source, participation));
    }
    records.into_values().collect()
}

fn participation_from_source(
    project: &str,
    issue: &str,
    source: &ParticipationSource,
    names: &BTreeMap<i32, String>,
    viewer_user_id: i32,
) -> AssistantParticipation {
    let role_id = source
        .role_id
        .as_deref()
        .and_then(known_role)
        .or_else(|| {
            source
                .conversation_id
                .as_deref()
                .and_then(role_from_conversation)
        })
        .unwrap_or_else(|| "unknown".to_string());
    let endpoint_ref = endpoint_ref(source, &role_id);
    let identity = serde_json::to_vec(&(
        project,
        issue,
        source.owner_user_id,
        &role_id,
        &endpoint_ref,
        &source.source_kind,
        &source.source_id,
    ))
    .expect("participation identity has only serializable primitives");
    let id = format!("{:x}", Sha256::digest(identity));
    AssistantParticipation {
        id,
        project_id: project.into(),
        issue_id: issue.into(),
        owner_user_id: source.owner_user_id,
        owner_display_name: names.get(&source.owner_user_id).cloned(),
        role_id,
        endpoint_ref: endpoint_ref.clone(),
        conversation_id: (source.owner_user_id == viewer_user_id)
            .then(|| source.conversation_id.clone())
            .flatten(),
        source: ParticipationReference {
            kind: source.source_kind.clone(),
            id: source.source_id.clone(),
        },
        workroom_ref: Some(ParticipationReference {
            kind: "endpoint".into(),
            id: endpoint_ref,
        }),
        trace_ref: source_trace_ref(project, issue, source),
        history_state: if source.available != 1 {
            "history-unavailable".into()
        } else if source.owner_user_id == viewer_user_id {
            "unverified".into()
        } else {
            "restricted".into()
        },
        audit_source: if source.role_id.is_some() {
            "recorded".into()
        } else {
            "unknown".into()
        },
    }
}

fn known_role(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value != "null").then(|| value.to_string())
}

fn role_from_conversation(conversation: &str) -> Option<String> {
    if !conversation.starts_with("stand-in-chat-") {
        return None;
    }
    if conversation.ends_with("-primary") || conversation.ends_with("-primary-collaboration") {
        return Some("@primary".into());
    }
    let (_, role) = conversation.split_once("-role-")?;
    let role = role.strip_suffix("-collaboration").unwrap_or(role);
    (!role.is_empty()).then(|| role.to_string())
}

fn endpoint_ref(source: &ParticipationSource, role_id: &str) -> String {
    format!("runtime:{}:{role_id}", source.owner_user_id)
}

fn source_trace_ref(project: &str, issue: &str, source: &ParticipationSource) -> Option<String> {
    let device = source
        .device_id
        .as_deref()
        .filter(|value| !value.is_empty())?;
    let task = source
        .task_id
        .as_deref()
        .filter(|value| !value.is_empty())?;
    Some(format!(
        "{:x}",
        Sha256::digest(format!("{project}\0{issue}\0{device}\0{task}").as_bytes())
    ))
}

fn runtime_address(source: &ParticipationSource) -> Option<Value> {
    if source.available != 1 {
        return None;
    }
    match (&source.device_id, &source.task_id) {
        (Some(device), Some(task)) if !device.is_empty() && !task.is_empty() => {
            Some(json!({"deviceId":device,"taskId":task}))
        }
        _ => None,
    }
}

fn managed_task_id(source: &ParticipationSource) -> Option<i64> {
    source
        .backend_task_id
        .filter(|id| *id > 0 && source.device_id.as_deref().unwrap_or_default().is_empty())
}

async fn verify_managed_sources(
    state: &AppState,
    sources: &mut [ParticipationSource],
) -> Result<(), FastApiError> {
    for source in sources {
        if let Some(task_id) = managed_task_id(source) {
            let task = crate::task_detail_api::repository::get_active_non_deleted_task(
                state.task_store.as_ref(),
                task_id,
                None,
            )
            .await
            .map_err(HttpError::internal)?;
            source.available =
                i32::from(task.is_some_and(|task| task.user_id == i64::from(source.owner_user_id)));
        }
    }
    Ok(())
}

fn participation_target(source: &ParticipationSource) -> ParticipationTarget {
    let backend_task = managed_task_id(source)
        .filter(|_| source.available == 1)
        .map(|task_id| {
            let origin = crate::config::env_or_dotenv("FRONTEND_URL")
                .unwrap_or_else(|| "http://localhost:3000".into());
            BackendTaskSource {
                task_id,
                execution_url: format!("{}/chat?taskId={task_id}", origin.trim_end_matches('/')),
            }
        });
    ParticipationTarget {
        runtime_address: runtime_address(source),
        backend_task,
    }
}

#[cfg(test)]
#[path = "assistant_participation_tests.rs"]
mod tests;

#[cfg(test)]
mod mysql_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires disposable loopback MySQL; invoked by Backend Rust CI"]
    async fn reads_execution_sources_from_the_deployed_schema() -> anyhow::Result<()> {
        crate::migrations::mysql_tests::isolated(async |mysql| {
            crate::migrations::mysql_tests::seed_collaboration(mysql).await?;
            seed_mixed_sources(mysql).await?;
            for collation in ["utf8mb4_0900_ai_ci", "utf8mb4_unicode_ci", "utf8mb4_bin"] {
                // The fixture owns a single-connection pool, closed before schema cleanup.
                mysql
                    .execute(format!("SET NAMES utf8mb4 COLLATE {collation}"), ())
                    .await?;
                assert_eq!(source_owner_ids(mysql, "1001", "root").await?, vec![7]);
                let sources = participation_sources(mysql, "1001", "root", 7).await?;
                assert_eq!(sources.len(), 3, "{collation}");
                for (kind, task) in [
                    ("binding", "Task-私人"),
                    ("execution", "run"),
                    ("message", "Task-消息"),
                ] {
                    let source = sources
                        .iter()
                        .find(|source| source.source_kind == kind)
                        .unwrap();
                    assert_eq!(source.owner_user_id, 7);
                    assert_eq!(source.task_id.as_deref(), Some(task));
                }
                let binding = sources
                    .iter()
                    .find(|source| source.source_kind == "binding")
                    .unwrap();
                assert_eq!(binding.source_id, "Binding-来源");
                assert_eq!(binding.device_id.as_deref(), Some("Device-设备"));
                let message = sources
                    .iter()
                    .find(|source| source.source_kind == "message")
                    .unwrap();
                assert_eq!(message.role_id.as_deref(), Some("评审"));
                assert!(
                    participation_sources(mysql, "1001", "root", 8)
                        .await?
                        .is_empty()
                );
            }
            Ok(())
        })
        .await
    }

    async fn seed_mixed_sources(mysql: &brz_mysql::MysqlService) -> anyhow::Result<()> {
        mysql.execute("ALTER TABLE loop_item_executions MODIFY runtime_device_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '', MODIFY runtime_task_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT ''", ()).await?;
        mysql.execute("INSERT INTO loop_items (id,resource_type,cloud_project_id,loop_item_id,task_user_id,device_id,task_id,metadata,description,created_at,updated_at) VALUES ('Binding-来源','execution','1001','root',7,'Device-设备','Task-私人','{}','',UTC_TIMESTAMP(),UTC_TIMESTAMP())", ()).await?;
        mysql.execute("INSERT INTO loop_item_executions (loop_item_id,cloud_project_id,executor_owner_user_id,runtime_device_id,runtime_task_id,error_message,execution_payload) VALUES ('root','1001',7,'device','run','','{}')", ()).await?;
        mysql.execute("INSERT INTO project_chat_messages (message_id,project_id,task_id,sender_type,content,runtime_device_id,runtime_task_id,metadata) VALUES ('Message-来源','1001','root','agent','','Device-消息','Task-消息',?)", (Json(json!({"stand_in":{"user_id":7,"role_id":"评审"}})),)).await?;
        Ok(())
    }
}
