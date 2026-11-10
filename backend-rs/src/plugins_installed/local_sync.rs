//! Account-scoped HTTP snapshots and receipts. No Device lookup or Socket RPC.
use super::{
    desired_capabilities::{build_local_plugins, capability_snapshot, restrict_local_plugin},
    write_coordination::{PluginWriteLease, coordination_error, http_error},
};
use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, MysqlError, MysqlResult, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncRequest {
    protocol_version: u32,
    instance_id: String,
    #[serde(default)]
    probe_only: bool,
    known_revision: Option<String>,
    actual_revision: Option<String>,
    operation_id: Option<String>,
    #[serde(default)]
    recovery_pending: bool,
    #[serde(default)]
    targeted: bool,
    installed_plugin_id: Option<i64>,
    #[serde(default)]
    operation_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptRequest {
    protocol_version: u32,
    instance_id: String,
    snapshot_id: String,
    generation: u64,
    result: Value,
}

#[derive(FromMysqlRow)]
struct OperationRow {
    id: i64,
    document: Value,
}
#[derive(FromMysqlRow)]
struct StateRow {
    id: i64,
    json: Value,
}

pub(super) fn enabled() -> bool {
    crate::config::env_or_dotenv("PLUGIN_LOCAL_SYNC_ENABLED")
        .is_some_and(|v| v.eq_ignore_ascii_case("true"))
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
}
fn validate(version: u32, instance: &str) -> Result<(), FastApiError> {
    if version != 1 || !valid_id(instance) {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "LOCAL_SYNC_PROTOCOL_UNSUPPORTED",
        ));
    }
    Ok(())
}
fn hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn map_error(error: MysqlError) -> FastApiError {
    if let MysqlError::InvalidQuery { reason } = &error {
        let status = match reason.as_str() {
            "SNAPSHOT_NOT_OWNED" => Some(StatusCode::FORBIDDEN),
            "SNAPSHOT_EXPIRED" => Some(StatusCode::GONE),
            "INVALID_RECEIPT" => Some(StatusCode::UNPROCESSABLE_ENTITY),
            "LOCAL_SYNC_DISABLED" => Some(StatusCode::CONFLICT),
            _ => None,
        };
        if let Some(status) = status {
            return FastApiError::detail(status, reason);
        }
    }
    http_error(error)
}

