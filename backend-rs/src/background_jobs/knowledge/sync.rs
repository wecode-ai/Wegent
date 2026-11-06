// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Cursor-based external synchronization and source-health probes.

use super::{
    cleanup, import,
    index::enabled,
    sources::{self, SourceError},
    store,
};
use crate::{
    AppState,
    background_jobs::{BackgroundJobRegistry, with_lock_watchdog},
};
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use brz_redis::{Redis, cmd};
use brz_schedule::{HandlerOptions, JobContext};
use chrono::Utc;
use serde_json::{Map, Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub const DAILY: &str = "app.tasks.external_document_sync_tasks.sync_external_documents";
pub const DINGTALK_SCAN: &str = "app.tasks.dingtalk_auto_sync_tasks.scan_dingtalk_copies";
pub const DINGTALK_REFRESH: &str = "app.tasks.dingtalk_auto_sync_tasks.refresh_dingtalk_copy";
pub const XIAOXIN: &str = "app.tasks.xiaoxin_knowledge_tasks.sync_xiaoxin_hr_knowledge";

pub fn register(registry: &mut BackgroundJobRegistry, state: Arc<AppState>) -> Result<()> {
    let copy = state.clone();
    registry.register_with_options(
        DAILY,
        HandlerOptions {
            timeout: Some(Duration::from_secs(3300)),
            retry_delay: Duration::from_secs(30),
            max_retry_delay: Duration::from_secs(30),
        },
        move |context, _| {
            let state = copy.clone();
            async move {
                if !enabled("EXTERNAL_DOC_SYNC_ENABLED", false) {
                    return Ok(brz_schedule::Completion::Success(
                        json!({"status":"disabled"}),
                    ));
                }
                let lease = Duration::from_secs(super::state::seconds(
                    "EXTERNAL_DOC_SYNC_LOCK_TTL_SECONDS",
                    3600,
                ) as u64);
                let report = with_lock_watchdog(
                    &state.background_jobs,
                    &context,
                    "wegent:lock:external-document-sync:daily",
                    lease,
                    daily(&state, &context),
                )
                .await?
                .unwrap_or(json!({"status":"locked"}));
                Ok(brz_schedule::Completion::Success(report))
            }
        },
    )?;
    registry.max_failures(DAILY, 1)?;
    registry.cron(
        DAILY,
        &crate::config::env_or_dotenv("EXTERNAL_DOC_SYNC_CRON")
            .unwrap_or_else(|| "0 21 * * *".into()),
        "UTC",
    )?;
    let copy = state.clone();
    registry.register(DINGTALK_SCAN, move |context, value| {
        let state = copy.clone();
        async move {
            let kb = value.get("knowledge_base_id").and_then(Value::as_i64);
            let key = format!(
                "wegent:lock:scan_dingtalk_copies:{}",
                kb.map(|id| id.to_string()).unwrap_or_else(|| "all".into())
            );
            Ok(with_lock_watchdog(
                &state.background_jobs,
                &context,
                &key,
                Duration::from_secs(3600),
                scan_dingtalk(&state, &context, kb),
            )
            .await?
            .unwrap_or(json!(0)))
        }
    })?;
    registry.max_failures(DINGTALK_SCAN, 1)?;
    if enabled("DINGTALK_SYNC_SCHEDULE_ENABLED", false) {
        registry.cron(DINGTALK_SCAN, "0 2 * * *", "Asia/Shanghai")?;
    }
    let copy = state.clone();
    registry.register(DINGTALK_REFRESH, move |_, value| {
        let state = copy.clone();
        async move {
            let id = value["document_id"]
                .as_i64()
                .context("document_id is required")?;
            let generation = value["expected_generation"]
                .as_i64()
                .context("expected_generation is required")?;
            Ok(json!(refresh_dingtalk(&state, id, generation).await?))
        }
    })?;
    registry.max_failures(DINGTALK_REFRESH, 1)?;
    registry.register(XIAOXIN, move |context, _| {
        let state = state.clone();
        async move {
            if let Some(reason) = xiaoxin_skip() {
                return Ok(json!({"status":"skipped","reason":reason}));
            }
            Ok(with_lock_watchdog(
                &state.background_jobs,
                &context,
                "wegent:lock:sync_xiaoxin_hr_knowledge",
                Duration::from_secs(120),
                submit_xiaoxin(&state),
            )
            .await?
            .unwrap_or(json!({"status":"skipped","reason":"lock_held_by_another_instance"})))
        }
    })?;
    registry.max_failures(XIAOXIN, 1)?;
    registry.cron(XIAOXIN, "0 3 * * *", "Asia/Shanghai")
}

#[derive(FromMysqlRow)]
struct Candidate {
    id: i64,
    index_generation: i64,
}
#[derive(FromMysqlRow)]
struct Current {
    attachment_id: i64,
    index_status: String,
    source_config: Json<Map<String, Value>>,
}

async fn daily(state: &Arc<AppState>, context: &JobContext) -> Result<Value> {
    let redis = state
        .redis
        .as_ref()
        .context("External sync cursor Redis is unavailable")?;
    let key = "external-document-sync:scan-cursor:wiki";
    let raw: Option<String> = redis.get(key).await?;
    let mut cursor = raw
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default()
        .max(0);
    let batch = super::state::seconds("EXTERNAL_DOC_SYNC_SCAN_BATCH_SIZE", 500);
    let maximum = super::state::seconds("EXTERNAL_DOC_SYNC_RUN_MAX_DOCUMENTS", 10000);
    let budget = Duration::from_secs(super::state::seconds(
        "EXTERNAL_DOC_SYNC_TIME_BUDGET_SECONDS",
        2700,
    ) as u64);
    let started = Instant::now();
    let (
        mut scanned,
        mut refreshed,
        mut reindexed,
        mut unchanged,
        mut missing,
        mut skipped,
        mut failed,
    ) = (0, 0, 0, 0, 0, 0, 0);
    while scanned < maximum && started.elapsed() < budget {
        if context.cancellation.is_cancelled() {
            bail!("External document sync cancelled")
        }
        let limit = batch.min(maximum - scanned);
        let rows:Vec<Candidate>=state.mysql.fetch_all("SELECT d.id,d.index_generation FROM knowledge_documents d JOIN knowledge_document_external_sources e ON e.document_id=d.id WHERE d.id>? AND d.source_type='external' AND e.external_provider='wiki' ORDER BY d.id LIMIT ?",(cursor,limit)).await?;
        if rows.is_empty() {
            cursor = 0;
            break;
        }
        for candidate in &rows {
            match inspect_wiki(state, candidate.id, candidate.index_generation).await {
                Ok(Action::Refresh) => refreshed += 1,
                Ok(Action::Reindex) => reindexed += 1,
                Ok(Action::Unchanged) => unchanged += 1,
                Ok(Action::Missing) => missing += 1,
                Ok(Action::Skip) => skipped += 1,
                Err(error) => {
                    failed += 1;
                    tracing::warn!(
                        document_id = candidate.id,
                        error_class = error
                            .downcast_ref::<SourceError>()
                            .map(|error| error.code)
                            .unwrap_or("external_sync_failed"),
                        "external sync document failed"
                    );
                }
            }
            cursor = candidate.id;
            scanned += 1;
        }
        store_cursor(redis, key, cursor).await?;
        if rows.len() < limit as usize {
            cursor = 0;
            break;
        }
    }
    store_cursor(redis, key, cursor).await?;
    Ok(
        json!({"status":"completed","scanned":scanned,"eligible":scanned,"updates_detected":refreshed+reindexed,"refreshed":refreshed,"reindexed":reindexed,"unchanged":unchanged,"source_missing":missing,"skipped":skipped,"failed":failed,"next_cursors":{"wiki":cursor}}),
    )
}

async fn store_cursor(redis: &brz_redis::RedisService, key: &str, cursor: i64) -> Result<()> {
    let mut command = cmd("SET");
    command.arg(key).arg(cursor).arg("EX").arg(8 * 86400);
    let _: String = redis.command(command).await?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Refresh,
    Reindex,
    Unchanged,
    Missing,
    Skip,
}

async fn inspect_wiki(state: &Arc<AppState>, id: i64, generation: i64) -> Result<Action> {
    let identity = sources::identity(state, id)
        .await?
        .context("External source owner is unavailable")?;
    let result = sources::inspect(state, &identity).await;
    let metadata = match result {
        Ok(metadata) => metadata,
        Err(error) => {
            let source = error.downcast_ref::<SourceError>();
            let missing = source.is_some_and(|source| source.unavailable);
            health(
                state,
                &identity,
                generation,
                if missing {
                    "inaccessible"
                } else {
                    "sync_error"
                },
                source
                    .map(|source| source.code)
                    .unwrap_or("external_sync_failed"),
                None,
            )
            .await?;
            return if missing {
                Ok(Action::Missing)
            } else {
                Err(error)
            };
        }
    };
    let version = metadata
        .pointer("/sync/observed_version")
        .filter(|version| !version.is_null() && version.as_str() != Some(""));
    if version.is_none() {
        health(
            state,
            &identity,
            generation,
            "sync_error",
            "external_version_unavailable",
            None,
        )
        .await?;
        return Err(sources::error(
            "external_version_unavailable",
            "External version is unavailable",
            true,
        ));
    }
    let action=state.mysql.with_transaction(async |tx|{
        let row:Option<Current>=tx.fetch_optional("SELECT attachment_id,index_status,COALESCE(NULLIF(source_config,CAST('null' AS JSON)),JSON_OBJECT()) AS source_config FROM knowledge_documents WHERE id=? AND user_id=? AND index_generation=? FOR UPDATE",(id,identity.user_id,generation)).await?;
        let Some(mut row)=row else{return Ok(Action::Skip)};
        let mut external=row.source_config.0.get("external").and_then(Value::as_object).cloned().unwrap_or_default();
        let sync=external.get("sync").cloned().unwrap_or(json!({}));
        let action=wiki_action(&sync,&row.index_status,row.attachment_id,version.expect("version checked"));
        let mut next_sync=sync.as_object().cloned().unwrap_or_default();
        next_sync.insert("last_checked_at".into(),Utc::now().to_rfc3339().into());
        if action!=Action::Skip {
            if let Some(updates)=metadata.get("sync").and_then(Value::as_object){next_sync.extend(updates.clone());}
            next_sync.remove("last_error_code");external.insert("status".into(),"accessible".into());external.insert("last_error".into(),Value::Null);
            if let Some(url)=metadata.get("url"){external.insert("url".into(),url.clone());}
        }
        external.insert("sync".into(),next_sync.into());row.source_config.0.insert("external".into(),external.into());
        tx.execute("UPDATE knowledge_documents SET source_config=?,name=COALESCE(NULLIF(?,''),name),updated_at=NOW() WHERE id=? AND index_generation=?",(Json(&row.source_config.0),metadata["title"].as_str().map(|title|title.chars().take(255).collect::<String>()),id,generation)).await?;
        Ok(action)
    }).await?;
    let scheduled = match action {
        Action::Refresh => refresh(state, id, generation).await?,
        Action::Reindex => import::schedule_index(state, &identity, generation, false).await?,
        _ => true,
    };
    if !scheduled {
        return Ok(Action::Skip);
    }
    Ok(action)
}

fn wiki_action(sync: &Value, status: &str, attachment: i64, version: &Value) -> Action {
    if sync.get("failed_version") == Some(version) && sync["last_error_retryable"] == false {
        return Action::Skip;
    }
    if sync.get("indexed_version") == Some(version) && status == "success" {
        return Action::Unchanged;
    }
    if sync.get("content_version") != Some(version) || attachment == 0 {
        Action::Refresh
    } else {
        Action::Reindex
    }
}

async fn scan_dingtalk(
    state: &Arc<AppState>,
    context: &JobContext,
    kb: Option<i64>,
) -> Result<Value> {
    let mut cursor = 0;
    let mut count = 0;
    loop {
        if context.cancellation.is_cancelled() {
            bail!("DingTalk copy scan cancelled")
        }
        let rows:Vec<Candidate>=state.mysql.fetch_all("SELECT d.id,d.index_generation FROM knowledge_documents d JOIN knowledge_document_external_sources e ON e.document_id=d.id JOIN kinds k ON k.id=d.kind_id WHERE d.id>? AND e.external_provider='dingtalk' AND d.index_status NOT IN ('queued','pending_conversion','converting','indexing') AND k.kind='KnowledgeBase' AND k.is_active=true AND JSON_EXTRACT(k.json,'$.spec.dingtalkAutoSyncEnabled')=true AND (? IS NULL OR d.kind_id=?) ORDER BY d.id LIMIT 100",(cursor,kb,kb)).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            cursor = row.id;
            let value = json!({"document_id":row.id,"expected_generation":row.index_generation});
            if let Err(error) = submit(state, DINGTALK_REFRESH, value, Some(86400)).await {
                tracing::warn!(document_id=row.id,%error,"DingTalk refresh dispatch failed");
            } else {
                count += 1;
            }
        }
    }
    Ok(json!(count))
}

