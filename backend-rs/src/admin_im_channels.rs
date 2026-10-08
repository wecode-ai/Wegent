// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Admin IM channel listing for `GET /api/admin/im-channels`.
//!
//! Mirrors `app.api.endpoints.admin.im_channels.list_im_channels`. The route is
//! protected by `get_admin_user` (`app.core.security`): the bearer token is
//! resolved to a session user first, then the `admin` role is required with
//! `403 {"detail": "Permission denied. Admin access required."}` otherwise.
//!
//! The handler reads every active `Messager` `Kind` row owned by the system
//! (`user_id = 0`) ordered by `id` descending, filters by `channel_type` in
//! process (the JSON spec is not indexed), slices the requested page, and
//! renders `IMChannelListResponse`. Sensitive `config` keys are masked with
//! `***` before rendering (the source never decrypts them on the list path).
use brz_mysql::{FromMysqlRow, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::json_compat::JsonProjection;
use crate::state::AppState;

/// Config keys whose values are masked in API responses
/// (`SENSITIVE_CONFIG_KEYS`). A key is sensitive when its lowercased form
/// contains any entry as a substring.
const SENSITIVE_CONFIG_KEYS: [&str; 8] = [
    "client_secret",
    "secret",
    "token",
    "access_token",
    "app_secret",
    "encrypt_key",
    "encoding_aes_key",
    "bot_token",
];

/// `_is_sensitive_key`: substring match over the lowercased key.
fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SENSITIVE_CONFIG_KEYS
        .iter()
        .any(|sensitive| lower.contains(sensitive))
}

/// `_mask_config`: replace every sensitive value with `***`, preserving the
/// stored key order so the response matches the source dictionary order.
fn mask_config(config: &Map<String, Value>) -> Map<String, Value> {
    config
        .iter()
        .map(|(key, value)| {
            if is_sensitive_key(key) {
                (key.clone(), Value::String("***".to_owned()))
            } else {
                (key.clone(), value.clone())
            }
        })
        .collect()
}

/// pydantic naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS`, plus the
/// zero-padded microsecond fraction when nonzero.
fn pydantic_datetime(value: chrono::NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    let micros = value.and_utc().timestamp_subsec_micros();
    if micros == 0 {
        base
    } else {
        format!("{base}.{micros:06}")
    }
}

/// Query parameters of the listing endpoint.
///
/// `page` and `limit` are validated like FastAPI query integers (`page >= 1`,
/// `1 <= limit <= 100`) so out-of-range values render the source 422 body.
#[derive(Debug, Default, Deserialize)]
pub struct ImChannelListQuery {
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub channel_type: Option<String>,
}

/// Validated pagination and filter parameters.
#[derive(Debug)]
struct ListParams {
    page: i64,
    limit: i64,
    channel_type: Option<String>,
}

impl ImChannelListQuery {
    /// Validate the FastAPI query contract. Defaults: `page = 1`, `limit = 20`.
    fn validated(self) -> Result<ListParams, FastApiError> {
        let page = parse_query_int(self.page.as_deref(), "page", 1, Some(1), None)?;
        let limit = parse_query_int(self.limit.as_deref(), "limit", 20, Some(1), Some(100))?;
        Ok(ListParams {
            page,
            limit,
            channel_type: self.channel_type,
        })
    }
}

/// Parse an optional integer query parameter with FastAPI/pydantic
/// `int_parsing` and range (`greater_than_equal`/`less_than_equal`) errors.
fn parse_query_int(
    raw: Option<&str>,
    field: &str,
    default: i64,
    min: Option<i64>,
    max: Option<i64>,
) -> Result<i64, FastApiError> {
    let Some(value) = raw else {
        return Ok(default);
    };
    let parsed = value.parse::<i64>().map_err(|_| {
        validation_error(
            field,
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
        )
    })?;
    if let Some(min) = min
        && parsed < min
    {
        return Err(validation_error(
            field,
            "greater_than_equal",
            &format!("Input should be greater than or equal to {min}"),
        ));
    }
    if let Some(max) = max
        && parsed > max
    {
        return Err(validation_error(
            field,
            "less_than_equal",
            &format!("Input should be less than or equal to {max}"),
        ));
    }
    Ok(parsed)
}

