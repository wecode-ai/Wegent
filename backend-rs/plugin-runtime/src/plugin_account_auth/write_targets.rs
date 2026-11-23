//! Resolve authentication writes to account installations before taking leases.

use brz_mysql::{FromMysqlRow, MysqlResult, MysqlTransaction};
use serde_json::Value;

#[derive(FromMysqlRow)]
struct TargetRow {
    json: Value,
}

pub(super) async fn resolve(
    tx: &mut impl MysqlTransaction,
    user_id: i64,
    data: &Value,
) -> MysqlResult<Vec<i64>> {
    let invalid = || super::exchange_error(super::INVALID_REQUEST);
    if let Some(ids) = data["installed_plugin_ids"].as_array() {
        return ids
            .iter()
            .map(|id| id.as_i64().filter(|id| *id > 0).ok_or_else(invalid))
            .collect();
    }
    if let Some(id) = data["installed_plugin_id"].as_i64().filter(|id| *id > 0) {
        return Ok(vec![id]);
    }
    let (name, kinds, field) = if let Some(name) = data["connection_id"].as_str() {
        (name, vec!["ConnectorConnection"], "installedPluginId")
    } else if let Some(name) = data["migration_id"].as_str() {
        (
            name,
            vec!["ConnectorMigration", "ConnectorTransfer"],
            "installed_plugin_id",
        )
    } else {
        return Err(invalid());
    };
    let mut ids = Vec::new();
    for kind in kinds {
        let rows: Vec<TargetRow> = tx.fetch_all(
            "SELECT json FROM kinds WHERE user_id=? AND kind=? AND namespace='plugin-auth' AND name=? LIMIT 2", (user_id, kind, name),
        ).await?;
        if rows.len() > 1 {
            return Err(super::exchange_error("plugin_auth_revision_conflict"));
        }
        for row in rows {
            ids.push(row.json["spec"][field].as_i64().ok_or_else(invalid)?);
        }
    }
    ids.sort();
    ids.dedup();
    if ids.len() != 1 {
        let code = if data["connection_id"].is_string() {
            "plugin_auth_connection_not_found"
        } else {
            "plugin_auth_migration_expired"
        };
        return Err(super::exchange_error(code));
    }
    Ok(ids)
}
