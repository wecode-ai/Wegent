// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/public-shells` — the admin public-shell list.
//!
//! Mirrors `app.api.endpoints.admin.public_shells.list_public_shells`
//! (router included by `app.api.endpoints.admin.router` and mounted under
//! `prefix="/admin"` in `app.api.api`, so the public path is
//! `/api/admin/public-shells`):
//!
//! 1. authenticate the bearer token and require an admin role
//!    (`Depends(get_admin_user)` — a non-admin session is `403
//!    {"detail": "Permission denied. Admin access required."}`);
//! 2. validate the `page >= 1` and `1 <= limit <= 1000` query contract;
//! 3. count the public shell rows (`Kind.user_id == 0`, `Kind.kind ==
//!    'Shell'`) — `query.count()`;
//! 4. load one page ordered by `updated_at DESC` with
//!    `.offset((page - 1) * limit).limit(limit)`;
//! 5. render `PublicShellListResponse` (`total`, `items`), each item the
//!    `PublicShellResponse` shape with `display_name`/`shell_type` derived
//!    from the stored `kinds.json` document.
use brz_mysql::Json;
use chrono::NaiveDateTime;
use serde::Deserialize;

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::json_compat::OpaqueJson;
use crate::state::AppState;

/// FastAPI `Query(1, ge=1)` default for `page`.
const DEFAULT_PAGE: i64 = 1;
/// FastAPI `Query(20, ge=1, le=1000)` default for `limit`.
const DEFAULT_LIMIT: i64 = 20;

/// `get_admin_user`'s 403 detail for a non-admin session.
const ADMIN_REQUIRED_DETAIL: &str = "Permission denied. Admin access required.";

/// The `kinds` column projection, labeled like SQLAlchemy's query rendering
/// (`kinds.<column> AS kinds_<column>`) so the prepared statement matches the
/// recorded exchange.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// Query parameters (`page >= 1` default 1, `1 <= limit <= 1000` default 20).
/// FastAPI renders validation failures as 422 before the handler body runs.
#[derive(Debug, Default, Deserialize)]
pub struct ShellQuery {
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

/// The effective query contract after FastAPI-compatible validation.
#[derive(Debug, PartialEq, Eq)]
struct ShellParams {
    page: i64,
    limit: i64,
}

/// One FastAPI `Query(...)` validation entry (`{type, loc, msg, input}`).
#[derive(serde::Serialize)]
struct QueryValidationError<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: &'a str,
    input: crate::json_compat::JsonNull,
}

/// FastAPI-style 422 validation error body (`Query(...)` constraints).
fn validation_error(field: &str, kind: &str, message: &str) -> FastApiError {
    FastApiError::validation(vec![QueryValidationError {
        kind,
        loc: ["query", field],
        msg: message,
        input: crate::json_compat::JsonNull,
    }])
}

impl ShellQuery {
    /// Validate the FastAPI query contract: `page >= 1` and
    /// `1 <= limit <= 1000`. Returns the effective [`ShellParams`].
    fn validated(&self) -> Result<ShellParams, FastApiError> {
        let page = match self.page {
            None => DEFAULT_PAGE,
            Some(page) if page >= 1 => page,
            Some(_) => {
                return Err(validation_error(
                    "page",
                    "greater_than_equal",
                    "Input should be greater than or equal to 1",
                ));
            }
        };
        let limit = match self.limit {
            None => DEFAULT_LIMIT,
            Some(limit) if (1..=1000).contains(&limit) => limit,
            Some(limit) if limit < 1 => {
                return Err(validation_error(
                    "limit",
                    "greater_than_equal",
                    "Input should be greater than or equal to 1",
                ));
            }
            Some(_) => {
                return Err(validation_error(
                    "limit",
                    "less_than_equal",
                    "Input should be less than or equal to 1000",
                ));
            }
        };
        Ok(ShellParams { page, limit })
    }
}

/// A public shell `Kind` row, selected with the full labeled source column
/// list; only the response fields are consumed. The result columns carry the
/// `kinds_<column>` aliases, so every field is renamed.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct PublicShellRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
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
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_user_id")]
    user_id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_kind")]
    kind: String,
}

/// The `count(*)` row of `query.count()`.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct CountRow {
    count_1: i64,
}

/// `query.count()`: the source wraps the filtered `Kind` projection in
/// `SELECT count(*) AS count_1 ... AS anon_1`.
fn count_sql() -> String {
    format!(
        "SELECT count(*) AS count_1 \nFROM (SELECT {KIND_COLUMNS} \n\
         FROM kinds \nWHERE kinds.user_id = 0 AND kinds.kind = 'Shell') AS anon_1",
    )
}

