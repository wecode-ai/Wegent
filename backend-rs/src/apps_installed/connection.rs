// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Runtime view of one user's stored connector authorization.
//!
//! Ports `app/services/connector_connections.py::ConnectorConnection` and
//! `ConnectorConnectionService.response`: the `ConnectorConnection` Kind stores
//! the OAuth status and encrypted tokens in `spec`, and a stored expiry that is
//! at or before the current UTC time turns a `connected` status into
//! `expired`.
use chrono::{NaiveDateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

use super::db::KindRow;
use super::models::{ConnectionResponse, ToolSummary};

/// `connector_runtime.TOOL_CACHE_TTL_SECONDS`: how long a discovered surface
/// stays fresh before the next listing rediscovers it.
const TOOL_CACHE_TTL_SECONDS: i64 = 600;

/// `spec["toolSummaries"]` entries written by the Python connector runtime
/// after a successful discovery; they keep expired connections visible.
#[brz_json::model]
#[derive(Debug, Deserialize)]
struct CachedToolSummary {
    /// `summary["name"] or f"{slug}__{rawName}"`; older caches may omit it.
    #[serde(default, deserialize_with = "brz_json::adapters::null_as_default")]
    name: String,
    title: Option<String>,
    #[serde(default, deserialize_with = "brz_json::adapters::null_as_default")]
    description: String,
    #[serde(default, rename = "rawToolName")]
    raw_tool_name: Option<String>,
    /// `summary["inputSchema"]`: kept so a cached surface can still drive a
    /// tool call.
    #[serde(default, rename = "inputSchema")]
    input_schema: Option<brz_json::OpaqueJson>,
}

/// Parsed `spec` of one `ConnectorConnection` Kind (`_row_to_connection`).
#[brz_json::model]
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ConnectionSpec {
    /// `str(spec.get("status") or "disconnected")`.
    #[serde(deserialize_with = "brz_json::adapters::null_as_default")]
    status: String,
    /// `spec.get("externalAccountName")`.
    #[serde(rename = "externalAccountName")]
    external_account_name: Option<String>,
    /// `list(spec.get("grantedScopes") or [])`.
    #[serde(
        rename = "grantedScopes",
        deserialize_with = "brz_json::adapters::null_as_default"
    )]
    granted_scopes: Vec<String>,
    /// `spec.get("expiresAt")`; only a string can parse into a datetime.
    #[serde(rename = "expiresAt")]
    expires_at: Option<String>,
    /// `str(spec.get("accessTokenEncrypted") or "")`.
    #[serde(
        rename = "accessTokenEncrypted",
        deserialize_with = "brz_json::adapters::null_as_default"
    )]
    access_token_encrypted: String,
    /// `spec.get("refreshTokenEncrypted")`: `None` when null or absent.
    #[serde(rename = "refreshTokenEncrypted")]
    refresh_token_encrypted: Option<String>,
    /// `spec.get("tokenType") or "bearer"`.
    #[serde(
        rename = "tokenType",
        deserialize_with = "brz_json::adapters::null_as_default"
    )]
    token_type: String,
    /// `spec.get("toolSummaries")`: the last successful tool discovery cache.
    #[serde(rename = "toolSummaries", default)]
    tool_summaries: Vec<CachedToolSummary>,
    /// `spec.get("toolsDiscoveredAt")`; only a string can parse into a datetime.
    #[serde(rename = "toolsDiscoveredAt")]
    tools_discovered_at: Option<String>,
    /// `spec.get("lastError")`: either a message string or an object carrying
    /// a `message` member (`record_tool_error`).
    #[serde(rename = "lastError", default)]
    last_error: Option<brz_json::OpaqueJson>,
}

#[derive(Debug, Default, Deserialize)]
struct ConnectionDocument {
    #[serde(default)]
    spec: Option<ConnectionSpec>,
}

