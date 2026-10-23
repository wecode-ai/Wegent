// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET/PUT /api/resource-library/agents/{agent_id}/bindings` — the
//! effective personal and group scopes referencing one owned Agent.
//!
//! Source: `app.api.endpoints.resource_library.get_agent_bindings` /
//! `sync_agent_bindings` and
//! `app.services.resource_library_service.ResourceLibraryService.get_agent_bindings` /
//! `sync_agent_bindings`. The endpoints authenticate the session
//! (`security.get_current_user`), load the Team Kind by id (`_get_source`
//! with `expected_kind="Team"`, answering `404 "Capability resource not
//! found"` otherwise), gate on `_require_publish_permission` (`403
//! "Publish permission denied"`), and render the
//! `ResourceLibraryAgentBindings` body (`agent_id`, `personal`,
//! `group_names`). The PUT path additionally rejects system agents with
//! `409 "System agents are globally available and do not need bindings"`,
//! replaces the extra group references, deletes legacy
//! `CapabilityInstallation` rows, and commits before rendering.
//!
//! The response shares `_agent_bindings_response` with the sibling listing
//! endpoints, so the group-name resolution reuses the parent module's
//! repository probes instead of duplicating them.

use brz_http_server::StatusCode;
use brz_mysql::{Mysql, MysqlResult};
use serde::Serialize;
use serde_json::Value;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::skills::skills_unified::effective_role_in_group;
use crate::state::AppState;
use crate::teams::group_membership::{ErpContext, has_permission};

use super::agent_bindings_sync::sync_bindings;
use super::repository::{
    KIND_COLUMNS, KindRow, NamespaceRow, fetch_namespaces, fetch_team_group_members,
    has_team_member,
};
use super::service::internal_error;

/// `ResourceLibraryAgentBindings`.
#[derive(Serialize)]
pub(super) struct AgentBindings {
    agent_id: i64,
    personal: bool,
    group_names: Vec<String>,
}

/// FastAPI's 422 body for an unparsable integer path parameter.
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
        loc: ["path", "agent_id"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: value,
    }])
}

/// `_get_source` with `expected_kind="Team"`:
/// `db.query(Kind).filter(Kind.id == id, Kind.is_active == True,
/// Kind.kind == 'Team').first()`.
fn source_statement(agent_id: i64) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = {agent_id} AND \
         kinds.is_active = true AND kinds.kind = 'Team' \n LIMIT 1"
    )
}

/// `ResourceLibraryAgentBindings.group_names` maximum length (`max_length=100`)
const GROUP_NAMES_MAX_LENGTH: usize = 100;

/// The decode result for `ResourceLibraryAgentBindingsUpdateRequest`.
#[derive(Debug)]
struct UpdateRequest {
    group_names: Vec<String>,
}

/// FastAPI body validation for `sync_agent_bindings`'s request model: the
/// body must be an object, `group_names` a list of at most 100 strings.
fn parse_update(body: &Value) -> Result<UpdateRequest, FastApiError> {
    let Value::Object(object) = body else {
        return Err(FastApiError::validation(serde_json::json!([{
            "type": "model_attributes_type",
            "loc": ["body"],
            "msg": "Input should be a valid dictionary or object to extract fields from",
            "input": body,
        }])));
    };
    let Some(raw) = object.get("group_names") else {
        // The field has a default factory, so FastAPI tolerates the missing
        // key; a present non-list value is the only failure mode.
        return Ok(UpdateRequest {
            group_names: Vec::new(),
        });
    };
    let Value::Array(items) = raw else {
        return Err(FastApiError::validation(serde_json::json!([{
            "type": "list_type",
            "loc": ["body", "group_names"],
            "msg": "Input should be a valid list",
            "input": raw,
        }])));
    };
    let mut group_names = Vec::with_capacity(items.len());
    for item in items {
        let Value::String(name) = item else {
            return Err(FastApiError::validation(serde_json::json!([{
                "type": "string_type",
                "loc": ["body", "group_names", group_names.len()],
                "msg": "Input should be a valid string",
                "input": item,
            }])));
        };
        group_names.push(name.clone());
    }
    if items.len() > GROUP_NAMES_MAX_LENGTH {
        return Err(FastApiError::validation(serde_json::json!([{
            "type": "too_long",
            "loc": ["body", "group_names"],
            "msg": "List should have at most 100 items after validation, not 101",
            "input": raw,
            "ctx": {"max_length": 100}
        }])));
    }
    Ok(UpdateRequest { group_names })
}

