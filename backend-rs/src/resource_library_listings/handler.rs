// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/resource-library/listings` handler.
//!
//! Source: `app.api.endpoints.resource_library.list_resource_library`. The
//! endpoint requires `security.get_current_user`, validates the query
//! parameters before the service runs, and returns the
//! `ResourceLibraryDiscoveryList` body.

use brz_http_server::{Binary, HttpResponse};
use serde::Serialize;

use crate::auth::{AuthFailure, get_current_user};
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::teams::group_membership::ErpContext;

use super::models::{DiscoveryParams, DiscoveryQuery, parse_tags, resource_type_entry};
use super::service::{internal_error_body, list_public};

/// `^(agent|skill|model|shell|retriever)$`.
const RESOURCE_TYPE_PATTERN: &str = "^(agent|skill|model|shell|retriever)$";
/// `keyword` maximum length.
const KEYWORD_MAX_LENGTH: usize = 200;
/// `target_namespace` bounds.
const NAMESPACE_MIN_LENGTH: usize = 1;
const NAMESPACE_MAX_LENGTH: usize = 100;
/// `cursor` maximum length.
const CURSOR_MAX_LENGTH: usize = 512;
/// `limit` bounds.
const LIMIT_MIN: i64 = 1;
const LIMIT_MAX: i64 = 100;
/// `limit` default.
const LIMIT_DEFAULT: i64 = 20;

/// GET /api/resource-library/listings: the listings free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/resource-library/listings")]
async fn list_resource_library_listings(
    #[inject(state)] state: &AppState,
    #[header] authorization: Option<&str>,
    query: brz_http_server::Query<DiscoveryQuery>,
) -> Result<HttpResponse<Binary>, FastApiError> {
    let params = parse_params(&query)?;
    let mysql = &state.mysql;
    let erp = ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    let user = match get_current_user(&state.auth, mysql, authorization).await {
        Ok(user) => user,
        Err(AuthFailure::InvalidCredentials) => {
            return Err(FastApiError::unauthorized("Could not validate credentials"));
        }
        Err(AuthFailure::UserNotActivated) => {
            return Err(FastApiError::unauthorized("User not activated"));
        }
    };
    let body = list_public(mysql, &erp, i64::from(user.id), &params).await?;
    let bytes = match serde_json::to_vec(&body) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::error!(%error, "failed to serialize resource-library listings");
            return Err(internal_error_body());
        }
    };
    Ok(HttpResponse::new(Binary::new(bytes)))
}

/// FastAPI query validation for `list_resource_library`.
fn parse_params(query: &DiscoveryQuery) -> Result<DiscoveryParams, FastApiError> {
    let mut errors: Vec<ValidationEntry<'_>> = Vec::new();
    let (resource_type, resource_kind) = match query.resource_type.as_deref() {
        None => (None, None),
        // `RESOURCE_KIND_BY_TYPE[resource_type]`; the validated value itself is
        // kept for the published scan's `resource_type` filter.
        Some(value) => match resource_type_entry(value) {
            Some((endpoint_value, kind)) => (Some(endpoint_value), Some(kind)),
            None => {
                errors.push(ValidationEntry::pattern("resource_type", value));
                (None, None)
            }
        },
    };
    let system_only = parse_bool(
        query.system_only.as_deref(),
        "system_only",
        &mut errors,
        false,
    );
    let featured_only = parse_bool(
        query.featured_only.as_deref(),
        "featured_only",
        &mut errors,
        false,
    );
    let keyword = match query.keyword.as_deref() {
        Some(value) if value.chars().count() > KEYWORD_MAX_LENGTH => {
            errors.push(ValidationEntry::too_long(
                "keyword",
                value,
                KEYWORD_MAX_LENGTH,
            ));
            Some(value.to_owned())
        }
        other => other.map(ToOwned::to_owned),
    };
    let target_namespace = match query.target_namespace.as_deref() {
        None => "default".to_owned(),
        Some(value) => {
            let length = value.chars().count();
            if length < NAMESPACE_MIN_LENGTH {
                errors.push(ValidationEntry::too_short(
                    "target_namespace",
                    value,
                    NAMESPACE_MIN_LENGTH,
                ));
            } else if length > NAMESPACE_MAX_LENGTH {
                errors.push(ValidationEntry::too_long(
                    "target_namespace",
                    value,
                    NAMESPACE_MAX_LENGTH,
                ));
            }
            value.to_owned()
        }
    };
    let cursor = match query.cursor.as_deref() {
        Some(value) if value.chars().count() > CURSOR_MAX_LENGTH => {
            errors.push(ValidationEntry::too_long(
                "cursor",
                value,
                CURSOR_MAX_LENGTH,
            ));
            Some(value.to_owned())
        }
        other => other.map(ToOwned::to_owned),
    };
    let limit = parse_limit(query.limit.as_deref(), &mut errors);
    if !errors.is_empty() {
        return Err(FastApiError::validation(errors));
    }
    Ok(DiscoveryParams {
        resource_type,
        resource_kind,
        system_only,
        featured_only,
        keyword,
        tags: parse_tags(query.tags.as_deref()),
        target_namespace,
        cursor,
        limit,
    })
}