#[brz_http_server::post("/api/plugins/local-sync")]
async fn local_sync(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: SyncRequest,
) -> Result<Value, FastApiError> {
    validate(body.protocol_version, &body.instance_id)?;
    if body.operation_ids.len() > 64 || body.operation_ids.iter().any(|id| !valid_id(id)) {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_OPERATION_IDS",
        ));
    }
    if body.installed_plugin_id.is_some_and(|id| id <= 0) {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_INSTALLED_ID",
        ));
    }
    if body.operation_id.as_deref().is_some_and(|id| !valid_id(id)) {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_OPERATION_ID",
        ));
    }
    if body.probe_only {
        return Ok(
            json!({"enabled":enabled(),"protocolVersion":1,"contractRevision":2,"accountId":i64::from(user.id),"supports":["install","update","uninstall","reconcile"],"snapshotTtlSeconds":86400}),
        );
    }
    let mysql = state.mysql.clone();
    let redis = state.redis.clone();
    super::auto_update::complete_auto_update(async move {
        let lease = PluginWriteLease::acquire(redis.as_ref(), i64::from(user.id)).await?;
        let result = async {
            lease.ensure_policy(&mysql).await?;
            tokio::time::timeout_at(lease.deadline, mysql.with_transaction(async |tx| {
                let revision = lease.read_revision(tx).await?;
                let mut query = &mut *tx;
                let mut payload = build_local_plugins(&mut query, i64::from(user.id)).await.map_err(|error| {
                    tracing::error!(%error, "local plugin snapshot failed"); coordination_error("plugin_write_unavailable")
                })?;
                let desired_revision = hash(&capability_snapshot(&payload));
                let operation = read_operation(tx, i64::from(user.id), &body.instance_id, body.operation_id.as_deref()).await?;
                if !enabled() {
                    let accepted: Option<OperationRow> = tx.fetch_optional("SELECT id, document FROM plugin_local_sync_operations WHERE user_id = ? AND instance_id = ? LIMIT 1", (i64::from(user.id), body.instance_id.as_str())).await?;
                    if accepted.is_none() { return Err(coordination_error("LOCAL_SYNC_DISABLED")); }
                }
                if body.known_revision.as_deref() == Some(&desired_revision) && body.actual_revision.as_deref() == Some(&desired_revision) && !body.recovery_pending && !body.targeted {
                    return Ok(json!({"enabled":enabled(),"protocolVersion":1,"revision":desired_revision,"unchanged":true,"operation":operation}));
                }
                if body.targeted {
                    let target=operation["installedPluginId"].as_i64().or(body.installed_plugin_id).ok_or_else(||coordination_error("SNAPSHOT_NOT_OWNED"))?;
                    let mut query=&mut *tx;
                    restrict_local_plugin(&mut query,i64::from(user.id),target,&mut payload).await.map_err(|error|match error { super::desired_capabilities::BuildError::Mysql(error)=>error, _=>coordination_error("plugin_write_unavailable") })?;
                }
                for id in &body.operation_ids {
                    let accepted = read_operation(tx, i64::from(user.id), &body.instance_id, Some(id)).await?;
                    if accepted["state"] == "unknown" { return Err(coordination_error("SNAPSHOT_NOT_OWNED")); }
                    if body.targeted && accepted["installedPluginId"] != operation["installedPluginId"] { return Err(coordination_error("INVALID_RECEIPT")); }
                }
                let generation = next_generation(tx, i64::from(user.id)).await?;
                payload["plugin_sync"] = json!({"version":2,"generation":generation,"complete":!body.targeted});
                let snapshot_id = new_snapshot_id()?;
                let document = json!({"state":"issued","revision":desired_revision,"generation":generation,"payload":payload,"operationIds":body.operation_ids,"operationState":operation["state"],"expiresAt":chrono::Utc::now().timestamp()+86400});
                tx.execute("INSERT INTO plugin_local_sync_operations (user_id, instance_id, operation_id, request_hash, action, installed_id, document, created_at, updated_at) VALUES (?, ?, ?, '', 'snapshot', 0, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))", (i64::from(user.id), body.instance_id.as_str(), snapshot_id.as_str(), document)).await?;
                lease.commit_revision(tx, revision).await?;
                Ok(json!({"enabled":enabled(),"protocolVersion":1,"revision":desired_revision,"unchanged":false,"snapshotId":snapshot_id,"generation":generation,"payload":payload,"operation":operation}))
            })).await.unwrap_or_else(|_| Err(coordination_error("plugin_write_busy")))
        }.await;
        lease.release().await;
        result
    }).await.map_err(map_error)
}

async fn read_operation(
    tx: &mut impl MysqlTransaction,
    user: i64,
    instance: &str,
    operation: Option<&str>,
) -> MysqlResult<Value> {
    let Some(operation) = operation else {
        return Ok(Value::Null);
    };
    #[derive(FromMysqlRow)]
    struct Intent {
        document: Value,
        installed_id: i64,
        action: String,
    }
    let row: Option<Intent> = tx.fetch_optional("SELECT document, installed_id, CAST(action AS CHAR) AS action FROM plugin_local_sync_operations WHERE user_id = ? AND instance_id = ? AND operation_id = ? AND action != 'snapshot'", (user, instance, operation)).await?;
    let Some(row) = row else {
        return Ok(json!({"operationId":operation,"state":"unknown"}));
    };
    #[derive(FromMysqlRow)]
    struct Current {
        json: Value,
        is_active: bool,
    }
    let current: Option<Current> = tx.fetch_optional("SELECT json, is_active FROM kinds WHERE id = ? AND user_id = ? AND kind = 'InstalledPlugin' AND namespace = 'default'", (row.installed_id, user)).await?;
    let matches = current.as_ref().is_some_and(|current| {
        if row.action == "uninstall" {
            return !current.is_active;
        }
        current.is_active
            && ["releaseId", "version", "enabled", "componentStates"]
                .iter()
                .all(|key| current.json["spec"][key] == row.document["plugin"]["spec"][key])
    });
    Ok(
        json!({"operationId":operation,"installedPluginId":row.installed_id,"state":if matches {"intent_saved"} else {"superseded"},"plugin":row.document["plugin"]}),
    )
}

