// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/public-models` — the admin public-model list.
//!
//! Source: `app/api/endpoints/admin/public_models.py::list_public_models`,
//! whose router is included by `app/api/endpoints/admin/router.py` and mounted
//! under `prefix="/admin"` in `app/api/api.py`.
//!
//! Flow: the session user must be an admin
//! (`app.core.security.get_admin_user`, `403 {"detail": ...}` for a non-admin
//! role); then FastAPI validates `page` (`ge=1`, default 1) and `limit`
//! (`ge=1, le=1000`, default 20); the source counts and loads every `kinds`
//! row with `user_id = 0 AND kind = 'Model' AND namespace = 'default'`, sorts
//! them by the lowercased display name (a stable Python `sorted`), applies the
//! page window, and renders each row as a `PublicModelResponse`.
//!
//! The dependency order mirrors FastAPI's `solve_dependencies`: the
//! authentication sub-dependencies run before query-parameter validation, so a
//! non-admin request answers `403` without issuing the list queries.

use std::collections::BTreeMap;

use brz_http_server::StatusCode;
use brz_mysql::FromMysqlRow;
use serde::{Deserialize, Serialize};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::json_compat::OpaqueJson;
use crate::state::AppState;

/// `kinds` columns as rendered by `db.query(Kind)`.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// `filter(Kind.user_id == 0, Kind.kind == "Model", Kind.namespace == "default")`
/// as SQLAlchemy renders it.
const MODEL_FILTER: &str =
    "kinds.user_id = 0 AND kinds.kind = 'Model' AND kinds.namespace = 'default'";

/// `get_admin_user`'s `403` detail for a non-admin session user.
const ADMIN_REQUIRED: &str = "Permission denied. Admin access required.";

/// `validation_exception_handler`'s `422` marker (`app/core/exceptions.py`).
const VALIDATION_FAILED: &str = "Request parameter validation failed";

/// One `kinds` row of the public-model query (only the columns the response
/// reads).
#[derive(Debug, FromMysqlRow)]
struct KindRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_namespace")]
    namespace: String,
    #[mysql(rename = "kinds_json")]
    json: brz_mysql::Json<OpaqueJson>,
    #[mysql(rename = "kinds_is_active")]
    is_active: bool,
    #[mysql(rename = "kinds_created_at")]
    created_at: chrono::NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    updated_at: chrono::NaiveDateTime,
}

/// `count(*) AS count_1` row of the source `query.count()`.
#[derive(Debug, FromMysqlRow)]
struct CountRow {
    count_1: i64,
}

/// A lenient projection of one stored `kinds.json` document: only the fields
/// `_get_display_name`, `is_public_model_visible`, and `_get_is_advanced` read.
#[derive(Debug, Serialize, Deserialize)]
struct KindDocument {
    metadata: Option<LooseJson>,
    spec: Option<LooseJson>,
}

/// An arbitrary JSON value projected far enough to reproduce Python truthiness
/// and the source's strict boolean check. Arrays and objects keep their length
/// so empty collections are falsy, matching Python.
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum LooseJson {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<LooseJson>),
    Object(BTreeMap<String, LooseJson>),
}

/// The document-derived fields of one row.
struct ModelView {
    /// `_get_display_name(model)`: the displayName when it is a non-empty
    /// string, otherwise the model name.
    display: String,
    /// `is_public_model_visible(model.json)`.
    is_visible: bool,
    /// `_get_is_advanced(model)`.
    is_advanced: bool,
}

/// One database row paired with its document-derived view and sort key.
struct SortedRow {
    sort_key: String,
    view: ModelView,
    row: KindRow,
}

/// `PublicModelResponse` (`app/schemas/admin.py`). `json` is the stored CRD
/// document echoed in its normalized compact form.
#[derive(Debug, Serialize)]
struct PublicModelItem {
    id: i64,
    name: String,
    namespace: String,
    display_name: Option<String>,
    json: OpaqueJson,
    is_active: bool,
    is_visible: bool,
    is_advanced: bool,
    created_at: Option<String>,
    updated_at: Option<String>,
}

/// `PublicModelListResponse`.
#[derive(Debug, Serialize)]
struct PublicModelListResponse {
    total: i64,
    items: Vec<PublicModelItem>,
}

/// `app.core.exceptions.validation_exception_handler`'s `422` body.
#[derive(Debug, Serialize)]
struct ValidationBody<'a> {
    error_code: u16,
    detail: &'a str,
    errors: [ValidationItem<'a>; 1],
}

