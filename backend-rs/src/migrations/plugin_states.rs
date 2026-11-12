//! Convert the old account synchronization Kind into plugin-scoped identities.

use std::collections::{BTreeMap, BTreeSet};

use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlTransaction};
use serde_json::{Value, json};

const CREATE: &str = "CREATE TABLE plugin_states (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,user_id BIGINT NOT NULL,plugin_key VARCHAR(100) NOT NULL,installed_kind_id INTEGER NOT NULL DEFAULT 0,json JSON NOT NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT uniq_plugin_states_identity UNIQUE (user_id,plugin_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Plugin-scoped synchronization identities and transaction fences'";

#[derive(FromMysqlRow)]
struct Source {
    id: i64,
    user_id: i64,
    name: String,
    document: Value,
}

fn invalid() -> brz_mysql::MysqlError {
    brz_mysql::MysqlError::InvalidQuery {
        reason: "Ambiguous plugin state migration identity; repair duplicate source records before migrating".into(),
    }
}

fn invalid_document() -> brz_mysql::MysqlError {
    brz_mysql::MysqlError::InvalidQuery {
        reason: "Invalid plugin synchronization document or counter; repair before migrating"
            .into(),
    }
}
fn mapping(value: Option<&Value>) -> MysqlResult<Option<&serde_json::Map<String, Value>>> {
    match value {
        None => Ok(None),
        Some(Value::Object(value)) => Ok(Some(value)),
        _ => Err(invalid_document()),
    }
}
fn counter(value: Option<&Value>) -> MysqlResult<()> {
    if value.is_none_or(|v| v.as_i64().is_some_and(|v| (0..i64::MAX).contains(&v))) {
        Ok(())
    } else {
        Err(invalid_document())
    }
}
fn validate_document(document: &Value) -> MysqlResult<()> {
    let root = document.as_object().ok_or_else(invalid_document)?;
    let Some(spec) = mapping(root.get("spec"))? else {
        return Ok(());
    };
    for field in ["revision", "generation"] {
        counter(spec.get(field))?;
    }
    if let Some(slots) = mapping(spec.get("creationRevisions"))? {
        for value in slots.values() {
            counter(Some(value))?;
        }
    }
    if let Some(devices) = mapping(spec.get("devices"))? {
        for value in devices.values() {
            let device = mapping(Some(value))?.expect("present object");
            counter(device.get("complete_generation"))?;
            if let Some(slots) = mapping(device.get("plugins"))? {
                for value in slots.values() {
                    counter(Some(value))?;
                }
            }
        }
    }
    for field in ["localIntents", "localIntentOrders"] {
        if let Some(instances) = mapping(spec.get(field))? {
            for value in instances.values() {
                for slot in mapping(Some(value))?.expect("present object").values() {
                    if field == "localIntentOrders" {
                        counter(Some(slot))?;
                    } else {
                        counter(
                            mapping(Some(slot))?
                                .expect("present object")
                                .get("intentOrder"),
                        )?;
                    }
                }
            }
        }
    }
    Ok(())
}

