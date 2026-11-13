// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Compact MCP entries for applications whose upstream tools load on demand.

use serde_json::{Value, json};

use crate::apps_installed::service::ConnectorApp;

pub(crate) const DISCOVER_PREFIX: &str = "_wegent_discover__";
pub(crate) const CALL_PREFIX: &str = "_wegent_call__";

pub(crate) fn deferred_tools(app: &ConnectorApp) -> Vec<Value> {
    let description = format!("{}: {}", app.name, app.description);
    vec![
        json!({
            "name": format!("{DISCOVER_PREFIX}{}", app.slug),
            "description": format!("Discover the available tools and their exact input schemas for {description}. Call this before invoking a tool."),
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
            "annotations": {"readOnlyHint": true},
            "_meta": {"connectorId": app.slug, "deferred": true},
        }),
        json!({
            "name": format!("{CALL_PREFIX}{}", app.slug),
            "description": format!("Invoke a previously discovered tool for {description}. Use the exact name and JSON argument types returned by discovery."),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1, "description": "The unqualified upstream tool name from discovery."},
                    "arguments": {"type": "object"},
                },
                "required": ["name", "arguments"],
                "additionalProperties": false,
            },
            "_meta": {"connectorId": app.slug, "deferred": true},
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deferred_entries_are_app_scoped_and_do_not_include_upstream_schemas() {
        let app = crate::apps_installed::service::row_to_app(&crate::apps_installed::db::KindRow {
            kinds_json: brz_mysql::Json(
                json!({"spec": {
                    "name": "Records", "toolLoadingMode": "lazy",
                    "authType": "none", "mcpUrl": "https://example.test/mcp"
                }})
                .into(),
            ),
            kinds_name: "records".to_string(),
            kinds_id: 1,
            kinds_user_id: 0,
            kinds_kind: "ConnectorApp".to_string(),
            kinds_namespace: "system".to_string(),
            kinds_is_active: true,
            kinds_created_at: Default::default(),
            kinds_updated_at: Default::default(),
        });
        let tools = deferred_tools(&app);
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["name"], "_wegent_discover__records");
        assert_eq!(tools[1]["name"], "_wegent_call__records");
        assert_eq!(
            tools[1]["inputSchema"]["required"],
            json!(["name", "arguments"])
        );
        assert_eq!(tools[0]["_meta"]["connectorId"], "records");
    }
}
