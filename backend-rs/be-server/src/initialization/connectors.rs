//! Backfill the shared system catalog independently of development-only YAML.

use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlService, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Definition {
    slug: String,
    name: String,
    mcp_url: String,
    keywords: Vec<String>,
}

fn definitions() -> Result<Vec<Definition>> {
    Ok(serde_json::from_str(include_str!(
        "../../../../shared/data/builtin-connector-apps.json"
    ))?)
}

fn backfill(payload: &mut Value, definition: &Definition) -> bool {
    let mut spec = payload["spec"].as_object().cloned().unwrap_or_default();
    let before = spec.clone();
    if spec.get("builtinToolLoadingMode") != Some(&json!("lazy")) {
        spec.insert("toolLoadingMode".into(), json!("lazy"));
        spec.insert("builtinToolLoadingMode".into(), json!("lazy"));
    }
    if spec.get("builtinKeywordsSeeded") != Some(&json!(true)) {
        if spec
            .get("keywords")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            spec.insert("keywords".into(), json!(definition.keywords));
        }
        spec.insert("builtinKeywordsSeeded".into(), json!(true));
    }
    let changed = before != spec;
    payload["spec"] = Value::Object(spec);
    changed
}

fn payload(definition: &Definition) -> Value {
    let mut value = json!({
        "apiVersion": "agent.wecode.io/v1",
        "kind": "ConnectorApp",
        "metadata": {
            "name": definition.slug,
            "namespace": "system",
            "displayName": definition.name,
        },
        "spec": {
            "name": definition.name,
            "description": "",
            "enabled": true,
            "visibility": "all",
            "allowedRoles": [],
            "authType": "oauth2",
            "transport": "streamable-http",
            "mcpUrl": definition.mcp_url,
            "providerHeadersEncrypted": null,
            "forwardUserContextHeaders": false,
            "toolAllowlist": [],
            "httpTools": [],
            "createdBy": 0,
        }
    });
    backfill(&mut value, definition);
    value
}

const COMPLETION_KEY: &str = "builtin_connector_apps_initialized";

async fn seed(tx: &mut impl MysqlTransaction, definitions: &[Definition]) -> MysqlResult<()> {
    #[derive(FromMysqlRow)]
    struct Endpoint {
        payload: Json<Value>,
    }
    for definition in definitions {
        let existing: Option<super::Kind> = tx
            .fetch_optional(
                "SELECT id,json AS payload,is_active FROM kinds WHERE user_id=0 AND kind=? AND name=? AND namespace=? LIMIT 1 FOR UPDATE",
                ("ConnectorApp", definition.slug.as_str(), "system"),
            )
            .await?;
        if let Some(existing) = existing {
            let mut value = existing.payload.0;
            if existing.is_active == Some(true) && backfill(&mut value, definition) {
                tx.execute(
                    "UPDATE kinds SET json=?,updated_at=NOW() WHERE id=?",
                    (Json(value), existing.id),
                )
                .await?;
            }
            continue;
        }
        let endpoints: Vec<Endpoint> = tx
            .fetch_all(
                "SELECT json AS payload FROM kinds WHERE user_id=0 AND kind='ConnectorApp' AND namespace='system' AND is_active=1",
                (),
            )
            .await?;
        let normalized = definition.mcp_url.trim_end_matches('/').to_lowercase();
        if endpoints.iter().any(|row| {
            row.payload.0["spec"]["mcpUrl"]
                .as_str()
                .unwrap_or("")
                .trim_end_matches('/')
                .to_lowercase()
                == normalized
        }) {
            continue;
        }
        super::insert_kind(
            tx,
            "ConnectorApp",
            &definition.slug,
            "system",
            &payload(definition),
        )
        .await?;
    }
    // Publish the completion marker atomically with the catalog entries.
    tx.execute(
        "INSERT INTO system_configs (config_key,config_value,version,updated_by,created_at,updated_at) VALUES (?, ?, 1, 0, NOW(), NOW())",
        (COMPLETION_KEY, r#"{"completed":true}"#),
    )
    .await?;
    Ok(())
}

async fn apply_transaction(
    tx: &mut impl MysqlTransaction,
    definitions: &[Definition],
) -> MysqlResult<()> {
    #[derive(FromMysqlRow)]
    struct Completion {
        payload: Json<Value>,
    }
    // Read the current marker and keep it locked until publication commits.
    let completion: Option<Completion> = tx
        .fetch_optional(
            "SELECT config_value AS payload FROM system_configs WHERE config_key=? LIMIT 1 FOR UPDATE",
            (COMPLETION_KEY,),
        )
        .await?;
    if completion.is_some_and(|row| row.payload.0["completed"] == true) {
        return Ok(());
    }
    // An incomplete marker remains retriable if this transaction fails.
    tx.execute(
        "DELETE FROM system_configs WHERE config_key=?",
        (COMPLETION_KEY,),
    )
    .await?;
    seed(tx, definitions).await
}

pub(super) async fn apply(mysql: &MysqlService) -> Result<()> {
    let definitions = definitions()?;
    mysql
        .with_transaction(async |tx| apply_transaction(tx, &definitions).await)
        .await?;
    Ok(())
}

#[cfg(test)]
#[path = "connectors_tests.rs"]
mod persistence_tests;

#[cfg(test)]
pub(crate) use persistence_tests::{
    verify_admin_edits_during_backfill, verify_concurrent_completion,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_are_enabled_lazy_oauth_apps() {
        let definitions = definitions().unwrap();
        assert_eq!(definitions.len(), 4);
        for definition in definitions {
            let value = payload(&definition);
            assert_eq!(value["spec"]["enabled"], true);
            assert_eq!(value["spec"]["authType"], "oauth2");
            assert_eq!(value["spec"]["toolLoadingMode"], "lazy");
            assert!(!value["spec"]["keywords"].as_array().unwrap().is_empty());
        }
    }

    #[test]
    fn backfill_is_once_only_and_preserves_admin_edits() {
        let definition = definitions().unwrap().remove(0);
        let mut value = json!({"spec":{"enabled": false}});
        assert!(backfill(&mut value, &definition));
        value["spec"]["toolLoadingMode"] = json!("static");
        value["spec"]["keywords"] = json!(["custom"]);
        assert!(!backfill(&mut value, &definition));
        assert_eq!(value["spec"]["enabled"], false);
        assert_eq!(value["spec"]["toolLoadingMode"], "static");
        assert_eq!(value["spec"]["keywords"], json!(["custom"]));
    }
}