/// The paginated list query: `.order_by(Kind.updated_at.desc())
/// .offset((page - 1) * limit).limit(limit)`. SQLAlchemy renders the offset
/// and limit as inline literals; both are validated integers, so inlining is
/// injection-safe.
fn list_sql(page: i64, limit: i64) -> String {
    let offset = (page - 1) * limit;
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = 0 AND kinds.kind = 'Shell' \
         ORDER BY kinds.updated_at DESC \n LIMIT {offset}, {limit}",
    )
}

/// pydantic datetime serialization for the `Kind` row timestamps
/// (`YYYY-MM-DDTHH:MM:SS`, microseconds appended only when non-zero).
fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

/// The `kinds.json` fields the response derives its display values from. The
/// document is decoded once; unknown keys are ignored and a non-object
/// document leaves every field absent.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ShellDocument {
    spec: Option<OpaqueJson>,
    metadata: Option<OpaqueJson>,
}

/// `_get_shell_type`: `spec.shellType` when `spec` is an object and the key is
/// a string, otherwise absent.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ShellSpec {
    #[serde(rename = "shellType")]
    shell_type: Option<String>,
}

/// `_get_shell_display_name`: `metadata.displayName` when `metadata` is an
/// object and the key is a string.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ShellMetadata {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

/// `_get_shell_display_name`: `metadata.displayName` when it is a non-empty
/// string different from the row name, otherwise `None`.
fn shell_display_name(document: &ShellDocument, name: &str) -> Option<String> {
    let display_name = document
        .metadata
        .as_ref()?
        .project::<ShellMetadata>()?
        .display_name?;
    if display_name.is_empty() || display_name == name {
        return None;
    }
    Some(display_name)
}

/// `_get_shell_type`: `spec.shellType` when present, otherwise `None`.
fn shell_type(document: &ShellDocument) -> Option<String> {
    document.spec.as_ref()?.project::<ShellSpec>()?.shell_type
}

/// `PublicShellResponse` pydantic serialization. Field order follows the model
/// declaration (`shell_json` carries the serialization alias `json`).
#[derive(serde::Serialize)]
struct PublicShellResponse {
    id: i64,
    name: String,
    namespace: String,
    display_name: Option<String>,
    shell_type: Option<String>,
    json: OpaqueJson,
    is_active: bool,
    created_at: String,
    updated_at: String,
}

/// `PublicShellListResponse` (`total`, `items`).
#[derive(serde::Serialize)]
struct PublicShellListResponse {
    total: i64,
    items: Vec<PublicShellResponse>,
}

/// `_shell_to_response`: derive the response fields from one `Kind` row.
fn shell_response(row: &PublicShellRow) -> PublicShellResponse {
    let document = row.json.0.project::<ShellDocument>().unwrap_or_default();
    PublicShellResponse {
        id: row.id,
        name: row.name.clone(),
        namespace: row.namespace.clone(),
        display_name: shell_display_name(&document, &row.name),
        shell_type: shell_type(&document),
        json: row.json.0.clone(),
        is_active: row.is_active != 0,
        created_at: pydantic_datetime(row.created_at),
        updated_at: pydantic_datetime(row.updated_at),
    }
}

/// `get_admin_user`: reject a non-admin session with the source 403.
fn require_admin(user: &UserRow) -> Result<(), FastApiError> {
    if user.role != "admin" {
        return Err(FastApiError::forbidden(ADMIN_REQUIRED_DETAIL));
    }
    Ok(())
}

/// GET /api/admin/public-shells: the admin list free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/admin/public-shells")]
async fn list_public_shells(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: brz_http_server::Query<ShellQuery>,
) -> Result<PublicShellListResponse, FastApiError> {
    admin_public_shells(state, user.0, &query).await
}

