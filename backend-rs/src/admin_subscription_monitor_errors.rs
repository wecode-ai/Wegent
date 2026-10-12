// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/subscription-monitor/errors` — admin background-execution
//! error list.
//!
//! Mirrors `app.api.endpoints.admin.subscription_monitor.get_subscription_monitor_errors`
//! (route `/subscription-monitor/errors`, router prefix `/subscription-monitor`
//! under `/admin`, mounted under `/api`).
//!
//! Source pipeline:
//! 1. `security.get_admin_user` — the standard `get_current_user` session
//!    decode plus the role check: `role != "admin"` raises
//!    `403 {"detail": "Permission denied. Admin access required."}`. The
//!    dependency resolves before the endpoint parameters, so the 403 wins
//!    over any query-validation error.
//! 2. `datetime.utcnow() - timedelta(hours=hours)` bounds the window.
//! 3. When `status` is truthy the query filters `status == status.upper()`;
//!    otherwise it filters `status IN ('FAILED', 'CANCELLED')`.
//! 4. `query.count()` — SQLAlchemy wraps the full projection in a subquery
//!    (`SELECT count(*) ... FROM (SELECT ...) AS anon_1`).
//! 5. `created_at DESC` with `offset((page-1)*limit).limit(limit)`.
//! 6. Build each item from the row; `task_id` collapses to `null` when
//!    `<= 0`, `error_message` to `null` when empty.
use brz_mysql::{FromMysqlRow, Mysql};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

use crate::http_compat::FastApiError;
use crate::state::AppState;

/// The admin-only 403 body (`security.get_admin_user`).
const ADMIN_REQUIRED: &str = "Permission denied. Admin access required.";

/// Query parameters of the errors endpoint.
#[derive(Debug, Default, Deserialize)]
pub struct ErrorsQuery {
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub hours: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

/// Validated pagination, window, and filter parameters.
#[derive(Debug)]
struct ErrorsParams {
    page: i64,
    limit: i64,
    hours: i64,
    status: Option<String>,
}

impl ErrorsQuery {
    /// Validate the FastAPI query contract: `page >= 1`, `1 <= limit <= 100`,
    /// `1 <= hours <= 168`. `status` stays optional; an empty string is falsy
    /// like the source `if status:`.
    fn validated(self) -> Result<ErrorsParams, FastApiError> {
        let page = parse_i64(self.page.as_deref(), "page", 1, 1, i64::MAX)?;
        let limit = parse_i64(self.limit.as_deref(), "limit", 20, 1, 100)?;
        let hours = parse_i64(self.hours.as_deref(), "hours", 24, 1, 168)?;
        let status = match self.status {
            Some(value) if !value.is_empty() => Some(value.to_uppercase()),
            _ => None,
        };
        Ok(ErrorsParams {
            page,
            limit,
            hours,
            status,
        })
    }
}

/// Parse an optional integer query parameter with FastAPI-compatible
/// validation. The default is used when the parameter is absent.
fn parse_i64(
    raw: Option<&str>,
    field: &str,
    default: i64,
    min: i64,
    max: i64,
) -> Result<i64, FastApiError> {
    match raw {
        None => Ok(default),
        Some(value) => match value.parse::<i64>() {
            Ok(parsed) if parsed >= min && parsed <= max => Ok(parsed),
            Ok(_) => Err(validation_error(
                field,
                "greater_than_equal",
                "Input should be in the valid range",
            )),
            Err(_) => Err(validation_error(
                field,
                "int_parsing",
                "Input should be a valid integer, unable to parse string as an integer",
            )),
        },
    }
}

/// One FastAPI query-validation error entry (`detail[]`), matching the shape
/// FastAPI emits for a rejected `Query(...)` parameter.
#[derive(Debug, Serialize)]
struct ValidationEntry<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: &'a str,
    input: Option<()>,
}

/// FastAPI-style 422 validation error body.
fn validation_error(field: &str, kind: &str, message: &str) -> FastApiError {
    FastApiError::validation([ValidationEntry {
        kind,
        loc: ["query", field],
        msg: message,
        input: None,
    }])
}

