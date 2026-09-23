// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/groups` — the current user's group list.
//!
//! Mirrors `app.api.endpoints.groups.list_groups` and
//! `app.services.group_service.list_user_groups`: resolve the user's group
//! memberships (`iter_user_groups_with_roles`, including entity-derived
//! memberships through the optional directory provider; admins
//! additionally own every active organization namespace), query the active
//! namespaces by name ordered by creation time descending, count the
//! approved members of every group, and paginate.
use std::collections::HashMap;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use serde::Serialize;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::teams::group_membership::{ErpContext, iter_user_groups_with_roles};
use crate::teams::teams_repository::{MEMBER_COLUMNS, NAMESPACE_COLUMNS};

/// One `namespace` row of the main list query (full column list, matching
/// `db.query(Namespace)`).
#[derive(Debug, FromMysqlRow)]
struct NamespaceFullRow {
    namespace_id: i64,
    namespace_name: String,
    namespace_display_name: Option<String>,
    namespace_owner_user_id: i64,
    namespace_visibility: String,
    namespace_description: String,
    namespace_level: Option<String>,
    namespace_is_active: i8,
    namespace_created_at: chrono::NaiveDateTime,
    namespace_updated_at: chrono::NaiveDateTime,
}

/// `namespace.id` from `get_namespace_id_by_name`.
#[derive(Debug, FromMysqlRow)]
struct NamespaceIdRow {
    namespace_id: i64,
}

/// `count(*) AS count_1` from the member-count query.
#[derive(Debug, FromMysqlRow)]
struct CountRow {
    count_1: i64,
}

/// `namespace.name` for the admin organization listing.
#[derive(Debug, FromMysqlRow)]
struct NamespaceNameRow {
    namespace_name: String,
}

/// `GroupResponse` (`app.schemas.namespace`): field order follows the
/// pydantic model declaration (GroupBase first, then GroupResponse).
#[derive(Debug, Serialize)]
pub struct GroupItem {
    pub name: String,
    pub display_name: Option<String>,
    pub visibility: String,
    pub description: String,
    pub id: i64,
    pub owner_user_id: i64,
    pub level: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
    pub my_role: Option<String>,
    pub member_count: i64,
}

/// `GroupListResponse` (`app.schemas.namespace`).
#[derive(Debug, Serialize)]
pub struct GroupListResponse {
    pub total: i64,
    pub items: Vec<GroupItem>,
}

/// GET /api/groups: the groups where the current user is a member, as a free
/// function injecting the process-lifetime application state.
#[brz_http_server::get("/api/groups")]
async fn list_groups(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
    page: Option<String>,
    limit: Option<String>,
) -> Result<GroupListResponse, FastApiError> {
    groups_list(state, &current_user, page.as_deref(), limit.as_deref()).await
}

/// Handler body for `GET /api/groups`.
async fn groups_list(
    state: &AppState,
    user: &SessionUser,
    page_raw: Option<&str>,
    limit_raw: Option<&str>,
) -> Result<GroupListResponse, FastApiError> {
    // FastAPI validates the query parameters before the endpoint body runs;
    // invalid values surface as 422 without any dependency traffic.
    let (page, limit) = parse_paging(page_raw, limit_raw)?;
    let user_id = i64::from(user.id);
    let user_role = &user.role;

    let skip = (page - 1) * limit;
    let group_roles = user_group_roles(state, user_id, user_role).await?;
    let names: Vec<String> = group_roles.iter().map(|(name, _)| name.clone()).collect();
    let namespaces = paged_namespaces(&state.mysql, &names, skip, limit)
        .await
        .map_err(internal)?;

    // `get_group_member_count` runs for every group the user belongs to
    // (`for group_name in group_names`), not just the returned page.
    let mut member_counts: HashMap<String, i64> = HashMap::with_capacity(names.len());
    for name in &names {
        let count = group_member_count(&state.mysql, name)
            .await
            .map_err(internal)?;
        member_counts.insert(name.clone(), count);
    }

    // `if page == 1 and len(groups) < limit: total = len(groups)` — the
    // short-circuit avoids the full pass; otherwise the source re-resolves
    // the memberships from scratch with `skip=0, limit=1000`.
    let total = if page == 1 && (namespaces.len() as i64) < limit {
        namespaces.len() as i64
    } else {
        let all_roles = user_group_roles(state, user_id, user_role).await?;
        let all_names: Vec<String> = all_roles.iter().map(|(name, _)| name.clone()).collect();
        paged_namespaces(&state.mysql, &all_names, 0, 1000)
            .await
            .map_err(internal)?
            .len() as i64
    };

    let items = namespaces
        .iter()
        .map(|row| {
            let my_role = group_roles
                .iter()
                .find(|(name, _)| *name == row.namespace_name)
                .map(|(_, role)| role.clone());
            GroupItem {
                name: row.namespace_name.clone(),
                display_name: row.namespace_display_name.clone(),
                visibility: row.namespace_visibility.clone(),
                description: row.namespace_description.clone(),
                id: row.namespace_id,
                owner_user_id: row.namespace_owner_user_id,
                level: row.namespace_level.clone(),
                is_active: row.namespace_is_active != 0,
                created_at: pydantic_datetime(row.namespace_created_at),
                updated_at: pydantic_datetime(row.namespace_updated_at),
                my_role,
                member_count: member_counts.get(&row.namespace_name).copied().unwrap_or(0),
            }
        })
        .collect();

    Ok(GroupListResponse { total, items })
}