/// `GET /api/resource-library/agents/{agent_id}/bindings`.
#[brz_http_server::get("/api/resource-library/agents/:agent_id/bindings")]
async fn get_agent_bindings(
    #[inject(state)] state: &AppState,
    agent_id: &str,
    #[auth] user: SessionUser,
) -> Result<AgentBindings, FastApiError> {
    let agent_id = agent_id
        .parse::<i64>()
        .map_err(|_| validation_error(agent_id))?;
    let erp = ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    get_bindings(
        &state.mysql,
        &erp,
        agent_id,
        i64::from(user.0.id),
        &user.0.role,
    )
    .await
}

/// `PUT /api/resource-library/agents/{agent_id}/bindings`.
#[brz_http_server::put("/api/resource-library/agents/:agent_id/bindings")]
async fn sync_agent_bindings(
    #[inject(state)] state: &AppState,
    agent_id: &str,
    #[auth] user: SessionUser,
    body: Value,
) -> Result<AgentBindings, FastApiError> {
    let agent_id = agent_id
        .parse::<i64>()
        .map_err(|_| validation_error(agent_id))?;
    let update = parse_update(&body)?;
    let erp = ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    sync_bindings(
        &state.mysql,
        &erp,
        agent_id,
        i64::from(user.0.id),
        &update.group_names,
        &user.0.role,
    )
    .await
}

/// `_get_source` for the Team Kind, mapped to the source's 404.
pub(super) async fn fetch_team_source<M>(mysql: &M, agent_id: i64) -> Result<KindRow, FastApiError>
where
    M: Mysql,
{
    mysql
        .fetch_optional(source_statement(agent_id), ())
        .await
        .map_err(internal_error)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Capability resource not found"))
}

/// The effective group role for a user (`get_effective_role_in_group`),
/// reached through the shared skills helper like the sibling endpoints.
pub(super) async fn effective_role<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    user_id: i64,
    group_name: &str,
) -> Result<Option<String>, FastApiError>
where
    M: Mysql,
{
    effective_role_in_group(
        mysql,
        erp,
        i32::try_from(user_id).unwrap_or(i32::MAX),
        group_name,
    )
    .await
    .map_err(internal_error)
}

/// `_require_publish_permission` / `_can_publish`.
pub(super) async fn require_publish_permission<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    source: &KindRow,
    user_id: i64,
    user_role: &str,
) -> Result<(), FastApiError>
where
    M: Mysql,
{
    // Admin bypass, then a `default`-namespace owner.
    if user_role == "admin"
        || (source.kinds_user_id == user_id && source.kinds_namespace == "default")
    {
        return Ok(());
    }
    if source.kinds_namespace != "default" {
        // `GroupRole.Developer` for a Team Kind.
        let role = effective_role(mysql, erp, user_id, &source.kinds_namespace).await?;
        if role
            .as_deref()
            .is_some_and(|role| has_permission(role, "Developer"))
        {
            return Ok(());
        }
    }
    Err(FastApiError::detail(
        StatusCode::FORBIDDEN,
        "Publish permission denied",
    ))
}

/// `_agent_bindings_response`.
pub(super) async fn bindings_response<M>(
    mysql: &M,
    source: &KindRow,
    user_id: i64,
) -> MysqlResult<AgentBindings>
where
    M: Mysql,
{
    let mut personal = source.kinds_namespace == "default" && source.kinds_user_id == user_id;
    if !personal {
        personal = has_team_member(mysql, source.kinds_id, user_id).await?;
    }
    Ok(AgentBindings {
        agent_id: source.kinds_id,
        personal,
        group_names: agent_group_names(mysql, source).await?,
    })
}

/// `_agent_group_names`: the intrinsic namespace plus every approved
/// namespace-entity grant resolved to an active namespace name, normalized.
async fn agent_group_names<M>(mysql: &M, source: &KindRow) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    let mut group_names: Vec<String> = if source.kinds_namespace == "default" {
        Vec::new()
    } else {
        vec![source.kinds_namespace.clone()]
    };
    let member_group_ids: Vec<String> = fetch_team_group_members(mysql, source.kinds_id)
        .await?
        .into_iter()
        .map(|member| member.resource_members_entity_id)
        .collect();
    if !member_group_ids.is_empty() {
        let namespace_ids: Vec<i64> = member_group_ids
            .iter()
            .filter_map(|value| value.trim().parse().ok())
            .collect();
        group_names.extend(
            fetch_namespaces(mysql, &namespace_ids)
                .await?
                .into_iter()
                .map(|namespace: NamespaceRow| namespace.namespace_name),
        );
    }
    Ok(normalize_group_names(group_names))
}

