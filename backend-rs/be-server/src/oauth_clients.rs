// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/oauth-clients` — the developer self-service OAuth client listing.
//!
//! Port of `app.api.endpoints.oauth_clients.list_oauth_clients`
//! (`app/api/endpoints/oauth_clients.py`) with
//! `app.services.auth.oauth_provider.OAuthProviderService.list_clients` and its
//! `_to_client_response` helper.
//!
//! Flow: `app.core.security.get_current_user` authenticates the bearer session
//! (the active `users` row by name); the service lists the caller's
//! `OAuthClient` CRDs
//! (`kinds.kind = 'OAuthClient' AND kinds.namespace = 'system' AND
//! kinds.user_id = <current user>`, ordered `created_at` descending); each row
//! renders as an `OAuthClientResponse`, resolving the owner's `user_name` with
//! one `users` lookup per row, wrapped in an `OAuthClientListResponse`
//! (`app/schemas/oauth_provider.py`).
//!
//! Recorded source evidence (`api-oauth-clients/dbccb0a8`): the authenticated
//! `users` lookup by user name, the `kinds` client scan returning no rows, and
//! the two trailing `ROLLBACK` session cleanups. The body is the empty list
//! `{"items":[],"total":0}`.

use brz_json::FieldState as _;
use brz_json::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::user_reader::USER_BY_ID_QUERY;

/// `oauth_provider_service.OAUTH_CLIENT_KIND` (`app/schemas/oauth_provider.py`).
const OAUTH_CLIENT_KIND: &str = "OAuthClient";
/// `outbound_token_service.SYSTEM_NAMESPACE`.
const SYSTEM_NAMESPACE: &str = "system";

/// `kinds` columns as rendered by `db.query(Kind)` (SQLAlchemy labels every
/// column `kinds_<name>`).
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, kinds.created_at AS \
     kinds_created_at, kinds.updated_at AS kinds_updated_at";

/// One `kinds` row of the client scan. Only the members the response reads are
/// declared; the remaining selected columns stay in the statement so the
/// rendered SQL matches the recorded exchange.
#[derive(Debug, FromMysqlRow)]
struct ClientKindRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_user_id")]
    user_id: i64,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_namespace")]
    namespace: String,
    #[mysql(rename = "kinds_json")]
    json: Json<OpaqueJson>,
    #[mysql(rename = "kinds_is_active")]
    is_active: i8,
    #[mysql(rename = "kinds_created_at")]
    created_at: NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    updated_at: NaiveDateTime,
}

/// `OAuthClientListResponse` (`app/schemas/oauth_provider.py`). Pydantic keeps
/// every member present, so the empty case renders `{"items":[],"total":0}`.
#[derive(Debug, Serialize)]
struct OAuthClientListResponse {
    items: Vec<OAuthClientResponse>,
    total: usize,
}

/// `OAuthClientResponse` in pydantic field-declaration order. Nullable members
/// serialize as JSON null.
#[derive(Debug, Serialize)]
struct OAuthClientResponse {
    id: i64,
    name: String,
    namespace: String,
    owner_user_id: i64,
    owner_user_name: Option<String>,
    client_id: String,
    client_type: String,
    redirect_uris: Vec<String>,
    description: String,
    is_active: bool,
    created_at: String,
    updated_at: String,
    client_secret: Option<String>,
}

/// The stored `kinds.json` document. `_to_client_response` reads only `spec`.
#[brz_json::model]
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ClientDocument {
    #[json(presence, lenient)]
    spec: ClientSpec,
}

/// The `OAuthClientSpec` members the response reads. Presence-aware fields keep
/// the distinction between an absent member and a present member of the wrong
/// shape, so a present value is reported the way pydantic rejects it.
#[brz_json::model]
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ClientSpec {
    #[serde(rename = "clientId")]
    #[json(presence, lenient)]
    client_id: String,
    #[serde(rename = "clientType")]
    #[json(presence, lenient)]
    client_type: String,
    #[serde(rename = "redirectUris")]
    #[json(presence, lenient)]
    redirect_uris: Vec<String>,
    #[json(presence, lenient)]
    description: String,
    #[json(presence, lenient)]
    enabled: bool,
}