/// Parse the `page`/`limit` query parameters with the source `Query`
/// constraints (`page >= 1`, `1 <= limit <= 100`, defaults 1/100).
fn parse_paging(
    page_raw: Option<&str>,
    limit_raw: Option<&str>,
) -> Result<(i64, i64), FastApiError> {
    let page = match page_raw {
        None => 1,
        Some(raw) => {
            let value = parse_int(raw, "page")?;
            if value < 1 {
                return Err(validation_error(
                    "page",
                    "greater_than_equal",
                    "Input should be greater than or equal to 1",
                    value,
                ));
            }
            value
        }
    };
    let limit = match limit_raw {
        None => 100,
        Some(raw) => {
            let value = parse_int(raw, "limit")?;
            if value < 1 {
                return Err(validation_error(
                    "limit",
                    "greater_than_equal",
                    "Input should be greater than or equal to 1",
                    value,
                ));
            }
            if value > 100 {
                return Err(validation_error(
                    "limit",
                    "less_than_equal",
                    "Input should be less than or equal to 100",
                    value,
                ));
            }
            value
        }
    };
    Ok((page, limit))
}

fn parse_int(value: &str, field: &str) -> Result<i64, FastApiError> {
    value.parse().map_err(|_| {
        validation_error(
            field,
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
            value,
        )
    })
}

/// FastAPI's 422 validation-error array body for one query parameter.
fn validation_error(field: &str, kind: &str, message: &str, input: impl Serialize) -> FastApiError {
    FastApiError::validation(serde_json::json!([
        {
            "type": kind,
            "loc": ["query", field],
            "msg": message,
            "input": input,
        }
    ]))
}

/// Dependency failure mapped to the source 500 response.
fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "groups database dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// `list_user_groups`' role resolution: direct + entity-derived memberships
/// (first-seen order, like the source dict), with admin users additionally
/// owning every active organization namespace (existing entries are
/// overwritten to Owner, new ones appended).
async fn user_group_roles(
    state: &AppState,
    user_id: i64,
    user_role: &str,
) -> Result<Vec<(String, String)>, FastApiError> {
    let erp = ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    let memberships = iter_user_groups_with_roles(&state.mysql, &erp, user_id)
        .await
        .map_err(internal)?;
    let mut roles: Vec<(String, String)> = memberships
        .into_iter()
        .map(|membership| (membership.group_name, membership.role))
        .collect();
    if user_role == "admin" {
        let organization_names = organization_namespace_names(&state.mysql)
            .await
            .map_err(internal)?;
        for name in organization_names {
            match roles.iter_mut().find(|(existing, _)| *existing == name) {
                Some(entry) => entry.1 = "Owner".to_string(),
                None => roles.push((name, "Owner".to_string())),
            }
        }
    }
    Ok(roles)
}

/// Expand `?, ?, ...` with `count` placeholders.
fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/// The paginated namespace query
/// (`db.query(Namespace).filter(name.in_(group_names), is_active)
/// .order_by(created_at.desc()).offset(skip).limit(limit)`). `skip` and
/// `limit` are pre-validated and inlined as literals exactly like the
/// source's rendered `LIMIT offset, limit` clause.
async fn paged_namespaces<M>(
    mysql: &M,
    names: &[String],
    skip: i64,
    limit: i64,
) -> MysqlResult<Vec<NamespaceFullRow>>
where
    M: Mysql,
{
    // `if not group_roles: return []` — no SQL is issued for an empty list.
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {NAMESPACE_COLUMNS} \nFROM namespace \nWHERE namespace.name IN ({}) \
         AND namespace.is_active = true ORDER BY namespace.created_at DESC \n LIMIT {skip}, {limit}",
        placeholders(names.len()),
    );
    mysql.fetch_all(sql.as_str(), names.to_vec()).await
}

