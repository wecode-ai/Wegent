// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/resource-library/listings/{listing_id}/publication` — the
//! editable publication settings for an owned capability.
//!
//! Source: `app.api.endpoints.resource_library.get_resource_library_publication`
//! and
//! `app.services.resource_library_service.ResourceLibraryService.get_manageable_publication`.
//! The endpoint authenticates the session (`security.get_current_user`),
//! loads the capability Kind by id through `_get_source` (answering `404
//! "Capability resource not found"` otherwise), gates on
//! `_require_publish_permission` (`403 "Publish permission denied"`), and
//! renders the same `ResourceLibraryListing` body as the detail endpoint
//! through the shared `to_listing` projection with the publication's
//! `install_count`.
//!
//! `_can_publish` requires `GroupRole.Developer` for a Team Kind and
//! `GroupRole.Maintainer` for every other capability Kind, so this module
//! keeps its own kind-aware gate instead of reusing the Team-only bindings
//! gate; the role resolution itself is the shared
//! `get_effective_role_in_group` port.

use brz_http_server::StatusCode;
use brz_mysql::Mysql;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::skills::skills_unified::effective_role_in_group;
use crate::state::AppState;
use crate::teams::group_membership::{ErpContext, has_permission};

use super::super::models::Listing;
use super::super::repository::KindRow;
use super::detail::{fetch_install_count, fetch_source, validation_error};
use super::{Source, internal_error, to_listing};

/// `_can_publish`'s required group role: `GroupRole.Developer` for a Team
/// Kind, `GroupRole.Maintainer` for every other capability Kind.
fn required_role(kind: &str) -> &'static str {
    if kind == "Team" {
        "Developer"
    } else {
        "Maintainer"
    }
}

/// `_require_publish_permission` / `_can_publish` for the five capability
/// kinds: the admin bypass, the `default`-namespace owner, then the group
/// role check against the kind-specific required role.
async fn require_publish_permission<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    source: &KindRow,
    user_id: i64,
    user_role: &str,
) -> Result<(), FastApiError>
where
    M: Mysql,
{
    if user_role == "admin"
        || (source.kinds_user_id == user_id && source.kinds_namespace == "default")
    {
        return Ok(());
    }
    if source.kinds_namespace != "default" {
        let role = effective_role_in_group(
            mysql,
            erp,
            i32::try_from(user_id).unwrap_or(i32::MAX),
            &source.kinds_namespace,
        )
        .await
        .map_err(internal_error)?;
        if role
            .as_deref()
            .is_some_and(|role| has_permission(role, required_role(source.kinds_kind.as_str())))
        {
            return Ok(());
        }
    }
    Err(FastApiError::detail(
        StatusCode::FORBIDDEN,
        "Publish permission denied",
    ))
}

/// `get_manageable_publication`.
async fn get_manageable_publication<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    listing_id: i64,
    user_id: i64,
    user_role: &str,
) -> Result<Listing, FastApiError>
where
    M: Mysql,
{
    let row = fetch_source(mysql, listing_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            FastApiError::detail(StatusCode::NOT_FOUND, "Capability resource not found")
        })?;
    require_publish_permission(mysql, erp, &row, user_id, user_role).await?;
    let install_count = fetch_install_count(mysql, row.kinds_id)
        .await
        .map_err(internal_error)?;
    to_listing(mysql, erp, &Source::from(&row), user_id, install_count)
        .await
        .map_err(internal_error)
}

