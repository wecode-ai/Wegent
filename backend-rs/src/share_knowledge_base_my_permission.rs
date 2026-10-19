// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/share/KnowledgeBase/{resource_id}/my-permission`
//! (`app.api.endpoints.share.get_my_kb_permission` ->
//! `app.services.share.knowledge_share_service.get_my_permission`).
//!
//! Source pipeline:
//!
//! 1. `security.get_current_user` — the session user (framework auth);
//! 2. the `Kind` record (`id`, `kind='KnowledgeBase'`, `is_active`) — an
//!    absent record returns the all-false response with no ACL query at all;
//! 3. `resolve_knowledge_base_permission` — the ACL chain shared with the
//!    knowledge-bases and document endpoints, whose explicit denials
//!    (`is_denied`) suppress the pending-request branch below;
//! 4. the caller's own `resource_members` row
//!    (`resource_type='KnowledgeBase'`, `entity_type='user'`, `entity_id` =
//!    the user id, no status filter) for the pending-request branch;
//! 5. `meets_direct_access_requirement` over the raw facts for `has_access`.
use brz_json::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Serialize;

use crate::crd::CrdDocument;
use crate::http_compat::FastApiError;
use crate::knowledge_documents_content::access::{
    KnowledgeBase, MEMBER_COLUMNS, PermissionFacts, has_permission, resolve_permission_facts,
};
use crate::state::AppState;

/// `MyKBPermissionResponse` (`app.schemas.share`): field order follows the
/// pydantic model's declaration order.
#[derive(Debug, Serialize)]
struct MyKbPermissionResponse {
    has_access: bool,
    role: Option<String>,
    is_creator: bool,
    pending_request: Option<PendingRequestInfo>,
}

/// `PendingRequestInfo` (`app.schemas.share`).
#[derive(Debug, Serialize)]
struct PendingRequestInfo {
    id: i64,
    role: String,
    requested_at: String,
}

/// GET /api/share/KnowledgeBase/:resource_id/my-permission: the share
/// endpoint, injecting the process-lifetime application state.
#[brz_http_server::get("/api/share/KnowledgeBase/:resource_id/my-permission")]
async fn get_my_kb_permission(
    #[inject(state)] state: &AppState,
    resource_id: &str,
    #[auth] current_user: crate::auth::SessionUser,
) -> Result<MyKbPermissionResponse, FastApiError> {
    let resource_id = resource_id
        .parse::<i64>()
        .map_err(|_| validation_error(resource_id))?;
    my_permission(state, resource_id, &current_user).await
}

/// FastAPI-style 422 for an unparsable `{resource_id}` path parameter.
fn validation_error(value: &str) -> FastApiError {
    FastApiError::validation([serde_json::json!({
        "type": "int_parsing",
        "loc": ["path", "resource_id"],
        "msg": "Input should be a valid integer, unable to parse string as an integer",
        "input": value,
    })])
}

