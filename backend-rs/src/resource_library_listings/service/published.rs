// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/resource-library/users/me/published` — the current user's
//! manageable publications.
//!
//! Source: `app.api.endpoints.resource_library.list_my_resource_library_publications`
//! and `app.services.resource_library_service.ResourceLibraryService.list_published`.
//! The endpoint authenticates the session (`security.get_current_user`),
//! counts and pages the caller's `marketplace_resources` rows, batches the
//! referenced active Kinds, and renders the parent module's shared
//! `to_listing` projection with each publication's `install_count`.

use std::collections::HashMap;

use brz_mysql::Mysql;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::teams::group_membership::ErpContext;

use super::super::handler::{ValidationEntry, parse_limit};
use super::super::models::{ListingList, PublishedParams, PublishedQuery, resource_type_entry};
use super::super::repository::{fetch_kinds_by_ids, fetch_published_count, fetch_published_page};
use super::{Source, internal_error, to_listing};

/// `page` default.
const PAGE_DEFAULT: i64 = 1;
/// `page` lower bound (`ge=1`).
const PAGE_MIN: i64 = 1;

/// GET /api/resource-library/users/me/published: the published free function,
/// injecting the process-lifetime application state.
///
/// The source declares `response_model=ResourceLibraryListingList`, so the
/// serializable body answers `application/json`.
#[brz_http_server::get("/api/resource-library/users/me/published")]
async fn list_my_resource_library_publications(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: brz_http_server::Query<PublishedQuery>,
) -> Result<ListingList, FastApiError> {
    let params = parse_params(&query)?;
    let erp = ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    list_published(&state.mysql, &erp, i64::from(user.id), &params).await
}

/// FastAPI query validation for `list_my_resource_library_publications`:
/// errors are collected in the parameter declaration order
/// (`resource_type`, `page`, `limit`).
fn parse_params(query: &PublishedQuery) -> Result<PublishedParams, FastApiError> {
    let mut errors: Vec<ValidationEntry<'_>> = Vec::new();
    let resource_type = match query.resource_type.as_deref() {
        None => None,
        Some(value) => match resource_type_entry(value) {
            Some((endpoint_value, _)) => Some(endpoint_value),
            None => {
                errors.push(ValidationEntry::pattern("resource_type", value));
                None
            }
        },
    };
    let page = parse_page(query.page.as_deref(), &mut errors);
    let limit = parse_limit(query.limit.as_deref(), &mut errors);
    if !errors.is_empty() {
        return Err(FastApiError::validation(errors));
    }
    Ok(PublishedParams {
        resource_type,
        page,
        limit,
    })
}

/// FastAPI integer decoding and bounds for `page`.
fn parse_page<'a>(value: Option<&'a str>, errors: &mut Vec<ValidationEntry<'a>>) -> i64 {
    let Some(value) = value else {
        return PAGE_DEFAULT;
    };
    let Ok(parsed) = value.trim().parse::<i64>() else {
        errors.push(ValidationEntry::int_parsing("page", value));
        return PAGE_DEFAULT;
    };
    if parsed < PAGE_MIN {
        errors.push(ValidationEntry::greater_than_equal("page", value, PAGE_MIN));
    }
    parsed
}