/// One entry of the `422` `errors` array (one invalid query parameter).
#[derive(Debug, Serialize)]
struct ValidationItem<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: &'a str,
    input: &'a str,
}

/// GET /api/admin/public-models: the public-model list as a free function
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/admin/public-models")]
async fn list_public_models(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
    page: Option<String>,
    limit: Option<String>,
) -> Result<PublicModelListResponse, FastApiError> {
    // `get_admin_user` runs as a dependency before query validation.
    if current_user.role != "admin" {
        return Err(FastApiError::forbidden(ADMIN_REQUIRED));
    }
    let (page, limit) = parse_paging(page.as_deref(), limit.as_deref())?;
    public_models(state, page, limit).await
}

/// Handler body for `GET /api/admin/public-models`.
async fn public_models(
    state: &AppState,
    page: i64,
    limit: i64,
) -> Result<PublicModelListResponse, FastApiError> {
    // `query.count()` renders the subquery count.
    let count: Option<CountRow> = state
        .mysql
        .fetch_optional(
            &format!(
                "SELECT count(*) AS count_1 \nFROM (SELECT {KIND_COLUMNS} \n\
                 FROM kinds \nWHERE {MODEL_FILTER}) AS anon_1"
            ),
            (),
        )
        .await
        .map_err(internal)?;
    let total = count.map(|row| row.count_1).unwrap_or(0);

    // `query.all()`: the unordered row set SQLAlchemy returns.
    let rows: Vec<KindRow> = state
        .mysql
        .fetch_all(
            &format!("SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE {MODEL_FILTER}"),
            (),
        )
        .await
        .map_err(internal)?;

    let mut models: Vec<SortedRow> = rows
        .into_iter()
        .map(|row| {
            let view = model_view(&row);
            SortedRow {
                sort_key: view.display.to_lowercase(),
                view,
                row,
            }
        })
        .collect();

    // `sorted(models, key=lambda m: _get_display_name(m).lower())`: a stable
    // sort, so equal keys keep the database row order.
    models.sort_by_cached_key(|model| model.sort_key.clone());

    // `sorted_models[start_idx:end_idx]`.
    let start = usize::try_from((page - 1) * limit).unwrap_or(usize::MAX);
    let take = usize::try_from(limit).unwrap_or(usize::MAX);
    let items = models
        .into_iter()
        .skip(start)
        .take(take)
        .map(|model| item(model.view, model.row))
        .collect();

    Ok(PublicModelListResponse { total, items })
}

/// `_model_to_response`: project one row and its document view into the item.
fn item(view: ModelView, row: KindRow) -> PublicModelItem {
    let KindRow {
        id,
        name,
        namespace,
        json,
        is_active,
        created_at,
        updated_at,
    } = row;
    let display_name = (view.display != name).then_some(view.display);
    PublicModelItem {
        id,
        name,
        namespace,
        display_name,
        json: json.0,
        is_active,
        is_visible: view.is_visible,
        is_advanced: view.is_advanced,
        created_at: Some(pydantic_datetime(created_at)),
        updated_at: Some(pydantic_datetime(updated_at)),
    }
}

/// Derive the document-backed fields of one row.
fn model_view(row: &KindRow) -> ModelView {
    let document: Option<KindDocument> = row.json.0.project();
    let document = document.as_ref();
    ModelView {
        display: display_name_of(document, &row.name),
        is_visible: is_public_model_visible(document),
        is_advanced: is_advanced(document),
    }
}

/// `_get_display_name`: `json.metadata.displayName` when it is a truthy string,
/// otherwise the model name.
fn display_name_of(document: Option<&KindDocument>, name: &str) -> String {
    object_field(document, "metadata", "displayName")
        .and_then(|value| match value {
            LooseJson::String(display) if !display.is_empty() => Some(display.clone()),
            _ => None,
        })
        .unwrap_or_else(|| name.to_string())
}

/// `is_public_model_visible` (`app/services/adapters/public_model.py`):
/// `spec.isVisible` when it is a JSON boolean, else `True`.
fn is_public_model_visible(document: Option<&KindDocument>) -> bool {
    object_field(document, "spec", "isVisible").is_none_or(|value| match value {
        LooseJson::Bool(value) => *value,
        _ => true,
    })
}

/// `_get_is_advanced`: Python truthiness of `json.spec.isAdvanced`
/// (`bool(spec.get("isAdvanced", False))`).
fn is_advanced(document: Option<&KindDocument>) -> bool {
    object_field(document, "spec", "isAdvanced").is_some_and(truthy)
}