async fn ding_access(state: &AppState, identity: &sources::Identity) -> Result<bool> {
    #[derive(FromMysqlRow)]
    struct ActiveUser {
        id: i64,
    }
    let active: Option<ActiveUser> = state
        .mysql
        .fetch_optional(
            "SELECT id FROM users WHERE id=? AND is_active=true",
            (identity.user_id,),
        )
        .await?;
    if active.is_none_or(|row| row.id != identity.user_id) {
        return Ok(false);
    }
    let kb = crate::knowledge_documents_content::access::knowledge_base_record(
        &state.mysql,
        identity.kind_id,
    )
    .await?;
    let Some(kb) = kb else { return Ok(false) };
    if kb
        .kinds_json
        .to_value()
        .pointer("/spec/dingtalkAutoSyncEnabled")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Ok(false);
    }
    if !crate::knowledge_documents_content::access::knowledge_base_access(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        &kb,
        identity.user_id,
    )
    .await
    .map_err(|_| anyhow::anyhow!("DingTalk knowledge-base access resolution failed"))?
    {
        return Ok(false);
    }
    Ok(
        crate::knowledge_documents_content::access::can_manage_knowledge_base_documents(
            &state.mysql,
            state.redis.as_ref(),
            &state.entity_resolvers,
            identity.kind_id,
            identity.user_id,
        )
        .await?,
    )
}

