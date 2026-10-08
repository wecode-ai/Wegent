// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Query parameters and FastAPI-compatible validation for the admin
//! plugin-publication list.

use brz_http_server::StatusCode;
use chrono::{NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

use crate::http_compat::FastApiError;

/// The endpoint's query parameters, using the source aliases
/// (`status`, `riskLevel`, `submittedAfter`, `submittedBefore`).
#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, rename = "riskLevel")]
    pub risk_level: Option<String>,
    #[serde(default)]
    pub submitter: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default, rename = "submittedAfter")]
    pub submitted_after: Option<String>,
    #[serde(default, rename = "submittedBefore")]
    pub submitted_before: Option<String>,
}

/// Validated list parameters.
#[derive(Debug)]
pub(super) struct ListParams {
    pub(super) page: i64,
    pub(super) limit: i64,
    pub(super) status: Option<String>,
    pub(super) risk_level: Option<String>,
    pub(super) submitter: Option<String>,
    pub(super) query: Option<String>,
    pub(super) submitted_after: Option<NaiveDateTime>,
    pub(super) submitted_before: Option<NaiveDateTime>,
}

/// One entry of FastAPI's 422 validation-error array.
#[derive(Debug, Serialize)]
struct ValidationError<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: String,
    input: &'a str,
}

impl ListQuery {
    /// Validate the FastAPI query contract in signature order: `page >= 1`,
    /// `1 <= limit <= 100`, and ISO-8601 datetimes for the submitted bounds.
    /// Pydantic reports every field error at once; the cross-field ordering
    /// check is a separate `HTTPException(422)` with a string `detail`.
    pub(super) fn validated(&self) -> Result<ListParams, FastApiError> {
        let mut errors: Vec<ValidationError<'_>> = Vec::new();
        let page = parse_int(&self.page, "page", 1, 1, i64::MAX, &mut errors);
        let limit = parse_int(&self.limit, "limit", 20, 1, 100, &mut errors);
        let submitted_after = parse_datetime(&self.submitted_after, "submittedAfter", &mut errors);
        let submitted_before =
            parse_datetime(&self.submitted_before, "submittedBefore", &mut errors);
        if !errors.is_empty() {
            return Err(FastApiError::validation(errors));
        }
        if let (Some(after), Some(before)) = (submitted_after, submitted_before)
            && after > before
        {
            return Err(FastApiError::detail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "submittedAfter must be earlier than or equal to submittedBefore",
            ));
        }
        Ok(ListParams {
            page,
            limit,
            status: self.status.clone(),
            risk_level: self.risk_level.clone(),
            submitter: self.submitter.clone(),
            query: self.query.clone(),
            submitted_after,
            submitted_before,
        })
    }
}

/// Parse an optional integer query parameter. On failure the FastAPI default is
/// returned and one validation error is recorded.
fn parse_int<'a>(
    raw: &'a Option<String>,
    field: &'a str,
    default: i64,
    min: i64,
    max: i64,
    errors: &mut Vec<ValidationError<'a>>,
) -> i64 {
    let Some(value) = raw else {
        return default;
    };
    match value.parse::<i64>() {
        Ok(parsed) if parsed < min => {
            errors.push(validation_error(
                "greater_than_equal",
                field,
                format!("Input should be greater than or equal to {min}"),
                value,
            ));
            default
        }
        Ok(parsed) if parsed > max => {
            errors.push(validation_error(
                "less_than_equal",
                field,
                format!("Input should be less than or equal to {max}"),
                value,
            ));
            default
        }
        Ok(parsed) => parsed,
        Err(_) => {
            errors.push(validation_error(
                "int_parsing",
                field,
                "Input should be a valid integer, unable to parse string as an integer",
                value,
            ));
            default
        }
    }
}

/// Parse an optional datetime query parameter, recording one error on failure.
fn parse_datetime<'a>(
    raw: &'a Option<String>,
    field: &'a str,
    errors: &mut Vec<ValidationError<'a>>,
) -> Option<NaiveDateTime> {
    let value = raw.as_deref()?;
    match parse_iso_datetime(value) {
        Some(parsed) => Some(parsed),
        None => {
            errors.push(validation_error(
                "datetime_from_date_parsing",
                field,
                "Input should be a valid datetime or date",
                value,
            ));
            None
        }
    }
}

/// `datetime.fromisoformat`: a naive local datetime or an aware value
/// normalized to UTC (source `_normalize_query_datetime`).
fn parse_iso_datetime(value: &str) -> Option<NaiveDateTime> {
    const NAIVE_FORMATS: [&str; 5] = [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M",
    ];
    for format in NAIVE_FORMATS {
        if let Ok(parsed) = NaiveDateTime::parse_from_str(value, format) {
            return Some(parsed);
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return date.and_hms_opt(0, 0, 0);
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.naive_utc())
}

/// One entry of FastAPI's 422 validation-error array.
fn validation_error<'a>(
    kind: &'a str,
    field: &'a str,
    msg: impl Into<String>,
    input: &'a str,
) -> ValidationError<'a> {
    ValidationError {
        kind,
        loc: ["query", field],
        msg: msg.into(),
        input,
    }
}
