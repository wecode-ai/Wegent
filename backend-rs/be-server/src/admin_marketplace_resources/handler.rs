// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/marketplace-resources` handler.
//!
//! Source: `app.api.endpoints.admin.marketplace.list_marketplace_resources`.
//! The endpoint requires `security.get_admin_user` (a valid session whose
//! `role` is `admin`) and validates the query parameters before the service
//! runs. Dependencies resolve before the endpoint's own parameters, so an
//! authentication or authorization failure precedes any 422.

use std::sync::Arc;

use serde::Serialize;

use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::models::{
    KIND_BY_RESOURCE_TYPE, ListingParams, MarketplaceResourcesQuery, parse_python_int,
};
use super::service::list;

/// `^(agent|skill)$`.
const RESOURCE_TYPE_PATTERN: &str = "^(agent|skill)$";
/// `page` / `limit` defaults and bounds.
const PAGE_DEFAULT: i64 = 1;
const LIMIT_DEFAULT: i64 = 50;
const PAGE_MIN: i64 = 1;
const LIMIT_MIN: i64 = 1;
const LIMIT_MAX: i64 = 200;

/// GET /api/admin/marketplace-resources: the free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/admin/marketplace-resources")]
async fn list_marketplace_resources(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] user: crate::auth::SessionUser,
    query: brz_http_server::Query<MarketplaceResourcesQuery>,
) -> Result<super::models::AdminMarketplaceResourceList, FastApiError> {
    // `get_admin_user` rejects a non-admin session after authentication.
    if user.role != "admin" {
        return Err(FastApiError::forbidden(
            "Permission denied. Admin access required.",
        ));
    }
    let params = parse_params(&query)?;
    list(&state.mysql, &params).await
}

/// FastAPI query validation for `list_marketplace_resources`.
fn parse_params(query: &MarketplaceResourcesQuery) -> Result<ListingParams, FastApiError> {
    let mut errors: Vec<ValidationEntry<'_>> = Vec::new();

    let resource_type = match query.resource_type.as_deref() {
        None => {
            errors.push(ValidationEntry::missing("resource_type"));
            None
        }
        Some(value) => match KIND_BY_RESOURCE_TYPE
            .iter()
            .find(|(candidate, _)| *candidate == value)
        {
            Some((resource_type, kind)) => Some((*resource_type, *kind)),
            None => {
                errors.push(ValidationEntry::pattern("resource_type", value));
                None
            }
        },
    };
    let page = parse_bounded(
        query.page.as_deref(),
        "page",
        PAGE_DEFAULT,
        PAGE_MIN,
        None,
        &mut errors,
    );
    let limit = parse_bounded(
        query.limit.as_deref(),
        "limit",
        LIMIT_DEFAULT,
        LIMIT_MIN,
        Some(LIMIT_MAX),
        &mut errors,
    );

    let Some((resource_type, kind)) = resource_type else {
        return Err(FastApiError::validation(errors));
    };
    if !errors.is_empty() {
        return Err(FastApiError::validation(errors));
    }
    Ok(ListingParams {
        resource_type,
        kind,
        page,
        limit,
    })
}

/// FastAPI integer decoding and bounds for an `int` query parameter.
fn parse_bounded<'a>(
    value: Option<&'a str>,
    field: &'static str,
    default: i64,
    minimum: i64,
    maximum: Option<i64>,
    errors: &mut Vec<ValidationEntry<'a>>,
) -> i64 {
    let Some(value) = value else {
        return default;
    };
    let Some(parsed) = parse_python_int(value) else {
        errors.push(ValidationEntry::int_parsing(field, value));
        return default;
    };
    if parsed < minimum {
        errors.push(ValidationEntry::greater_than_equal(field, value, minimum));
    } else if let Some(maximum) = maximum
        && parsed > maximum
    {
        errors.push(ValidationEntry::less_than_equal(field, value, maximum));
    }
    parsed
}

