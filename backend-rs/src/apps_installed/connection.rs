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

use super::db::KindRow;
use super::models::ConnectionResponse;

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
        }
    }

    /// `ConnectorConnection.access_token`: decrypt the stored credential.
    /// Every value the source's `decrypt_sensitive_data` cannot decrypt is
    /// returned unchanged; only missing crypto configuration is an error.
    pub(crate) fn access_token(
        &self,
    ) -> Result<String, crate::subscriptions_item::crypto::CryptoError> {
        crate::subscriptions_item::crypto::decrypt_sensitive_data(&self.access_token_encrypted)
    }
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
fn render_datetime(value: NaiveDateTime) -> String {
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
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use serde_json::Value;

    use super::*;

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
        assert_eq!(connection.access_token().unwrap(), "***");
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
}
