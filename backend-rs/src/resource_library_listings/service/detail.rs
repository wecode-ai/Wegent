// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/resource-library/listings/{listing_id}` — one public capability.
//!
//! Source: `app.api.endpoints.resource_library.get_resource_library_listing`
//! and `app.services.resource_library_service.ResourceLibraryService.get_public_listing`.
//! The endpoint authenticates the session (`security.get_current_user`), loads
//! the capability Kind by id, rejects a Kind that is not publicly published
//! with `404 "Capability not found"`, and renders the single-listing
//! `ResourceLibraryListing` body.
//!
//! The body is the same `to_listing` projection the discovery listing renders,
//! so this item endpoint reuses that parent module instead of duplicating it.
//! The only endpoint-specific reads are the `_get_source` Kind lookup and
//! `_listing_install_count`'s `marketplace_resources` row.

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use serde::Serialize;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::teams::group_membership::ErpContext;

use super::super::models::{JsonScalar, Listing};
use super::super::repository::{KIND_COLUMNS, KindRow};
use super::{Source, internal_error, to_listing};

/// `RESOURCE_TYPE_BY_KIND`: `_get_source` restricts the lookup to the five
/// capability CRD Kinds.
const SOURCE_KINDS: &str = "'Team', 'Skill', 'Model', 'Shell', 'Retriever'";

/// `_get_source`: `db.query(Kind).filter(Kind.id == id, Kind.is_active == True,
/// Kind.kind.in_(RESOURCE_TYPE_BY_KIND)).first()`.
#[must_use]
fn source_statement(listing_id: i64) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = {listing_id} AND \
         kinds.is_active = true AND kinds.kind IN ({SOURCE_KINDS}) \n LIMIT 1"
    )
}

/// `_listing_install_count`: `db.get(MarketplaceResource, source.id)`. The
/// primary key is `kind_id`; the full mapped column list keeps the statement
/// identical to the recorded exchange.
#[must_use]
fn install_count_statement(listing_id: i64) -> String {
    format!(
        "SELECT marketplace_resources.kind_id AS marketplace_resources_kind_id, \
         marketplace_resources.owner_user_id AS marketplace_resources_owner_user_id, \
         marketplace_resources.resource_type AS marketplace_resources_resource_type, \
         marketplace_resources.recommendation_score AS \
         marketplace_resources_recommendation_score, marketplace_resources.install_count AS \
         marketplace_resources_install_count, marketplace_resources.published_at AS \
         marketplace_resources_published_at, marketplace_resources.updated_at AS \
         marketplace_resources_updated_at \nFROM marketplace_resources \nWHERE \
         marketplace_resources.kind_id = {listing_id}"
    )
}

/// One `marketplace_resources` row; only `install_count` is projected.
#[derive(Debug, FromMysqlRow)]
struct InstallCountRow {
    #[mysql(rename = "marketplace_resources_install_count")]
    install_count: i64,
}

/// The capability Kind behind one listing id, or `None` when no active
/// capability carries that id.
async fn fetch_source<M>(mysql: &M, listing_id: i64) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    mysql.fetch_optional(source_statement(listing_id), ()).await
}

/// `_listing_install_count`; a missing publication row means zero installs.
async fn fetch_install_count<M>(mysql: &M, listing_id: i64) -> MysqlResult<i64>
where
    M: Mysql,
{
    let row: Option<InstallCountRow> = mysql
        .fetch_optional(install_count_statement(listing_id), ())
        .await?;
    Ok(row.map_or(0, |row| row.install_count))
}

/// `_is_public`. A system Kind (`user_id == 0`) defaults to the public and
/// published values; a user Kind must carry both members explicitly.
fn is_public(source: &Source<'_>) -> bool {
    let capability = source
        .payload
        .and_then(|payload| payload.spec.capability.as_ref());
    let visibility = capability
        .and_then(|capability| capability.visibility.as_ref())
        .map(JsonScalar::text);
    let publish_status = capability
        .and_then(|capability| capability.publish_status.as_ref())
        .map(JsonScalar::text);
    if source.user_id == 0 {
        visibility.as_deref().unwrap_or("public") == "public"
            && publish_status.as_deref().unwrap_or("published") == "published"
    } else {
        visibility.as_deref() == Some("public") && publish_status.as_deref() == Some("published")
    }
}

/// `get_public_listing`.
pub(super) async fn get_public_listing<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    listing_id: i64,
    user_id: i64,
) -> Result<Listing, FastApiError>
where
    M: Mysql,
{
    let Some(row) = fetch_source(mysql, listing_id)
        .await
        .map_err(internal_error)?
    else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Capability resource not found",
        ));
    };
    let source = Source::from(&row);
    if !is_public(&source) {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Capability not found",
        ));
    }
    let install_count = fetch_install_count(mysql, source.id)
        .await
        .map_err(internal_error)?;
    to_listing(mysql, erp, &source, user_id, install_count)
        .await
        .map_err(internal_error)
}

/// GET /api/resource-library/listings/{listing_id}: the listing detail free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/resource-library/listings/:listing_id")]
async fn get_resource_library_listing(
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
    get_public_listing(&state.mysql, &erp, listing_id, i64::from(user.id)).await
}

