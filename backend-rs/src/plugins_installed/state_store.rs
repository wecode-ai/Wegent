//! Durable, independent synchronization fences for canonical plugin identities.

use std::collections::{BTreeMap, BTreeSet};

use brz_mysql::{FromMysqlRow, MysqlResult};
use serde_json::{Value, json};

use crate::plugins_marketplace::db::{InstalledKindRow, KIND_COLUMNS};
use crate::plugins_marketplace::query::PluginQuery;

use super::write_coordination::{business_revision, coordination_error};

#[derive(FromMysqlRow)]
pub(super) struct PluginState {
    pub id: i64,
    pub user_id: i64,
    pub plugin_key: String,
    pub installed_kind_id: i64,
    pub json: Value,
}

pub(super) fn initial_document(key: &str) -> Value {
    json!({"apiVersion":"agent.wecode.io/v1","kind":"PluginState","metadata":{"name":key,"namespace":"plugin-sync"},"spec":{"revision":0,"generation":0}})
}

pub(super) async fn read<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    key: &str,
) -> MysqlResult<Option<PluginState>> {
    query.fetch_optional("SELECT id,user_id,plugin_key,installed_kind_id,json FROM plugin_states WHERE user_id=? AND plugin_key=?", (user_id,key)).await
}

pub(super) async fn ensure<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    key: &str,
    installed_id: i64,
) -> MysqlResult<PluginState> {
    let owned: Vec<PluginState> = if installed_id != 0 {
        query.fetch_all("SELECT id,user_id,plugin_key,installed_kind_id,json FROM plugin_states WHERE user_id=? AND installed_kind_id=?", (user_id,installed_id)).await?
    } else {
        Vec::new()
    };
    if owned.len() > 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    let existing = if let Some(row) = owned.into_iter().next() {
        Some(row)
    } else {
        read(query, user_id, key).await?
    };

    let mut row = match existing {
        Some(row) => row,
        None => {
            let mut document = initial_document(key);
            if let Some(legacy) = read(query, user_id, "@legacy-v2").await? {
                document["spec"]["generation"] = json!(generation(&legacy.json)?);
            }
            query.execute("INSERT INTO plugin_states (user_id,plugin_key,installed_kind_id,json) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE plugin_key=plugin_states.plugin_key", (user_id,key,installed_id,document)).await?;
            read(query, user_id, key)
                .await?
                .ok_or_else(|| coordination_error("plugin_write_conflict"))?
        }
    };
    if installed_id != 0 && row.installed_kind_id != 0 && row.installed_kind_id != installed_id {
        return Err(coordination_error("plugin_write_conflict"));
    }
    if installed_id != 0 && row.installed_kind_id == 0 {
        row.installed_kind_id = installed_id;
    }
    Ok(row)
}

pub(super) async fn replace<Q: PluginQuery>(
    query: &mut Q,
    row: &PluginState,
    mut document: Value,
) -> MysqlResult<()> {
    let revision = business_revision(&row.json)?;
    document["spec"]["revision"] = json!(revision + 1);
    let updated = query.execute("UPDATE plugin_states SET json=?,installed_kind_id=?,updated_at=NOW() WHERE id=? AND user_id=? AND plugin_key=? AND COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.revision')) AS SIGNED),0)=? AND installed_kind_id IN (0,?)", (document,row.installed_kind_id,row.id,row.user_id,row.plugin_key.as_str(),revision,row.installed_kind_id)).await?;
    if updated.rows_affected != 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    Ok(())
}

pub(super) struct SnapshotFence {
    pub state: PluginState,
    pub installed: Option<InstalledKindRow>,
}