/// The `background_executions` column projection rendered by
/// `db.query(BackgroundExecution)` (SQLAlchemy labels every column
/// `background_executions_<name>`), in the model's mapped order.
const EXECUTION_COLUMNS: &str = "background_executions.id AS background_executions_id, \
     background_executions.user_id AS background_executions_user_id, \
     background_executions.subscription_id AS background_executions_subscription_id, \
     background_executions.task_id AS background_executions_task_id, \
     background_executions.inbox_message_id AS background_executions_inbox_message_id, \
     background_executions.trigger_type AS background_executions_trigger_type, \
     background_executions.trigger_reason AS background_executions_trigger_reason, \
     background_executions.prompt AS background_executions_prompt, \
     background_executions.status AS background_executions_status, \
     background_executions.result_summary AS background_executions_result_summary, \
     background_executions.error_message AS background_executions_error_message, \
     background_executions.retry_attempt AS background_executions_retry_attempt, \
     background_executions.version AS background_executions_version, \
     background_executions.started_at AS background_executions_started_at, \
     background_executions.completed_at AS background_executions_completed_at, \
     background_executions.created_at AS background_executions_created_at, \
     background_executions.updated_at AS background_executions_updated_at";

/// A `background_executions` row, selected with the full labeled source column
/// list; only response-driving fields are consumed.
#[derive(Debug, FromMysqlRow)]
struct ErrorRow {
    #[mysql(rename = "background_executions_id")]
    id: i32,
    #[mysql(rename = "background_executions_user_id")]
    user_id: i32,
    #[mysql(rename = "background_executions_subscription_id")]
    subscription_id: i32,
    #[mysql(rename = "background_executions_task_id")]
    task_id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "background_executions_inbox_message_id")]
    inbox_message_id: i32,
    #[mysql(rename = "background_executions_trigger_type")]
    trigger_type: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "background_executions_trigger_reason")]
    trigger_reason: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "background_executions_prompt")]
    prompt: String,
    #[mysql(rename = "background_executions_status")]
    status: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "background_executions_result_summary")]
    result_summary: String,
    #[mysql(rename = "background_executions_error_message")]
    error_message: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "background_executions_retry_attempt")]
    retry_attempt: i32,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "background_executions_version")]
    version: i32,
    #[mysql(rename = "background_executions_started_at")]
    started_at: Option<NaiveDateTime>,
    #[mysql(rename = "background_executions_completed_at")]
    completed_at: Option<NaiveDateTime>,
    #[mysql(rename = "background_executions_created_at")]
    created_at: NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "background_executions_updated_at")]
    updated_at: NaiveDateTime,
}

/// `count(*) AS count_1` row.
#[derive(Debug, FromMysqlRow)]
struct CountRow {
    #[mysql(rename = "count_1")]
    count: i64,
}

/// `SubscriptionMonitorErrorListResponse` — the top-level JSON body.
#[derive(Debug, Serialize)]
struct ErrorListResponse {
    total: i64,
    items: Vec<ErrorItem>,
}

/// One `SubscriptionMonitorError` item in pydantic field declaration order.
#[derive(Debug, Serialize)]
struct ErrorItem {
    execution_id: i32,
    subscription_id: i32,
    user_id: i32,
    task_id: Option<i64>,
    status: String,
    error_message: Option<String>,
    trigger_type: String,
    created_at: PydanticDateTime,
    started_at: Option<PydanticDateTime>,
    completed_at: Option<PydanticDateTime>,
}

/// pydantic naive-datetime serialization: `isoformat()` without an offset,
/// 6-digit microseconds only when nonzero.
#[derive(Debug, Serialize)]
struct PydanticDateTime(String);

impl PydanticDateTime {
    fn new(value: NaiveDateTime) -> Self {
        let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
        if value.and_utc().timestamp_subsec_nanos() == 0 {
            Self(base)
        } else {
            Self(format!(
                "{base}.{:06}",
                value.and_utc().timestamp_subsec_micros()
            ))
        }
    }
}

