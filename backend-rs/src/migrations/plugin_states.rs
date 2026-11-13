//! Create plugin-scoped identities; restore legacy state only on rollback.

use std::collections::BTreeMap;

use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlTransaction};
use serde_json::{Value, json};

const CREATE: &str = "CREATE TABLE plugin_states (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,user_id BIGINT NOT NULL,plugin_key VARCHAR(100) NOT NULL,installed_kind_id INTEGER NOT NULL DEFAULT 0,json JSON NOT NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT uniq_plugin_states_identity UNIQUE (user_id,plugin_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Plugin-scoped synchronization identities and transaction fences'";

#[cfg(test)]
use crate::plugins_installed::state_history::plugin_document;
use crate::plugins_installed::state_history::{Source, validate_document};

pub(super) async fn upgrade(tx: &mut impl MysqlTransaction) -> MysqlResult<()> {
    // Historical data is inherited on demand, not scanned or deleted at startup.
    tx.execute(CREATE, ()).await?;
    Ok(())
}

#[derive(FromMysqlRow)]
struct State {
    user_id: i64,
    document: Value,
}

pub(super) async fn downgrade(tx: &mut impl MysqlTransaction) -> MysqlResult<()> {
    let rows: Vec<State> = tx
        .fetch_all("SELECT user_id,json AS document FROM plugin_states", ())
        .await?;
    let old: Vec<Source> = tx.fetch_all("SELECT id,user_id,name,json AS document FROM kinds WHERE kind='PluginSyncState' AND namespace='plugin-sync' AND name='account' AND is_active=1 AND user_id IN (SELECT DISTINCT user_id FROM plugin_states)", ()).await?;
    let mut old_ids = BTreeMap::new();
    let mut accounts = BTreeMap::new();
    for row in old {
        validate_document(&row.document)?;
        if old_ids.insert(row.user_id, row.id).is_some() {
            return Err(brz_mysql::MysqlError::InvalidQuery {
                reason: "Ambiguous legacy plugin state on rollback".into(),
            });
        }
        accounts.insert(row.user_id, row.document);
    }
    for row in rows {
        validate_document(&row.document)?;
        let document = accounts.entry(row.user_id).or_insert_with(|| json!({"apiVersion":"agent.wecode.io/v1","kind":"PluginSyncState","metadata":{"name":"account","namespace":"plugin-sync"},"spec":{}}));
        merge_account(&mut document["spec"], &row.document["spec"]);
    }
    for (user_id, document) in accounts {
        if let Some(id) = old_ids.get(&user_id) {
            tx.execute("UPDATE kinds SET json=?,updated_at=NOW() WHERE id=? AND user_id=? AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account'", (Json(document),*id,user_id)).await?;
        } else {
            tx.execute("INSERT INTO kinds (user_id,kind,name,namespace,json,is_active,created_at,updated_at) VALUES (?,'PluginSyncState','account','plugin-sync',?,1,NOW(),NOW())", (user_id,Json(document))).await?;
        }
    }
    tx.execute("DROP TABLE plugin_states", ()).await?;
    Ok(())
}

fn maximum(target: &mut Value, source: &Value) {
    *target = json!(
        target
            .as_u64()
            .unwrap_or(0)
            .max(source.as_u64().unwrap_or(0))
    );
}

fn merge_account(target: &mut Value, source: &Value) {
    for field in ["generation", "revision"] {
        maximum(&mut target[field], &source[field]);
    }
    if let Some(slots) = source["creationRevisions"].as_object() {
        for (key, value) in slots {
            maximum(&mut target["creationRevisions"][key], value);
        }
    }
    for field in ["localIntents", "localIntentOrders"] {
        if let Some(instances) = source[field].as_object() {
            for (instance, slots) in instances {
                for (key, value) in slots.as_object().into_iter().flatten() {
                    let previous = &mut target[field][instance][key];
                    if field == "localIntentOrders" {
                        maximum(previous, value);
                    } else if value["intentOrder"].as_u64().unwrap_or(0)
                        >= previous["intentOrder"].as_u64().unwrap_or(0)
                    {
                        *previous = value.clone();
                    }
                }
            }
        }
    }
    if let Some(devices) = source["devices"].as_object() {
        for (device, value) in devices {
            maximum(
                &mut target["devices"][device]["complete_generation"],
                &value["complete_generation"],
            );
            for (key, generation) in value["plugins"].as_object().into_iter().flatten() {
                maximum(&mut target["devices"][device]["plugins"][key], generation);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_keeps_only_this_plugins_ordering_and_preserves_on_rollback() {
        let account = json!({"spec":{"generation":10,"localIntentOrders":{"client":{"11":4,"12":5}},"localIntents":{"client":{"11":{"operationId":"first","intentOrder":4}}},"devices":{"desktop":{"complete_generation":8,"plugins":{"11":10,"12":9}}}}});
        let plugin = Source {
            id: 11,
            user_id: 151,
            name: "plugin-a".into(),
            document: json!({}),
        };
        let projected = plugin_document(Some(&account), &plugin);
        assert_eq!(
            projected["spec"]["localIntentOrders"],
            json!({"client":{"11":4}})
        );
        assert_eq!(
            projected["spec"]["devices"],
            json!({"desktop":{"complete_generation":8,"plugins":{"11":10}}})
        );
        let mut target = account["spec"].clone();
        let mut changed = projected["spec"].clone();
        changed["generation"] = json!(25);
        changed["localIntentOrders"]["client"]["11"] = json!(6);
        merge_account(&mut target, &changed);
        assert_eq!(target["generation"], 25);
        assert_eq!(
            target["localIntentOrders"],
            json!({"client":{"11":6,"12":5}})
        );
    }
}