/// Read `document.<section>.<field>` when both levels are JSON objects
/// (`isinstance(..., dict)` in the source).
fn object_field<'a>(
    document: Option<&'a KindDocument>,
    section: &str,
    field: &str,
) -> Option<&'a LooseJson> {
    let KindDocument { metadata, spec } = document?;
    let section = match section {
        "metadata" => metadata.as_ref()?,
        _ => spec.as_ref()?,
    };
    match section {
        LooseJson::Object(map) => map.get(field),
        _ => None,
    }
}

/// Python truthiness for a projected JSON value.
fn truthy(value: &LooseJson) -> bool {
    match value {
        LooseJson::Null => false,
        LooseJson::Bool(value) => *value,
        LooseJson::Number(value) => *value != 0.0,
        LooseJson::String(value) => !value.is_empty(),
        LooseJson::Array(value) => !value.is_empty(),
        LooseJson::Object(value) => !value.is_empty(),
    }
}

/// Pydantic v2 naive `datetime` serialization: `YYYY-MM-DDTHH:MM:SS`
/// (six-digit microseconds appended only when non-zero).
fn pydantic_datetime(value: chrono::NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        format!(
            "{}.{:06}",
            value.format("%Y-%m-%dT%H:%M:%S"),
            value.and_utc().timestamp_subsec_micros()
        )
    }
}

/// FastAPI `Query` validation for `page` and `limit`.
fn parse_paging(
    page_raw: Option<&str>,
    limit_raw: Option<&str>,
) -> Result<(i64, i64), FastApiError> {
    let page = match page_raw {
        None => 1,
        Some(raw) => {
            let value = parse_int(raw, "page")?;
            if value < 1 {
                return Err(validation_error(
                    "page",
                    "greater_than_equal",
                    "Input should be greater than or equal to 1",
                    raw,
                ));
            }
            value
        }
    };
    let limit = match limit_raw {
        None => 20,
        Some(raw) => {
            let value = parse_int(raw, "limit")?;
            if value < 1 {
                return Err(validation_error(
                    "limit",
                    "greater_than_equal",
                    "Input should be greater than or equal to 1",
                    raw,
                ));
            }
            if value > 1000 {
                return Err(validation_error(
                    "limit",
                    "less_than_equal",
                    "Input should be less than or equal to 1000",
                    raw,
                ));
            }
            value
        }
    };
    Ok((page, limit))
}

/// Pydantic's lax `int` parsing of one query string.
fn parse_int(raw: &str, field: &str) -> Result<i64, FastApiError> {
    raw.trim().parse().map_err(|_| {
        validation_error(
            field,
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
            raw,
        )
    })
}

/// `app.core.exceptions.validation_exception_handler`'s `422` response for one
/// query parameter.
fn validation_error(field: &str, kind: &str, message: &str, input: &str) -> FastApiError {
    FastApiError::json_body(
        StatusCode::UNPROCESSABLE_ENTITY,
        validation_body(field, kind, message, input),
    )
}

/// The `{"error_code":422,"detail":...,"errors":[...]}` body for one invalid
/// query parameter.
fn validation_body<'a>(
    field: &'a str,
    kind: &'a str,
    message: &'a str,
    input: &'a str,
) -> ValidationBody<'a> {
    ValidationBody {
        error_code: 422,
        detail: VALIDATION_FAILED,
        errors: [ValidationItem {
            kind,
            loc: ["query", field],
            msg: message,
            input,
        }],
    }
}