/// `ConnectorConnection`: the authorization state one user has for one app.
#[derive(Debug)]
pub(crate) struct ConnectorConnection {
    /// `status` after `str(... or "disconnected")`.
    pub status: String,
    pub external_account_name: Option<String>,
    pub granted_scopes: Vec<String>,
    /// Recorded expiry parsed from the ISO-8601 `expiresAt` member.
    pub expires_at: Option<NaiveDateTime>,
    pub access_token_encrypted: String,
    /// `ConnectorConnection.refresh_token_encrypted`.
    pub refresh_token_encrypted: Option<String>,
    /// `ConnectorConnection.token_type`.
    pub token_type: String,
    /// Cached tool summaries from the last successful discovery.
    pub tool_summaries: Vec<ToolSummary>,
    /// `ConnectorConnection.tools_discovered_at`.
    pub tools_discovered_at: Option<NaiveDateTime>,
    /// `ConnectorConnection.last_error`: the extracted failure message.
    pub last_error: Option<String>,
}

impl ConnectorConnection {
    /// `_row_to_connection`: decode one `ConnectorConnection` kinds row.
    pub(crate) fn from_row(row: &KindRow) -> Self {
        let spec = row
            .kinds_json
            .0
            .project::<ConnectionDocument>()
            .and_then(|document| document.spec)
            .unwrap_or_default();
        Self {
            status: if spec.status.is_empty() {
                "disconnected".to_string()
            } else {
                spec.status
            },
            external_account_name: spec.external_account_name,
            granted_scopes: spec.granted_scopes,
            expires_at: spec.expires_at.as_deref().and_then(parse_expires_at),
            access_token_encrypted: spec.access_token_encrypted,
            refresh_token_encrypted: spec
                .refresh_token_encrypted
                .filter(|value| !value.is_empty()),
            token_type: if spec.token_type.is_empty() {
                "bearer".to_string()
            } else {
                spec.token_type
            },
            tool_summaries: spec
                .tool_summaries
                .into_iter()
                .map(|tool| ToolSummary {
                    name: tool.name,
                    title: tool.title,
                    description: tool.description,
                    raw_tool_name: tool.raw_tool_name,
                    input_schema: tool.input_schema,
                })
                .collect(),
            tools_discovered_at: spec
                .tools_discovered_at
                .as_deref()
                .and_then(parse_expires_at),
            last_error: parse_last_error(spec.last_error.as_ref()),
        }
    }

    /// `ConnectorConnection.access_token`: decrypt the stored credential.
    ///
    /// `decrypt_sensitive_data` echoes the ciphertext back when the configured
    /// key cannot read it; sending that as a bearer token only produces an
    /// upstream 401, so it answers `""` and the caller reports a configuration
    /// fault rather than a missing grant.
    pub(crate) fn access_token(
        &self,
    ) -> Result<String, crate::subscriptions_item::crypto::CryptoError> {
        let decrypted = crate::subscriptions_item::crypto::decrypt_sensitive_data(
            &self.access_token_encrypted,
        )?;
        Ok(if decrypted == self.access_token_encrypted {
            String::new()
        } else {
            decrypted
        })
    }

    /// `ConnectorConnection.refresh_token`: the decrypted refresh token, or
    /// `None` when the configured key cannot read the stored ciphertext.
    pub(crate) fn refresh_token(&self) -> Option<String> {
        let encrypted = self.refresh_token_encrypted.as_deref()?;
        let decrypted =
            crate::subscriptions_item::crypto::decrypt_sensitive_data(encrypted).ok()?;
        (!decrypted.is_empty() && decrypted != encrypted).then_some(decrypted)
    }

    /// `_cached_tools`: the cached tool surface while it is still fresh, or
    /// `None` when discovery has to run again.
    pub(crate) fn cached_tool_entries(
        &self,
        slug: &str,
        allowlist: &[String],
    ) -> Option<Vec<Value>> {
        if self.tool_summaries.is_empty() {
            return None;
        }
        let discovered_at = self.tools_discovered_at?;
        let age = Utc::now().naive_utc() - discovered_at;
        if age > chrono::TimeDelta::seconds(TOOL_CACHE_TTL_SECONDS) {
            return None;
        }
        Some(
            self.tool_summaries
                .iter()
                .filter_map(|summary| {
                    let raw_name = summary
                        .raw_tool_name
                        .as_deref()
                        .filter(|name| !name.is_empty())?;
                    if !allowlist.is_empty() && !allowlist.iter().any(|tool| tool == raw_name) {
                        return None;
                    }
                    let name = if summary.name.is_empty() {
                        format!("{slug}__{raw_name}")
                    } else {
                        summary.name.clone()
                    };
                    let mut entry = serde_json::json!({
                        "name": name,
                        "description": summary.description,
                        "inputSchema": summary
                            .input_schema
                            .as_ref()
                            .map(brz_json::OpaqueJson::to_value)
                            .unwrap_or_else(default_input_schema),
                    });
                    if let Some(title) = summary.title.as_deref().filter(|title| !title.is_empty())
                    {
                        entry["title"] = Value::String(title.to_string());
                    }
                    Some(entry)
                })
                .collect(),
        )
    }
}

