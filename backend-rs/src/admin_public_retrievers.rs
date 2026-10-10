// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Admin public retriever listing for `GET /api/admin/public-retrievers`.
//!
//! Mirrors `app.api.endpoints.admin.public_retrievers.list_public_retrievers`
//! (router prefix `/admin`, mounted under the app prefix `/api`): an admin
//! session counts and lists the active public retrievers, which are stored as
//! `kinds` rows with `user_id = 0`, `kind = 'Retriever'`, `namespace =
//! 'default'`, ordered by `created_at` descending and paginated by
//! `page`/`limit`. Authorization follows `get_admin_user`: a non-admin role is
//! rejected with `403 {"detail": "Permission denied. Admin access required."}`.
//!
//! The response follows `PublicRetrieverListResponse`: `id`, `name`,
//! `namespace`, `displayName`, `storageType`, `description`, `json` (the raw
//! `kind.json` payload echoed verbatim), `is_active`, `created_at`, and
//! `updated_at`. `displayName`, `storageType`, and `description` are parsed out
//! of the stored `Retriever` CRD like `RetrieverAdapter.to_retriever_dict`; a
//! payload that fails `Retriever.model_validate` falls back to
//! `displayName = null`, `storageType = "unknown"`, `description = null`.
//!
//! Column aliases (`kinds_<column>`) mirror the source SQLAlchemy labeled
//! rendering so the statements match the recorded exchanges.
use brz_mysql::{FromMysqlRow, Json};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::json_compat::OpaqueJson;
use crate::state::AppState;

/// `get_admin_user`: the role that grants admin access.
const ADMIN_ROLE: &str = "admin";

/// `get_admin_user`: the `403` detail for an authenticated non-admin.
const ADMIN_REQUIRED: &str = "Permission denied. Admin access required.";

/// `to_retriever_dict`: `storageType` when the stored CRD cannot be parsed.
const UNKNOWN_STORAGE_TYPE: &str = "unknown";

/// The default `page` (`Query(1, ge=1)`).
const DEFAULT_PAGE: i64 = 1;

/// The default `limit` (`Query(20, ge=1, le=1000)`).
const DEFAULT_LIMIT: i64 = 20;

/// The `limit` upper bound (`Query(20, ge=1, le=1000)`).
const MAX_LIMIT: i64 = 1000;

/// The source `Kind` projection, labeled like SQLAlchemy's query rendering.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
     kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at";

/// The shared `WHERE` predicate for `get_retrievers`/`count_active_retrievers`.
const RETRIEVER_FILTER: &str = "kinds.user_id = 0 AND kinds.kind = 'Retriever' \
     AND kinds.namespace = 'default' AND kinds.is_active = true";

/// `count_active_retrievers`: the source `query.count()` wraps the labeled
/// projection in `SELECT count(*) ... AS anon_1`.
fn count_sql() -> String {
    format!(
        "SELECT count(*) AS count_1 \nFROM (SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE {RETRIEVER_FILTER}) AS anon_1"
    )
}

/// `get_retrievers`: ordered by `created_at` descending and paginated with the
/// source `offset(skip).limit(limit)` (`LIMIT skip, limit`, both integers).
fn list_sql(skip: i64, limit: i64) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE {RETRIEVER_FILTER} \
         ORDER BY kinds.created_at DESC \n LIMIT {skip}, {limit}"
    )
}

/// The `count(*) AS count_1` row from `count_active_retrievers`.
#[derive(Debug, FromMysqlRow)]
struct CountRow {
    count_1: i64,
}

/// One public `kinds` row, selected with the labeled source column list. Only
/// the response fields are consumed, but every selected column is declared so
/// the projection matches the recorded statement.
#[derive(Debug, FromMysqlRow)]
struct RetrieverRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "kinds_kind")]
    kind: String,
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

