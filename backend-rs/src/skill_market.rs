// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/skill-market/search` — search the configured skill market.
//!
//! Mirrors `app.api.endpoints.skill_market.search_skills` together with
//! `app.services.skill_market.provider` (`SearchParams`, `MarketSkill`,
//! `SearchResult`, `ISkillMarketProvider`, `SkillMarketProviderRegistry`). The
//! endpoint and the registry are public; a deployment registers its concrete
//! market provider before route construction. With no provider registered the
//! endpoint renders the source's
//! `503` "Skill market not available"; an unknown `provider` renders the `404`
//! "Skill market provider not found".
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use brz_http_server::{Query, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `SearchParams`: the arguments the endpoint hands to a provider.
#[derive(Debug, Clone, Default)]
pub struct SearchParams {
    /// Keyword search (`app.services.skill_market.provider.SearchParams.keyword`).
    pub keyword: Option<String>,
    /// Tag filter.
    pub tags: Option<String>,
    /// Page number (1-based).
    pub page: i64,
    /// Page size.
    pub page_size: i64,
    /// Authenticated user name used by the provider's permission lookup.
    pub user: Option<String>,
}

/// `MarketSkill`: one skill entry, serialized with the API field names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSkill {
    pub skill_key: String,
    pub original_skill_key: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub visibility: String,
    pub tags: Vec<String>,
    pub version: String,
    pub download_count: i64,
    pub created_at: String,
    pub has_download_permission: bool,
    pub permission_url: String,
}

/// `SearchResult` / `SearchResultResponse`: the search page.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub skills: Vec<MarketSkill>,
}

/// `ISkillMarketProvider`: a skill market backend.
///
/// `search` returns the provider's error text on failure; the endpoint renders
/// it as the source's `500 {"detail": {"error": <message>}}`.
#[async_trait]
pub trait SkillMarketProvider: Send + Sync {
    /// Stable provider identifier used by API clients.
    fn key(&self) -> &str;
    /// Provider name for display.
    fn name(&self) -> &str;
    /// Market URL for navigation.
    fn market_url(&self) -> &str;
    /// Search the market (`ISkillMarketProvider.search`).
    async fn search(&self, params: &SearchParams) -> Result<SearchResult, String>;
}

/// `SkillMarketProviderRegistry`: providers keyed by their stable key.
///
/// `register` replaces a provider with the same key in place, matching the
/// source dict's insertion-order semantics.
#[derive(Default)]
pub struct SkillMarketRegistry {
    providers: RwLock<Vec<Arc<dyn SkillMarketProvider>>>,
}

impl SkillMarketRegistry {
    /// Register a provider, replacing an existing entry with the same key.
    pub fn register(&self, provider: Arc<dyn SkillMarketProvider>) {
        let mut providers = self
            .providers
            .write()
            .expect("skill market registry lock poisoned");
        if let Some(existing) = providers
            .iter_mut()
            .find(|candidate| candidate.key() == provider.key())
        {
            *existing = provider;
        } else {
            providers.push(provider);
        }
    }

    /// `get_provider`: the provider registered under `key`.
    fn get_provider(&self, key: &str) -> Option<Arc<dyn SkillMarketProvider>> {
        self.providers
            .read()
            .expect("skill market registry lock poisoned")
            .iter()
            .find(|provider| provider.key() == key)
            .cloned()
    }

    /// `get_single_provider`: the only registered provider, if exactly one.
    fn get_single_provider(&self) -> Option<Arc<dyn SkillMarketProvider>> {
        let providers = self
            .providers
            .read()
            .expect("skill market registry lock poisoned");
        if providers.len() == 1 {
            providers.first().cloned()
        } else {
            None
        }
    }

    /// `count`: the number of registered providers.
    fn count(&self) -> usize {
        self.providers
            .read()
            .expect("skill market registry lock poisoned")
            .len()
    }

    /// Registered provider keys in registration order (tests only).
    #[cfg(test)]
    fn keys(&self) -> Vec<String> {
        self.providers
            .read()
            .expect("skill market registry lock poisoned")
            .iter()
            .map(|provider| provider.key().to_string())
            .collect()
    }
}

/// `_resolve_provider`: select the provider for the request.
fn resolve_provider(
    registry: &SkillMarketRegistry,
    provider_key: Option<&str>,
) -> Result<Arc<dyn SkillMarketProvider>, FastApiError> {
    if let Some(key) = provider_key {
        if let Some(provider) = registry.get_provider(key) {
            return Ok(provider);
        }
        return Err(provider_not_found(key));
    }
    if let Some(provider) = registry.get_single_provider() {
        return Ok(provider);
    }
    if registry.count() > 1 {
        return Err(provider_required());
    }
    Err(market_not_available())
}