/// GET /api/resource-library/listings/{listing_id}/publication: the
/// publication free function, injecting the process-lifetime state.
#[brz_http_server::get("/api/resource-library/listings/:listing_id/publication")]
async fn get_resource_library_publication(
    #[inject(state)] state: &AppState,
    listing_id: &str,
    #[auth] user: SessionUser,
) -> Result<Listing, FastApiError> {
    let listing_id = listing_id
        .parse::<i64>()
        .map_err(|_| validation_error(listing_id))?;
    let erp = ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    get_manageable_publication(
        &state.mysql,
        &erp,
        listing_id,
        i64::from(user.id),
        &user.role,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Before this migration the route was selected for Rust without a
    /// registered handler, so the gateway answered the recorded request with
    /// the 404 fallback; the route is registered exactly once now.
    #[test]
    fn publication_is_registered_in_the_public_group() {
        use brz_http_server::__private::inventory;

        // Bit 1 in the route method mask is GET (see the `METHODS` order in
        // `hybrid::routes`).
        const GET_BIT: u16 = 1 << 1;
        let routes: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)())
            .filter(|route| route.path == "/api/resource-library/listings/:listing_id/publication")
            .collect();
        assert_eq!(routes.len(), 1, "the publication route is registered once");
        assert_eq!(routes[0].methods, GET_BIT, "the route is GET-only");
    }

    #[test]
    fn required_role_follows_the_source_kind() {
        assert_eq!(required_role("Team"), "Developer");
        for kind in ["Skill", "Model", "Shell", "Retriever"] {
            assert_eq!(required_role(kind), "Maintainer");
        }
    }

    #[test]
    fn invalid_path_parameter_reports_fastapi_int_parsing() {
        let error = validation_error("abc");
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let detail = error.validation_detail();
        assert!(detail.contains("\"type\":\"int_parsing\""), "{detail}");
        assert!(detail.contains("[\"path\",\"listing_id\"]"), "{detail}");
        assert!(detail.contains("\"input\":\"abc\""), "{detail}");
    }

    /// The publication body is the same `ResourceLibraryListing` projection
    /// as the detail endpoint; keep the recorded field order.
    #[test]
    fn listing_serializes_with_the_pydantic_field_order() {
        use crate::resource_library_listings::models::Version;

        let listing = Listing {
            id: 262_629,
            resource_type: "agent".to_owned(),
            name: "示例 Example".to_owned(),
            display_name: "示例 Example".to_owned(),
            description: None,
            icon: None,
            tags: Vec::new(),
            feature_tags: Vec::new(),
            publisher_user_id: 3101,
            publisher_user_name: Some("example-publisher".to_owned()),
            publisher_namespace: "AI_agent-pro".to_owned(),
            status: "archived".to_owned(),
            current_version_id: 262_629,
            current_version: Version {
                id: 262_629,
                listing_id: 262_629,
                version: "1.0.0".to_owned(),
                changelog: None,
                package_url: None,
                created_at: "2026-07-15T06:44:46".to_owned(),
                updated_at: "2026-08-10T12:05:54".to_owned(),
            },
            install_count: 0,
            is_installed: false,
            example_conversations: Vec::new(),
            bind_modes: vec!["chat".to_owned()],
            allow_personal_install: true,
            allow_group_install: true,
            target_groups: vec!["AI_agent-pro".to_owned()],
            created_at: "2026-07-15T06:44:46".to_owned(),
            updated_at: "2026-08-10T12:05:54".to_owned(),
        };
        let body = serde_json::to_string(&listing).unwrap();
        assert!(body.starts_with(
            "{\"id\":262629,\"resource_type\":\"agent\",\"name\":\"示例 Example\",\
             \"display_name\":\"示例 Example\",\"description\":null,\"icon\":null,\"tags\":[],\
             \"feature_tags\":[],\"publisher_user_id\":3101,\
             \"publisher_user_name\":\"example-publisher\",\
             \"publisher_namespace\":\"AI_agent-pro\",\"status\":\"archived\","
        ));
        assert!(body.ends_with(
            "\"bind_modes\":[\"chat\"],\"allow_personal_install\":true,\
             \"allow_group_install\":true,\"target_groups\":[\"AI_agent-pro\"],\
             \"created_at\":\"2026-07-15T06:44:46\",\"updated_at\":\"2026-08-10T12:05:54\"}"
        ));
    }
}
