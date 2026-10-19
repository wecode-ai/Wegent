// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Query parameters and FastAPI-compatible validation for the submitter
//! plugin-publication list
//! (`app/api/endpoints/plugin_publications.py::list_plugin_publication_requests`).
//!
//! The source signature is `page`, `limit`, `sourcePluginId` (`gt=0`),
//! `activeOnly` (pydantic boolean), `submittedAfter`, `submittedBefore`. The
//! bound window check is the service-level `HTTPException(422)` and therefore
//! runs after FastAPI validation, exactly like the admin variant.

use brz_http_server::StatusCode;
use chrono::{NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

use crate::http_compat::FastApiError;

/// The endpoint's query parameters, using the source aliases.
#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
    #[serde(default, rename = "sourcePluginId")]
    pub source_plugin_id: Option<String>,
    #[serde(default, rename = "activeOnly")]
    pub active_only: Option<String>,
    #[serde(default, rename = "submittedAfter")]
    pub submitted_after: Option<String>,
    #[serde(default, rename = "submittedBefore")]
    pub submitted_before: Option<String>,
}

/// Validated list parameters.
#[derive(Debug)]
pub struct ListParams {
    pub page: i64,
    pub limit: i64,
    pub source_plugin_id: Option<i64>,
    pub active_only: bool,
    pub submitted_after: Option<NaiveDateTime>,
    pub submitted_before: Option<NaiveDateTime>,
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
    /// `1 <= limit <= 100`, `sourcePluginId > 0`, a pydantic boolean for
    /// `activeOnly`, and ISO-8601 datetimes for the submitted bounds. The
    /// cross-field ordering check is the service's separate 422 detail.
    pub fn validated(&self) -> Result<ListParams, FastApiError> {
        let mut errors: Vec<ValidationError<'_>> = Vec::new();
        let page = parse_int(&self.page, "page", 1, 1, i64::MAX, &mut errors);
        let limit = parse_int(&self.limit, "limit", 20, 1, 100, &mut errors);
        let source_plugin_id = match self.source_plugin_id.as_deref() {
            Some(value) => match value.parse::<i64>() {
                Ok(parsed) if parsed <= 0 => {
                    errors.push(validation_error(
                        "greater_than",
                        "sourcePluginId",
                        "Input should be greater than 0",
                        value,
                    ));
                    None
                }
                Ok(parsed) => Some(parsed),
                Err(_) => {
                    errors.push(validation_error(
                        "int_parsing",
                        "sourcePluginId",
                        "Input should be a valid integer, unable to parse string as an integer",
                        value,
                    ));
                    None
                }
            },
            None => None,
        };
        let active_only = match &self.active_only {
            Some(value) => match value.to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => true,
                "false" | "0" | "no" | "off" => false,
                _ => {
                    errors.push(validation_error(
                        "bool_parsing",
                        "activeOnly",
                        "Input should be a valid boolean, unable to interpret input",
                        value,
                    ));
                    false
                }
            },
            None => false,
        };
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
            source_plugin_id,
            active_only,
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
