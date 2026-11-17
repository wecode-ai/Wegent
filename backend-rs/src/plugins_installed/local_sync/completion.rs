//! Materialize successful Native HTTP execution without another Socket round trip.
use super::*;
use crate::plugins_installed::{
    plugin_sync_protocol, record_sync_result,
    write_coordination::{PluginWriteLease, business_revision},
};
use crate::plugins_marketplace::db::{InstalledKindRow, KIND_COLUMNS};
use brz_mysql::Mysql;
use brz_redis::Redis;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Completion {
    device_id: String,
    generation: i64,
    installed_revisions: BTreeMap<i64, i64>,
    result: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompletionRequest {
    protocol_version: u32,
    instance_id: String,
    completion: Completion,
}

#[brz_http_server::post("/api/plugins/local-sync/complete")]
async fn complete(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: CompletionRequest,
) -> Result<Value, FastApiError> {
    validate(body.protocol_version, &body.instance_id)?;
    let mysql = state.mysql.clone();
    let redis = state.redis.clone();
    crate::plugins_installed::auto_update::complete_auto_update(async move {
        record(&mysql, redis.as_ref(), i64::from(user.id), body.completion).await
    })
    .await
    .map_err(map_error)
}

pub(super) async fn record<M: Mysql, R: Redis + Sync>(
    mysql: &M,
    redis: Option<&R>,
    user_id: i64,
    completion: Completion,
) -> MysqlResult<Value> {
    if !valid_id(&completion.device_id)
        || completion.generation <= 0
        || completion.result["success"] != true
    {
        return Err(coordination_error("INVALID_LOCAL_COMPLETION"));
    }
    let mut query = mysql;
    let device = crate::device_identity::resolve_owned_device_alias_on(
        &mut query,
        user_id,
        &completion.device_id,
    )
    .await?
    .ok_or_else(|| coordination_error("SNAPSHOT_NOT_OWNED"))?;
    let device_id = crate::device_identity::record_route_id(&device);
    let mut items = completion.result["plugins"]
        .as_array()
        .cloned()
        .ok_or_else(|| coordination_error("INVALID_LOCAL_COMPLETION"))?;
    if completion.result["plugin_sync"]["complete"] == true {
        #[derive(FromMysqlRow)]
        struct Removed {
            installed_kind_id: i64,
        }
        let rows: Vec<Removed> = query.fetch_all(
            "SELECT installed_kind_id FROM plugin_device_installations WHERE user_id=? AND device_id=?",
            (user_id, device_id.as_str()),
        ).await?;
        for row in rows {
            if completion
                .installed_revisions
                .contains_key(&row.installed_kind_id)
                && !items
                    .iter()
                    .any(|item| item["id"].as_i64() == Some(row.installed_kind_id))
            {
                items.push(json!({"id":row.installed_kind_id,"status":"removed"}));
            }
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    for item in &items {
        let id = item["id"]
            .as_i64()
            .filter(|id| *id > 0)
            .ok_or_else(|| coordination_error("INVALID_LOCAL_COMPLETION"))?;
        if !seen.insert(id) || !matches!(item["status"].as_str(), Some("synced" | "removed")) {
            return Err(coordination_error("INVALID_LOCAL_COMPLETION"));
        }
    }
    let mut recorded = Vec::new();
    let mut superseded = Vec::new();
    for item in items {
        let id = item["id"].as_i64().expect("Validated completion ID");
        let accepted =
            record_one(mysql, redis, user_id, &device_id, &completion, id, &item).await?;
        if accepted {
            recorded.push(id);
        } else {
            superseded.push(id);
        }
    }
    Ok(json!({"recorded":recorded,"superseded":superseded}))
}

async fn record_one<M: Mysql, R: Redis + Sync>(
    mysql: &M,
    redis: Option<&R>,
    user_id: i64,
    device_id: &str,
    completion: &Completion,
    id: i64,
    item: &Value,
) -> MysqlResult<bool> {
    let lease = PluginWriteLease::acquire_installed(mysql, redis, user_id, Some(&[id])).await?;
    let outcome = plugin_sync_protocol::retry_sync_write(|| mysql.with_transaction_options(
        MysqlTransactionOptions::default().with_isolation_level(MysqlIsolationLevel::ReadCommitted),
        async |tx| {
            let revisions = lease.read_plugin_revisions(tx).await?;
            let mut query = &mut *tx;
            if crate::device_identity::resolve_owned_device_alias_on(&mut query, user_id, device_id).await?.is_none() {
                return Err(coordination_error("SNAPSHOT_NOT_OWNED"));
            }
            let installed: Option<InstalledKindRow> = query.fetch_optional(
                format!("SELECT {KIND_COLUMNS} FROM kinds WHERE id=? AND user_id=? AND kind='InstalledPlugin' AND namespace='default'"),
                (id, user_id),
            ).await?;
            let Some(installed) = installed else {
                tracing::info!(user_id, installed_id=id, device_id, "Local plugin completion has no owned installation");
                return Ok(false);
            };
            let revision = business_revision(&installed.json.0.to_value())?;
            if completion.installed_revisions.get(&id) != Some(&revision)
                || installed.is_active != (item["status"] == "synced")
            {
                tracing::info!(user_id, installed_id=id, device_id, generation=completion.generation,
                    expected_revision=?completion.installed_revisions.get(&id), current_revision=revision,
                    active=installed.is_active, status=?item["status"].as_str(),
                    "Local plugin completion superseded by current intent");
                return Ok(false);
            }
            let state = plugin_sync_protocol::lock_plugin_sync_state(&mut query, user_id).await?;
            let watermark = plugin_sync_protocol::plugin_snapshot_watermark(&state.json, device_id, id);
            let latest = state.json["spec"]["generation"].as_i64().unwrap_or(0);
            if completion.generation > latest {
                tracing::info!(user_id, installed_id=id, device_id, generation=completion.generation, latest,
                    "Local plugin completion has an unissued generation");
                return Ok(false);
            }
            if completion.generation <= watermark {
                let row: Option<crate::device_identity::PluginDeviceInstallationRow> = query.fetch_optional(
                    crate::plugins_installed::report::DEVICE_ROW_QUERY, (id, device_id),
                ).await?;
                let release = installed.json.0.to_value()["spec"]["releaseId"].as_i64().unwrap_or(0);
                let matches = if installed.is_active {
                    row.is_some_and(|row| row.state == "installed" && row.actual_release_id == release && row.desired_release_id == release)
                } else { row.is_none() };
                if matches { return Ok(true); }
                // Dispatch advances the watermark before the device executes.
                // The unchanged business revision fences semantic supersession;
                // another queued delivery cannot invalidate actual materialization.
            }
            let mut result = record_sync_result::SyncResult::from_ack(device_id, &completion.result);
            result.plugins = vec![record_sync_result::SyncItem::from_value(item)];
            record_sync_result::record_local_completion(&mut query, user_id, &installed, &result, completion.generation, &state, &lease).await?;
            lease.commit_plugin_revisions(tx, revisions).await?;
            Ok(true)
        },
    )).await;
    lease.release().await;
    outcome
}