/// Handler body for `GET /api/share/KnowledgeBase/{resource_id}/my-permission`.
async fn my_permission(
    state: &AppState,
    knowledge_base_id: i64,
    user: &crate::auth::SessionUser,
) -> Result<MyKbPermissionResponse, FastApiError> {
    let user_id = i64::from(user.id);

    let mysql = &state.mysql;
    let redis = state.redis.as_ref();

    // `get_my_permission`'s own `Kind` lookup (`.filter(Kind.is_active)` renders
    // `kinds.is_active = 1`). A missing record short-circuits before any ACL
    // query and renders the all-false response.
    let Some(kb) = my_permission_kb_record(mysql, knowledge_base_id)
        .await
        .map_err(|_| FastApiError::unhandled())?
    else {
        return Ok(MyKbPermissionResponse {
            has_access: false,
            role: None,
            is_creator: false,
            pending_request: None,
        });
    };

    // `resolve_knowledge_base_permission(db, kb, user_id)`.
    let facts = resolve_permission_facts(mysql, redis, &state.entity_resolvers, &kb, user_id)
        .await
        .map_err(|_| FastApiError::unhandled())?;

    // The endpoint's own `ResourceMember` lookup for the pending request. Its
    // predicates differ from `_append_direct_member_source`'s (single
    // `resource_type` value, no status filter), so it is a distinct statement.
    let explicit = explicit_member(mysql, knowledge_base_id, user_id)
        .await
        .map_err(|_| FastApiError::unhandled())?;

    let mut pending_request = None;
    if let Some(member) = explicit
        && !facts.is_denied
        && member.resource_members_status == "pending"
    {
        // `PendingRequestInfo(role=SchemaMemberRole(effective_role))`:
        // `get_effective_role` defaults an empty role to Reporter, and an
        // out-of-enum role raises before the response is built.
        let effective_role = effective_role(&member.resource_members_role);
        if role_known(effective_role) {
            pending_request = Some(PendingRequestInfo {
                id: member.resource_members_id,
                role: effective_role.to_string(),
                requested_at: pydantic_datetime(member.resource_members_requested_at),
            });
        } else {
            return Err(FastApiError::unhandled());
        }
    }

    // Suppress a pending request that cannot raise the caller above the role
    // they already hold.
    if let Some(pending) = &pending_request
        && facts.has_access
        && let Some(role) = &facts.role
        && has_permission(role, &pending.role)
    {
        pending_request = None;
    }

    let has_access = meets_direct_access_requirement(&kb, &facts);
    // `SchemaMemberRole.Owner if permission.is_creator else <raw role>`.
    let role = if facts.is_creator {
        Some("Owner".to_string())
    } else {
        facts.role.clone()
    };

    Ok(MyKbPermissionResponse {
        has_access,
        role,
        is_creator: facts.is_creator,
        pending_request,
    })
}

/// `ResourceMember.get_effective_role`: an empty role defaults to Reporter.
fn effective_role(role: &str) -> &str {
    if role.is_empty() { "Reporter" } else { role }
}

/// Whether `role` is a member of the role enum (`SchemaMemberRole`).
fn role_known(role: &str) -> bool {
    matches!(
        role,
        "Owner" | "Maintainer" | "Developer" | "Reporter" | "Viewer" | "RestrictedAnalyst"
    )
}

/// `meets_direct_access_requirement(kb=kb, permission=permission)` over the raw
/// ACL facts: `read` needs raw access, `edit` needs
/// `can_manage_accessible_knowledge_base_documents`, anything else denies.
fn meets_direct_access_requirement(kb: &KnowledgeBase, facts: &PermissionFacts) -> bool {
    let crd = CrdDocument::project_opaque(&kb.kinds_json);
    let requirement = crd
        .spec
        .as_ref()
        .and_then(|spec| spec.direct_access_requirement.as_deref())
        .unwrap_or("read");
    match requirement {
        "read" => facts.has_access,
        "edit" => {
            facts.has_access
                && (facts.is_creator
                    || facts
                        .role
                        .as_deref()
                        .is_some_and(|role| has_permission(role, "Developer")))
        }
        _ => false,
    }
}

/// `get_my_permission`'s `Kind` lookup: `.filter(Kind.id == ..., Kind.kind ==
/// "KnowledgeBase", Kind.is_active)`. SQLAlchemy renders the bare boolean
/// column as `kinds.is_active = 1`, distinct from the `= true` / `IS true`
/// renderings of the sibling knowledge endpoints, so this is its own
/// statement.
async fn my_permission_kb_record<M>(
    mysql: &M,
    knowledge_base_id: i64,
) -> MysqlResult<Option<KnowledgeBase>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        kinds_id: i64,
        kinds_user_id: i64,
        kinds_namespace: String,
        kinds_json: Json<OpaqueJson>,
        kinds_created_at: NaiveDateTime,
        kinds_updated_at: NaiveDateTime,
    }
    let row: Option<Row> = mysql
        .fetch_optional(
            &format!(
                "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
                 kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
                 kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
                 kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
                 kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
                 WHERE kinds.id = {knowledge_base_id} AND kinds.kind = 'KnowledgeBase' \
                 AND kinds.is_active = 1 \n LIMIT 1"
            ),
            (),
        )
        .await?;
    Ok(row.map(|row| KnowledgeBase {
        kinds_id: row.kinds_id,
        kinds_user_id: row.kinds_user_id,
        kinds_namespace: row.kinds_namespace,
        kinds_json: row.kinds_json.0,
        kinds_created_at: row.kinds_created_at,
        kinds_updated_at: row.kinds_updated_at,
    }))
}