/// GET /api/oauth-clients: the client list as a free function injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/oauth-clients")]
async fn list_oauth_clients_route(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<OAuthClientListResponse, FastApiError> {
    list_oauth_clients(state, current_user.0).await
}

/// Handler body for `GET /api/oauth-clients`.
async fn list_oauth_clients(
    state: &AppState,
    current_user: UserRow,
) -> Result<OAuthClientListResponse, FastApiError> {
    let rows: Vec<ClientKindRow> = state
        .mysql
        .fetch_all(clients_sql(), (i64::from(current_user.id),))
        .await
        .map_err(internal)?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        items.push(to_client_response(state, row).await?);
    }
    let total = items.len();
    Ok(OAuthClientListResponse { items, total })
}

/// `db.query(Kind).filter(kind == 'OAuthClient', namespace == 'system',
/// user_id == <current>).order_by(Kind.created_at.desc()).all()`.
fn clients_sql() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = '{OAUTH_CLIENT_KIND}' \
         AND kinds.namespace = '{SYSTEM_NAMESPACE}' AND kinds.user_id = ? \
         ORDER BY kinds.created_at DESC"
    )
}

/// `_to_client_response`: parse the row's CRD, resolve its owner, and render
/// the response item.
async fn to_client_response(
    state: &AppState,
    row: ClientKindRow,
) -> Result<OAuthClientResponse, FastApiError> {
    let spec = parse_spec(&row)?;
    // `db.query(User).filter(User.id == row.user_id).first()`.
    let owner: Option<UserRow> = state
        .mysql
        .fetch_optional(USER_BY_ID_QUERY, (row.user_id,))
        .await
        .map_err(internal)?;
    build_response(row, spec, owner.map(|user| user.user_name))
}

/// Parse `kinds.json` and its `spec` member. A non-object document or a present
/// `spec` that is not a mapping is the source's unhandled error
/// (`OAuthClientKind.model_validate` would raise).
fn parse_spec(row: &ClientKindRow) -> Result<ClientSpec, FastApiError> {
    let document: Option<ClientDocument> = row.json.0.project();
    let document = document.ok_or_else(unhandled)?;
    match (document.spec.is_present(), document.spec.into_value()) {
        (false, _) => Ok(ClientSpec::default()),
        (true, None) => Err(unhandled()),
        (true, Some(spec)) => Ok(spec),
    }
}

/// Project one row and its validated spec into the response item. `clientId`,
/// `clientType`, and `redirectUris` are required by the pydantic model, so an
/// absent or wrong-shaped member is the source's validation failure;
/// `description` defaults to the empty string and `enabled` to `true`.
fn build_response(
    row: ClientKindRow,
    spec: ClientSpec,
    owner_user_name: Option<String>,
) -> Result<OAuthClientResponse, FastApiError> {
    let client_id = spec.client_id.value().cloned().ok_or_else(unhandled)?;
    let client_type = match spec.client_type.value().map(String::as_str) {
        Some("public") => "public".to_owned(),
        Some("confidential") => "confidential".to_owned(),
        _ => return Err(unhandled()),
    };
    let redirect_uris = spec.redirect_uris.value().cloned().ok_or_else(unhandled)?;
    let description = spec.description.value().cloned().unwrap_or_default();
    let enabled = spec.enabled.value().copied().unwrap_or(true);

    Ok(OAuthClientResponse {
        id: row.id,
        name: row.name,
        namespace: row.namespace,
        owner_user_id: row.user_id,
        owner_user_name,
        client_id,
        client_type,
        redirect_uris,
        description,
        // `row.is_active and client.spec.enabled`.
        is_active: row.is_active != 0 && enabled,
        created_at: pydantic_datetime(row.created_at),
        updated_at: pydantic_datetime(row.updated_at),
        // The listing never echoes a freshly minted secret.
        client_secret: None,
    })
}

/// pydantic v2 naive `datetime` serialization: `YYYY-MM-DDTHH:MM:SS`
/// (microseconds appended only when non-zero).
fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.f").to_string()
    }
}

/// Dependent-query failure mapped to the source `python_exception_handler`
/// body (`{"error_code": 500, "detail": "Internal server error"}`).
fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "oauth-client list database dependency failure");
    unhandled()
}