async fn next_generation(tx: &mut impl MysqlTransaction, user: i64) -> MysqlResult<u64> {
    let rows: Vec<StateRow> = tx.fetch_all("SELECT id, json FROM kinds WHERE user_id = ? AND kind = 'PluginSyncState' AND namespace = 'plugin-sync' AND name = 'account' LIMIT 2", (user,)).await?;
    if rows.len() > 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    if let Some(row) = rows.into_iter().next() {
        let mut document = row.json;
        let current_generation = match document.pointer("/spec/generation") {
            None => 0,
            Some(value) => value
                .as_u64()
                .ok_or_else(|| coordination_error("plugin_write_conflict"))?,
        };
        if !document.get("spec").is_some_and(Value::is_object) {
            return Err(coordination_error("plugin_write_conflict"));
        }
        let generation = current_generation
            .checked_add(1)
            .filter(|g| *g < i64::MAX as u64)
            .ok_or_else(|| coordination_error("plugin_write_conflict"))?;
        document["spec"]["generation"] = json!(generation);
        tx.execute(
            "UPDATE kinds SET json = ?, updated_at = NOW() WHERE id = ? AND user_id = ?",
            (document, row.id, user),
        )
        .await?;
        Ok(generation)
    } else {
        tx.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (?, 'PluginSyncState','plugin-sync','account', ?, true,NOW(),NOW())", (user,json!({"spec":{"generation":1}}))).await?;
        Ok(1)
    }
}

#[brz_http_server::post("/api/plugins/local-sync/receipts")]
async fn local_sync_receipts(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: ReceiptRequest,
) -> Result<Value, FastApiError> {
    validate(body.protocol_version, &body.instance_id)?;
    if !valid_id(&body.snapshot_id) {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_RECEIPT",
        ));
    }
    let mysql = state.mysql.clone();
    let redis = state.redis.clone();
    super::auto_update::complete_auto_update(async move {
        let lease = PluginWriteLease::acquire(redis.as_ref(), i64::from(user.id)).await?;
        let result = async {
            lease.ensure_policy(&mysql).await?;
            mysql.with_transaction(async |tx| {
                let revision = lease.read_revision(tx).await?;
                let row: OperationRow = tx.fetch_optional("SELECT id, document FROM plugin_local_sync_operations WHERE user_id = ? AND instance_id = ? AND operation_id = ? AND action = 'snapshot'", (i64::from(user.id), body.instance_id.as_str(), body.snapshot_id.as_str())).await?.ok_or_else(|| coordination_error("SNAPSHOT_NOT_OWNED"))?;
                let mut document = row.document;
                if document["generation"].as_u64() != Some(body.generation) || !valid_receipt(&document["payload"], &body.result) { return Err(coordination_error("INVALID_RECEIPT")); }
                if let Some(previous) = document.get("result") {
                    if previous != &body.result { return Err(coordination_error("INVALID_RECEIPT")); }
                    return Ok(json!({"state":document["state"]}));
                }
                if document["expiresAt"].as_i64().unwrap_or(0) < chrono::Utc::now().timestamp() { return Err(coordination_error("SNAPSHOT_EXPIRED")); }
                let newer: Option<OperationRow> = tx.fetch_optional("SELECT id, document FROM plugin_local_sync_operations WHERE user_id = ? AND instance_id = ? AND action = 'snapshot' AND id > ? LIMIT 1", (i64::from(user.id), body.instance_id.as_str(), row.id)).await?;
                let mut query = &mut *tx;
                let current = build_local_plugins(&mut query, i64::from(user.id)).await.map_err(|_| coordination_error("plugin_write_unavailable"))?;
                let obsolete = document["revision"] != hash(&capability_snapshot(&current));
                let state = if newer.is_some() || obsolete || document["operationState"] == "superseded" { "superseded" } else if body.result["success"] == true { "local_completed" } else { "failed" };
                document["state"] = json!(state);
                document["result"] = body.result;
                tx.execute("UPDATE plugin_local_sync_operations SET document = ?, updated_at = UTC_TIMESTAMP(6) WHERE id = ? AND user_id = ?", (document.clone(), row.id, i64::from(user.id))).await?;
                if document["result"]["success"] == true || document["operationState"] == "superseded" {
                    for operation in document["operationIds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                        tx.execute("UPDATE plugin_local_sync_operations SET document = JSON_SET(document, '$.state', 'reconciled'), updated_at = UTC_TIMESTAMP(6) WHERE user_id = ? AND instance_id = ? AND operation_id = ? AND action != 'snapshot' AND id < ?", (i64::from(user.id), body.instance_id.as_str(), operation, row.id)).await?;
                    }
                }
                lease.commit_revision(tx, revision).await?;
                Ok(json!({"state":state}))
            }).await
        }.await;
        lease.release().await;
        result
    }).await.map_err(map_error)
}