/// `404` "Skill market provider not found".
fn provider_not_found(key: &str) -> FastApiError {
    FastApiError::json_body(
        StatusCode::NOT_FOUND,
        json!({
            "detail": {
                "error": "Skill market provider not found",
                "details": { "provider": key },
            }
        }),
    )
}

/// `400` "Skill market provider is required".
fn provider_required() -> FastApiError {
    FastApiError::json_body(
        StatusCode::BAD_REQUEST,
        json!({
            "detail": {
                "error": "Skill market provider is required",
                "message": "Specify the provider query parameter.",
            }
        }),
    )
}

/// `503` "Skill market not available".
fn market_not_available() -> FastApiError {
    FastApiError::json_body(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({
            "detail": {
                "error": "Skill market not available",
                "message": "No skill market provider is configured.",
            }
        }),
    )
}

/// `500 {"detail": {"error": <message>}}` for a provider failure.
fn search_failed(message: impl Into<String>) -> FastApiError {
    FastApiError::json_body(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "detail": { "error": message.into() } }),
    )
}

/// The endpoint's query parameters, captured as raw strings so binding never
/// fails; the FastAPI-compatible contract is validated in the handler.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    provider: Option<String>,
    keyword: Option<String>,
    tags: Option<String>,
    page: Option<String>,
    page_size: Option<String>,
}

/// The validated query contract.
#[derive(Debug, PartialEq, Eq)]
struct SearchQueryParams {
    provider: Option<String>,
    keyword: Option<String>,
    tags: Option<String>,
    page: i64,
    page_size: i64,
}

/// One FastAPI query-validation entry.
#[derive(Debug, Serialize)]
struct QueryValidationError<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    loc: [&'static str; 2],
    msg: String,
    input: &'a str,
}

impl SearchQuery {
    /// Validate the FastAPI query contract: `page >= 1` (default 1) and
    /// `1 <= pageSize <= 100` (default 20). `provider`, `keyword` and `tags`
    /// are optional strings; an empty value behaves like the source's
    /// truthiness checks.
    fn validated(&self) -> Result<SearchQueryParams, FastApiError> {
        let mut errors: Vec<QueryValidationError<'_>> = Vec::new();
        let page = parse_int(&self.page, "page", 1, 1, i64::MAX, &mut errors);
        let page_size = parse_int(&self.page_size, "pageSize", 20, 1, 100, &mut errors);
        if !errors.is_empty() {
            return Err(FastApiError::validation(errors));
        }
        Ok(SearchQueryParams {
            provider: self.provider.clone().filter(|value| !value.is_empty()),
            keyword: self.keyword.clone().filter(|value| !value.is_empty()),
            tags: self.tags.clone().filter(|value| !value.is_empty()),
            page,
            page_size,
        })
    }
}

/// Parse an optional integer query parameter, recording one FastAPI-style
/// validation error and returning the default on failure.
fn parse_int<'a>(
    raw: &'a Option<String>,
    field: &'static str,
    default: i64,
    min: i64,
    max: i64,
    errors: &mut Vec<QueryValidationError<'a>>,
) -> i64 {
    let Some(value) = raw else {
        return default;
    };
    match value.parse::<i64>() {
        Ok(parsed) if parsed < min => {
            errors.push(QueryValidationError {
                kind: "greater_than_equal",
                loc: ["query", field],
                msg: format!("Input should be greater than or equal to {min}"),
                input: value,
            });
            default
        }
        Ok(parsed) if parsed > max => {
            errors.push(QueryValidationError {
                kind: "less_than_equal",
                loc: ["query", field],
                msg: format!("Input should be less than or equal to {max}"),
                input: value,
            });
            default
        }
        Ok(parsed) => parsed,
        Err(_) => {
            errors.push(QueryValidationError {
                kind: "int_parsing",
                loc: ["query", field],
                msg: "Input should be a valid integer, unable to parse string as an integer"
                    .to_string(),
                input: value,
            });
            default
        }
    }
}

