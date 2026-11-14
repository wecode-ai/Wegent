//! Backfill the shared system catalog independently of development-only YAML.

use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json, MysqlService, MysqlTransaction};
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
        "../../../shared/data/builtin-connector-apps.json"
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

pub(super) async fn apply(mysql: &MysqlService) -> Result<()> {
    #[derive(FromMysqlRow)]
    struct Endpoint {
        payload: Json<Value>,
    }
    for definition in definitions()? {
        mysql.with_transaction(async |tx| {
            if let Some(existing) = super::kind(tx, "ConnectorApp", &definition.slug, "system").await? {
                let mut value = existing.payload.0;
                if existing.is_active == Some(true) && backfill(&mut value, &definition) {
                    tx.execute("UPDATE kinds SET json=?,updated_at=NOW() WHERE id=?", (Json(value), existing.id)).await?;
                }
                return Ok(());
            }
            let endpoints: Vec<Endpoint> = tx.fetch_all(
                "SELECT json AS payload FROM kinds WHERE user_id=0 AND kind='ConnectorApp' AND namespace='system' AND is_active=1", ()
            ).await?;
            let normalized = definition.mcp_url.trim_end_matches('/').to_lowercase();
            if endpoints.iter().any(|row| row.payload.0["spec"]["mcpUrl"].as_str().unwrap_or("").trim_end_matches('/').to_lowercase() == normalized) {
                return Ok(());
            }
            super::insert_kind(tx, "ConnectorApp", &definition.slug, "system", &payload(&definition)).await?;
            Ok(())
        }).await?;
    }
    Ok(())
}

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