/// The subset of the stored `Retriever` CRD read by `RetrieverAdapter`. The
/// non-optional fields mirror `Retriever.model_validate`'s required fields, so
/// a payload missing any of them falls back just like the source.
#[derive(Debug, Deserialize)]
struct RetrieverCrd {
    metadata: ObjectMeta,
    spec: RetrieverSpec,
}

/// `ObjectMeta`: `name` is required, `displayName` is `Optional[str]`.
#[derive(Debug, Deserialize)]
struct ObjectMeta {
    #[allow(dead_code, reason = "required by Retriever.model_validate")]
    name: String,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
}

/// `RetrieverSpec`: `storageConfig` is required, `description` is `Optional[str]`.
#[derive(Debug, Deserialize)]
struct RetrieverSpec {
    #[serde(rename = "storageConfig")]
    storage_config: StorageConfig,
    #[serde(default)]
    description: Option<String>,
}

/// `StorageConfig`: `type`, `url`, and `indexStrategy` are all required.
#[derive(Debug, Deserialize)]
struct StorageConfig {
    #[serde(rename = "type")]
    storage_type: String,
    #[allow(dead_code, reason = "required by Retriever.model_validate")]
    url: String,
    #[allow(dead_code, reason = "required by Retriever.model_validate")]
    #[serde(rename = "indexStrategy")]
    index_strategy: IndexStrategy,
}

/// `IndexStrategy`: `mode` is required.
#[derive(Debug, Deserialize)]
struct IndexStrategy {
    #[allow(dead_code, reason = "required by Retriever.model_validate")]
    mode: String,
}

/// `displayName`, `storageType`, and `description` extracted from a stored
/// `Retriever` CRD.
#[derive(Debug, Default, PartialEq, Eq)]
struct RetrieverDerived {
    display_name: Option<String>,
    storage_type: String,
    description: Option<String>,
}

/// The `to_retriever_dict` fallback when `Retriever.model_validate` fails.
fn unknown_retriever() -> RetrieverDerived {
    RetrieverDerived {
        display_name: None,
        storage_type: UNKNOWN_STORAGE_TYPE.to_owned(),
        description: None,
    }
}

/// `RetrieverAdapter.to_retriever_dict`: parse the stored CRD, or fall back when
/// it is not a valid `Retriever`.
fn derive_retriever(json: &OpaqueJson) -> RetrieverDerived {
    match json.project::<RetrieverCrd>() {
        Some(crd) => RetrieverDerived {
            display_name: crd.metadata.display_name,
            storage_type: crd.spec.storage_config.storage_type,
            description: crd.spec.description,
        },
        None => unknown_retriever(),
    }
}

/// Pydantic v2 naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS` with
/// fractional seconds appended only when nonzero.
fn format_datetime(value: &NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        base
    } else {
        format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
    }
}

/// `PublicRetrieverResponse` with `by_alias=True` field order and names.
#[derive(Serialize)]
struct PublicRetrieverResponse {
    id: i64,
    name: String,
    namespace: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "storageType")]
    storage_type: String,
    description: Option<String>,
    json: OpaqueJson,
    is_active: bool,
    created_at: String,
    updated_at: String,
}

/// `PublicRetrieverListResponse`.
#[derive(Serialize)]
struct PublicRetrieverListResponse {
    total: i64,
    items: Vec<PublicRetrieverResponse>,
}

impl RetrieverRow {
    fn to_response(&self) -> PublicRetrieverResponse {
        let derived = derive_retriever(&self.json.0);
        PublicRetrieverResponse {
            id: self.id,
            name: self.name.clone(),
            namespace: self.namespace.clone(),
            display_name: derived.display_name,
            storage_type: derived.storage_type,
            description: derived.description,
            json: self.json.0.clone(),
            is_active: self.is_active != 0,
            created_at: format_datetime(&self.created_at),
            updated_at: format_datetime(&self.updated_at),
        }
    }
}