/// One FastAPI validation-error entry (`{type, loc, msg, input?, ctx?}`).
#[derive(Serialize)]
struct ValidationEntry<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    loc: [&'a str; 2],
    msg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<&'a str>,
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
    fn missing(field: &'a str) -> Self {
        Self {
            kind: "missing",
            loc: ["query", field],
            msg: "Field required".to_owned(),
            input: None,
            ctx: None,
        }
    }

    fn pattern(field: &'a str, value: &'a str) -> Self {
        Self {
            kind: "string_pattern_mismatch",
            loc: ["query", field],
            msg: format!("String should match pattern '{RESOURCE_TYPE_PATTERN}'"),
            input: Some(value),
            ctx: None,
        }
    }

    fn int_parsing(field: &'a str, value: &'a str) -> Self {
        Self {
            kind: "int_parsing",
            loc: ["query", field],
            msg: "Input should be a valid integer, unable to parse string as an integer".to_owned(),
            input: Some(value),
            ctx: None,
        }
    }

    fn greater_than_equal(field: &'a str, value: &'a str, ge: i64) -> Self {
        Self {
            kind: "greater_than_equal",
            loc: ["query", field],
            msg: format!("Input should be greater than or equal to {ge}"),
            input: Some(value),
            ctx: Some(ValidationContext::GreaterThanEqual { ge }),
        }
    }

    fn less_than_equal(field: &'a str, value: &'a str, le: i64) -> Self {
        Self {
            kind: "less_than_equal",
            loc: ["query", field],
            msg: format!("Input should be less than or equal to {le}"),
            input: Some(value),
            ctx: Some(ValidationContext::LessThanEqual { le }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;

    fn query(
        resource_type: Option<&str>,
        page: Option<&str>,
        limit: Option<&str>,
    ) -> MarketplaceResourcesQuery {
        MarketplaceResourcesQuery {
            resource_type: resource_type.map(ToOwned::to_owned),
            page: page.map(ToOwned::to_owned),
            limit: limit.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn agent_selects_team_with_defaults() {
        let params = parse_params(&query(Some("agent"), None, None)).unwrap();
        assert_eq!(params.resource_type, "agent");
        assert_eq!(params.kind, "Team");
        assert_eq!(params.page, 1);
        assert_eq!(params.limit, 50);
    }

    #[test]
    fn skill_selects_skill() {
        let params = parse_params(&query(Some("skill"), Some("2"), Some("10"))).unwrap();
        assert_eq!(params.resource_type, "skill");
        assert_eq!(params.kind, "Skill");
        assert_eq!(params.page, 2);
        assert_eq!(params.limit, 10);
    }

    #[test]
    fn missing_resource_type_is_a_required_error() {
        let error = parse_params(&query(None, None, None)).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let detail = error.validation_detail();
        assert!(detail.contains("\"missing\""));
        assert!(detail.contains("[\"query\",\"resource_type\"]"));
    }

    #[test]
    fn invalid_resource_type_reports_a_pattern_error() {
        let error = parse_params(&query(Some("bogus"), None, None)).unwrap_err();
        let detail = error.validation_detail();
        assert!(detail.contains("\"string_pattern_mismatch\""));
        assert!(detail.contains("^(agent|skill)$"));
    }

    #[test]
    fn out_of_range_limit_reports_bound_errors() {
        let detail = parse_params(&query(Some("agent"), None, Some("0")))
            .unwrap_err()
            .validation_detail();
        assert!(detail.contains("\"greater_than_equal\""));
        assert!(detail.contains("\"ge\":1"));

        let detail = parse_params(&query(Some("agent"), None, Some("500")))
            .unwrap_err()
            .validation_detail();
        assert!(detail.contains("\"less_than_equal\""));
        assert!(detail.contains("\"le\":200"));
    }

    #[test]
    fn non_numeric_page_reports_int_parsing() {
        let detail = parse_params(&query(Some("agent"), Some("many"), None))
            .unwrap_err()
            .validation_detail();
        assert!(detail.contains("\"int_parsing\""));
        assert!(detail.contains("[\"query\",\"page\"]"));
    }
}