/// `_normalize_group_names`: strip, drop empties, `default`, and duplicates,
/// preserving the requested order.
pub(super) fn normalize_group_names(values: Vec<String>) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for value in values {
        let name = value.trim();
        if name.is_empty() || name == "default" || result.iter().any(|existing| existing == name) {
            continue;
        }
        result.push(name.to_owned());
    }
    result
}

/// `get_agent_bindings`.
async fn get_bindings<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    agent_id: i64,
    user_id: i64,
    user_role: &str,
) -> Result<AgentBindings, FastApiError>
where
    M: Mysql,
{
    let source = fetch_team_source(mysql, agent_id).await?;
    require_publish_permission(mysql, erp, &source, user_id, user_role).await?;
    bindings_response(mysql, &source, user_id)
        .await
        .map_err(internal_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_statement_matches_the_recorded_query() {
        let sql = source_statement(195_057);
        assert!(sql.starts_with("SELECT kinds.id AS kinds_id"));
        assert!(sql.contains(
            "WHERE kinds.id = 195057 AND kinds.is_active = true AND kinds.kind = 'Team'"
        ));
        assert!(sql.ends_with("\n LIMIT 1"));
    }

    #[test]
    fn normalize_group_names_preserves_order_and_drops_invalid_entries() {
        assert_eq!(
            normalize_group_names(vec![
                " alpha ".to_owned(),
                "default".to_owned(),
                "".to_owned(),
                "alpha".to_owned(),
                "beta".to_owned(),
            ]),
            vec!["alpha".to_owned(), "beta".to_owned()]
        );
    }

    #[test]
    fn update_body_decodes_group_names() {
        let body = serde_json::json!({"group_names": ["example-team"]});
        let update = parse_update(&body).unwrap();
        assert_eq!(update.group_names, vec!["example-team".to_owned()]);

        let body = serde_json::json!({});
        assert!(parse_update(&body).unwrap().group_names.is_empty());

        let error = parse_update(&serde_json::json!([])).unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        assert!(error.validation_detail().contains("model_attributes_type"));

        let error = parse_update(&serde_json::json!({"group_names": "example-team"})).unwrap_err();
        assert!(error.validation_detail().contains("list_type"));

        let error = parse_update(&serde_json::json!({"group_names": [1]})).unwrap_err();
        assert!(error.validation_detail().contains("string_type"));
    }

    #[test]
    fn update_body_rejects_more_than_one_hundred_groups() {
        let names: Vec<String> = (0..101).map(|index| index.to_string()).collect();
        let error = parse_update(&serde_json::json!({ "group_names": names }))
            .unwrap_err()
            .validation_detail();
        assert!(error.contains("too_long"));
        assert!(error.contains("\"max_length\":100"));
    }

    #[test]
    fn agent_id_path_validation_renders_the_fastapi_entry() {
        let error = validation_error("abc");
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
        let detail = error.validation_detail();
        assert!(detail.contains("int_parsing"));
        assert!(detail.contains("[\"path\",\"agent_id\"]"));
    }

    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/resource-library/agents/:agent_id/bindings";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        const PUT: u16 = 1 << 6;
        let mut methods = 0;
        for route in
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>()
                .flat_map(|entry| (entry.0.routes)())
        {
            if route.path == PATH {
                methods |= route.methods;
            }
        }
        assert!(methods & GET != 0, "GET {PATH} must be registered");
        assert!(methods & PUT != 0, "PUT {PATH} must be registered");
        // Both methods keep Python ownership until their cutovers are verified.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("the route file loads");
        let table = crate::RouteTable::compile(config).expect("the route table compiles");
        assert!(!table.matches(
            &http::Method::GET,
            "/api/resource-library/agents/195057/bindings"
        ));
        assert!(!table.matches(
            &http::Method::PUT,
            "/api/resource-library/agents/195057/bindings"
        ));
    }

    #[test]
    fn response_renders_the_source_field_order() {
        let body = AgentBindings {
            agent_id: 195_057,
            personal: true,
            group_names: Vec::new(),
        };
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            "{\"agent_id\":195057,\"personal\":true,\"group_names\":[]}"
        );
    }
}