/// FastAPI-style 422 validation error body.
fn validation_error(field: &str, kind: &str, message: &str) -> FastApiError {
    FastApiError::validation(json!([
        {
            "type": kind,
            "loc": ["query", field],
            "msg": message,
            "input": null,
        }
    ]))
}

/// A `Messager` `kinds` row selected with the full labeled source column list
/// (`db.query(Kind)`); only `id`, `name`, `namespace`, `json`, and the
/// timestamps are consumed.
#[derive(Debug, FromMysqlRow)]
struct MessagerKindRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_user_id")]
    user_id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_kind")]
    kind: String,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_namespace")]
    namespace: String,
    #[mysql(rename = "kinds_json")]
    json: Json<JsonProjection<MessagerInput>>,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_is_active")]
    is_active: i8,
    #[mysql(rename = "kinds_created_at")]
    created_at: chrono::NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    updated_at: chrono::NaiveDateTime,
}

/// The source listing query: active system `Messager` rows newest first. All
/// values are source constants and therefore inline; the statement runs with
/// no bind parameters.
const MESSAGER_LIST_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.kind = 'Messager' \
     AND kinds.user_id = 0 AND kinds.is_active = true ORDER BY kinds.id DESC";

/// Messager CRD document (`kinds.json`).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct MessagerInput {
    spec: Option<MessagerSpec>,
}

/// Messager `spec` fields consumed by the response renderer.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct MessagerSpec {
    #[serde(rename = "channelType")]
    channel_type: Option<String>,
    #[serde(rename = "isEnabled")]
    is_enabled: Option<bool>,
    config: Option<Map<String, Value>>,
    #[serde(rename = "defaultTeamId")]
    default_team_id: Option<i64>,
    #[serde(rename = "defaultModelName")]
    default_model_name: Option<String>,
}

/// `IMChannelListResponse` — the top-level JSON body.
#[derive(Debug, Serialize)]
struct ImChannelListResponse {
    total: usize,
    items: Vec<ImChannelResponse>,
}

/// `IMChannelResponse` in pydantic field declaration order.
#[derive(Debug, Serialize)]
struct ImChannelResponse {
    id: i64,
    name: String,
    namespace: String,
    channel_type: String,
    is_enabled: bool,
    config: Map<String, Value>,
    default_team_id: i64,
    default_model_name: String,
    created_at: String,
    updated_at: String,
}

/// The `spec` of a row, or the empty default when the CRD is absent or of the
/// wrong shape (`kind.json.get("spec", {})`).
fn spec_of(row: &MessagerKindRow) -> MessagerSpec {
    row.json
        .0
        .value
        .as_ref()
        .and_then(|input| input.spec.as_ref())
        .map(|spec| MessagerSpec {
            channel_type: spec.channel_type.clone(),
            is_enabled: spec.is_enabled,
            config: spec.config.clone(),
            default_team_id: spec.default_team_id,
            default_model_name: spec.default_model_name.clone(),
        })
        .unwrap_or_default()
}

/// `_kind_to_response`: render one channel with masked config.
fn kind_to_response(row: &MessagerKindRow) -> ImChannelResponse {
    let spec = spec_of(row);
    ImChannelResponse {
        id: row.id,
        name: row.name.clone(),
        namespace: row.namespace.clone(),
        channel_type: spec.channel_type.unwrap_or_else(|| "dingtalk".to_owned()),
        is_enabled: spec.is_enabled.unwrap_or(true),
        config: spec.config.as_ref().map(mask_config).unwrap_or_default(),
        default_team_id: spec.default_team_id.unwrap_or(0),
        default_model_name: spec.default_model_name.unwrap_or_default(),
        created_at: pydantic_datetime(row.created_at),
        updated_at: pydantic_datetime(row.updated_at),
    }
}

/// GET /api/admin/im-channels: inject the process-lifetime application state.
#[brz_http_server::get("/api/admin/im-channels")]
async fn list_im_channels(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
    query: brz_http_server::Query<ImChannelListQuery>,
) -> Result<ImChannelListResponse, FastApiError> {
    list(state, &current_user, &query).await
}

