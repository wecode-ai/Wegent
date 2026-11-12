//! Account-scoped execution plans reuse the existing generation and latest intent slots.
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
            json!({"enabled":enabled(),"protocolVersion":1,"contractRevision":3,"accountId":i64::from(user.id),"supports":["install","update","uninstall","reconcile"]}),
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
                if !enabled() && !has_instance(tx, i64::from(user.id), &body.instance_id).await? {
                    return Err(coordination_error("LOCAL_SYNC_DISABLED"));
                }
                if body.known_revision.as_deref() == Some(&desired_revision) && body.actual_revision.as_deref() == Some(&desired_revision) && !body.recovery_pending && !body.targeted {
                    return Ok(json!({"enabled":enabled(),"protocolVersion":1,"revision":desired_revision,"unchanged":true,"operation":operation}));
                }
                if body.targeted {
                    let target=operation["installedPluginId"].as_i64().or(body.installed_plugin_id).ok_or_else(||coordination_error("SNAPSHOT_NOT_OWNED"))?;
                    let mut query=&mut *tx;
                    restrict_local_plugin(&mut query,i64::from(user.id),target,&mut payload).await.map_err(|error|match error { super::desired_capabilities::BuildError::Mysql(error)=>error, _=>coordination_error("plugin_write_unavailable") })?;
                }
                let generation = next_generation(tx, i64::from(user.id)).await?;
                payload["plugin_sync"] = json!({"version":2,"generation":generation,"complete":!body.targeted});
                lease.commit_revision(tx, revision).await?;
                Ok(json!({"enabled":enabled(),"protocolVersion":1,"revision":desired_revision,"unchanged":false,"generation":generation,"payload":payload,"operation":operation}))
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
    let rows: Vec<StateRow> = tx.fetch_all("SELECT id,json FROM kinds WHERE user_id=? AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account' AND is_active=1 LIMIT 2", (user,)).await?;
    if rows.len() > 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    let slot = rows
        .first()
        .and_then(|row| row.json["spec"]["localIntents"][instance].as_object())
        .and_then(|slots| slots.values().find(|slot| slot["operationId"] == operation));
    let Some(slot) = slot else {
        return Ok(json!({"operationId":operation,"state":"unknown"}));
    };
    let id = slot["installedId"]
        .as_i64()
        .ok_or_else(|| coordination_error("plugin_write_conflict"))?;
    #[derive(FromMysqlRow)]
    struct Current {
        id: i64,
        json: Value,
        is_active: bool,
    }
    let current:Option<Current> = tx.fetch_optional("SELECT id,json,is_active FROM kinds WHERE id=? AND user_id=? AND kind='InstalledPlugin' AND namespace='default'",(id,user)).await?;
    let matches = current.as_ref().is_some_and(|row| {
        row.json["spec"]["revision"].as_i64().unwrap_or(0)
            == slot["installedRevision"].as_i64().unwrap_or(-1)
            && row.is_active != (slot["action"] == "uninstall")
    });
    let plugin = current.filter(|row| row.is_active).and_then(|row| {
        super::kind_to_item(&super::KindRow {
            id: row.id,
            json: row.json,
        })
    });
    Ok(
        json!({"operationId":operation,"installedPluginId":id,"state":if matches {"intent_saved"} else {"superseded"},"plugin":plugin}),
    )
}

async fn has_instance(
    tx: &mut impl MysqlTransaction,
    user: i64,
    instance: &str,
) -> MysqlResult<bool> {
    let rows:Vec<StateRow>=tx.fetch_all("SELECT id,json FROM kinds WHERE user_id=? AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account' AND is_active=1 LIMIT 2",(user,)).await?;
    if rows.len() > 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    Ok(rows
        .first()
        .is_some_and(|row| row.json["spec"]["localIntentOrders"][instance].is_object()))
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
            "UPDATE kinds SET json = ?, updated_at = NOW() WHERE id = ? AND user_id = ? AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account'",
            (document, row.id, user),
        )
        .await?;
        Ok(generation)
    } else {
        tx.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (?, 'PluginSyncState','plugin-sync','account', ?, true,NOW(),NOW())", (user,json!({"spec":{"generation":1}}))).await?;
        Ok(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_identifiers_and_protocol() {
        assert!(validate(1, "instance:1").is_ok());
        for instance in ["", "../x", " x", "a/b"] {
            assert!(validate(1, instance).is_err());
        }
        assert!(validate(2, "instance").is_err());
    }
}

#[cfg(test)]
#[path = "local_sync_mysql_tests.rs"]
mod mysql_tests;