/// Handler body for `GET /api/admin/public-shells`.
async fn admin_public_shells(
    state: &AppState,
    user: UserRow,
    query: &ShellQuery,
) -> Result<PublicShellListResponse, FastApiError> {
    require_admin(&user)?;
    let ShellParams { page, limit } = query.validated()?;

    // `query.count()`.
    let count_row: Option<CountRow> = state
        .mysql
        .fetch_optional(count_sql().as_str(), ())
        .await
        .map_err(|error| {
            tracing::error!(%error, "admin public-shells count database failure");
            FastApiError::internal()
        })?;
    let total = count_row.map(|row| row.count_1).unwrap_or(0);

    // `query.order_by(...).offset(...).limit(...).all()`.
    let rows: Vec<PublicShellRow> = state
        .mysql
        .fetch_all(list_sql(page, limit).as_str(), ())
        .await
        .map_err(|error| {
            tracing::error!(%error, "admin public-shells list database failure");
            FastApiError::internal()
        })?;

    Ok(PublicShellListResponse {
        total,
        items: rows.iter().map(shell_response).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    /// The exact `count(*)` statement captured in the recording.
    const RECORDED_COUNT_SQL: &str = "SELECT count(*) AS count_1 \n\
        FROM (SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
        kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
        kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
        kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
        kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
        WHERE kinds.user_id = 0 AND kinds.kind = 'Shell') AS anon_1";

    /// The exact paginated statement captured in the recording (`page=1`,
    /// `limit=100`).
    const RECORDED_LIST_SQL: &str = "SELECT kinds.id AS kinds_id, \
        kinds.user_id AS kinds_user_id, kinds.kind AS kinds_kind, \
        kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
        kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
        kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at \n\
        FROM kinds \nWHERE kinds.user_id = 0 AND kinds.kind = 'Shell' \
        ORDER BY kinds.updated_at DESC \n LIMIT 0, 100";

    #[derive(serde::Serialize)]
    struct LabelsFixture {
        #[serde(rename = "type")]
        kind: &'static str,
    }

    #[derive(serde::Serialize)]
    struct MetadataFixture {
        name: &'static str,
        labels: LabelsFixture,
        namespace: &'static str,
    }

    #[derive(serde::Serialize)]
    struct SpecFixture {
        runtime: &'static str,
        #[serde(rename = "shellType")]
        shell_type: &'static str,
        #[serde(rename = "supportModel")]
        support_model: [&'static str; 1],
    }

    #[derive(serde::Serialize)]
    struct StatusFixture {
        state: &'static str,
    }

    #[derive(serde::Serialize)]
    struct ShellDocumentFixture {
        kind: &'static str,
        spec: SpecFixture,
        status: StatusFixture,
        metadata: MetadataFixture,
        #[serde(rename = "apiVersion")]
        api_version: &'static str,
    }

    fn shell_document() -> OpaqueJson {
        OpaqueJson::from_serializable(ShellDocumentFixture {
            kind: "Shell",
            spec: SpecFixture {
                runtime: "ClaudeCode",
                shell_type: "ClaudeCode",
                support_model: ["claude"],
            },
            status: StatusFixture { state: "Available" },
            metadata: MetadataFixture {
                name: "ClaudeCode",
                labels: LabelsFixture {
                    kind: "local_engine",
                },
                namespace: "default",
            },
            api_version: "agent.wecode.io/v1",
        })
    }

    fn shell_row() -> PublicShellRow {
        PublicShellRow {
            id: 50366,
            name: "ClaudeCode".to_string(),
            namespace: "default".to_string(),
            json: Json(shell_document()),
            is_active: 1,
            created_at: NaiveDate::from_ymd_opt(2025, 10, 12)
                .unwrap()
                .and_hms_opt(11, 16, 31)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 9, 16)
                .unwrap()
                .and_hms_opt(13, 1, 14)
                .unwrap(),
            user_id: 0,
            kind: "Shell".to_string(),
        }
    }

    fn parse_document(value: OpaqueJson) -> ShellDocument {
        value.project::<ShellDocument>().unwrap_or_default()
    }

    /// An empty JSON object, serialized without naming any JSON crate.
    #[derive(serde::Serialize)]
    struct EmptyDocument {}

    #[test]
    fn count_sql_matches_the_recorded_statement() {
        assert_eq!(count_sql(), RECORDED_COUNT_SQL);
    }

    #[test]
    fn list_sql_matches_the_recorded_statement() {
        assert_eq!(list_sql(1, 100), RECORDED_LIST_SQL);
    }

    #[test]
    fn list_sql_renders_offset_from_page_and_limit() {
        assert!(list_sql(3, 20).ends_with(" LIMIT 40, 20"));
        assert!(list_sql(1, 20).ends_with(" LIMIT 0, 20"));
    }

    #[test]
    fn query_defaults_when_absent() {
        let query = ShellQuery::default();
        assert_eq!(
            query.validated().unwrap(),
            ShellParams { page: 1, limit: 20 }
        );
    }

    #[test]
    fn query_accepts_explicit_values() {
        let query = ShellQuery {
            page: Some(2),
            limit: Some(100),
        };
        assert_eq!(
            query.validated().unwrap(),
            ShellParams {
                page: 2,
                limit: 100
            }
        );
    }

    #[test]
    fn query_rejects_out_of_range_values() {
        let page = ShellQuery {
            page: Some(0),
            limit: None,
        };
        assert_eq!(
            page.validated().unwrap_err().status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        let limit_low = ShellQuery {
            page: None,
            limit: Some(0),
        };
        assert_eq!(
            limit_low.validated().unwrap_err().status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        let limit_high = ShellQuery {
            page: None,
            limit: Some(1001),
        };
        assert_eq!(
            limit_high.validated().unwrap_err().status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn shell_response_matches_the_recorded_item() {
        let value = crate::json_contract_tests::serialized(shell_response(&shell_row())).unwrap();
        assert_eq!(
            value.to_string(),
            "{\"id\":50366,\"name\":\"ClaudeCode\",\"namespace\":\"default\",\
             \"display_name\":null,\"shell_type\":\"ClaudeCode\",\"json\":{\
             \"kind\":\"Shell\",\"spec\":{\"runtime\":\"ClaudeCode\",\
             \"shellType\":\"ClaudeCode\",\"supportModel\":[\"claude\"]},\
             \"status\":{\"state\":\"Available\"},\"metadata\":{\"name\":\"ClaudeCode\",\
             \"labels\":{\"type\":\"local_engine\"},\"namespace\":\"default\"},\
             \"apiVersion\":\"agent.wecode.io/v1\"},\"is_active\":true,\
             \"created_at\":\"2025-10-12T11:16:31\",\"updated_at\":\"2026-09-16T13:01:14\"}"
        );
    }

    #[test]
    fn display_name_is_suppressed_when_equal_to_the_row_name() {
        // The recorded `Chat` row carries `displayName: "Chat"` yet renders
        // `display_name: null`.
        #[derive(serde::Serialize)]
        struct DisplayName {
            #[serde(rename = "displayName")]
            display_name: &'static str,
        }
        #[derive(serde::Serialize)]
        struct MetadataOnly {
            metadata: DisplayName,
        }
        let chat = parse_document(OpaqueJson::from_serializable(MetadataOnly {
            metadata: DisplayName {
                display_name: "Chat",
            },
        }));
        assert_eq!(shell_display_name(&chat, "Chat"), None);
        assert_eq!(shell_display_name(&chat, "Other"), Some("Chat".to_string()));

        // Absent `metadata`/`displayName` and an empty value all render null.
        let absent = parse_document(OpaqueJson::from_serializable(EmptyDocument {}));
        assert_eq!(shell_display_name(&absent, "Chat"), None);
        let empty = parse_document(OpaqueJson::from_serializable(MetadataOnly {
            metadata: DisplayName { display_name: "" },
        }));
        assert_eq!(shell_display_name(&empty, "Chat"), None);
    }

    #[test]
    fn shell_type_reads_only_spec_shell_type() {
        // The recorded `Agno`/`Dify` rows carry `spec.runtime` but no
        // `spec.shellType`, so `shell_type` is null.
        #[derive(serde::Serialize)]
        struct Runtime {
            runtime: &'static str,
        }
        #[derive(serde::Serialize)]
        struct RuntimeDocument {
            spec: Runtime,
        }
        let agno = parse_document(OpaqueJson::from_serializable(RuntimeDocument {
            spec: Runtime { runtime: "Agno" },
        }));
        assert_eq!(shell_type(&agno), None);
        assert_eq!(
            shell_type(&parse_document(shell_document())),
            Some("ClaudeCode".to_string())
        );
        assert_eq!(
            shell_type(&parse_document(OpaqueJson::from_serializable(
                EmptyDocument {}
            ))),
            None
        );
    }

    #[test]
    fn admin_check_rejects_non_admin_sessions() {
        let mut user = crate::auth::UserRow {
            id: 157,
            user_name: "example-user".to_string(),
            users_password_hash: String::new(),
            email: None,
            git_info: Json(OpaqueJson::from_serializable(crate::json_compat::JsonNull)),
            is_active: 1,
            role: "user".to_string(),
            auth_source: "oidc".to_string(),
            preferences: String::new(),
            created_at: NaiveDate::from_ymd_opt(2025, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2025, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
        };
        let error = require_admin(&user).unwrap_err();
        assert_eq!(error.status(), brz_http_server::StatusCode::FORBIDDEN);
        assert_eq!(error.detail_message(), Some(ADMIN_REQUIRED_DETAIL));

        user.role = "admin".to_string();
        assert!(require_admin(&user).is_ok());
    }
}