/// Dependent-query failure mapped to the source `python_exception_handler`
/// body (`{"error_code": 500, "detail": "Internal server error"}`).
fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "public-model list database dependency failure");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(entries: Vec<(&str, LooseJson)>) -> LooseJson {
        LooseJson::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        )
    }

    fn document(metadata: Option<LooseJson>, spec: Option<LooseJson>) -> KindDocument {
        KindDocument { metadata, spec }
    }

    fn row(id: i64, name: &str, document: &KindDocument) -> KindRow {
        KindRow {
            id,
            name: name.to_string(),
            namespace: "default".to_string(),
            json: brz_mysql::Json(OpaqueJson::from_serializable(document)),
            is_active: true,
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        }
    }

    #[test]
    fn visibility_follows_spec_boolean_only() {
        let visible = |spec: LooseJson| is_public_model_visible(Some(&document(None, Some(spec))));
        assert!(visible(object(vec![("isVisible", LooseJson::Bool(true))])));
        assert!(!visible(object(vec![(
            "isVisible",
            LooseJson::Bool(false)
        )])));
        // A non-boolean `isVisible`, a missing key, or an invalid spec is true.
        assert!(visible(object(vec![("isVisible", LooseJson::Null)])));
        assert!(visible(object(vec![("isVisible", LooseJson::Number(0.0))])));
        assert!(visible(object(vec![])));
        assert!(visible(LooseJson::Null));
        assert!(is_public_model_visible(None));
        assert!(is_public_model_visible(Some(&document(
            None,
            Some(LooseJson::String("nope".to_string()))
        ))));
    }

    #[test]
    fn advanced_uses_python_truthiness() {
        let advanced = |spec: LooseJson| is_advanced(Some(&document(None, Some(spec))));
        assert!(advanced(object(vec![(
            "isAdvanced",
            LooseJson::Bool(true)
        )])));
        assert!(!advanced(object(vec![(
            "isAdvanced",
            LooseJson::Bool(false)
        )])));
        assert!(!advanced(object(vec![(
            "isAdvanced",
            LooseJson::Number(0.0)
        )])));
        assert!(advanced(object(vec![(
            "isAdvanced",
            LooseJson::String("yes".to_string())
        )])));
        assert!(!advanced(object(vec![(
            "isAdvanced",
            LooseJson::String(String::new())
        )])));
        assert!(!advanced(object(vec![])));
        assert!(!is_advanced(None));
    }

    #[test]
    fn display_name_falls_back_to_the_model_name() {
        let named =
            |metadata: Option<LooseJson>| display_name_of(Some(&document(metadata, None)), "m");
        assert_eq!(named(None), "m");
        assert_eq!(named(Some(LooseJson::Null)), "m");
        assert_eq!(named(Some(object(vec![]))), "m");
        assert_eq!(
            named(Some(object(vec![(
                "displayName",
                LooseJson::String(String::new())
            )]))),
            "m"
        );
        assert_eq!(
            named(Some(object(vec![(
                "displayName",
                LooseJson::String("Nice".to_string())
            )]))),
            "Nice"
        );
    }

    #[test]
    fn item_nulls_display_name_when_it_equals_the_model_name() {
        let same = document(
            Some(object(vec![(
                "displayName",
                LooseJson::String("m".to_string()),
            )])),
            None,
        );
        assert_eq!(model_view(&row(1, "m", &same)).display, "m");

        let different = document(
            Some(object(vec![(
                "displayName",
                LooseJson::String("Nice".to_string()),
            )])),
            None,
        );
        assert_eq!(model_view(&row(2, "m", &different)).display, "Nice");
    }

    #[test]
    fn pydantic_datetime_matches_the_source_rendering() {
        let whole =
            chrono::NaiveDateTime::parse_from_str("2026-08-27 03:15:52", "%Y-%m-%d %H:%M:%S")
                .unwrap();
        assert_eq!(pydantic_datetime(whole), "2026-08-27T03:15:52");
        let fractional = chrono::NaiveDateTime::parse_from_str(
            "2026-08-27 03:15:52.123",
            "%Y-%m-%d %H:%M:%S%.f",
        )
        .unwrap();
        assert_eq!(pydantic_datetime(fractional), "2026-08-27T03:15:52.123000");
    }

    #[test]
    fn paging_defaults_and_bounds() {
        assert_eq!(parse_paging(None, None).unwrap(), (1, 20));
        assert_eq!(parse_paging(Some("1"), Some("100")).unwrap(), (1, 100));
        assert!(parse_paging(Some("0"), None).is_err());
        assert!(parse_paging(Some("1"), Some("0")).is_err());
        assert!(parse_paging(Some("1"), Some("1001")).is_err());
        assert!(parse_paging(Some("x"), None).is_err());
    }

    #[test]
    fn validation_body_matches_the_source_handler() {
        let error = parse_paging(Some("0"), None).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let body = validation_body(
            "page",
            "greater_than_equal",
            "Input should be greater than or equal to 1",
            "0",
        );
        assert_eq!(body.error_code, 422);
        assert_eq!(body.detail, VALIDATION_FAILED);
        assert_eq!(body.errors[0].kind, "greater_than_equal");
        assert_eq!(body.errors[0].loc, ["query", "page"]);
        assert_eq!(
            body.errors[0].msg,
            "Input should be greater than or equal to 1"
        );
        assert_eq!(body.errors[0].input, "0");
    }
}
