//! Account-scoped execution plans reuse the existing generation and latest intent slots.
use super::{
    desired_capabilities::{build_local_plugins, capability_snapshot, restrict_local_plugin},
    write_coordination::{coordination_error, http_error},
};
use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};
use brz_http_server::StatusCode;
use brz_mysql::{
    FromMysqlRow, MysqlError, MysqlIsolationLevel, MysqlResult, MysqlTransaction,
    MysqlTransactionOptions,
};
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
        super::plugin_sync_protocol::ensure_sync_state(&mysql, redis.as_ref(), i64::from(user.id))
            .await?;
        super::plugin_sync_protocol::retry_sync_write(
            super::plugin_sync_protocol::SNAPSHOT_WRITE_ATTEMPTS,
            || {
                mysql.with_transaction_options(
                    MysqlTransactionOptions::default()
                        .with_isolation_level(MysqlIsolationLevel::ReadCommitted),
                    async |tx| local_plan(tx, i64::from(user.id), &body).await,
                )
            },
        )
        .await
    })
    .await
    .map_err(map_error)
}

async fn local_plan(
    tx: &mut impl MysqlTransaction,
    user_id: i64,
    body: &SyncRequest,
) -> MysqlResult<Value> {
    use super::plugin_sync_protocol::{lock_plugin_sync_state, write_sync_state_document};
    let mut query = &mut *tx;
    let state = lock_plugin_sync_state(&mut query, user_id).await?;
    let operation =
        read_operation(tx, user_id, &body.instance_id, body.operation_id.as_deref()).await?;
    if !enabled() && !has_instance(tx, user_id, &body.instance_id).await? {
        return Err(coordination_error("LOCAL_SYNC_DISABLED"));
    }
    let mut query = &mut *tx;
    let mut payload = if body.targeted {
        let target = operation["installedPluginId"]
            .as_i64()
            .or(body.installed_plugin_id)
            .ok_or_else(|| coordination_error("SNAPSHOT_NOT_OWNED"))?;
        let mut payload = json!({"mode":"merge", "scope":"plugins", "plugins":[]});
        restrict_local_plugin(&mut query, user_id, target, &mut payload)
            .await
            .map_err(|error| match error {
                super::desired_capabilities::BuildError::Mysql(error) => error,
                _ => coordination_error("plugin_write_unavailable"),
            })?;
        payload
    } else {
        build_local_plugins(&mut query, user_id)
            .await
            .map_err(|error| {
                tracing::error!(%error, "local plugin snapshot failed");
                coordination_error("plugin_write_unavailable")
            })?
    };
    let revision = hash(&capability_snapshot(&payload));
    let unchanged = !body.targeted
        && body.known_revision.as_deref() == Some(&revision)
        && body.actual_revision.as_deref() == Some(&revision)
        && !body.recovery_pending;
    let mut document = state.json.clone();
    let generation = if unchanged {
        None
    } else {
        let current = document["spec"]["generation"]
            .as_u64()
            .ok_or_else(|| coordination_error("plugin_write_conflict"))?;
        let generation = current
            .checked_add(1)
            .filter(|value| *value < i64::MAX as u64)
            .ok_or_else(|| coordination_error("plugin_write_conflict"))?;
        document["spec"]["generation"] = json!(generation);
        Some(generation)
    };
    let mut query = &mut *tx;
    write_sync_state_document(
        &mut query,
        state.id,
        user_id,
        &crate::json_compat::python_json_value(&document),
        true,
    )
    .await?;
    if unchanged {
        return Ok(
            json!({"enabled":enabled(),"protocolVersion":1,"revision":revision,"unchanged":true,"operation":operation}),
        );
    }
    let generation = generation.expect("changed snapshot has a generation");
    payload["plugin_sync"] = json!({"version":2,"generation":generation,"complete":!body.targeted});
    Ok(
        json!({"enabled":enabled(),"protocolVersion":1,"revision":revision,"unchanged":false,"generation":generation,"payload":payload,"operation":operation}),
    )
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
    let rows: Vec<StateRow> = tx.fetch_all("SELECT json FROM kinds WHERE user_id=? AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account' AND is_active=1 LIMIT 2", (user,)).await?;
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
    let rows:Vec<StateRow>=tx.fetch_all("SELECT json FROM kinds WHERE user_id=? AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account' AND is_active=1 LIMIT 2",(user,)).await?;
    if rows.len() > 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    Ok(rows
        .first()
        .is_some_and(|row| row.json["spec"]["localIntentOrders"][instance].is_object()))
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
