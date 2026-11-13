//! Frozen legacy projection shared by on-demand initialization and backfill.
use super::write_coordination::coordination_error;
use crate::plugins_marketplace::query::PluginQuery;
use brz_mysql::{FromMysqlRow, MysqlResult};
use serde_json::{Value, json};

#[derive(FromMysqlRow)]
pub(crate) struct Source {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub document: Value,
}

#[derive(FromMysqlRow)]
struct Document {
    document: Value,
}

pub(crate) async fn frozen<Q: PluginQuery>(query: &mut Q, user_id: i64) -> MysqlResult<Value> {
    let mut rows: Vec<Document> = query.fetch_all("SELECT json AS document FROM kinds WHERE user_id=? AND kind='PluginSyncState' AND namespace='plugin-sync' AND name='account' AND is_active=1 LIMIT 2", (user_id,)).await?;
    if rows.len() > 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    let document = rows
        .pop()
        .map(|row| row.document)
        .unwrap_or_else(|| json!({}));
    validate_document(&document).map_err(|_| coordination_error("plugin_write_conflict"))?;
    Ok(document)
}

pub(crate) async fn legacy<Q: PluginQuery>(query: &mut Q, user_id: i64) -> MysqlResult<Value> {
    let row: Option<Document> = query.fetch_optional("SELECT json AS document FROM plugin_states WHERE user_id=? AND plugin_key='@legacy-v2'", (user_id,)).await?;
    if let Some(row) = row {
        validate_document(&row.document)
            .map_err(|_| coordination_error("plugin_write_conflict"))?;
        Ok(row.document)
    } else {
        frozen(query, user_id).await
    }
}

pub(super) async fn initialize<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    key: &str,
    installed_id: i64,
) -> MysqlResult<(i64, Value)> {
    let mut document = super::state_store::initial_document(key);
    if key == "@account-policy" {
        return Ok((0, document));
    }
    let baseline = if key == "@legacy-v2" {
        frozen(query, user_id).await?
    } else {
        legacy(query, user_id).await?
    };
    if key == "@legacy-v2" && baseline.as_object().is_some_and(|v| !v.is_empty()) {
        return Ok((0, baseline));
    }
    if !key.starts_with('@') {
        let mut rows: Vec<Source> = query.fetch_all("SELECT id,user_id,name,json AS document FROM kinds WHERE user_id=? AND kind='InstalledPlugin' AND namespace='default' AND name=? LIMIT 2", (user_id,key)).await?;
        if rows.len() > 1 {
            return Err(coordination_error("plugin_write_conflict"));
        }
        if let Some(installed) = rows.pop() {
            if installed_id != 0 && installed_id != installed.id {
                return Err(coordination_error("plugin_write_conflict"));
            }
            return Ok((installed.id, plugin_document(Some(&baseline), &installed)));
        }
        if installed_id != 0 {
            return Err(coordination_error("plugin_write_conflict"));
        }
    }
    document["spec"]["generation"] = baseline["spec"]["generation"]
        .as_i64()
        .map(Value::from)
        .unwrap_or(json!(0));
    Ok((installed_id, document))
}

pub(super) async fn validate_binding<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    key: &str,
    installed_id: i64,
) -> MysqlResult<()> {
    if installed_id == 0 {
        return Ok(());
    }
    #[derive(FromMysqlRow)]
    struct Id {
        id: i64,
    }
    let parent: Option<Id> = query.fetch_optional("SELECT id FROM kinds WHERE id=? AND user_id=? AND kind='InstalledPlugin' AND namespace='default' AND name=?", (installed_id,user_id,key)).await?;
    let bindings: Vec<Id> = query
        .fetch_all(
            "SELECT id FROM plugin_states WHERE user_id=? AND installed_kind_id=? LIMIT 2",
            (user_id, installed_id),
        )
        .await?;
    if parent.is_none() || bindings.len() != 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    let _ = parent.map(|row| row.id);
    Ok(())
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
pub(crate) fn validate_document(document: &Value) -> MysqlResult<()> {
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

pub(crate) fn plugin_document(account: Option<&Value>, installed: &Source) -> Value {
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