/// FastAPI boolean decoding (`true/false`, `1/0`, `on/off`, `yes/no`, ...).
fn parse_bool<'a>(
    value: Option<&'a str>,
    field: &'static str,
    errors: &mut Vec<ValidationEntry<'a>>,
    default: bool,
) -> bool {
    let Some(value) = value else {
        return default;
    };
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" | "y" | "t" => true,
        "false" | "0" | "off" | "no" | "n" | "f" => false,
        _ => {
            errors.push(ValidationEntry::bool_parsing(field, value));
            default
        }
    }
}

/// FastAPI integer decoding and bounds for `limit`.
fn parse_limit<'a>(value: Option<&'a str>, errors: &mut Vec<ValidationEntry<'a>>) -> i64 {
    let Some(value) = value else {
        return LIMIT_DEFAULT;
    };
    let Ok(parsed) = value.trim().parse::<i64>() else {
        errors.push(ValidationEntry::int_parsing("limit", value));
        return LIMIT_DEFAULT;
    };
    if parsed < LIMIT_MIN {
        errors.push(ValidationEntry::greater_than_equal(
            "limit", value, LIMIT_MIN,
        ));
    } else if parsed > LIMIT_MAX {
        errors.push(ValidationEntry::less_than_equal("limit", value, LIMIT_MAX));
    }
    parsed
}