/// GET /api/skill-market/search: the endpoint free function, injecting the
/// shared application state and the standard session principal.
#[brz_http_server::get("/api/skill-market/search")]
async fn search_skills(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: Query<SearchQuery>,
) -> Result<SearchResult, FastApiError> {
    let params = query.validated()?;
    let provider = resolve_provider(&state.skill_market, params.provider.as_deref())?;
    let search = SearchParams {
        keyword: params.keyword,
        tags: params.tags,
        page: params.page,
        page_size: params.page_size,
        user: Some(user.user_name.clone()),
    };
    provider.search(&search).await.map_err(search_failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StubProvider {
        key: &'static str,
        result: Result<SearchResult, String>,
    }

    #[async_trait]
    impl SkillMarketProvider for StubProvider {
        fn key(&self) -> &str {
            self.key
        }
        fn name(&self) -> &str {
            "Stub"
        }
        fn market_url(&self) -> &str {
            "https://market.invalid"
        }
        async fn search(&self, _params: &SearchParams) -> Result<SearchResult, String> {
            self.result.clone()
        }
    }

    fn stub(key: &'static str) -> Arc<StubProvider> {
        Arc::new(StubProvider {
            key,
            result: Ok(SearchResult {
                total: 2542,
                page: 1,
                page_size: 20,
                skills: vec![],
            }),
        })
    }

    fn detail(error: &FastApiError) -> serde_json::Value {
        serde_json::from_str(&error.validation_detail()).expect("detail is JSON")
    }

    #[test]
    fn an_empty_registry_is_not_available() {
        let registry = SkillMarketRegistry::default();
        let error = resolve_provider(&registry, None).map(|_| ()).unwrap_err();
        assert_eq!(error.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            detail(&error),
            json!({
                "error": "Skill market not available",
                "message": "No skill market provider is configured.",
            })
        );
    }

    #[test]
    fn an_unknown_provider_is_not_found() {
        let registry = SkillMarketRegistry::default();
        registry.register(stub("primary"));
        let error = resolve_provider(&registry, Some("github"))
            .map(|_| ())
            .unwrap_err();
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            detail(&error),
            json!({
                "error": "Skill market provider not found",
                "details": { "provider": "github" },
            })
        );
    }

    #[test]
    fn a_single_provider_resolves_without_a_key() {
        let registry = SkillMarketRegistry::default();
        registry.register(stub("primary"));
        assert!(resolve_provider(&registry, None).is_ok());
    }

    #[test]
    fn multiple_providers_require_a_key() {
        let registry = SkillMarketRegistry::default();
        registry.register(stub("primary"));
        registry.register(stub("github"));
        let error = resolve_provider(&registry, None).map(|_| ()).unwrap_err();
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            detail(&error),
            json!({
                "error": "Skill market provider is required",
                "message": "Specify the provider query parameter.",
            })
        );
    }

    #[test]
    fn a_provider_failure_is_a_500_with_the_error_text() {
        let error = search_failed("HTTP 500: boom");
        assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(detail(&error), json!({ "error": "HTTP 500: boom" }));
    }

    #[test]
    fn registering_the_same_key_replaces_in_place() {
        let registry = SkillMarketRegistry::default();
        registry.register(stub("primary"));
        registry.register(stub("github"));
        registry.register(stub("primary"));
        assert_eq!(registry.count(), 2);
        // The replacement keeps the original insertion position.
        assert_eq!(registry.keys(), ["primary", "github"]);
    }

    #[test]
    fn page_size_defaults_and_bounds_are_enforced() {
        let ok = SearchQuery {
            page: None,
            page_size: Some("20".to_string()),
            ..Default::default()
        }
        .validated()
        .unwrap();
        assert_eq!((ok.page, ok.page_size), (1, 20));

        for invalid in ["0", "101"] {
            let error = SearchQuery {
                page_size: Some(invalid.to_string()),
                ..Default::default()
            }
            .validated()
            .unwrap_err();
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
    }

    #[test]
    fn a_non_integer_page_is_rejected() {
        let error = SearchQuery {
            page: Some("abc".to_string()),
            ..Default::default()
        }
        .validated()
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn empty_optional_values_behave_like_absent_ones() {
        let params = SearchQuery {
            provider: Some(String::new()),
            keyword: Some(String::new()),
            tags: Some(String::new()),
            ..Default::default()
        }
        .validated()
        .unwrap();
        assert_eq!(params.provider, None);
        assert_eq!(params.keyword, None);
        assert_eq!(params.tags, None);
    }

    #[test]
    fn the_response_uses_the_api_field_names() {
        let result = SearchResult {
            total: 1,
            page: 1,
            page_size: 20,
            skills: vec![MarketSkill {
                skill_key: "a_b".to_string(),
                original_skill_key: "b".to_string(),
                name: "n".to_string(),
                description: "d".to_string(),
                author: "u".to_string(),
                visibility: "public".to_string(),
                tags: vec!["t".to_string()],
                version: "v".to_string(),
                download_count: 3,
                created_at: "1".to_string(),
                has_download_permission: true,
                permission_url: "https://m/pages/skills/a_b".to_string(),
            }],
        };
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            "{\"total\":1,\"page\":1,\"pageSize\":20,\"skills\":[{\"skillKey\":\"a_b\",\
             \"originalSkillKey\":\"b\",\"name\":\"n\",\"description\":\"d\",\"author\":\"u\",\
             \"visibility\":\"public\",\"tags\":[\"t\"],\"version\":\"v\",\"downloadCount\":3,\
             \"createdAt\":\"1\",\"hasDownloadPermission\":true,\
             \"permissionUrl\":\"https://m/pages/skills/a_b\"}]}"
        );
    }
}