fn valid_receipt(payload: &Value, result: &Value) -> bool {
    if !result["success"].is_boolean()
        || result["plugin_sync"] != payload["plugin_sync"]
        || result["scope"] != payload["scope"]
    {
        return false;
    }
    let Some(items) = result["plugins"].as_array() else {
        return false;
    };
    let Some(expected) = payload["plugins"].as_array() else {
        return false;
    };
    if result["success"] == true
        && items
            .iter()
            .any(|item| !matches!(item["status"].as_str(), Some("synced" | "removed")))
    {
        return false;
    }
    let removed = payload["removed_plugins"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    for item in items {
        let id = item["id"]
            .as_i64()
            .map(|id| id.to_string())
            .or_else(|| item["id"].as_str().map(str::to_owned));
        let Some(id) = id else {
            return false;
        };
        if !seen.insert(id.clone()) || item["generation"] != payload["plugin_sync"]["generation"] {
            return false;
        }
        let target = expected
            .iter()
            .find(|target| target["installed_plugin_id"].to_string().trim_matches('"') == id);
        let status = item["status"].as_str().unwrap_or_default();
        if let Some(target) = target {
            if item["operation"] != "upsert"
                || !matches!(status, "synced" | "failed" | "superseded")
            {
                return false;
            }
            if status == "synced"
                && (item["version"] != target["version"] || item["checksum"] != target["checksum"])
            {
                return false;
            }
        } else {
            let requested = removed
                .iter()
                .any(|target| target["installed_plugin_id"].to_string().trim_matches('"') == id);
            if (!requested && payload["plugin_sync"]["complete"] != true)
                || item["operation"] != "remove"
                || !matches!(status, "removed" | "failed" | "superseded")
            {
                return false;
            }
        }
    }
    expected
        .iter()
        .chain(removed.iter())
        .all(|item| seen.contains(item["installed_plugin_id"].to_string().trim_matches('"')))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delta_removals_require_the_exact_requested_acknowledgement() {
        let payload = json!({"scope":"plugin_delta","plugin_sync":{"version":2,"generation":3,"complete":false},"plugins":[],"removed_plugins":[{"installed_plugin_id":7}]});
        let mut result = json!({"success":true,"scope":"plugin_delta","plugin_sync":payload["plugin_sync"],"plugins":[]});
        assert!(!valid_receipt(&payload, &result));
        result["plugins"] =
            json!([{"id":7,"generation":3,"operation":"remove","status":"removed"}]);
        assert!(valid_receipt(&payload, &result));
        result["plugins"][0]["id"] = json!(8);
        assert!(!valid_receipt(&payload, &result));
    }

    #[test]
    fn validates_identifiers_and_protocol() {
        assert!(validate(1, "instance:1").is_ok());
        for instance in ["", "../x", " x", "a/b"] {
            assert!(validate(1, instance).is_err());
        }
        assert!(validate(2, "instance").is_err());
    }
    #[test]
    fn receipt_cannot_change_target_generation_or_package() {
        let payload = json!({"scope":"plugins","plugin_sync":{"version":2,"generation":3,"complete":true},"plugins":[{"installed_plugin_id":7,"version":"1","checksum":"sha256:abc"}]});
        let mut result = json!({"success":true,"scope":"plugins","plugin_sync":payload["plugin_sync"],"plugins":[{"id":7,"generation":3,"operation":"upsert","status":"synced","version":"1","checksum":"sha256:abc"}]});
        assert!(valid_receipt(&payload, &result));
        result["plugins"][0]["checksum"] = json!("wrong");
        assert!(!valid_receipt(&payload, &result));
        result["plugins"] = json!([]);
        assert!(!valid_receipt(&payload, &result));
    }
}

fn new_snapshot_id() -> MysqlResult<String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| coordination_error("plugin_write_unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(super) async fn enqueue_auto_update(
    tx: &mut impl MysqlTransaction,
    user: i64,
    installed: i64,
    source: Option<&str>,
) -> MysqlResult<()> {
    let instance = source
        .filter(|id| !id.is_empty())
        .map(|id| format!("auto-update:{id}"))
        .unwrap_or_else(|| "auto-update".into());
    tx.execute("INSERT INTO plugin_sync_outbox (user_id, instance_id, installed_id, operation_id, action, state, claim_token, attempt_count, next_attempt_at, lease_until, created_at, updated_at) VALUES (?, ?, ?, ?, 'update', 'pending', '', 0, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))", (user, instance, installed, new_snapshot_id()?)).await?;
    Ok(())
}

#[cfg(test)]
#[path = "local_sync_mysql_tests.rs"]
mod mysql_tests;