/// `list_published`.
pub async fn list_published<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    user_id: i64,
    params: &PublishedParams,
) -> Result<ListingList, FastApiError>
where
    M: Mysql,
{
    let total = fetch_published_count(mysql, user_id, params.resource_type)
        .await
        .map_err(internal_error)?;
    let offset = (params.page - 1) * params.limit;
    let publications =
        fetch_published_page(mysql, user_id, params.resource_type, offset, params.limit)
            .await
            .map_err(internal_error)?;
    let kind_ids: Vec<i64> = publications
        .iter()
        .map(|row| row.marketplace_resources_kind_id)
        .collect();
    let resources = fetch_kinds_by_ids(mysql, &kind_ids)
        .await
        .map_err(internal_error)?;
    // `resource_by_id = {resource.id: resource}`; the page order comes from the
    // publications, not from the batch lookup.
    let mut resource_by_id = HashMap::with_capacity(resources.len());
    for resource in &resources {
        resource_by_id.insert(resource.kinds_id, resource);
    }
    let mut items = Vec::with_capacity(publications.len());
    for publication in &publications {
        let Some(resource) = resource_by_id.get(&publication.marketplace_resources_kind_id) else {
            continue;
        };
        let source = Source::from(*resource);
        items.push(
            to_listing(
                mysql,
                erp,
                &source,
                user_id,
                publication.marketplace_resources_install_count,
            )
            .await
            .map_err(internal_error)?,
        );
    }
    Ok(ListingList {
        items,
        total,
        page: params.page,
        limit: params.limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The published listing is registered exactly once in the public route
    /// group; before this migration the path had no handler, so the gateway
    /// answered the recorded request with the 404 fallback.
    #[test]
    fn published_is_registered_in_the_public_group() {
        use brz_http_server::__private::inventory;

        // Bit 1 in the route method mask is GET (see the `METHODS` order in
        // `hybrid::routes`).
        const GET_BIT: u16 = 1 << 1;
        let routes: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)())
            .filter(|route| route.path == "/api/resource-library/users/me/published")
            .collect();
        assert_eq!(routes.len(), 1, "the published route is registered once");
        assert_eq!(routes[0].methods, GET_BIT, "the route is GET-only");
    }

    #[test]
    fn defaults_match_the_endpoint_declaration() {
        let params = parse_params(&PublishedQuery::default()).unwrap();
        assert!(params.resource_type.is_none());
        assert_eq!(params.page, 1);
        assert_eq!(params.limit, 20);
    }

    #[test]
    fn query_values_are_validated() {
        let params = parse_params(&PublishedQuery {
            resource_type: Some("agent".to_owned()),
            page: Some("3".to_owned()),
            limit: Some("100".to_owned()),
        })
        .unwrap();
        assert_eq!(params.resource_type, Some("agent"));
        assert_eq!(params.page, 3);
        assert_eq!(params.limit, 100);
    }

    #[test]
    fn invalid_resource_type_reports_a_pattern_error() {
        let error = parse_params(&PublishedQuery {
            resource_type: Some("bogus".to_owned()),
            ..PublishedQuery::default()
        })
        .unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        let detail = error.validation_detail();
        assert!(detail.contains("\"string_pattern_mismatch\""));
        assert!(detail.contains("[\"query\",\"resource_type\"]"));
        assert!(detail.contains("^(agent|skill|model|shell|retriever|template)$"));
    }

    #[test]
    fn page_and_limit_out_of_range_report_bound_errors() {
        let detail = parse_params(&PublishedQuery {
            page: Some("0".to_owned()),
            limit: Some("500".to_owned()),
            ..PublishedQuery::default()
        })
        .unwrap_err()
        .validation_detail();
        assert!(detail.contains("\"greater_than_equal\""));
        assert!(detail.contains("[\"query\",\"page\"]"));
        assert!(detail.contains("\"ge\":1"));
        assert!(detail.contains("\"less_than_equal\""));
        assert!(detail.contains("[\"query\",\"limit\"]"));
        assert!(detail.contains("\"le\":100"));
    }

    #[test]
    fn non_numeric_page_and_limit_report_parse_errors() {
        let detail = parse_params(&PublishedQuery {
            page: Some("many".to_owned()),
            limit: Some("lots".to_owned()),
            ..PublishedQuery::default()
        })
        .unwrap_err()
        .validation_detail();
        assert!(detail.contains("\"int_parsing\""));
        assert!(detail.contains("[\"query\",\"page\"]"));
        assert!(detail.contains("[\"query\",\"limit\"]"));
    }

    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    // A dedicated test group (separate from the crate's real `http_apis` group)
    // so the probe's route does not collide with the real handler registration.
    mod probe {
        brz_http_server::registry!(group = published_probe, dependencies());
    }

    /// Renders the published-list success value through the route macro over a
    /// real socket: the source declares
    /// `response_model=ResourceLibraryListingList`, so the response must answer
    /// `application/json`.
    #[brz_http_server::get(
        "/api/resource-library/users/me/published",
        group = probe::published_probe,
        access = public
    )]
    async fn published_probe() -> Result<ListingList, FastApiError> {
        Ok(ListingList {
            items: Vec::new(),
            total: 0,
            page: 1,
            limit: 100,
        })
    }

    async fn serve_published() -> String {
        let handler =
            brz_http_server::handlers!(; group = probe::published_probe).expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = TcpStream::connect(address).await.expect("connect");
        client
            .write_all(
                b"GET /api/resource-library/users/me/published?resource_type=agent&page=1&limit=100 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("send request");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read response");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    #[tokio::test]
    async fn published_answers_application_json() {
        let raw = serve_published().await;
        assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
        let content_type = raw
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("content-type:"))
            .expect("content-type header");
        assert_eq!(
            content_type["content-type:".len()..].trim(),
            "application/json",
            "{raw}"
        );
        let body = raw.split_once("\r\n\r\n").map_or("", |(_, body)| body);
        assert_eq!(
            body, "{\"items\":[],\"total\":0,\"page\":1,\"limit\":100}",
            "{raw}"
        );
    }
}