async fn refresh_dingtalk(state: &Arc<AppState>, id: i64, generation: i64) -> Result<bool> {
    let Some(identity) = sources::identity(state, id)
        .await?
        .filter(|identity| identity.external_provider == "dingtalk")
    else {
        return Ok(false);
    };
    let Some(doc) = store::load(&state.mysql, id).await?.filter(|doc| {
        doc.generation == generation && !super::state::ACTIVE.contains(&doc.index_status.as_str())
    }) else {
        return Ok(false);
    };
    if !ding_access(state, &identity).await? {
        return Ok(false);
    }
    let result = sources::inspect(state, &identity).await;
    if !ding_access(state, &identity).await? {
        return Ok(false);
    }
    let metadata = match result {
        Ok(metadata) => metadata,
        Err(error) => {
            let source = error.downcast_ref::<SourceError>();
            health(
                state,
                &identity,
                generation,
                if source.is_some_and(|source| source.unavailable) {
                    "inaccessible"
                } else {
                    "sync_error"
                },
                source
                    .map(|source| source.code)
                    .unwrap_or("dingtalk_sync_check_failed"),
                None,
            )
            .await?;
            return Ok(false);
        }
    };
    let baseline = doc
        .external()
        .get("source_update_time")
        .cloned()
        .unwrap_or(Value::Null);
    let update = metadata
        .get("source_update_time")
        .filter(|value| !value.is_null());
    let unchanged = (!baseline.is_null() && update.is_none() || update == Some(&baseline))
        && doc.index_status == "success"
        && doc.active
        && doc.attachment_id != 0;
    if !health(
        state,
        &identity,
        generation,
        "accessible",
        "",
        Some(&metadata),
    )
    .await?
    {
        return Ok(false);
    }
    if unchanged {
        return Ok(false);
    }
    refresh(state, id, generation).await
}

