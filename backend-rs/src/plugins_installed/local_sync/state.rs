//! Internal recovery records reuse PluginSyncState in the existing Kind store.
use super::coordination_error;
use brz_mysql::{FromMysqlRow, MysqlResult, MysqlTransaction};
use serde_json::{Value, json};

pub(super) struct OperationRow {
    pub id: i64,
    pub document: Value,
    pub action: String,
    pub installed_id: i64,
}

pub(super) fn operation_name(instance: &str, operation: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(format!("{instance}\0{operation}").as_bytes())
    )
}

pub(super) async fn load(
    tx: &mut impl MysqlTransaction,
    user: i64,
    instance: &str,
    operation: &str,
) -> MysqlResult<Option<OperationRow>> {
    #[derive(FromMysqlRow)]
    struct StoredKind {
        id: i64,
        json: Value,
    }
    let mut rows: Vec<StoredKind> = tx.fetch_all("SELECT id,json FROM kinds WHERE user_id=? AND kind='PluginSyncState' AND namespace='plugin-local-sync' AND name=? AND is_active=1 LIMIT 2", (user,operation_name(instance,operation))).await?;
    if rows.len() > 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    let Some(row) = rows.pop() else {
        return Ok(None);
    };
    let spec = &row.json["spec"];
    if spec["instanceId"] != instance
        || spec["operationId"] != operation
        || !spec["document"].is_object()
    {
        return Err(coordination_error("plugin_write_conflict"));
    }
    let action = spec["action"]
        .as_str()
        .filter(|action| {
            matches!(
                *action,
                "install" | "update" | "uninstall" | "ensure_builtin" | "snapshot"
            )
        })
        .ok_or_else(|| coordination_error("plugin_write_conflict"))?;
    let installed_id = spec["installedId"]
        .as_i64()
        .filter(|id| *id > 0 || (*id == 0 && action == "snapshot"))
        .ok_or_else(|| coordination_error("plugin_write_conflict"))?;
    Ok(Some(OperationRow {
        id: row.id,
        document: spec["document"].clone(),
        action: action.to_owned(),
        installed_id,
    }))
}

pub(super) async fn has_instance(
    tx: &mut impl MysqlTransaction,
    user: i64,
    instance: &str,
) -> MysqlResult<bool> {
    #[derive(FromMysqlRow)]
    struct Count {
        n: i64,
    }
    let row: Count = tx.fetch_one("SELECT COUNT(*) AS n FROM kinds WHERE user_id=? AND kind='PluginSyncState' AND namespace='plugin-local-sync' AND is_active=1 AND JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.instanceId'))=?", (user,instance)).await?;
    Ok(row.n > 0)
}

pub(super) async fn save_snapshot(
    tx: &mut impl MysqlTransaction,
    user: i64,
    instance: &str,
    snapshot: &str,
    document: Value,
) -> MysqlResult<()> {
    let name = operation_name(instance, snapshot);
    let payload = json!({"apiVersion":"agent.wecode.io/v1","kind":"PluginSyncState","metadata":{"name":name,"namespace":"plugin-local-sync"},"spec":{"instanceId":instance,"operationId":snapshot,"requestHash":"","action":"snapshot","installedId":0,"document":document}});
    tx.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (?,'PluginSyncState','plugin-local-sync',?,?,1,NOW(),NOW())",(user,name,payload)).await?;
    Ok(())
}

pub(super) async fn has_newer_snapshot(
    tx: &mut impl MysqlTransaction,
    user: i64,
    instance: &str,
    id: i64,
) -> MysqlResult<bool> {
    #[derive(FromMysqlRow)]
    struct Count {
        n: i64,
    }
    let row: Count = tx.fetch_one("SELECT COUNT(*) AS n FROM kinds WHERE user_id=? AND kind='PluginSyncState' AND namespace='plugin-local-sync' AND is_active=1 AND JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.instanceId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.action'))='snapshot' AND id>?",(user,instance,id)).await?;
    Ok(row.n > 0)
}

pub(super) async fn update_document(
    tx: &mut impl MysqlTransaction,
    user: i64,
    instance: &str,
    operation: &str,
    document: Value,
) -> MysqlResult<()> {
    tx.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec.document',CAST(? AS JSON)),updated_at=NOW() WHERE user_id=? AND kind='PluginSyncState' AND namespace='plugin-local-sync' AND name=? AND is_active=1",(document,user,operation_name(instance,operation))).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_identity_matches_python_and_preserves_identifier_boundaries() {
        assert_eq!(
            operation_name("local:one", "install:1"),
            "3d16bf5618f292c6f8e1f364babdab4bef3fb8ca12e4edf797d0012952e0fe26"
        );
        assert_ne!(operation_name("a:b", "c"), operation_name("a", "b:c"));
        assert_eq!(operation_name(&"i".repeat(128), &"o".repeat(128)).len(), 64);
    }
}
