// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Query contract for `GET /api/v1/kinds/skills/unified`.
//!
//! Mirrors the source `list_unified_skills` parameters: `skip`/`limit` keep
//! their raw text so the FastAPI `Query(..., ge, le)` bounds can reject invalid
//! values with the source's `422` validation body instead of a plain
//! deserialization failure.
use serde::Deserialize;

use crate::http_compat::FastApiError;

/// Query parameters.
#[derive(Debug, Deserialize)]
pub struct UnifiedParams {
    #[serde(default)]
    pub(super) skip: Option<String>,
    #[serde(default)]
    pub(super) limit: Option<String>,
    #[serde(default)]
    pub(super) scope: Option<String>,
    #[serde(default)]
    pub(super) group_name: Option<String>,
}

impl UnifiedParams {
    /// Validate `skip` (`ge=0`, default 0) and `limit` (`ge=1`, `le=100`,
    /// default 100) and return the pagination window.
    pub(super) fn validated(&self) -> Result<(usize, usize), FastApiError> {
        let skip = bounded_integer(self.skip.as_deref(), "skip", 0, 0, None)?;
        let limit = bounded_integer(self.limit.as_deref(), "limit", 100, 1, Some(100))?;
        Ok((skip as usize, limit as usize))
    }
}

/// One FastAPI 422 validation entry (`{type, loc, msg, input}`).
#[derive(Debug, serde::Serialize)]
struct QueryValidationError<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: String,
    input: &'a str,
}

/// FastAPI-style 422 validation body for one query parameter.
fn validation_error(field: &str, kind: &str, message: String, input: &str) -> FastApiError {
    FastApiError::validation([QueryValidationError {
        kind,
        loc: ["query", field],
        msg: message,
        input,
    }])
}

/// Parse one integer query parameter with its source bounds.
fn bounded_integer(
    raw: Option<&str>,
    field: &str,
    default: i64,
    minimum: i64,
    maximum: Option<i64>,
) -> Result<i64, FastApiError> {
    let Some(raw) = raw else {
        return Ok(default);
    };
    let value: i64 = raw.trim().parse().map_err(|_| {
        validation_error(
            field,
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer".to_string(),
            raw,
        )
    })?;
    if value < minimum {
        return Err(validation_error(
            field,
            "greater_than_equal",
            format!("Input should be greater than or equal to {minimum}"),
            raw,
        ));
    }
    if let Some(maximum) = maximum
        && value > maximum
    {
        return Err(validation_error(
            field,
            "less_than_equal",
            format!("Input should be less than or equal to {maximum}"),
            raw,
        ));
    }
    Ok(value)
}