/// Query parameters for `GET /api/admin/public-retrievers`: `page` and `limit`
/// as raw strings so FastAPI's integer coercion and bounds produce its exact
/// `422` body.
#[derive(Debug, Default, Deserialize)]
pub struct PublicRetrieverListQuery {
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

/// The effective pagination after FastAPI-compatible validation.
#[derive(Debug, PartialEq, Eq)]
struct ListParams {
    skip: i64,
    limit: i64,
}

/// One FastAPI validation-error entry (`{type, loc, msg, input, ctx?}`),
/// mirroring the source `RequestValidationError` rendering.
#[derive(Serialize)]
struct ValidationEntry<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    loc: [&'a str; 2],
    msg: &'static str,
    input: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    ctx: Option<ValidationContext>,
}

/// The numeric bound pydantic reports alongside comparison errors.
#[derive(Serialize)]
#[serde(untagged)]
enum ValidationContext {
    GreaterThanEqual { ge: i64 },
    LessThanEqual { le: i64 },
}

impl<'a> ValidationEntry<'a> {
    /// `int_parsing`: the raw query value was not an integer.
    fn int_parsing(field: &'a str, input: &'a str) -> Self {
        Self {
            kind: "int_parsing",
            loc: ["query", field],
            msg: "Input should be a valid integer, unable to parse string as an integer",
            input,
            ctx: None,
        }
    }

    /// `greater_than_equal`: the parsed value fell below its lower bound.
    fn greater_than_equal(field: &'a str, input: &'a str, ge: i64, msg: &'static str) -> Self {
        Self {
            kind: "greater_than_equal",
            loc: ["query", field],
            msg,
            input,
            ctx: Some(ValidationContext::GreaterThanEqual { ge }),
        }
    }

    /// `less_than_equal`: the parsed value exceeded its upper bound.
    fn less_than_equal(field: &'a str, input: &'a str, le: i64, msg: &'static str) -> Self {
        Self {
            kind: "less_than_equal",
            loc: ["query", field],
            msg,
            input,
            ctx: Some(ValidationContext::LessThanEqual { le }),
        }
    }
}

impl PublicRetrieverListQuery {
    /// Validate `page >= 1` and `1 <= limit <= 1000`, returning `skip`/`limit`.
    fn validated(&self) -> Result<ListParams, FastApiError> {
        let page = validate_page(self.page.as_deref())?;
        let limit = validate_limit(self.limit.as_deref())?;
        Ok(ListParams {
            skip: (page - 1) * limit,
            limit,
        })
    }
}

/// Parse and bound the `page` query value.
fn validate_page(raw: Option<&str>) -> Result<i64, FastApiError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_PAGE);
    };
    let page = parse_query_int(raw, "page")?;
    if page < 1 {
        return Err(bound_error(ValidationEntry::greater_than_equal(
            "page",
            raw,
            1,
            "Input should be greater than or equal to 1",
        )));
    }
    Ok(page)
}

/// Parse and bound the `limit` query value.
fn validate_limit(raw: Option<&str>) -> Result<i64, FastApiError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_LIMIT);
    };
    let limit = parse_query_int(raw, "limit")?;
    if limit < 1 {
        return Err(bound_error(ValidationEntry::greater_than_equal(
            "limit",
            raw,
            1,
            "Input should be greater than or equal to 1",
        )));
    }
    if limit > MAX_LIMIT {
        return Err(bound_error(ValidationEntry::less_than_equal(
            "limit",
            raw,
            MAX_LIMIT,
            "Input should be less than or equal to 1000",
        )));
    }
    Ok(limit)
}

/// Parse one query value into an `int`, mirroring FastAPI's `int_parsing`
/// failure with the raw value as `input`.
fn parse_query_int(raw: &str, field: &str) -> Result<i64, FastApiError> {
    raw.trim()
        .parse::<i64>()
        .map_err(|_| FastApiError::validation([ValidationEntry::int_parsing(field, raw)]))
}

