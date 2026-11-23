// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/resources` — the user's owned agents and execution environments
//! (`app.api.endpoints.workspaces.list_personal_resources`).
use crate::ResourceReadinessState;
use crate::auth::SessionUser;
use crate::http_compat::FastApiError;

use super::response::PersonalResourcesResponse;
use super::service;

/// Query parameters for `GET /api/v1/resources`. `include_readiness` is parsed
/// from its raw string so a FastAPI-invalid literal renders the pydantic 422
/// body instead of a framework deserialization error.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct ResourcesQuery {
    pub include_readiness: Option<String>,
}

/// `Query(True)` boolean parsing (pydantic v2 accepted literals), returning
/// the 422 `bool_parsing` body for any other value.
fn parse_include_readiness(raw: Option<&str>) -> Result<bool, FastApiError> {
    let Some(value) = raw else {
        return Ok(true);
    };
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" | "y" | "t" => Ok(true),
        "false" | "0" | "no" | "off" | "n" | "f" => Ok(false),
        _ => Err(FastApiError::validation([serde_json::json!({
            "type": "bool_parsing",
            "loc": ["query", "include_readiness"],
            "msg": "Input should be a valid boolean, unable to interpret input",
            "input": value,
        })])),
    }
}

/// GET /api/v1/resources: list the current user's owned agents and execution
/// environments.
///
/// The source endpoint is async (`list_personal_resources`) and uses the
/// `get_current_user_jwt_apikey_tasktoken` dependency; the framework
/// `AppAuthenticator::SessionUser` performs the equivalent bearer JWT + user
/// lookup (the recorded request authenticates a bearer token resolving to the
/// `sifang` user). FastAPI serializes the returned `PersonalResourcesResponse`
/// via `model_validate` + `model_dump_json`; the response body is the UTF-8
/// JSON document, and the `content-type` is `application/json`.
///
/// A 404 `User not found` is unreachable here because authentication already
/// loads the user (the inner `db.get(User, user_id)` is satisfied by the
/// identity-mapped session user and issues no query).
#[brz_http_server::get("/api/v1/resources")]
async fn list_personal_resources(
    #[inject(state)] state: &ResourceReadinessState,
    #[auth] current_user: SessionUser,
    query: brz_http_server::Query<ResourcesQuery>,
) -> Result<PersonalResourcesResponse, FastApiError> {
    let include_readiness = parse_include_readiness(query.include_readiness.as_deref())?;
    service::list_personal_resources(state, &current_user.0, include_readiness).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The defaulted flag keeps the full readiness projection.
    #[test]
    fn include_readiness_defaults_to_true() {
        assert!(parse_include_readiness(None).unwrap());
        assert!(!parse_include_readiness(Some("false")).unwrap());
        assert!(parse_include_readiness(Some("1")).unwrap());
    }

    /// An unparsable literal renders the pydantic 422 body.
    #[test]
    fn include_readiness_rejects_unknown_literals() {
        let error = parse_include_readiness(Some("maybe")).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        assert!(error.validation_detail().contains("bool_parsing"));
    }
}