/// `{"type": "object", "properties": {}}`: the schema the source substitutes
/// for a tool that declares none.
pub(crate) fn default_input_schema() -> Value {
    serde_json::json!({"type": "object", "properties": {}})
}

/// `ConnectorConnectionService.is_usable`: a connected grant, or an expired one
/// whose stored refresh token can still renew it.
pub(crate) fn is_usable(connection: Option<&ConnectorConnection>) -> bool {
    let Some(connection) = connection else {
        return false;
    };
    match response(Some(connection)).status.as_str() {
        "connected" => true,
        "expired" => connection.refresh_token().is_some(),
        _ => false,
    }
}

/// `_parse_last_error`: an object's non-empty `message`, or a non-empty string.
fn parse_last_error(value: Option<&brz_json::OpaqueJson>) -> Option<String> {
    let value = value?;
    if let Some(message) = value.project::<String>() {
        return (!message.is_empty()).then_some(message);
    }
    let object = value.project::<LastErrorMessage>()?;
    object.message.filter(|message| !message.is_empty())
}

/// The `record_tool_error` payload (`{"message": ..., "at": ...}`).
#[derive(Debug, serde::Deserialize)]
struct LastErrorMessage {
    message: Option<String>,
}

/// `datetime.fromisoformat(raw.replace("Z", "+00:00"))`, then `.replace(tzinfo=None)`:
/// a timezone suffix is dropped without converting the wall-clock value.
fn parse_expires_at(raw: &str) -> Option<NaiveDateTime> {
    if raw.is_empty() {
        return None;
    }
    let normalized = raw.replace('Z', "+00:00");
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&normalized) {
        // `replace(tzinfo=None)` drops the offset; it does not convert.
        return Some(parsed.naive_local());
    }
    NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f").ok()
}

/// Pydantic's naive-datetime wire form (`2026-10-16T09:01:23.898264`).
pub(crate) fn render_datetime(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.f").to_string()
}