async fn health(
    state: &AppState,
    identity: &sources::Identity,
    generation: i64,
    status: &str,
    code: &str,
    metadata: Option<&Value>,
) -> Result<bool> {
    Ok(state.mysql.with_transaction(async |tx|{
        let row:Option<Current>=tx.fetch_optional("SELECT attachment_id,index_status,COALESCE(NULLIF(source_config,CAST('null' AS JSON)),JSON_OBJECT()) AS source_config FROM knowledge_documents WHERE id=? AND user_id=? AND index_generation=? FOR UPDATE",(identity.id,identity.user_id,generation)).await?;
        let Some(mut row)=row else{return Ok(false)};
        if identity.external_provider=="dingtalk"&&super::state::ACTIVE.contains(&row.index_status.as_str()){return Ok(false)}
        if identity.external_provider=="dingtalk"&&!ding_access(state,identity).await.map_err(|_|brz_mysql::MysqlError::InvalidQuery{reason:"DingTalk permission recheck failed".into()})?{return Ok(false)}
        let mut external=row.source_config.0.get("external").and_then(Value::as_object).cloned().unwrap_or_default();
        let mut sync=external.get("sync").and_then(Value::as_object).cloned().unwrap_or_default();sync.insert("last_checked_at".into(),Utc::now().to_rfc3339().into());
        let preserve=status=="sync_error"&&external.get("status").and_then(Value::as_str)==Some("inaccessible")&&identity.external_provider=="dingtalk";
        if !preserve {
            external.insert("status".into(),status.into());
            if code.is_empty(){sync.remove("last_error_code");external.insert("last_error".into(),Value::Null);}else{sync.insert("last_error_code".into(),code.into());external.insert("last_error".into(),if status=="inaccessible"{"External source document no longer exists"}else{"External source synchronization check failed"}.into());}
        }
        if let Some(metadata)=metadata&&let Some(url)=metadata.get("url"){external.insert("url".into(),url.clone());}
        external.insert("sync".into(),sync.into());row.source_config.0.insert("external".into(),external.into());
        tx.execute("UPDATE knowledge_documents SET source_config=?,updated_at=NOW() WHERE id=? AND index_generation=?",(Json(&row.source_config.0),identity.id,generation)).await?;Ok(true)
    }).await?)
}