pub(super) async fn snapshot_fences<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    target: Option<i64>,
) -> MysqlResult<Vec<SnapshotFence>> {
    let mut rows: Vec<InstalledKindRow> = query.fetch_all(format!("SELECT {KIND_COLUMNS} FROM kinds WHERE user_id=? AND kind='InstalledPlugin' AND namespace='default' ORDER BY name,id"), (user_id,)).await?;
    if let Some(target) = target {
        rows.retain(|row| row.id == target);
    }
    let mut result = Vec::new();
    for installed in rows {
        let state = ensure(query, user_id, &installed.name, installed.id).await?;
        result.push(SnapshotFence {
            state,
            installed: Some(installed),
        });
    }
    let ids: Vec<i64> = result.iter().map(|f| f.state.installed_kind_id).collect();
    let (filter, mut arguments) = crate::sql_support::id_in_clause("id", &ids);
    arguments.insert(0, crate::sql_support::StatementArg::Int(user_id));
    let fresh:Vec<InstalledKindRow>=query.fetch_all(format!("SELECT {KIND_COLUMNS} FROM kinds WHERE user_id=? AND kind='InstalledPlugin' AND namespace='default' AND {filter}"),arguments).await?;
    let mut fresh: BTreeMap<_, _> = fresh.into_iter().map(|row| (row.id, row)).collect();
    for fence in &mut result {
        fence.installed = Some(
            fresh
                .remove(&fence.state.installed_kind_id)
                .ok_or_else(|| coordination_error("plugin_write_conflict"))?,
        );
    }
    let orphans:Vec<PluginState>=query.fetch_all("SELECT id,user_id,plugin_key,installed_kind_id,json FROM plugin_states s WHERE user_id=? AND installed_kind_id>0 AND NOT EXISTS (SELECT 1 FROM kinds k WHERE k.id=s.installed_kind_id AND k.user_id=s.user_id AND k.kind='InstalledPlugin' AND k.namespace='default') ORDER BY plugin_key",(user_id,)).await?;
    for state in orphans {
        if target.is_none_or(|id| id == state.installed_kind_id)
            && state.json["spec"]["runtimeIdentity"]["installed_plugin_id"].as_i64()
                == Some(state.installed_kind_id)
        {
            result.push(SnapshotFence {
                state,
                installed: None,
            });
        }
    }
    result.sort_by(|a, b| a.state.plugin_key.cmp(&b.state.plugin_key));
    if target.is_some() && result.is_empty() {
        return Err(coordination_error("SNAPSHOT_NOT_OWNED"));
    }
    Ok(result)
}