/// `ConnectorConnectionService.response`: a missing connection answers
/// `disconnected`; a stored `connected` status past its expiry answers
/// `expired`.
pub(crate) fn response(connection: Option<&ConnectorConnection>) -> ConnectionResponse {
    let Some(connection) = connection else {
        return ConnectionResponse {
            status: "disconnected".to_string(),
            external_account_name: None,
            granted_scopes: Vec::new(),
            expires_at: None,
            last_error: None,
            last_discovered_at: None,
            tool_count: 0,
        };
    };
    let mut status = connection.status.clone();
    if status == "connected"
        && connection
            .expires_at
            .is_some_and(|expires_at| expires_at <= Utc::now().naive_utc())
    {
        status = "expired".to_string();
    }
    ConnectionResponse {
        status,
        external_account_name: connection.external_account_name.clone(),
        granted_scopes: connection.granted_scopes.clone(),
        expires_at: connection.expires_at.map(render_datetime),
        last_error: connection.last_error.clone(),
        last_discovered_at: connection.tools_discovered_at.map(render_datetime),
        tool_count: connection.tool_summaries.len(),
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use serde_json::Value;

    use super::*;
    use crate::subscriptions_item::crypto::encrypt_sensitive_data;

    fn row(spec: Value) -> KindRow {
        KindRow {
            kinds_id: 1892924,
            kinds_user_id: 2230,
            kinds_kind: "ConnectorConnection".to_string(),
            kinds_name: "dingtalk-mcp-generic".to_string(),
            kinds_namespace: "system".to_string(),
            kinds_json: brz_mysql::Json(
                Value::Object(
                    [
                        (
                            "kind".to_string(),
                            Value::String("ConnectorConnection".to_string()),
                        ),
                        ("spec".to_string(), spec),
                    ]
                    .into_iter()
                    .collect(),
                )
                .into(),
            ),
            kinds_is_active: true,
            kinds_created_at: NaiveDateTime::default(),
            kinds_updated_at: NaiveDateTime::default(),
        }
    }

    fn iso(value: NaiveDateTime) -> String {
        value.format("%Y-%m-%dT%H:%M:%S%.f").to_string()
    }

    #[test]
    fn decodes_the_stored_spec() {
        let connection = ConnectorConnection::from_row(&row(serde_json::json!({
            "status": "connected",
            "expiresAt": "2026-10-16T09:01:23.898264",
            "tokenType": "Bearer",
            "grantedScopes": ["user"],
            "accessTokenEncrypted": "***",
        })));
        assert_eq!(connection.status, "connected");
        assert_eq!(connection.granted_scopes, vec!["user".to_string()]);
        assert_eq!(
            connection.expires_at.map(iso).as_deref(),
            Some("2026-10-16T09:01:23.898264")
        );
        assert_eq!(connection.token_type, "Bearer");
        // `decrypt_sensitive_data` passes "***" through unchanged, so the
        // source's `access_token()` reads it as no credential either.
        assert_eq!(connection.access_token().unwrap(), "");
    }

    #[test]
    fn defaults_missing_spec_members() {
        let connection = ConnectorConnection::from_row(&row(serde_json::json!({})));
        assert_eq!(connection.status, "disconnected");
        assert!(connection.granted_scopes.is_empty());
        assert_eq!(connection.expires_at, None);
        assert_eq!(connection.access_token().unwrap(), "");
    }

    #[test]
    fn a_stored_expiry_turns_connected_into_expired() {
        let expired = ConnectorConnection::from_row(&row(serde_json::json!({
            "status": "connected",
            "expiresAt": iso(Utc::now().naive_utc() - Duration::days(2)),
        })));
        assert_eq!(response(Some(&expired)).status, "expired");

        let connected = ConnectorConnection::from_row(&row(serde_json::json!({
            "status": "connected",
            "expiresAt": iso(Utc::now().naive_utc() + Duration::hours(1)),
        })));
        assert_eq!(response(Some(&connected)).status, "connected");
    }

    #[test]
    fn missing_connection_is_disconnected() {
        let view = response(None);
        assert_eq!(view.status, "disconnected");
        assert!(view.granted_scopes.is_empty());
        assert_eq!(view.expires_at, None);
    }

    #[test]
    fn response_forwards_the_recorded_view() {
        let expires_at = iso(Utc::now().naive_utc() + Duration::hours(1));
        let connection = ConnectorConnection::from_row(&row(serde_json::json!({
            "status": "connected",
            "expiresAt": expires_at,
            "externalAccountName": "chenbo",
            "grantedScopes": ["user"],
        })));
        let view = response(Some(&connection));
        assert_eq!(view.status, "connected");
        assert_eq!(view.external_account_name.as_deref(), Some("chenbo"));
        assert_eq!(view.expires_at.as_deref(), Some(expires_at.as_str()));
    }

    #[test]
    fn response_carries_the_discovery_state() {
        let discovered_at = iso(Utc::now().naive_utc());
        let connection = ConnectorConnection::from_row(&row(serde_json::json!({
            "status": "connected",
            "toolsDiscoveredAt": discovered_at,
            "lastError": {"message": "upstream unavailable", "at": discovered_at},
            "toolSummaries": [
                {"name": "dws__list", "title": null, "description": "d", "rawToolName": "list"}
            ],
        })));
        let view = response(Some(&connection));

        assert_eq!(view.last_error.as_deref(), Some("upstream unavailable"));
        assert_eq!(
            view.last_discovered_at.as_deref(),
            Some(discovered_at.as_str())
        );
        assert_eq!(view.tool_count, 1);
    }

    #[test]
    fn last_error_accepts_a_bare_string_and_ignores_empty_values() {
        let message = ConnectorConnection::from_row(&row(serde_json::json!({
            "lastError": "boom",
        })));
        assert_eq!(message.last_error.as_deref(), Some("boom"));

        let empty = ConnectorConnection::from_row(&row(serde_json::json!({
            "lastError": "",
        })));
        assert_eq!(empty.last_error, None);

        let cleared = ConnectorConnection::from_row(&row(serde_json::json!({
            "lastError": null,
        })));
        assert_eq!(cleared.last_error, None);

        let shape = ConnectorConnection::from_row(&row(serde_json::json!({
            "lastError": {"message": ""},
        })));
        assert_eq!(shape.last_error, None);
    }

    fn cached(discovered_at: String) -> ConnectorConnection {
        ConnectorConnection::from_row(&row(serde_json::json!({
            "status": "connected",
            "toolsDiscoveredAt": discovered_at,
            "toolSummaries": [
                {
                    "name": "dingtalk__list",
                    "title": "List",
                    "description": "List bases",
                    "rawToolName": "list",
                    "inputSchema": {"type": "object", "properties": {}},
                },
                {"name": "dingtalk__delete", "rawToolName": "delete"},
            ],
        })))
    }

    /// `_cached_tools`: a fresh surface is served without another discovery.
    #[test]
    fn a_fresh_cache_is_served() {
        let entries = cached(iso(Utc::now().naive_utc()))
            .cached_tool_entries("dingtalk", &[])
            .expect("fresh cache");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["name"], serde_json::json!("dingtalk__list"));
        assert_eq!(entries[0]["title"], serde_json::json!("List"));
        assert_eq!(
            entries[0]["inputSchema"],
            serde_json::json!({"type": "object", "properties": {}})
        );
        // A summary without a schema still exposes the source's default.
        assert_eq!(
            entries[1]["inputSchema"],
            serde_json::json!({"type": "object", "properties": {}})
        );
    }

    /// `TOOL_CACHE_TTL_SECONDS`: an older surface must be rediscovered.
    #[test]
    fn a_stale_cache_is_ignored() {
        let stale = iso(Utc::now().naive_utc() - Duration::seconds(TOOL_CACHE_TTL_SECONDS + 1));
        assert!(cached(stale).cached_tool_entries("dingtalk", &[]).is_none());
    }

    /// The administrator's allowlist still bounds a cached surface.
    #[test]
    fn a_cached_surface_respects_the_allowlist() {
        let entries = cached(iso(Utc::now().naive_utc()))
            .cached_tool_entries("dingtalk", &["list".to_string()])
            .expect("fresh cache");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], serde_json::json!("dingtalk__list"));
    }

    /// `_cached_tools` derives the name from the slug when a summary omits it.
    #[test]
    fn a_summary_without_a_name_uses_the_app_slug() {
        let connection = ConnectorConnection::from_row(&row(serde_json::json!({
            "status": "connected",
            "toolsDiscoveredAt": iso(Utc::now().naive_utc()),
            "toolSummaries": [{"rawToolName": "list"}],
        })));
        let entries = connection
            .cached_tool_entries("dingtalk", &[])
            .expect("fresh cache");

        assert_eq!(entries[0]["name"], serde_json::json!("dingtalk__list"));
    }

    /// An expired grant stays usable while a refresh token can renew it, and
    /// stops being usable once that token is gone.
    #[test]
    fn is_usable_keeps_an_expired_grant_with_a_refresh_token() {
        crate::subscriptions_item::crypto::use_test_key();
        let expired: ConnectorConnection = ConnectorConnection::from_row(&row(serde_json::json!({
            "status": "connected",
            "expiresAt": "2020-01-01T00:00:00",
            "accessTokenEncrypted": encrypt_sensitive_data("access").unwrap(),
            "refreshTokenEncrypted": encrypt_sensitive_data("refresh").unwrap(),
        })));
        assert_eq!(response(Some(&expired)).status, "expired");
        assert!(is_usable(Some(&expired)));

        let without_refresh = ConnectorConnection::from_row(&row(serde_json::json!({
            "status": "connected",
            "expiresAt": "2020-01-01T00:00:00",
            "accessTokenEncrypted": encrypt_sensitive_data("access").unwrap(),
        })));
        assert!(!is_usable(Some(&without_refresh)));
        assert!(!is_usable(None));
    }

    /// A ciphertext the key cannot read is missing, not a credential to send.
    #[test]
    fn undecryptable_credentials_read_as_empty() {
        let stored = ConnectorConnection::from_row(&row(serde_json::json!({
            "status": "connected",
            "accessTokenEncrypted": "bm90LWEtcmVhbC1jaXBoZXJ0ZXh0",
            "refreshTokenEncrypted": "bm90LWEtcmVhbC1jaXBoZXJ0ZXh0",
        })));
        assert_eq!(stored.access_token().unwrap(), "");
        assert_eq!(stored.refresh_token(), None);
    }
}