pub async fn refresh(state: &Arc<AppState>, id: i64, generation: i64) -> Result<bool> {
    let identity = sources::identity(state, id)
        .await?
        .context("External source is unavailable")?;
    let synchronized = identity.external_provider == "wiki" && identity.sync()["enabled"] == true;
    let prepared = store::enqueue(&state.mysql, id, Some(generation), false, synchronized).await?;
    let was_success = prepared.previous_status.as_deref() == Some("success");
    let Some(document) = prepared.document.filter(|_| prepared.accepted) else {
        return Ok(false);
    };
    cleanup::cleanup_replaced(state, document.user_id, prepared.cleanup).await;
    invalidate_refresh(
        &state.mysql,
        id,
        document.generation,
        synchronized,
        was_success,
    )
    .await?;
    if let Err(error) = submit(
        state,
        import::NAME,
        json!({"document_id":id,"expected_generation":document.generation}),
        None,
    )
    .await
    {
        let public = super::state::processing_error(
            "dispatch",
            "external_import_dispatch_failed",
            "The external document import could not be queued. Please retry.",
            document.generation,
            Utc::now(),
        );
        let failure =
            store::fail(&state.mysql, id, document.generation, public, true, false).await?;
        cleanup::cleanup_replaced(state, document.user_id, failure.cleanup).await;
        return Err(error);
    }
    Ok(true)
}

pub(super) async fn invalidate_refresh(
    mysql: &brz_mysql::MysqlService,
    id: i64,
    generation: i64,
    synchronized: bool,
    was_success: bool,
) -> brz_mysql::MysqlResult<()> {
    mysql.with_transaction(async|tx|{
        #[derive(FromMysqlRow)]struct Config{attachment_id:i64,is_active:i8,source_config:Json<Value>}
        let row:Option<Config>=tx.fetch_optional("SELECT attachment_id,is_active,COALESCE(NULLIF(source_config,CAST('null' AS JSON)),JSON_OBJECT()) AS source_config FROM knowledge_documents WHERE id=? AND index_generation=? FOR UPDATE",(id,generation)).await?;
        let Some(row)=row else{return Ok(())};
        let mut config=row.source_config.0;
        if !config["external"].is_object(){config["external"]=json!({});}
        // Preserve Python's previous-status gate; a failed replacement is not
        // evidence that its currently attached body was successfully indexed.
        if !synchronized&&was_success&&row.is_active!=0&&row.attachment_id>0&&config["external"]["last_success_attachment_id"].is_null(){config["external"]["last_success_attachment_id"]=row.attachment_id.into();}
        config["external"]["source_update_time"]=Value::Null;
        tx.execute("UPDATE knowledge_documents SET source_config=?,is_active=IF(?,is_active,false),updated_at=NOW() WHERE id=? AND index_generation=?",(Json(&config),synchronized,id,generation)).await?;
        Ok(())
    }).await
}