/// GET /api/admin/subscription-monitor/errors: the errors free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/admin/subscription-monitor/errors")]
async fn get_subscription_monitor_errors(
    #[inject(state)] state: &AppState,
    #[auth] current_user: crate::auth::SessionUser,
    query: brz_http_server::Query<ErrorsQuery>,
) -> Result<ErrorListResponse, FastApiError> {
    subscription_monitor_errors(state, &current_user, &query).await
}

/// Handler body for `GET /api/admin/subscription-monitor/errors`.
async fn subscription_monitor_errors(
    state: &AppState,
    current_user: &crate::auth::SessionUser,
    query: &ErrorsQuery,
) -> Result<ErrorListResponse, FastApiError> {
    // `get_admin_user` resolves before the endpoint parameters.
    ensure_admin(&current_user.role)?;

    let params = ErrorsQuery {
        page: query.page.clone(),
        limit: query.limit.clone(),
        hours: query.hours.clone(),
        status: query.status.clone(),
    }
    .validated()?;

    let where_clause = build_where_clause(&params);
    let total = count_errors(&state.mysql, &where_clause)
        .await
        .map_err(internal_error)?;
    let skip = (params.page - 1) * params.limit;
    let rows = fetch_errors(&state.mysql, &where_clause, &params, skip)
        .await
        .map_err(internal_error)?;

    let items = rows.iter().map(error_item).collect();
    Ok(ErrorListResponse { total, items })
}

/// `security.get_admin_user` role check.
fn ensure_admin(role: &str) -> Result<(), FastApiError> {
    if role != "admin" {
        return Err(FastApiError::forbidden(ADMIN_REQUIRED));
    }
    Ok(())
}

/// Build the WHERE clause fragment shared by the count and select queries.
/// The time threshold renders `datetime.utcnow() - timedelta(hours=hours)` as
/// an inlined literal (microsecond precision, naive UTC), matching the
/// recorded `COM_QUERY`.
fn build_where_clause(params: &ErrorsParams) -> String {
    let threshold = (chrono::Utc::now().naive_utc() - chrono::Duration::hours(params.hours))
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string();
    let mut clause = format!("background_executions.created_at >= '{threshold}'");
    match &params.status {
        Some(status) => clause.push_str(&format!(
            " AND background_executions.status = '{}'",
            escape_sql_string(status)
        )),
        None => clause.push_str(" AND background_executions.status IN ('FAILED', 'CANCELLED')"),
    }
    clause
}

/// The count statement: the source wraps the full select projection in a
/// subquery (`SELECT count(*) FROM (SELECT ... FROM ... WHERE ...) AS anon_1`).
fn count_sql(where_clause: &str) -> String {
    format!(
        "SELECT count(*) AS count_1 \n\
         FROM (SELECT {EXECUTION_COLUMNS} \n\
         FROM background_executions \n\
         WHERE {where_clause}) AS anon_1"
    )
}

/// The paginated select statement, ordered by `created_at DESC`.
fn select_sql(where_clause: &str, skip: i64, limit: i64) -> String {
    format!(
        "SELECT {EXECUTION_COLUMNS} \n\
         FROM background_executions \n\
         WHERE {where_clause} ORDER BY background_executions.created_at DESC \n LIMIT {skip}, {limit}"
    )
}

/// Count matching executions.
async fn count_errors<M: Mysql>(
    mysql: &M,
    where_clause: &str,
) -> Result<i64, brz_mysql::MysqlError> {
    let row: CountRow = mysql.fetch_one(count_sql(where_clause), ()).await?;
    Ok(row.count)
}

/// Fetch the paginated execution rows.
async fn fetch_errors<M: Mysql>(
    mysql: &M,
    where_clause: &str,
    params: &ErrorsParams,
    skip: i64,
) -> Result<Vec<ErrorRow>, brz_mysql::MysqlError> {
    mysql
        .fetch_all(select_sql(where_clause, skip, params.limit), ())
        .await
}

