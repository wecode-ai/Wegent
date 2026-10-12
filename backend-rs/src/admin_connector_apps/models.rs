// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Response model for `GET /api/admin/connector-apps`.
//!
//! Mirrors `ConnectorAppAdminResponse` in `app/schemas/connector.py`. Serde
//! serializes the fields in declaration order with their snake_case names, so
//! the object matches pydantic's key order and wire names.
use serde::Serialize;

use crate::json_compat::OpaqueJson;

/// `ConnectorAppAdminResponse`.
#[derive(Debug, Serialize)]
pub struct ConnectorAppAdminResponse {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub enabled: bool,
    pub visibility: String,
    pub allowed_roles: Vec<String>,
    pub auth_type: String,
    pub transport: String,
    pub mcp_url: String,
    pub provider_header_names: Vec<String>,
    pub provider_headers_configured: bool,
    pub forward_user_context_headers: bool,
    pub tool_allowlist: Vec<String>,
    /// The source stores `httpTools` as the serialized
    /// `ConnectorHttpToolDefinition` models (`model_dump(mode="json")` at
    /// write time), so each entry already carries every field in declaration
    /// order and is echoed verbatim.
    pub http_tools: Vec<OpaqueJson>,
    pub connection_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// The pydantic `datetime` rendering (`datetime.isoformat()`): a naive
/// datetime serializes as `YYYY-MM-DDTHH:MM:SS`, with a six-digit
/// microsecond fraction only when the stored value has one.
pub fn isoformat(value: chrono::NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_micros() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn datetime(micros: u32) -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 7, 30)
            .unwrap()
            .and_hms_opt(13, 5, 35)
            .unwrap()
            + chrono::Duration::microseconds(i64::from(micros))
    }

    #[test]
    fn isoformat_matches_pydantic() {
        assert_eq!(isoformat(datetime(0)), "2026-07-30T13:05:35");
        assert_eq!(isoformat(datetime(123_456)), "2026-07-30T13:05:35.123456");
        // Trailing-zero microseconds still render all six digits.
        assert_eq!(isoformat(datetime(1)), "2026-07-30T13:05:35.000001");
    }

    #[test]
    fn response_field_order_matches_the_source_model() {
        let response = ConnectorAppAdminResponse {
            id: 7,
            slug: "example-app".to_string(),
            name: "Example App".to_string(),
            description: "d".to_string(),
            icon_url: None,
            enabled: true,
            visibility: "all".to_string(),
            allowed_roles: Vec::new(),
            auth_type: "none".to_string(),
            transport: "streamable-http".to_string(),
            mcp_url: "http://example.invalid/mcp".to_string(),
            provider_header_names: Vec::new(),
            provider_headers_configured: false,
            forward_user_context_headers: true,
            tool_allowlist: Vec::new(),
            http_tools: Vec::new(),
            connection_count: 0,
            created_at: "2026-01-02T03:04:05".to_string(),
            updated_at: "2026-02-03T04:05:06".to_string(),
        };
        let body = serde_json::to_string(&response).unwrap();
        assert_eq!(
            body,
            r#"{"id":7,"slug":"example-app","name":"Example App","description":"d","icon_url":null,"enabled":true,"visibility":"all","allowed_roles":[],"auth_type":"none","transport":"streamable-http","mcp_url":"http://example.invalid/mcp","provider_header_names":[],"provider_headers_configured":false,"forward_user_context_headers":true,"tool_allowlist":[],"http_tools":[],"connection_count":0,"created_at":"2026-01-02T03:04:05","updated_at":"2026-02-03T04:05:06"}"#
        );
    }
}