/// `get_my_permission`'s explicit `ResourceMember` lookup:
/// `resource_type == 'KnowledgeBase'`, `resource_id`, `entity_type == 'user'`,
/// `entity_id == str(user_id)` — no status filter.
async fn explicit_member<M>(
    mysql: &M,
    knowledge_base_id: i64,
    user_id: i64,
) -> MysqlResult<Option<ExplicitMemberRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {MEMBER_COLUMNS} \nFROM resource_members \n\
                 WHERE resource_members.resource_type = 'KnowledgeBase' \
                 AND resource_members.resource_id = {knowledge_base_id} \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = '{user_id}' \n LIMIT 1"
            ),
            (),
        )
        .await
}

/// The columns the pending-request branch reads from the explicit membership
/// row.
#[derive(Debug, FromMysqlRow)]
struct ExplicitMemberRow {
    resource_members_id: i64,
    resource_members_role: String,
    resource_members_status: String,
    resource_members_requested_at: NaiveDateTime,
}

/// Pydantic naive-`datetime` serialization: `YYYY-MM-DDTHH:MM:SS`
/// (zero-padded six-digit microseconds only when the value has a fractional
/// part, like Python's `datetime.isoformat()`).
fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_micros() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kb_from_json(json: &str) -> KnowledgeBase {
        KnowledgeBase {
            kinds_id: 17,
            kinds_user_id: 3,
            kinds_namespace: "default".to_string(),
            kinds_json: OpaqueJson::from(serde_json::from_str::<serde_json::Value>(json).unwrap()),
            kinds_created_at: NaiveDateTime::parse_from_str(
                "2026-01-01 16:43:32",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
            kinds_updated_at: NaiveDateTime::parse_from_str(
                "2026-01-01 16:43:32",
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
        }
    }

    fn facts(has_access: bool, role: Option<&str>, is_creator: bool) -> PermissionFacts {
        PermissionFacts {
            has_access,
            role: role.map(str::to_string),
            is_creator,
            is_denied: false,
        }
    }

    #[test]
    fn recorded_creator_response_renders_expected_body() {
        let kb = kb_from_json(r#"{"spec":{"directAccessRequirement":"read"}}"#);
        let facts = facts(true, Some("Owner"), true);
        assert!(meets_direct_access_requirement(&kb, &facts));
        let response = MyKbPermissionResponse {
            has_access: true,
            role: Some("Owner".to_string()),
            is_creator: true,
            pending_request: None,
        };
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            r#"{"has_access":true,"role":"Owner","is_creator":true,"pending_request":null}"#
        );
    }

    #[test]
    fn missing_knowledge_base_body_is_all_false() {
        let response = MyKbPermissionResponse {
            has_access: false,
            role: None,
            is_creator: false,
            pending_request: None,
        };
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            r#"{"has_access":false,"role":null,"is_creator":false,"pending_request":null}"#
        );
    }

    /// `meets_direct_access_requirement`: `read` follows raw access, `edit`
    /// needs the creator or a Developer role, any other value denies.
    #[test]
    fn direct_access_requirement_branches() {
        let read = kb_from_json(r#"{"spec":{}}"#);
        assert!(meets_direct_access_requirement(
            &read,
            &facts(true, None, false)
        ));
        assert!(!meets_direct_access_requirement(
            &read,
            &facts(false, None, false)
        ));

        let edit = kb_from_json(r#"{"spec":{"directAccessRequirement":"edit"}}"#);
        assert!(meets_direct_access_requirement(
            &edit,
            &facts(true, Some("Maintainer"), false)
        ));
        assert!(!meets_direct_access_requirement(
            &edit,
            &facts(true, Some("Reporter"), false)
        ));
        assert!(meets_direct_access_requirement(
            &edit,
            &facts(true, Some("Reporter"), true)
        ));

        let unknown = kb_from_json(r#"{"spec":{"directAccessRequirement":"weird"}}"#);
        assert!(!meets_direct_access_requirement(
            &unknown,
            &facts(true, Some("Owner"), true)
        ));
    }

    #[test]
    fn pending_request_renders_effective_role_and_timestamp() {
        let pending = PendingRequestInfo {
            id: 42,
            role: "Developer".to_string(),
            requested_at: pydantic_datetime(
                NaiveDateTime::parse_from_str("2026-01-01 16:43:32.500000", "%Y-%m-%d %H:%M:%S%.f")
                    .unwrap(),
            ),
        };
        assert_eq!(
            serde_json::to_string(&pending).unwrap(),
            r#"{"id":42,"role":"Developer","requested_at":"2026-01-01T16:43:32.500000"}"#
        );
        assert_eq!(
            pydantic_datetime(
                NaiveDateTime::parse_from_str("2026-01-01 16:43:32", "%Y-%m-%d %H:%M:%S").unwrap()
            ),
            "2026-01-01T16:43:32"
        );
    }

    #[test]
    fn empty_role_defaults_to_reporter_and_unknown_roles_are_rejected() {
        assert_eq!(effective_role(""), "Reporter");
        assert_eq!(effective_role("Developer"), "Developer");
        assert!(role_known("RestrictedAnalyst"));
        assert!(!role_known("Administrator"));
    }

    /// The endpoint's own `Kind` lookup renders the bare boolean column as
    /// `kinds.is_active = 1`; the recorded representative case
    /// (`GET /api/share/KnowledgeBase/1758221/my-permission`) issues exactly
    /// this statement, distinct from the sibling knowledge endpoints'
    /// `= true` / `IS true` renderings.
    #[tokio::test]
    async fn knowledge_base_lookup_renders_the_recorded_statement() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        assert!(
            my_permission_kb_record(&mysql, 1758221)
                .await
                .unwrap()
                .is_none()
        );
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(
            queries[0].sql,
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at FROM kinds \
             WHERE kinds.id = 1758221 AND kinds.kind = 'KnowledgeBase' \
             AND kinds.is_active = 1 LIMIT 1"
        );
    }

    /// The pending-request lookup uses a single `resource_type` value and no
    /// status filter, matching the recorded representative case.
    #[tokio::test]
    async fn explicit_member_lookup_renders_the_recorded_statement() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        assert!(
            explicit_member(&mysql, 1758221, 238)
                .await
                .unwrap()
                .is_none()
        );
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.starts_with(
            "SELECT resource_members.id AS resource_members_id, \
             resource_members.resource_type AS resource_members_resource_type,"
        ));
        assert!(queries[0].sql.ends_with(
            "FROM resource_members \
             WHERE resource_members.resource_type = 'KnowledgeBase' \
             AND resource_members.resource_id = 1758221 \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = '238' LIMIT 1"
        ));
        // `resource_members.status` is selected but never filtered, unlike the
        // ACL chain's approved-membership lookups.
        assert!(!queries[0].sql.contains("AND resource_members.status"));
    }

    /// The cutover and the handler registration must agree. The hybrid gateway
    /// sends `GET /api/share/KnowledgeBase/*/my-permission` to the Rust
    /// listener, whose unmatched-path fallback renders FastAPI's
    /// `404 {"detail":"Not Found"}`; a missing registration therefore
    /// reproduces the recorded failure instead of the endpoint's body.
    #[test]
    fn selected_route_is_registered_in_the_shared_group() {
        const PATH: &str = "/api/share/KnowledgeBase/:resource_id/my-permission";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must be selected for Rust"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(table.matches(
            &http::Method::GET,
            "/api/share/KnowledgeBase/1758221/my-permission"
        ));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}