/// Build one `SubscriptionMonitorError` item: `task_id` collapses to `null`
/// when `<= 0`; `error_message` collapses to `null` when empty.
fn error_item(row: &ErrorRow) -> ErrorItem {
    ErrorItem {
        execution_id: row.id,
        subscription_id: row.subscription_id,
        user_id: row.user_id,
        task_id: (row.task_id > 0).then_some(row.task_id),
        status: row.status.clone(),
        error_message: (!row.error_message.is_empty()).then(|| row.error_message.clone()),
        trigger_type: row.trigger_type.clone(),
        created_at: PydanticDateTime::new(row.created_at),
        started_at: row.started_at.map(PydanticDateTime::new),
        completed_at: row.completed_at.map(PydanticDateTime::new),
    }
}

/// Escape one string literal with MySQL's default quoting rules, iterating
/// over Unicode scalar values so multi-byte UTF-8 passes through unchanged.
fn escape_sql_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\0' => out.push_str("\\0"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{1a}' => out.push_str("\\Z"),
            other => out.push(other),
        }
    }
    out
}

/// Source `python_exception_handler` 500 response body
/// (`{"error_code": 500, "detail": "Internal server error"}`).
fn internal_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "subscription monitor errors dependency failure");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;
    use chrono::NaiveDate;

    fn params(status: Option<&str>) -> ErrorsParams {
        ErrorsParams {
            page: 1,
            limit: 20,
            hours: 24,
            status: status.map(str::to_string),
        }
    }

    #[test]
    fn default_query_params_match_source_defaults() {
        let parsed = ErrorsQuery::default().validated().unwrap();
        assert_eq!(parsed.page, 1);
        assert_eq!(parsed.limit, 20);
        assert_eq!(parsed.hours, 24);
        assert_eq!(parsed.status, None);
    }

    #[test]
    fn empty_status_is_treated_as_absent() {
        let parsed = ErrorsQuery {
            status: Some(String::new()),
            ..Default::default()
        }
        .validated()
        .unwrap();
        assert_eq!(parsed.status, None);
    }

    #[test]
    fn status_is_uppercased() {
        let parsed = ErrorsQuery {
            status: Some("failed".to_string()),
            ..Default::default()
        }
        .validated()
        .unwrap();
        assert_eq!(parsed.status.as_deref(), Some("FAILED"));
    }

    #[test]
    fn rejects_out_of_range_params() {
        for query in [
            ErrorsQuery {
                page: Some("0".to_string()),
                ..Default::default()
            },
            ErrorsQuery {
                limit: Some("101".to_string()),
                ..Default::default()
            },
            ErrorsQuery {
                hours: Some("169".to_string()),
                ..Default::default()
            },
        ] {
            let error = query.validated().unwrap_err();
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
    }

    #[test]
    fn rejects_non_integer_params() {
        let error = ErrorsQuery {
            page: Some("x".to_string()),
            ..Default::default()
        }
        .validated()
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn where_clause_defaults_to_error_statuses() {
        let clause = build_where_clause(&params(None));
        assert!(clause.contains("background_executions.created_at >= '"));
        assert!(clause.contains("background_executions.status IN ('FAILED', 'CANCELLED')"));
    }

    #[test]
    fn where_clause_uses_single_status_filter() {
        let clause = build_where_clause(&params(Some("CANCELLED")));
        assert!(clause.contains("background_executions.status = 'CANCELLED'"));
        assert!(!clause.contains(" IN ("));
    }

    #[test]
    fn item_collapses_task_and_empty_error() {
        let dt = NaiveDate::from_ymd_opt(2026, 10, 7)
            .unwrap()
            .and_hms_opt(7, 10, 31)
            .unwrap();
        let mut row = ErrorRow {
            id: 2376235,
            user_id: 3733,
            subscription_id: 200322,
            task_id: 513059613498149,
            inbox_message_id: 0,
            trigger_type: "interval".to_string(),
            trigger_reason: String::new(),
            prompt: String::new(),
            status: "FAILED".to_string(),
            result_summary: String::new(),
            error_message: String::new(),
            retry_attempt: 0,
            version: 1,
            started_at: Some(dt),
            completed_at: Some(dt),
            created_at: dt,
            updated_at: dt,
        };
        let item = error_item(&row);
        assert_eq!(item.task_id, Some(513059613498149));
        assert_eq!(item.error_message, None);
        assert_eq!(item.created_at.0, "2026-10-07T07:10:31");
        assert_eq!(
            item.started_at.as_ref().map(|value| value.0.as_str()),
            Some("2026-10-07T07:10:31")
        );

        row.task_id = 0;
        row.error_message = "boom".to_string();
        let item = error_item(&row);
        assert_eq!(item.task_id, None);
        assert_eq!(item.error_message.as_deref(), Some("boom"));
    }

    #[test]
    fn pydantic_datetime_renders_whole_seconds_without_fraction() {
        let dt = NaiveDate::from_ymd_opt(2026, 10, 7)
            .unwrap()
            .and_hms_opt(7, 10, 31)
            .unwrap();
        assert_eq!(PydanticDateTime::new(dt).0, "2026-10-07T07:10:31");
    }

    #[test]
    fn pydantic_datetime_renders_nonzero_microseconds() {
        let dt = NaiveDate::from_ymd_opt(2026, 10, 7)
            .unwrap()
            .and_hms_micro_opt(7, 10, 31, 123456)
            .unwrap();
        assert_eq!(PydanticDateTime::new(dt).0, "2026-10-07T07:10:31.123456");
    }

    #[test]
    fn item_keeps_pydantic_field_order() {
        let dt = NaiveDate::from_ymd_opt(2026, 10, 7)
            .unwrap()
            .and_hms_opt(7, 10, 31)
            .unwrap();
        let row = ErrorRow {
            id: 1,
            user_id: 2,
            subscription_id: 3,
            task_id: 4,
            inbox_message_id: 0,
            trigger_type: "cron".to_string(),
            trigger_reason: String::new(),
            prompt: String::new(),
            status: "FAILED".to_string(),
            result_summary: String::new(),
            error_message: "e".to_string(),
            retry_attempt: 0,
            version: 1,
            started_at: Some(dt),
            completed_at: Some(dt),
            created_at: dt,
            updated_at: dt,
        };
        let rendered = crate::json_contract_tests::serialized(error_item(&row)).unwrap();
        let keys: Vec<&str> = rendered
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "execution_id",
                "subscription_id",
                "user_id",
                "task_id",
                "status",
                "error_message",
                "trigger_type",
                "created_at",
                "started_at",
                "completed_at",
            ]
        );
    }

    #[test]
    fn escaping_quotes_apostrophes() {
        assert_eq!(escape_sql_string("a'b"), "a\\'b");
        assert_eq!(escape_sql_string("normal"), "normal");
    }

    #[test]
    fn count_and_select_sql_match_the_recorded_renderings() {
        let where_clause = "background_executions.created_at >= '2026-10-06 07:11:17.605790' \
             AND background_executions.status IN ('FAILED', 'CANCELLED')";
        let count = count_sql(where_clause);
        assert!(count.starts_with(
            "SELECT count(*) AS count_1 \nFROM (SELECT background_executions.id AS \
             background_executions_id, "
        ));
        assert!(count.contains("FROM background_executions \n"));
        assert!(count.ends_with(&format!("WHERE {where_clause}) AS anon_1")));

        let select = select_sql(where_clause, 0, 20);
        assert!(
            select.starts_with("SELECT background_executions.id AS background_executions_id, ")
        );
        // The recorded statement carries a space on both sides of the newline
        // before LIMIT.
        assert!(select.ends_with(&format!(
            "WHERE {where_clause} ORDER BY background_executions.created_at DESC \n LIMIT 0, 20"
        )));
    }

    #[test]
    fn admin_check_rejects_non_admin() {
        let error = ensure_admin("user").unwrap_err();
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
        assert!(ensure_admin("admin").is_ok());
    }
}