/// FastAPI's 422 body for an unparsable integer path parameter
/// (`{type, loc, msg, input}`).
fn validation_error(value: &str) -> FastApiError {
    #[derive(Serialize)]
    struct Entry<'a> {
        #[serde(rename = "type")]
        kind: &'static str,
        loc: [&'static str; 2],
        msg: &'static str,
        input: &'a str,
    }
    FastApiError::validation(vec![Entry {
        kind: "int_parsing",
        loc: ["path", "listing_id"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: value,
    }])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource_library_listings::models::{KindPayload, Version};

    fn payload(json: serde_json::Value) -> KindPayload {
        serde_json::from_value(json).expect("test payload projects")
    }

    fn timestamp() -> chrono::NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, 8, 17)
            .unwrap()
            .and_hms_opt(10, 20, 22)
            .unwrap()
    }

    fn source_of(payload: &KindPayload, user_id: i64) -> Source<'_> {
        Source {
            id: 7,
            user_id,
            kind: "Team",
            name: "alpha",
            namespace: "default",
            payload: Some(payload),
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    #[test]
    fn source_statement_matches_the_recorded_query() {
        let sql = source_statement(269_955);
        assert!(sql.starts_with("SELECT kinds.id AS kinds_id"));
        assert!(sql.contains(
            "WHERE kinds.id = 269955 AND kinds.is_active = true AND kinds.kind IN \
             ('Team', 'Skill', 'Model', 'Shell', 'Retriever')"
        ));
        assert!(sql.ends_with("\n LIMIT 1"));
    }

    #[test]
    fn install_count_statement_selects_the_full_row() {
        let sql = install_count_statement(269_955);
        assert!(sql.contains(
            "marketplace_resources.install_count AS marketplace_resources_install_count"
        ));
        assert!(sql.contains(
            "\nFROM marketplace_resources \nWHERE marketplace_resources.kind_id = 269955"
        ));
        assert!(!sql.contains("LIMIT"));
    }

    #[test]
    fn system_kind_defaults_to_public_and_published() {
        for json in [
            serde_json::json!({"spec": {}}),
            serde_json::json!({"spec": {"capability": {}}}),
        ] {
            let payload = payload(json);
            assert!(is_public(&source_of(&payload, 0)));
        }
    }

    #[test]
    fn user_kind_requires_explicit_public_and_published() {
        let public = payload(serde_json::json!({
            "spec": {"capability": {"visibility": "public", "publishStatus": "published"}}
        }));
        assert!(is_public(&source_of(&public, 9)));
        let draft = payload(serde_json::json!({
            "spec": {"capability": {"visibility": "public", "publishStatus": "draft"}}
        }));
        assert!(!is_public(&source_of(&draft, 9)));
        let private = payload(serde_json::json!({
            "spec": {"capability": {"visibility": "private", "publishStatus": "published"}}
        }));
        assert!(!is_public(&source_of(&private, 9)));
    }

    #[test]
    fn system_kind_may_be_archived_explicitly() {
        let archived = payload(serde_json::json!({
            "spec": {"capability": {"publishStatus": "archived"}}
        }));
        assert!(!is_public(&source_of(&archived, 0)));
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

    /// The detail body is the discovery projection; keep its field order.
    #[test]
    fn listing_serializes_with_the_pydantic_field_order() {
        let listing = Listing {
            id: 269_955,
            resource_type: "agent".to_owned(),
            name: "生成视频".to_owned(),
            display_name: "生成视频".to_owned(),
            description: None,
            icon: None,
            tags: vec!["daily_work".to_owned()],
            feature_tags: Vec::new(),
            publisher_user_id: 0,
            publisher_user_name: None,
            publisher_namespace: "default".to_owned(),
            status: "published".to_owned(),
            current_version_id: 269_955,
            current_version: Version {
                id: 269_955,
                listing_id: 269_955,
                version: "1.0.0".to_owned(),
                changelog: None,
                package_url: None,
                created_at: "2026-08-17T10:20:22".to_owned(),
                updated_at: "2026-09-06T13:21:23".to_owned(),
            },
            install_count: 0,
            is_installed: true,
            example_conversations: Vec::new(),
            bind_modes: vec!["video".to_owned()],
            allow_personal_install: true,
            allow_group_install: true,
            target_groups: Vec::new(),
            created_at: "2026-08-17T10:20:22".to_owned(),
            updated_at: "2026-09-06T13:21:23".to_owned(),
        };
        let body = serde_json::to_string(&listing).unwrap();
        assert!(body.starts_with(
            "{\"id\":269955,\"resource_type\":\"agent\",\"name\":\"生成视频\",\
             \"display_name\":\"生成视频\",\"description\":null,\"icon\":null,"
        ));
        assert!(body.contains(
            "\"publisher_user_name\":null,\"publisher_namespace\":\"default\",\
             \"status\":\"published\",\"current_version_id\":269955,\"current_version\":\
             {\"id\":269955,\"listing_id\":269955,\"version\":\"1.0.0\",\"changelog\":null,\
             \"package_url\":null,"
        ));
        assert!(body.ends_with(
            "\"target_groups\":[],\"created_at\":\"2026-08-17T10:20:22\",\
             \"updated_at\":\"2026-09-06T13:21:23\"}"
        ));
    }
}