/// The application's `python_exception_handler` body for an unmapped failure.
fn unhandled() -> FastApiError {
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_json::OpaqueJson;
    use chrono::NaiveDate;

    fn row(id: i64, user_id: i64, is_active: i8, json: &str) -> ClientKindRow {
        ClientKindRow {
            id,
            user_id,
            name: "my-client".to_owned(),
            namespace: "system".to_owned(),
            json: Json(OpaqueJson::from_json_text(json).unwrap()),
            is_active,
            created_at: NaiveDate::from_ymd_opt(2026, 4, 22)
                .unwrap()
                .and_hms_opt(22, 19, 21)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 4, 21)
                .unwrap()
                .and_hms_opt(17, 20, 33)
                .unwrap(),
        }
    }

    fn client() -> String {
        r#"{
            "apiVersion": "agent.wecode.io/v1",
            "kind": "OAuthClient",
            "metadata": {"name": "portal", "namespace": "system"},
            "spec": {
                "clientId": "portal-client-id",
                "clientType": "public",
                "redirectUris": ["https://example.com/callback"],
                "tokenIssuerRef": {"kindId": 7},
                "description": "demo",
                "enabled": true
            }
        }"#
        .to_owned()
    }

    #[test]
    fn clients_query_matches_the_recorded_projection() {
        let sql = clients_sql();
        for label in [
            "kinds_id",
            "kinds_user_id",
            "kinds_kind",
            "kinds_name",
            "kinds_namespace",
            "kinds_json",
            "kinds_is_active",
            "kinds_created_at",
            "kinds_updated_at",
        ] {
            assert!(sql.contains(label), "missing {label}");
        }
        assert_eq!(sql.matches('?').count(), 1);
        assert!(sql.contains("kinds.kind = 'OAuthClient'"));
        assert!(sql.contains("kinds.namespace = 'system'"));
        assert!(sql.contains("AND kinds.user_id = ?"));
        assert!(sql.ends_with("ORDER BY kinds.created_at DESC"));
    }

    #[test]
    fn empty_list_renders_the_recorded_body() {
        let response = OAuthClientListResponse {
            items: Vec::new(),
            total: 0,
        };
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            r#"{"items":[],"total":0}"#
        );
    }

    #[test]
    fn renders_each_client_in_pydantic_field_order() {
        // Arrange
        let client_row = row(42, 60, 1, &client());

        // Act
        let spec = parse_spec(&client_row).unwrap();
        let item = build_response(client_row, spec, Some("example-owner".to_owned())).unwrap();
        let rendered = serde_json::to_string(&item).unwrap();

        // Assert
        assert_eq!(
            rendered,
            concat!(
                r#"{"id":42,"name":"my-client","namespace":"system","owner_user_id":60,"#,
                r#""owner_user_name":"example-owner","client_id":"portal-client-id","#,
                r#""client_type":"public","redirect_uris":["https://example.com/callback"],"#,
                r#""description":"demo","is_active":true,"created_at":"2026-04-22T22:19:21","#,
                r#""updated_at":"2026-04-21T17:20:33","client_secret":null}"#
            )
        );
    }

    #[test]
    fn inactive_row_or_disabled_client_is_inactive() {
        // Arrange / Act / Assert: the column alone disables the client.
        let inactive_row = row(1, 60, 0, &client());
        let spec = parse_spec(&inactive_row).unwrap();
        assert!(!build_response(inactive_row, spec, None).unwrap().is_active);

        // Arrange / Act / Assert: the CRD's `enabled` also disables it.
        let disabled = client().replace("\"enabled\": true", "\"enabled\": false");
        let disabled_row = row(1, 60, 1, &disabled);
        let spec = parse_spec(&disabled_row).unwrap();
        assert!(!build_response(disabled_row, spec, None).unwrap().is_active);
    }

    #[test]
    fn missing_or_wrong_shaped_required_members_are_unhandled() {
        // Absent `clientId`.
        let missing_client_id_row = row(
            1,
            60,
            1,
            r#"{"spec": {"clientType": "public", "redirectUris": ["https://a.example"]}}"#,
        );
        let spec = parse_spec(&missing_client_id_row).unwrap();
        assert!(build_response(missing_client_id_row, spec, None).is_err());

        // A `clientType` outside the pydantic `Literal`.
        let bad_type_row = row(
            1,
            60,
            1,
            r#"{"spec": {"clientId": "abcdefgh", "clientType": "other", "redirectUris": ["https://a.example"]}}"#,
        );
        let spec = parse_spec(&bad_type_row).unwrap();
        assert!(build_response(bad_type_row, spec, None).is_err());
    }

    #[test]
    fn malformed_document_is_unhandled() {
        // A non-object `kinds.json` is the source's validation failure.
        let malformed_row = row(1, 60, 1, "[1,2,3]");
        assert!(parse_spec(&malformed_row).is_err());
    }
}