/// Handler body for `GET /api/admin/im-channels`.
async fn list(
    state: &AppState,
    current_user: &SessionUser,
    query: &ImChannelListQuery,
) -> Result<ImChannelListResponse, FastApiError> {
    // `get_admin_user`: only the `admin` role may list channels.
    if current_user.role != "admin" {
        return Err(FastApiError::forbidden(
            "Permission denied. Admin access required.",
        ));
    }

    let params = ImChannelListQuery {
        page: query.page.clone(),
        limit: query.limit.clone(),
        channel_type: query.channel_type.clone(),
    }
    .validated()?;

    let rows: Vec<MessagerKindRow> = state
        .mysql
        .fetch_all(MESSAGER_LIST_QUERY, ())
        .await
        .map_err(|error| {
            tracing::error!(%error, "im-channels kinds database dependency failure");
            FastApiError::unhandled()
        })?;

    // `channel_type` filtering happens in process because the JSON spec is not
    // an indexed column.
    let filtered: Vec<&MessagerKindRow> = rows
        .iter()
        .filter(|row| match params.channel_type.as_deref() {
            None => true,
            Some(kind) => spec_of(row).channel_type.as_deref() == Some(kind),
        })
        .collect();

    let total = filtered.len();
    let start =
        usize::try_from((params.page - 1).saturating_mul(params.limit)).unwrap_or(usize::MAX);
    let end = start.saturating_add(usize::try_from(params.limit).unwrap_or(usize::MAX));
    let items = if start >= filtered.len() {
        Vec::new()
    } else {
        filtered[start..end.min(filtered.len())]
            .iter()
            .map(|row| kind_to_response(row))
            .collect()
    };

    Ok(ImChannelListResponse { total, items })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn row(spec: Value) -> MessagerKindRow {
        MessagerKindRow {
            id: 1001,
            user_id: 0,
            kind: "Messager".to_owned(),
            name: "dingtalk-example-inner".to_owned(),
            namespace: "default".to_owned(),
            json: Json(json!({ "spec": spec }).into()),
            is_active: 1,
            created_at: NaiveDate::from_ymd_opt(2026, 9, 25)
                .unwrap()
                .and_hms_opt(11, 14, 4)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 9, 25)
                .unwrap()
                .and_hms_opt(11, 14, 4)
                .unwrap(),
        }
    }

    fn rendered(response: &ImChannelResponse) -> Value {
        crate::json_contract_tests::serialized(response).unwrap()
    }

    #[test]
    fn sensitive_keys_follow_the_source_substring_rule() {
        for key in [
            "client_secret",
            "secret",
            "app_access_token",
            "bot_token",
            "encoding_aes_key",
            "encrypt_key",
        ] {
            assert!(is_sensitive_key(key), "{key} must be masked");
        }
        for key in [
            "client_id",
            "chat_card",
            "card_template_id",
            "user_mapping_mode",
        ] {
            assert!(!is_sensitive_key(key), "{key} must stay visible");
        }
    }

    #[test]
    fn mask_config_masks_values_and_keeps_order() {
        let config: Map<String, Value> = serde_json::from_value(json!({
            "chat_card": null,
            "client_id": "dingtalk-example-client-id",
            "client_secret": "encrypted",
            "card_template_id": "00000000-0000-4000-8000-000000000000.schema",
            "user_mapping_mode": "select_user",
            "user_mapping_config": {"target_user_id": 1}
        }))
        .unwrap();
        let masked = mask_config(&config);
        let keys: Vec<&String> = masked.keys().collect();
        assert_eq!(
            keys,
            vec![
                "chat_card",
                "client_id",
                "client_secret",
                "card_template_id",
                "user_mapping_mode",
                "user_mapping_config",
            ]
        );
        assert_eq!(masked["client_secret"], json!("***"));
        assert_eq!(masked["client_id"], json!("dingtalk-example-client-id"));
        assert_eq!(masked["user_mapping_config"], json!({"target_user_id": 1}));
    }

    #[test]
    fn kind_to_response_matches_the_recorded_item() {
        let response = kind_to_response(&row(json!({
            "channelType": "dingtalk",
            "isEnabled": true,
            "config": {
                "chat_card": null,
                "client_id": "dingtalk-example-client-id",
                "client_secret": "encrypted",
                "card_template_id": "00000000-0000-4000-8000-000000000000.schema",
                "user_mapping_mode": "select_user",
                "user_mapping_config": {"target_user_id": 1}
            },
            "defaultTeamId": 10,
            "defaultModelName": "openai-gpt-5.1(海外)"
        })));
        let value = rendered(&response);
        assert_eq!(
            value,
            json!({
                "id": 1001,
                "name": "dingtalk-example-inner",
                "namespace": "default",
                "channel_type": "dingtalk",
                "is_enabled": true,
                "config": {
                    "chat_card": null,
                    "client_id": "dingtalk-example-client-id",
                    "client_secret": "***",
                    "card_template_id": "00000000-0000-4000-8000-000000000000.schema",
                    "user_mapping_mode": "select_user",
                    "user_mapping_config": {"target_user_id": 1}
                },
                "default_team_id": 10,
                "default_model_name": "openai-gpt-5.1(海外)",
                "created_at": "2026-09-25T11:14:04",
                "updated_at": "2026-09-25T11:14:04"
            })
        );
        // JSON key order follows the pydantic model declaration order.
        let text = serde_json::to_string(&response).unwrap();
        assert!(text.starts_with(
            "{\"id\":1001,\"name\":\"dingtalk-example-inner\",\"namespace\":\"default\",\
             \"channel_type\":\"dingtalk\",\"is_enabled\":true,\"config\":{\"chat_card\":null,\
             \"client_id\":\"dingtalk-example-client-id\",\"client_secret\":\"***\","
        ));
    }

    #[test]
    fn kind_to_response_defaults_when_spec_fields_are_absent() {
        let response = kind_to_response(&row(json!({})));
        let value = rendered(&response);
        assert_eq!(value["channel_type"], json!("dingtalk"));
        assert_eq!(value["is_enabled"], json!(true));
        assert_eq!(value["config"], json!({}));
        assert_eq!(value["default_team_id"], json!(0));
        assert_eq!(value["default_model_name"], json!(""));
    }

    #[test]
    fn query_validation_matches_the_fastapi_ranges() {
        let defaults = ImChannelListQuery::default().validated().unwrap();
        assert_eq!((defaults.page, defaults.limit), (1, 20));

        let explicit = ImChannelListQuery {
            page: Some("1".to_owned()),
            limit: Some("100".to_owned()),
            channel_type: Some("dingtalk".to_owned()),
        }
        .validated()
        .unwrap();
        assert_eq!((explicit.page, explicit.limit), (1, 100));
        assert_eq!(explicit.channel_type.as_deref(), Some("dingtalk"));

        for (page, limit, kind) in [
            (Some("0"), None, "greater_than_equal"),
            (None, Some("101"), "less_than_equal"),
            (None, Some("abc"), "int_parsing"),
        ] {
            let error = ImChannelListQuery {
                page: page.map(str::to_owned),
                limit: limit.map(str::to_owned),
                channel_type: None,
            }
            .validated()
            .unwrap_err();
            assert!(
                error.validation_detail().contains(kind),
                "expected {kind} in {}",
                error.validation_detail()
            );
        }
    }

    #[test]
    fn rejection_is_a_403_with_the_source_detail() {
        let error = FastApiError::forbidden("Permission denied. Admin access required.");
        assert_eq!(error.status(), brz_http_server::StatusCode::FORBIDDEN);
        assert_eq!(
            error.validation_detail(),
            "\"Permission denied. Admin access required.\""
        );
    }

    #[test]
    fn pydantic_datetime_adds_a_fraction_only_when_present() {
        let whole = NaiveDate::from_ymd_opt(2026, 9, 25)
            .unwrap()
            .and_hms_opt(11, 14, 4)
            .unwrap();
        assert_eq!(pydantic_datetime(whole), "2026-09-25T11:14:04");
        assert_eq!(
            pydantic_datetime(whole + chrono::Duration::microseconds(123456)),
            "2026-09-25T11:14:04.123456"
        );
    }
}
