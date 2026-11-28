//! Author-source identity is an account capability, never a device assertion.
use brz_mysql::{FromMysqlRow, MysqlResult};
use serde_json::Value;
use std::collections::BTreeSet;
use wegent_backend_persistence::mysql_query::MysqlQuery;

#[derive(FromMysqlRow)]
struct OwnedPlugin {
    id: i64,
}

fn plugin_id(document: &Value) -> Option<i64> {
    let spec = &document["spec"];
    let value = spec
        .get("pluginId")
        .or_else(|| spec["source"].get("catalogItemId"))?;
    value
        .as_i64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|id| *id > 0)
}

pub(super) fn valid_source(source: &Value) -> bool {
    source.is_object()
        && source.as_object().is_some_and(|object| {
            object
                .keys()
                .all(|key| matches!(key.as_str(), "installed" | "enabled" | "version"))
        })
        && source["installed"].is_boolean()
        && source["enabled"].is_boolean()
        && source
            .get("version")
            .is_none_or(|value| value.as_str().is_some_and(|text| !text.trim().is_empty()))
}

pub(super) async fn owned_install<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    document: &Value,
) -> MysqlResult<bool> {
    let Some(id) = plugin_id(document) else {
        return Ok(false);
    };
    let row: Option<OwnedPlugin> = query
        .fetch_optional(
            "SELECT id FROM plugins WHERE id=? AND owner_user_id=? AND visibility='personal'",
            (id, user_id),
        )
        .await?;
    Ok(row.is_some())
}

pub(super) async fn mark_owned_payloads<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    payloads: &mut [Value],
) -> MysqlResult<()> {
    let ids: BTreeSet<_> = payloads
        .iter()
        .filter_map(|item| item["cloud_plugin_id"].as_i64())
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let ids: Vec<_> = ids.into_iter().collect();
    let (filter, arguments) = crate::sql_support::id_in_clause("id", &ids);
    let mut params = vec![crate::sql_support::StatementArg::Int(user_id)];
    params.extend(arguments);
    let rows: Vec<OwnedPlugin> = query.fetch_all(
        format!("SELECT id FROM plugins WHERE owner_user_id=? AND visibility='personal' AND {filter}"),
        params,
    ).await?;
    let owned: BTreeSet<_> = rows.into_iter().map(|row| row.id).collect();
    for payload in payloads {
        if payload["cloud_plugin_id"]
            .as_i64()
            .is_some_and(|id| owned.contains(&id))
        {
            payload["personal_source_owner"] = Value::Bool(true);
        }
    }
    Ok(())
}