/// One FastAPI validation-error entry (`{type, loc, msg, input, ctx?}`).
#[derive(Serialize)]
struct ValidationEntry<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    loc: [&'a str; 2],
    msg: String,
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
    fn pattern(field: &'a str, value: &'a str) -> Self {
        Self {
            kind: "string_pattern_mismatch",
            loc: ["query", field],
            msg: format!("String should match pattern '{RESOURCE_TYPE_PATTERN}'"),
            input: value,
            ctx: None,
        }
    }

    fn too_long(field: &'a str, value: &'a str, max: usize) -> Self {
        Self {
            kind: "string_too_long",
            loc: ["query", field],
            msg: format!("String should have at most {max} characters"),
            input: value,
            ctx: None,
        }
    }

    fn too_short(field: &'a str, value: &'a str, min: usize) -> Self {
        Self {
            kind: "string_too_short",
            loc: ["query", field],
            msg: format!("String should have at least {min} character"),
            input: value,
            ctx: None,
        }
    }

    fn int_parsing(field: &'a str, value: &'a str) -> Self {
        Self {
            kind: "int_parsing",
            loc: ["query", field],
            msg: "Input should be a valid integer, unable to parse string as an integer".to_owned(),
            input: value,
            ctx: None,
        }
    }

    fn bool_parsing(field: &'a str, value: &'a str) -> Self {
        Self {
            kind: "bool_parsing",
            loc: ["query", field],
            msg: "Input should be a valid boolean, unable to interpret input".to_owned(),
            input: value,
            ctx: None,
        }
    }

    fn greater_than_equal(field: &'a str, value: &'a str, ge: i64) -> Self {
        Self {
            kind: "greater_than_equal",
            loc: ["query", field],
            msg: format!("Input should be greater than or equal to {ge}"),
            input: value,
            ctx: Some(ValidationContext::GreaterThanEqual { ge }),
        }
    }

    fn less_than_equal(field: &'a str, value: &'a str, le: i64) -> Self {
        Self {
            kind: "less_than_equal",
            loc: ["query", field],
            msg: format!("Input should be less than or equal to {le}"),
            input: value,
            ctx: Some(ValidationContext::LessThanEqual { le }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query() -> DiscoveryQuery {
        DiscoveryQuery::default()
    }

    #[test]
    fn defaults_match_the_endpoint_declaration() {
        let params = parse_params(&query()).unwrap();
        assert_eq!(params.limit, 20);
        assert_eq!(params.target_namespace, "default");
        assert!(params.resource_type.is_none());
        assert!(!params.system_only);
        assert!(!params.featured_only);
        assert!(params.tags.is_empty());
    }

    #[test]
    fn query_values_are_decoded() {
        let mut raw = query();
        raw.resource_type = Some("skill".to_owned());
        raw.featured_only = Some("true".to_owned());
        raw.system_only = Some("0".to_owned());
        raw.tags = Some(" daily_work ,,finance ".to_owned());
        raw.keyword = Some("  Mail ".to_owned());
        raw.limit = Some("5".to_owned());
        let params = parse_params(&raw).unwrap();
        assert_eq!(params.resource_type, Some("skill"));
        assert_eq!(params.resource_kind, Some("Skill"));
        assert!(params.featured_only);
        assert!(!params.system_only);
        assert_eq!(params.tags, vec!["daily_work", "finance"]);
        assert_eq!(params.keyword.as_deref(), Some("  Mail "));
        assert_eq!(params.limit, 5);
    }

    #[test]
    fn resource_type_keeps_the_endpoint_value_and_its_kind() {
        let mut raw = query();
        raw.resource_type = Some("agent".to_owned());
        let params = parse_params(&raw).unwrap();
        assert_eq!(params.resource_type, Some("agent"));
        assert_eq!(params.resource_kind, Some("Team"));
    }

    #[test]
    fn invalid_resource_type_reports_a_pattern_error() {
        let mut raw = query();
        raw.resource_type = Some("bogus".to_owned());
        let error = parse_params(&raw).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        let detail = error.validation_detail();
        assert!(detail.contains("\"string_pattern_mismatch\""));
        assert!(detail.contains("[\"query\",\"resource_type\"]"));
        assert!(detail.contains("^(agent|skill|model|shell|retriever)$"));
    }

    #[test]
    fn limit_out_of_range_reports_bound_errors() {
        let mut raw = query();
        raw.limit = Some("0".to_owned());
        let detail = parse_params(&raw).unwrap_err().validation_detail();
        assert!(detail.contains("\"greater_than_equal\""));
        assert!(detail.contains("\"ge\":1"));

        raw.limit = Some("500".to_owned());
        let detail = parse_params(&raw).unwrap_err().validation_detail();
        assert!(detail.contains("\"less_than_equal\""));
        assert!(detail.contains("\"le\":100"));
    }

    #[test]
    fn non_numeric_limit_and_boolean_report_parse_errors() {
        let mut raw = query();
        raw.limit = Some("many".to_owned());
        raw.system_only = Some("maybe".to_owned());
        let detail = parse_params(&raw).unwrap_err().validation_detail();
        assert!(detail.contains("\"int_parsing\""));
        assert!(detail.contains("\"bool_parsing\""));
    }
}