pub(super) fn add_tombstones(payload: &mut Value, fences: &[SnapshotFence]) {
    let mut removed = payload["removed_plugins"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut included: BTreeSet<i64> = removed
        .iter()
        .filter_map(|row| row["installed_plugin_id"].as_i64())
        .collect();
    included.extend(
        payload["plugins"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| row["installed_plugin_id"].as_i64()),
    );
    for fence in fences {
        if included.insert(fence.state.installed_kind_id) {
            removed.push(match &fence.installed {
                Some(installed) => super::desired_capabilities::removed_plugin_payload(installed),
                None => fence.state.json["spec"]["runtimeIdentity"].clone(),
            });
        }
    }
    if !removed.is_empty() {
        payload["removed_plugins"] = json!(removed);
    }
}

pub(super) async fn publish_snapshot<Q: PluginQuery>(
    query: &mut Q,
    payload: &mut Value,
    fences: Vec<SnapshotFence>,
    capabilities: Option<PluginState>,
) -> MysqlResult<i64> {
    let included: BTreeSet<i64> = ["plugins", "removed_plugins"]
        .into_iter()
        .flat_map(|field| payload[field].as_array().into_iter().flatten())
        .filter_map(|item| item["installed_plugin_id"].as_i64())
        .collect();
    let mut remaining = included.clone();
    let mut revisions = BTreeMap::new();
    let mut intents = BTreeMap::new();
    for fence in fences {
        let id = fence.state.installed_kind_id;
        if !included.contains(&id) {
            continue;
        }
        let generation = generation(&fence.state.json)?
            .checked_add(1)
            .filter(|v| *v > 0 && *v < i64::MAX)
            .ok_or_else(|| coordination_error("plugin_write_conflict"))?;
        let mut document = fence.state.json.clone();
        document["spec"]["generation"] = json!(generation);
        let item = ["plugins", "removed_plugins"]
            .into_iter()
            .flat_map(|field| payload[field].as_array().into_iter().flatten())
            .find(|item| item["installed_plugin_id"].as_i64() == Some(id))
            .expect("included plugin");
        document["spec"]["runtimeIdentity"] = runtime_identity(item);
        replace(query, &fence.state, document).await?;
        revisions.insert(id.to_string(), generation);
        intents.insert(
            id.to_string(),
            match &fence.installed {
                Some(row) => business_revision(&row.json.0.to_value())?,
                None => 0,
            },
        );
        remaining.remove(&id);
    }
    if !remaining.is_empty() {
        return Err(coordination_error("plugin_write_conflict"));
    }
    let generation = if let Some(state) = capabilities {
        let next = generation(&state.json)?
            .checked_add(1)
            .filter(|v| *v > 0 && *v < i64::MAX)
            .ok_or_else(|| coordination_error("plugin_write_conflict"))?;
        let mut document = state.json.clone();
        document["spec"]["generation"] = json!(next);
        replace(query, &state, document).await?;
        next
    } else {
        revisions.values().copied().max().unwrap_or(1)
    };
    payload["plugin_sync"] = json!({"version":3,"generation":generation,"complete":false,"revisions":revisions,"intentRevisions":intents});
    Ok(generation)
}

fn runtime_identity(item: &Value) -> Value {
    json!({"installed_plugin_id":item["installed_plugin_id"],"name":item["name"],"marketplace":item["marketplace"]})
}

fn generation(document: &Value) -> MysqlResult<i64> {
    document["spec"]["generation"]
        .as_i64()
        .filter(|v| *v >= 0 && *v < i64::MAX - 1)
        .ok_or_else(|| coordination_error("plugin_write_conflict"))
}

pub(super) async fn touch_installations<Q: PluginQuery>(
    query: &mut Q,
    user_id: i64,
    ids: &[i64],
) -> MysqlResult<()> {
    let mut rows: Vec<InstalledKindRow> = query.fetch_all(format!("SELECT {KIND_COLUMNS} FROM kinds WHERE user_id=? AND kind='InstalledPlugin' AND namespace='default' ORDER BY name,id"), (user_id,)).await?;
    rows.retain(|row| ids.contains(&row.id));
    for installed in rows {
        let state = ensure(query, user_id, &installed.name, installed.id).await?;
        let updated = query.execute("UPDATE plugin_states SET installed_kind_id=?,json=JSON_SET(json,'$.spec.revision',COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.revision')) AS SIGNED),0)+1),updated_at=NOW() WHERE id=? AND user_id=? AND plugin_key=?", (installed.id,state.id,user_id,state.plugin_key.as_str())).await?;
        if updated.rows_affected != 1 {
            return Err(coordination_error("plugin_write_conflict"));
        }
    }
    Ok(())
}

pub(super) async fn fence_legacy_snapshot<Q: PluginQuery>(
    query: &mut Q,
    payload: &Value,
    fences: Vec<SnapshotFence>,
) -> MysqlResult<()> {
    let items: BTreeMap<_, _> = ["plugins", "removed_plugins"]
        .into_iter()
        .flat_map(|field| payload[field].as_array().into_iter().flatten())
        .filter_map(|item| item["installed_plugin_id"].as_i64().map(|id| (id, item)))
        .collect();
    let known: BTreeSet<_> = fences.iter().map(|f| f.state.installed_kind_id).collect();
    if items.keys().any(|id| !known.contains(id)) {
        return Err(coordination_error("plugin_write_conflict"));
    }
    for fence in fences {
        let mut document = fence.state.json.clone();
        if let Some(item) = items.get(&fence.state.installed_kind_id) {
            document["spec"]["runtimeIdentity"] = runtime_identity(item);
        }
        replace(query, &fence.state, document).await?;
    }
    Ok(())
}