pub(super) async fn upgrade(tx: &mut impl MysqlTransaction) -> MysqlResult<()> {
    #[derive(FromMysqlRow)]
    struct Duplicate {
        user_id: i64,
    }
    let duplicates: Vec<Duplicate> = tx.fetch_all("SELECT user_id FROM kinds WHERE kind='InstalledPlugin' AND namespace='default' GROUP BY user_id,CONVERT(name USING utf8mb4) COLLATE utf8mb4_unicode_ci HAVING COUNT(*)>1 LIMIT 1",()).await?;
    if let Some(duplicate) = duplicates.first() {
        let _ = duplicate.user_id;
        return Err(invalid());
    }
    let accounts: Vec<Source> = tx.fetch_all("SELECT id,user_id,name,json AS document FROM kinds WHERE kind='PluginSyncState' AND namespace='plugin-sync' AND name='account' AND is_active=1", ()).await?;
    let installations: Vec<Source> = tx.fetch_all("SELECT id,user_id,name,json AS document FROM kinds WHERE kind='InstalledPlugin' AND namespace='default'", ()).await?;
    let mut seen_accounts = BTreeSet::new();
    for row in &accounts {
        validate_document(&row.document)?;
        if !seen_accounts.insert(row.user_id) {
            return Err(invalid());
        }
    }
    let mut seen_installations = BTreeSet::new();
    for row in &installations {
        if row.name.starts_with('@') || !seen_installations.insert((row.user_id, row.name.as_str()))
        {
            return Err(invalid());
        }
    }
    tx.execute(CREATE, ()).await?;
    let mut account_documents = BTreeMap::new();
    for account in &accounts {
        let document = account.document.clone();
        tx.execute(
            "INSERT INTO plugin_states (user_id,plugin_key,json) VALUES (?,'@legacy-v2',?)",
            (account.user_id, Json(document)),
        )
        .await?;
        account_documents.insert(account.user_id, &account.document);
    }
    for installed in installations {
        let document = plugin_document(
            account_documents.get(&installed.user_id).copied(),
            &installed,
        );
        tx.execute("INSERT INTO plugin_states (user_id,plugin_key,installed_kind_id,json) VALUES (?,?,?,?)", (installed.user_id,installed.name.as_str(),installed.id,Json(document))).await?;
    }
    for account in accounts {
        tx.execute("DELETE FROM kinds WHERE id=?", (account.id,))
            .await?;
    }
    Ok(())
}

fn plugin_document(account: Option<&Value>, installed: &Source) -> Value {
    let empty = json!({});
    let source = account.unwrap_or(&empty);
    let key = installed.id.to_string();
    let document = &installed.document;
    let name = [
        &document["spec"]["source"]["pluginKey"],
        &document["spec"]["source"]["plugin"],
        &document["spec"]["manifest"]["name"],
        &document["metadata"]["name"],
    ]
    .into_iter()
    .filter_map(|v| v.as_str())
    .find(|v| !v.is_empty())
    .unwrap_or(&installed.name);
    let marketplace = document["spec"]
        .get("marketplace")
        .filter(|v| !v.is_null())
        .or_else(|| document["spec"]["source"].get("marketplace"))
        .cloned()
        .unwrap_or(Value::Null);

    let mut spec = json!({"revision":0,"generation":source["spec"]["generation"].as_u64().unwrap_or(0),"creationRevisions":{installed.name.clone():source["spec"]["creationRevisions"][&installed.name].as_u64().unwrap_or(0)},"localIntents":{},"localIntentOrders":{},"devices":{}});
    spec["runtimeIdentity"] =
        json!({"installed_plugin_id":installed.id,"name":name,"marketplace":marketplace});
    for field in ["localIntents", "localIntentOrders"] {
        if let Some(instances) = source["spec"][field].as_object() {
            for (instance, slots) in instances {
                if let Some(value) = slots.get(&key) {
                    spec[field][instance] = json!({key.clone():value});
                }
            }
        }
    }
    if let Some(devices) = source["spec"]["devices"].as_object() {
        for (device, value) in devices {
            spec["devices"][device] = json!({"complete_generation":value["complete_generation"].as_u64().unwrap_or(0),"plugins":{key.clone():value["plugins"][&key].as_u64().unwrap_or(0)}});
        }
    }
    json!({"apiVersion":"agent.wecode.io/v1","kind":"PluginState","metadata":{"name":installed.name,"namespace":"plugin-sync"},"spec":spec})
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
    let mut accounts = BTreeMap::new();
    for row in rows {
        validate_document(&row.document)?;
        let document = accounts.entry(row.user_id).or_insert_with(|| json!({"apiVersion":"agent.wecode.io/v1","kind":"PluginSyncState","metadata":{"name":"account","namespace":"plugin-sync"},"spec":{}}));
        merge_account(&mut document["spec"], &row.document["spec"]);
    }
    for (user_id, document) in accounts {
        tx.execute("INSERT INTO kinds (user_id,kind,name,namespace,json,is_active,created_at,updated_at) VALUES (?,'PluginSyncState','account','plugin-sync',?,1,NOW(),NOW())", (user_id,Json(document))).await?;
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