async fn submit(state: &AppState, name: &str, value: Value, expires: Option<i64>) -> Result<()> {
    if state.background_jobs.is_enabled(name) {
        // Scan refreshes carry the source's one-day execution deadline.
        state
            .background_jobs
            .submit_with_deadline(
                name,
                value,
                None,
                None,
                expires.map(|seconds| Utc::now() + chrono::Duration::seconds(seconds)),
            )
            .await?;
    } else {
        let redis = state
            .redis
            .as_ref()
            .context("External document task broker is unavailable")?;
        let id = super::super::client::random_id()?;
        state
            .celery
            .dispatch(
                redis,
                &crate::celery_broker::CeleryTask {
                    task_name: name,
                    queue: "wegent_online",
                    task_id: &id,
                    kwargs: value
                        .as_object()
                        .context("External job payload is invalid")?,
                    expires_at: expires
                        .map(|seconds| Utc::now() + chrono::Duration::seconds(seconds)),
                },
            )
            .await?;
    }
    Ok(())
}

fn xiaoxin_skip() -> Option<String> {
    if !enabled("XIAOXIN_SYNC_ENABLED", false) {
        return Some("sync_disabled".into());
    }
    let missing = [
        "XIAOXIN_KNOWLEDGE_PULL_URL",
        "XIAOXIN_SIGN_SECRET",
        "XIAOXIN_TARGET_KB_ID",
        "XIAOXIN_SYNC_USER_ID",
    ]
    .into_iter()
    .filter(|name| {
        crate::config::env_or_dotenv(name).is_none_or(|value| {
            value.trim().is_empty()
                || ((*name == "XIAOXIN_TARGET_KB_ID" || *name == "XIAOXIN_SYNC_USER_ID")
                    && value.parse::<i64>().unwrap_or_default() <= 0)
        })
    })
    .collect::<Vec<_>>();
    (!missing.is_empty()).then(|| format!("missing_configuration:{}", missing.join(",")))
}