/// Wrap one validation entry in the source's 422 array body.
fn bound_error(entry: ValidationEntry<'_>) -> FastApiError {
    FastApiError::validation([entry])
}

/// `get_admin_user`: an authenticated non-admin is rejected with `403`.
fn require_admin(user: &SessionUser) -> Result<(), FastApiError> {
    if user.role == ADMIN_ROLE {
        Ok(())
    } else {
        Err(FastApiError::forbidden(ADMIN_REQUIRED))
    }
}

/// GET /api/admin/public-retrievers: the admin listing free function.
#[brz_http_server::get("/api/admin/public-retrievers")]
async fn list_public_retrievers(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: brz_http_server::Query<PublicRetrieverListQuery>,
) -> Result<PublicRetrieverListResponse, FastApiError> {
    require_admin(&user)?;
    let params = query.validated()?;
    public_retrievers(state, params).await
}

/// Handler body for `GET /api/admin/public-retrievers`: count first, then list.
async fn public_retrievers(
    state: &AppState,
    params: ListParams,
) -> Result<PublicRetrieverListResponse, FastApiError> {
    let count: CountRow = match state.mysql.fetch_one(&count_sql(), ()).await {
        Ok(row) => row,
        Err(error) => {
            tracing::error!(%error, "admin public-retrievers count database failure");
            return Err(FastApiError::internal());
        }
    };

    let rows: Vec<RetrieverRow> = match state
        .mysql
        .fetch_all(&list_sql(params.skip, params.limit), ())
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "admin public-retrievers list database failure");
            return Err(FastApiError::internal());
        }
    };

    Ok(PublicRetrieverListResponse {
        total: count.count_1,
        items: rows.iter().map(RetrieverRow::to_response).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    /// Serialize a value to its JSON text through the shared opaque helper, so
    /// the tests never depend on the JSON crate directly.
    fn json_text<T: Serialize>(value: &T) -> String {
        OpaqueJson::from_serializable(value)
            .to_raw_value()
            .get()
            .to_owned()
    }

    /// A stored `Retriever` CRD honoring the source key order.
    #[derive(Serialize)]
    struct TestCrd {
        kind: &'static str,
        spec: TestSpec,
        metadata: TestMetadata,
        #[serde(rename = "apiVersion")]
        api_version: &'static str,
    }

    #[derive(Serialize)]
    struct TestSpec {
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<&'static str>,
        #[serde(rename = "storageConfig")]
        storage_config: TestStorageConfig,
    }

    #[derive(Serialize)]
    struct TestStorageConfig {
        #[serde(rename = "type")]
        storage_type: &'static str,
        url: &'static str,
        #[serde(rename = "indexStrategy")]
        index_strategy: TestIndexStrategy,
    }

    #[derive(Serialize)]
    struct TestIndexStrategy {
        mode: &'static str,
        prefix: &'static str,
    }

    #[derive(Serialize)]
    struct TestMetadata {
        name: &'static str,
        #[serde(rename = "displayName")]
        display_name: Option<&'static str>,
    }

    /// A CRD with no `storageConfig.url`, so `Retriever.model_validate` fails.
    #[derive(Serialize)]
    struct MissingUrlStorageConfig {
        #[serde(rename = "type")]
        storage_type: &'static str,
        #[serde(rename = "indexStrategy")]
        index_strategy: TestIndexStrategy,
    }

    #[derive(Serialize)]
    struct MissingUrlCrd {
        metadata: TestMetadata,
        spec: MissingUrlSpec,
    }

    #[derive(Serialize)]
    struct MissingUrlSpec {
        #[serde(rename = "storageConfig")]
        storage_config: MissingUrlStorageConfig,
    }

    fn valid_crd() -> TestCrd {
        TestCrd {
            kind: "Retriever",
            spec: TestSpec {
                description: Some("retriever-elasticsearch"),
                storage_config: TestStorageConfig {
                    storage_type: "elasticsearch",
                    url: "http://es.example:9200",
                    index_strategy: TestIndexStrategy {
                        mode: "per_user",
                        prefix: "wegent",
                    },
                },
            },
            metadata: TestMetadata {
                name: "elasticsearch",
                display_name: Some("retriever-elasticsearch"),
            },
            api_version: "agent.wecode.io/v1",
        }
    }

    fn sample_row() -> RetrieverRow {
        RetrieverRow {
            id: 102_218,
            kind: "Retriever".to_owned(),
            name: "elasticsearch".to_owned(),
            namespace: "default".to_owned(),
            json: Json(OpaqueJson::from_serializable(valid_crd())),
            is_active: 1,
            created_at: NaiveDate::from_ymd_opt(2025, 12, 31)
                .unwrap()
                .and_hms_opt(20, 8, 45)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2025, 12, 31)
                .unwrap()
                .and_hms_opt(20, 47, 35)
                .unwrap(),
        }
    }

    #[test]
    fn count_and_list_sql_match_the_source_projection() {
        assert_eq!(
            count_sql(),
            "SELECT count(*) AS count_1 \nFROM (SELECT kinds.id AS kinds_id, \
             kinds.user_id AS kinds_user_id, kinds.kind AS kinds_kind, \
             kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
             kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
             kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at \n\
             FROM kinds \nWHERE kinds.user_id = 0 AND kinds.kind = 'Retriever' \
             AND kinds.namespace = 'default' AND kinds.is_active = true) AS anon_1"
        );
        assert_eq!(
            list_sql(0, 100),
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at \nFROM kinds \nWHERE kinds.user_id = 0 \
             AND kinds.kind = 'Retriever' AND kinds.namespace = 'default' \
             AND kinds.is_active = true ORDER BY kinds.created_at DESC \n LIMIT 0, 100"
        );
    }

    #[test]
    fn list_sql_renders_the_offset_and_limit_pair() {
        assert!(list_sql(40, 20).ends_with("ORDER BY kinds.created_at DESC \n LIMIT 40, 20"));
    }

    #[test]
    fn response_matches_the_source_field_order_and_values() {
        let response = sample_row().to_response();
        assert_eq!(
            json_text(&response),
            "{\"id\":102218,\"name\":\"elasticsearch\",\"namespace\":\"default\",\
             \"displayName\":\"retriever-elasticsearch\",\"storageType\":\"elasticsearch\",\
             \"description\":\"retriever-elasticsearch\",\"json\":{\"kind\":\"Retriever\",\
             \"spec\":{\"description\":\"retriever-elasticsearch\",\"storageConfig\":\
             {\"type\":\"elasticsearch\",\"url\":\"http://es.example:9200\",\
             \"indexStrategy\":{\"mode\":\"per_user\",\"prefix\":\"wegent\"}}},\
             \"metadata\":{\"name\":\"elasticsearch\",\"displayName\":\"retriever-elasticsearch\"},\
             \"apiVersion\":\"agent.wecode.io/v1\"},\"is_active\":true,\
             \"created_at\":\"2025-12-31T20:08:45\",\"updated_at\":\"2025-12-31T20:47:35\"}"
        );
    }

    #[test]
    fn opaque_json_is_echoed_without_microseconds_when_zero() {
        let response = sample_row().to_response();
        assert_eq!(response.created_at, "2025-12-31T20:08:45");
        assert!(response.is_active);
    }

    #[test]
    fn missing_optional_description_renders_null() {
        let mut row = sample_row();
        row.json = Json(OpaqueJson::from_serializable(TestCrd {
            kind: "Retriever",
            spec: TestSpec {
                description: None,
                storage_config: TestStorageConfig {
                    storage_type: "milvus",
                    url: "http://x:1",
                    index_strategy: TestIndexStrategy {
                        mode: "per_dataset",
                        prefix: "wegent",
                    },
                },
            },
            metadata: TestMetadata {
                name: "r",
                display_name: None,
            },
            api_version: "agent.wecode.io/v1",
        }));
        let response = row.to_response();
        assert_eq!(response.display_name, None);
        assert_eq!(response.storage_type, "milvus");
        assert_eq!(response.description, None);
        let body = json_text(&response);
        assert!(body.contains("\"displayName\":null"), "{body}");
        assert!(body.contains("\"description\":null"), "{body}");
    }

    #[test]
    fn invalid_retriever_payload_falls_back_to_unknown() {
        let mut row = sample_row();
        row.json = Json(OpaqueJson::from_serializable(MissingUrlCrd {
            metadata: TestMetadata {
                name: "r",
                display_name: Some("r"),
            },
            spec: MissingUrlSpec {
                storage_config: MissingUrlStorageConfig {
                    storage_type: "milvus",
                    index_strategy: TestIndexStrategy {
                        mode: "per_dataset",
                        prefix: "wegent",
                    },
                },
            },
        }));
        let response = row.to_response();
        assert_eq!(response.display_name, None);
        assert_eq!(response.storage_type, "unknown");
        assert_eq!(response.description, None);
    }

    #[test]
    fn non_object_payload_falls_back_to_unknown() {
        let derived = derive_retriever(&OpaqueJson::from_serializable(vec![1, 2, 3]));
        assert_eq!(derived, unknown_retriever());
    }

    #[test]
    fn query_defaults_are_page_one_limit_twenty() {
        let params = PublicRetrieverListQuery::default().validated().unwrap();
        assert_eq!(params, ListParams { skip: 0, limit: 20 });
    }

    #[test]
    fn query_computes_skip_from_page_and_limit() {
        let query = PublicRetrieverListQuery {
            page: Some("3".to_owned()),
            limit: Some("100".to_owned()),
        };
        assert_eq!(
            query.validated().unwrap(),
            ListParams {
                skip: 200,
                limit: 100
            }
        );
    }

    #[test]
    fn page_below_one_is_rejected() {
        let query = PublicRetrieverListQuery {
            page: Some("0".to_owned()),
            limit: None,
        };
        let error = query.validated().expect_err("page must be >= 1");
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            error.validation_detail(),
            "[{\"type\":\"greater_than_equal\",\"loc\":[\"query\",\"page\"],\
             \"msg\":\"Input should be greater than or equal to 1\",\"input\":\"0\",\
             \"ctx\":{\"ge\":1}}]"
        );
    }

    #[test]
    fn limit_upper_and_lower_bounds_are_enforced() {
        for (value, expected) in [
            (
                "0",
                "[{\"type\":\"greater_than_equal\",\"loc\":[\"query\",\"limit\"],\
                 \"msg\":\"Input should be greater than or equal to 1\",\"input\":\"0\",\
                 \"ctx\":{\"ge\":1}}]",
            ),
            (
                "1001",
                "[{\"type\":\"less_than_equal\",\"loc\":[\"query\",\"limit\"],\
                 \"msg\":\"Input should be less than or equal to 1000\",\"input\":\"1001\",\
                 \"ctx\":{\"le\":1000}}]",
            ),
        ] {
            let query = PublicRetrieverListQuery {
                page: None,
                limit: Some(value.to_owned()),
            };
            let error = query.validated().expect_err("limit out of range");
            assert_eq!(
                error.status(),
                brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
            );
            assert_eq!(error.validation_detail(), expected);
        }
    }

    #[test]
    fn non_integer_query_value_is_rejected() {
        let query = PublicRetrieverListQuery {
            page: Some("abc".to_owned()),
            limit: None,
        };
        let error = query.validated().expect_err("non-integer page");
        assert_eq!(
            error.validation_detail(),
            "[{\"type\":\"int_parsing\",\"loc\":[\"query\",\"page\"],\
             \"msg\":\"Input should be a valid integer, unable to parse string as an integer\",\
             \"input\":\"abc\"}]"
        );
    }
}