/// `get_group_member_count`: the namespace id by name
/// (`get_namespace_id_by_name`, `LIMIT 1`), then the approved-member count
/// (any entity type) over the full `resource_members` projection wrapped in
/// SQLAlchemy's `count(*)` subquery.
async fn group_member_count<M>(mysql: &M, group_name: &str) -> MysqlResult<i64>
where
    M: Mysql,
{
    let namespace: Option<NamespaceIdRow> = mysql
        .fetch_optional(
            format!(
                "SELECT {NAMESPACE_COLUMNS} \nFROM namespace \
                 \nWHERE namespace.name = ? AND namespace.is_active = 1 \n LIMIT 1"
            )
            .as_str(),
            (group_name,),
        )
        .await?;
    let Some(namespace) = namespace else {
        return Ok(0);
    };
    let row: CountRow = mysql
        .fetch_one(
            format!(
                "SELECT count(*) AS count_1 \nFROM (SELECT {MEMBER_COLUMNS} \
                 \nFROM resource_members \nWHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.resource_id = ? \
                 AND resource_members.status = 'approved') AS anon_1"
            )
            .as_str(),
            (namespace.namespace_id,),
        )
        .await?;
    Ok(row.count_1)
}

/// Active organization-level namespace names (the admin overlay in
/// `list_user_groups`).
async fn organization_namespace_names<M>(mysql: &M) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    let rows: Vec<NamespaceNameRow> = mysql
        .fetch_all(
            "SELECT namespace.name AS namespace_name \nFROM namespace \
             \nWHERE namespace.level = 'organization' AND namespace.is_active = true",
            (),
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.namespace_name).collect())
}

/// pydantic serializes a DB `datetime` as `YYYY-MM-DDTHH:MM:SS`.
fn pydantic_datetime(value: chrono::NaiveDateTime) -> String {
    value.format("%Y-%m-%dT%H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;
    use chrono::NaiveDate;

    fn item() -> GroupItem {
        GroupItem {
            name: "example".to_string(),
            display_name: Some("Example Group".to_string()),
            visibility: "internal".to_string(),
            description: String::new(),
            id: 1001,
            owner_user_id: 1002,
            level: Some("group".to_string()),
            is_active: true,
            created_at: "2026-05-29T16:21:14".to_string(),
            updated_at: "2026-05-29T16:21:14".to_string(),
            my_role: Some("Developer".to_string()),
            member_count: 13,
        }
    }

    #[test]
    fn paging_defaults_match_source() {
        assert_eq!(parse_paging(None, None).unwrap(), (1, 100));
        assert_eq!(parse_paging(Some("2"), Some("20")).unwrap(), (2, 20));
    }

    #[test]
    fn paging_rejects_non_integers() {
        let error = parse_paging(Some("x"), None).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(parse_paging(None, Some("y")).is_err());
    }

    #[test]
    fn paging_enforces_bounds() {
        assert!(parse_paging(Some("0"), None).is_err());
        assert!(parse_paging(None, Some("0")).is_err());
        assert!(parse_paging(None, Some("101")).is_err());
        assert_eq!(parse_paging(Some("1"), Some("1")).unwrap(), (1, 1));
        assert_eq!(parse_paging(Some("1"), Some("100")).unwrap(), (1, 100));
    }

    #[test]
    fn response_field_order_matches_pydantic_model() {
        let response = GroupListResponse {
            total: 1,
            items: vec![item()],
        };
        let body = serde_json::to_string(&response).unwrap();
        assert_eq!(
            body,
            "{\"total\":1,\"items\":[{\"name\":\"example\",\"display_name\":\"Example Group\",\
             \"visibility\":\"internal\",\"description\":\"\",\"id\":1001,\"owner_user_id\":1002,\
             \"level\":\"group\",\"is_active\":true,\"created_at\":\"2026-05-29T16:21:14\",\
             \"updated_at\":\"2026-05-29T16:21:14\",\"my_role\":\"Developer\",\"member_count\":13}]}"
        );
    }

    #[test]
    fn pydantic_datetime_has_no_fraction() {
        let dt = NaiveDate::from_ymd_opt(2026, 5, 29)
            .unwrap()
            .and_hms_micro_opt(16, 21, 14, 999999)
            .unwrap();
        assert_eq!(pydantic_datetime(dt), "2026-05-29T16:21:14");
    }
}