async fn submit_xiaoxin(state: &Arc<AppState>) -> Result<Value> {
    let kb: i64 = crate::config::env_or_dotenv("XIAOXIN_TARGET_KB_ID")
        .context("Xiaoxin KB is not configured")?
        .parse()?;
    let user: i64 = crate::config::env_or_dotenv("XIAOXIN_SYNC_USER_ID")
        .context("Xiaoxin owner is not configured")?
        .parse()?;
    let target =
        crate::knowledge_documents_content::access::knowledge_base_record(&state.mysql, kb)
            .await?
            .context("Xiaoxin target knowledge base could not be resolved")?;
    #[derive(FromMysqlRow)]
    struct ActiveUser {
        id: i64,
    }
    let active: Option<ActiveUser> = state
        .mysql
        .fetch_optional(
            "SELECT id FROM users WHERE id=? AND is_active=true",
            (user,),
        )
        .await?;
    if active.is_none_or(|row| row.id != user) {
        bail!("Xiaoxin sync user is unavailable")
    }
    if !crate::knowledge_documents_content::access::knowledge_base_access(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        &target,
        user,
    )
    .await
    .map_err(|_| anyhow::anyhow!("Xiaoxin knowledge-base access resolution failed"))?
    {
        bail!("Xiaoxin sync user cannot access the target knowledge base")
    }
    if !crate::knowledge_documents_content::access::can_manage_knowledge_base_documents(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        kb,
        user,
    )
    .await?
    {
        bail!("Xiaoxin sync user cannot manage the target knowledge base")
    }
    let retrieval = target.kinds_json.to_value();
    let retriever = retrieval
        .pointer("/spec/retrievalConfig/retriever_name")
        .and_then(Value::as_str)
        .context("Xiaoxin target has no retriever")?;
    let embedding = retrieval
        .pointer("/spec/retrievalConfig/embedding_config/model_name")
        .and_then(Value::as_str)
        .context("Xiaoxin target has no embedding model")?;
    super::resources::authorized(
        state,
        kb,
        target.kinds_user_id,
        "index",
        retriever,
        retrieval
            .pointer("/spec/retrievalConfig/retriever_namespace")
            .and_then(Value::as_str)
            .unwrap_or("default"),
        Some((
            embedding,
            retrieval
                .pointer("/spec/retrievalConfig/embedding_config/model_namespace")
                .and_then(Value::as_str)
                .unwrap_or("default"),
        )),
    )
    .await?;
    let id=state.mysql.with_transaction(async|tx|{
        #[derive(FromMysqlRow)]struct Target{#[mysql(rename="id")]_id:i64}
        tx.fetch_optional::<_,_,Target>("SELECT id FROM kinds WHERE id=? AND kind='KnowledgeBase' AND is_active=true FOR UPDATE",(kb,)).await?.ok_or_else(||brz_mysql::MysqlError::InvalidQuery{reason:"Xiaoxin target is no longer active".into()})?;
        let existing:Option<Candidate>=tx.fetch_optional("SELECT d.id,d.index_generation FROM knowledge_documents d JOIN knowledge_document_external_sources e ON e.document_id=d.id WHERE e.kind_id=? AND e.external_provider='xiaoxin' AND e.external_resource_id='HR'",(kb,)).await?;
        if let Some(existing)=existing{return Ok((existing.id,Some(existing.index_generation)))}
        let row=tx.execute("INSERT INTO knowledge_documents (kind_id,attachment_id,name,file_extension,file_size,status,user_id,is_active,index_status,index_generation,splitter_config,source_type,source_config,origin,folder_id,created_at,updated_at) VALUES (?,0,'FAQ.md','md',0,'disabled',?,false,'queued',0,JSON_OBJECT(),'external',?,'user',0,NOW(),NOW())",(kb,user,Json(json!({"external":{"provider":"xiaoxin","resource_id":"HR","domain":"HR","title":"FAQ.md"}})))).await?;
        let id=row.last_insert_id as i64;
        tx.execute("INSERT INTO knowledge_document_external_sources (document_id,kind_id,external_provider,external_resource_id) VALUES (?,?,'xiaoxin','HR')",(id,kb)).await?;
        update_document_count(tx,kb).await?;
        Ok((id,None))
    }).await?;
    if let Some(generation) = id.1 {
        refresh(state, id.0, generation).await?;
    } else {
        submit(
            state,
            import::NAME,
            json!({"document_id":id.0,"expected_generation":0}),
            None,
        )
        .await?;
    }
    Ok(json!({"status":"submitted","knowledge_base_id":kb,"document_id":id.0}))
}

pub(super) async fn update_document_count<T: MysqlTransaction>(
    tx: &mut T,
    kb: i64,
) -> brz_mysql::MysqlResult<()> {
    tx.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec',JSON_SET(COALESCE(NULLIF(JSON_EXTRACT(json,'$.spec'),CAST('null' AS JSON)),JSON_OBJECT()),'$.document_count',(SELECT COUNT(*) FROM knowledge_documents WHERE kind_id=?))),updated_at=NOW() WHERE id=? AND kind='KnowledgeBase'",(kb,kb)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_nonretryable_version_is_not_fetched_again() {
        let sync =
            json!({"failed_version":"v2","last_error_retryable":false,"content_version":"v1"});
        assert_eq!(wiki_action(&sync, "failed", 7, &json!("v2")), Action::Skip);
        assert_eq!(
            wiki_action(&sync, "failed", 7, &json!("v3")),
            Action::Refresh
        );
    }
    #[test]
    fn matching_body_without_index_reuses_body() {
        let sync = json!({"content_version":"v2","indexed_version":"v1"});
        assert_eq!(
            wiki_action(&sync, "failed", 7, &json!("v2")),
            Action::Reindex
        );
        assert_eq!(
            wiki_action(&json!({"indexed_version":"v2"}), "success", 7, &json!("v2")),
            Action::Unchanged
        );
    }
}
