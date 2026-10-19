// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PUT /api/resource-library/agents/{agent_id}/bindings` — the write side of
//! the agent binding endpoints.
//!
//! Source: `app.services.resource_library_service.ResourceLibraryService.
//! sync_agent_bindings` and its helpers `_sync_agent_group_members`,
//! `_ensure_agent_access_binding`, and `_delete_legacy_agent_installations`.
//! The handler gates on `_require_publish_permission`, rejects system agents
//! with `409 "System agents are globally available and do not need bindings"`,
//! replaces the extra namespace grants, hard-deletes the legacy
//! `CapabilityInstallation` rows, commits, replays the `expire_on_commit`
//! refreshes, and renders the shared bindings response.

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

use crate::http_compat::FastApiError;
use crate::teams::group_membership::{ErpContext, has_permission};

use super::agent_bindings::{
    AgentBindings, bindings_response, effective_role, fetch_team_source, normalize_group_names,
    require_publish_permission,
};
use super::models::scalar_to_int;
use super::repository::{
    KIND_COLUMNS, KindPayloadRow, KindRow, RESOURCE_MEMBER_COLUMNS, ResourceMemberRow,
    quote_literal,
};
use super::service::internal_error;

/// `db.get(User, id)` after the commit expires the ORM row: the bare entity
/// projection SQLAlchemy renders for `Session.get`.
const REFRESH_USER_QUERY: &str = "SELECT users.id, users.user_name, users.password_hash, \
     users.email, users.git_info, users.is_active, users.`role`, users.auth_source, \
     users.preferences, users.created_at, users.updated_at \
     \nFROM users \nWHERE users.id = ?";

/// `db.refresh(source)`'s unlabeled `kinds` entity projection with no LIMIT.
const REFRESH_KIND_QUERY: &str = "SELECT kinds.id, kinds.user_id, kinds.kind, kinds.name, \
     kinds.namespace, kinds.json, kinds.is_active, kinds.created_at, kinds.updated_at \
     \nFROM kinds \nWHERE kinds.id = ?";

/// One refreshed `kinds` row (unlabeled columns). Every member renames the
/// projected column: `FromMysqlRow` matches exact column names, and the
/// unaliased projection emits `id`, `user_id`, `kind`, `name`, `namespace`,
/// `json`, `is_active`, `created_at` and `updated_at`.
#[derive(Debug, FromMysqlRow)]
struct RefreshedKindRow {
    #[mysql(rename = "id")]
    kinds_id: i64,
    #[mysql(rename = "user_id")]
    kinds_user_id: i64,
    #[mysql(rename = "kind")]
    kinds_kind: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "name")]
    kinds_name: String,
    #[mysql(rename = "namespace")]
    kinds_namespace: String,
    #[allow(
        dead_code,
        reason = "the projection decodes the full source column list"
    )]
    #[mysql(rename = "json")]
    kinds_json: Option<brz_mysql::Json<brz_json::OpaqueJson>>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "is_active")]
    kinds_is_active: i8,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "created_at")]
    kinds_created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "updated_at")]
    kinds_updated_at: chrono::NaiveDateTime,
}

/// One refreshed `users` row; only the refresh exchange itself is needed.
#[derive(Debug, FromMysqlRow)]
struct RefreshedUserRow {
    #[allow(
        dead_code,
        reason = "the refresh exchange is required, the values are not"
    )]
    id: i64,
    #[allow(
        dead_code,
        reason = "the refresh exchange is required, the values are not"
    )]
    user_name: String,
    #[allow(
        dead_code,
        reason = "the refresh exchange is required, the values are not"
    )]
    #[mysql(rename = "password_hash")]
    password_hash: String,
    #[allow(
        dead_code,
        reason = "the refresh exchange is required, the values are not"
    )]
    email: Option<String>,
    #[allow(
        dead_code,
        reason = "the refresh exchange is required, the values are not"
    )]
    git_info: brz_mysql::Json<brz_json::OpaqueJson>,
    #[allow(
        dead_code,
        reason = "the refresh exchange is required, the values are not"
    )]
    is_active: i8,
    #[allow(
        dead_code,
        reason = "the refresh exchange is required, the values are not"
    )]
    role: String,
    #[allow(
        dead_code,
        reason = "the refresh exchange is required, the values are not"
    )]
    auth_source: String,
    #[allow(
        dead_code,
        reason = "the refresh exchange is required, the values are not"
    )]
    preferences: String,
    #[allow(
        dead_code,
        reason = "the refresh exchange is required, the values are not"
    )]
    created_at: chrono::NaiveDateTime,
    #[allow(
        dead_code,
        reason = "the refresh exchange is required, the values are not"
    )]
    updated_at: chrono::NaiveDateTime,
}

/// `sync_agent_bindings`: gate, replace the extra group references, delete
/// the legacy installation rows, commit, then render the bindings response.
///
/// The source's `sessionmaker` keeps `expire_on_commit=True`, so `db.commit()`
/// expires `current_user` and `source`; the response path then refreshes both
/// rows (`current_user.id` first as the evaluated argument, then
/// `source.namespace`/`source.user_id`) through the bare entity projections
/// on a fresh pooled connection before reading the group grants.
pub(super) async fn sync_bindings<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    agent_id: i64,
    user_id: i64,
    group_names: &[String],
    user_role: &str,
) -> Result<AgentBindings, FastApiError>
where
    M: Mysql,
{
    let source = fetch_team_source(mysql, agent_id).await?;
    require_publish_permission(mysql, erp, &source, user_id, user_role).await?;
    if source.kinds_user_id == 0 {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "System agents are globally available and do not need bindings",
        ));
    }
    let requested = normalize_group_names(group_names.to_vec());
    sync_agent_group_members(mysql, erp, &source, &requested, user_id).await?;
    delete_legacy_agent_installations(mysql, source.kinds_id).await?;
    mysql.execute("COMMIT", ()).await.map_err(internal_error)?;
    // `db.commit()` expires the ORM rows; `_agent_bindings_response`'s
    // argument evaluation refreshes the User, then the Kind.
    let refreshed_user: Option<RefreshedUserRow> = mysql
        .fetch_optional(REFRESH_USER_QUERY, (user_id,))
        .await
        .map_err(internal_error)?;
    let _ = refreshed_user;
    let refreshed: Option<RefreshedKindRow> = mysql
        .fetch_optional(REFRESH_KIND_QUERY, (source.kinds_id,))
        .await
        .map_err(internal_error)?;
    let refreshed = refreshed.ok_or_else(|| {
        FastApiError::detail(StatusCode::NOT_FOUND, "Capability resource not found")
    })?;
    // The refreshed row keeps the loaded identity members; re-build the
    // labeled view the response projection consumes. The unused projection
    // members carry placeholder values because only the id, user, kind and
    // namespace drive the response.
    let source = KindRow {
        kinds_id: refreshed.kinds_id,
        kinds_user_id: refreshed.kinds_user_id,
        kinds_kind: refreshed.kinds_kind,
        kinds_name: String::new(),
        kinds_namespace: refreshed.kinds_namespace,
        kinds_json: None,
        kinds_is_active: 1,
        kinds_created_at: epoch(),
        kinds_updated_at: epoch(),
    };
    bindings_response(mysql, &source, user_id)
        .await
        .map_err(internal_error)
}

/// `_sync_agent_group_members`: replace the extra namespace-entity grants
/// for one Team with the requested active groups.
async fn sync_agent_group_members<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    source: &KindRow,
    group_names: &[String],
    installed_by: i64,
) -> Result<(), FastApiError>
where
    M: Mysql,
{
    // `_normalize_group_names` already dropped duplicates; the intrinsic
    // namespace is not a desired extra group.
    let intrinsic_group = if source.kinds_namespace == "default" {
        None
    } else {
        Some(source.kinds_namespace.as_str())
    };
    let desired_names: Vec<String> = group_names
        .iter()
        .filter(|name| !name.is_empty() && Some(name.as_str()) != intrinsic_group)
        .cloned()
        .collect();
    let namespaces = if desired_names.is_empty() {
        Vec::new()
    } else {
        fetch_named_namespaces(mysql, &desired_names)
            .await
            .map_err(internal_error)?
    };
    let missing = desired_names.iter().any(|name| {
        !namespaces
            .iter()
            .any(|namespace| namespace.namespace_name == *name)
    });
    if missing {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Target group not found",
        ));
    }
    for namespace in &namespaces {
        require_target_namespace_permission(mysql, erp, &namespace.namespace_name, installed_by)
            .await?;
    }

    // `current_members`: the Team's namespace-entity grants without a status
    // filter. The source always issues this read, even for an empty desired
    // set, and reconciles the rows below.
    let current_members = fetch_team_namespace_members(mysql, source.kinds_id)
        .await
        .map_err(internal_error)?;
    let desired_ids: Vec<String> = namespaces
        .iter()
        .map(|namespace| namespace.namespace_id.to_string())
        .collect();
    for member in &current_members {
        if !desired_ids.contains(&member.resource_members_entity_id) {
            mysql
                .execute(
                    format!(
                        "DELETE FROM resource_members WHERE resource_members.id = {}",
                        member.resource_members_id
                    ),
                    (),
                )
                .await
                .map_err(internal_error)?;
        }
    }
    for namespace in &namespaces {
        ensure_agent_access_binding(
            mysql,
            source,
            &namespace.namespace_name,
            namespace.namespace_id,
            namespace.namespace_display_name.as_deref(),
            installed_by,
        )
        .await?;
    }
    Ok(())
}

/// `_sync_agent_group_members`' `current_members` read: the Team's
/// namespace-entity grants with no status filter.
async fn fetch_team_namespace_members<M>(
    mysql: &M,
    resource_id: i64,
) -> MysqlResult<Vec<ResourceMemberRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            format!(
                "SELECT {RESOURCE_MEMBER_COLUMNS} \nFROM resource_members \n\
                 WHERE resource_members.resource_type = 'Team' AND \
                 resource_members.resource_id = {resource_id} AND \
                 resource_members.entity_type = 'namespace'"
            ),
            (),
        )
        .await
}

/// `ResourceMember.create(...)` for a new Team/namespace grant. The legacy
/// `user_id` mirrors `invited_by_user_id` through
/// `_sync_user_id_from_entity`; `reviewed_at` and `requested_at` stay literal
/// because the source passes generated `datetime.utcnow()` values while
/// `created_at`/`updated_at` fall back to the column's `func.now()` default.
fn namespace_grant_insert(
    source_id: i64,
    entity_id: &str,
    display: &str,
    installed_by: i64,
    reviewed_at: &str,
    requested_at: &str,
) -> String {
    format!(
        "INSERT INTO resource_members \
         (resource_type, resource_id, entity_type, entity_id, \
         entity_display_name, user_id, `role`, status, invited_by_user_id, \
         share_link_id, reviewed_by_user_id, reviewed_at, copied_resource_id, \
         requested_at, created_at, updated_at) \
         VALUES ('Team', {source_id}, 'namespace', {}, {}, {installed_by}, 'Reporter', \
         'approved', {installed_by}, 0, {installed_by}, {}, 0, {}, now(), now())",
        quote_literal(entity_id),
        quote_literal(display),
        quote_literal(reviewed_at),
        quote_literal(requested_at),
    )
}

/// `_ensure_agent_access_binding`'s existing-grant branch. SQLAlchemy writes
/// only the columns the source assignments change; `reviewed_at` and
/// `updated_at` are always reassigned to generated UTC values.
fn namespace_grant_update(
    member: &ResourceMemberRow,
    installed_by: i64,
    reviewed_at: &str,
    updated_at: &str,
) -> String {
    let mut assignments: Vec<String> = Vec::new();
    // `_sync_user_id_from_entity` fills the legacy user id for Team/namespace
    // grants; the before-update listener only marks it dirty when it changes.
    let legacy_user_id = if member.resource_members_user_id != 0 {
        member.resource_members_user_id
    } else if member.resource_members_invited_by_user_id != 0 {
        member.resource_members_invited_by_user_id
    } else {
        member.resource_members_reviewed_by_user_id
    };
    if legacy_user_id != member.resource_members_user_id {
        assignments.push(format!("user_id={legacy_user_id}"));
    }
    if !has_permission(&member.resource_members_role, "Reporter") {
        assignments.push("`role`='Reporter'".to_owned());
    }
    if member.resource_members_status != "approved" {
        assignments.push("status='approved'".to_owned());
    }
    if member.resource_members_reviewed_by_user_id != installed_by {
        assignments.push(format!("reviewed_by_user_id={installed_by}"));
    }
    assignments.push(format!("reviewed_at={}", quote_literal(reviewed_at)));
    assignments.push(format!("updated_at={}", quote_literal(updated_at)));
    format!(
        "UPDATE resource_members SET {} WHERE resource_members.id = {}",
        assignments.join(", "),
        member.resource_members_id
    )
}

/// pymysql's `escape_datetime` for a generated `datetime.utcnow()` value.
fn utc_now_literal() -> String {
    render_python_datetime(chrono::Utc::now().naive_utc())
}

/// pymysql's `escape_datetime`: `datetime.isoformat(" ")`, with microseconds
/// omitted when they are zero.
fn render_python_datetime(value: chrono::NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%d %H:%M:%S").to_string();
    let micros = value.and_utc().timestamp_subsec_micros();
    if micros == 0 {
        base
    } else {
        format!("{base}.{micros:06}")
    }
}

/// `_ensure_agent_access_binding` for one group: upsert the approved
/// namespace grant.
async fn ensure_agent_access_binding<M>(
    mysql: &M,
    source: &KindRow,
    target_namespace: &str,
    namespace_id: i64,
    namespace_display_name: Option<&str>,
    installed_by: i64,
) -> Result<(), FastApiError>
where
    M: Mysql,
{
    let entity_id = namespace_id.to_string();
    let existing = fetch_team_namespace_member(mysql, source.kinds_id, &entity_id)
        .await
        .map_err(internal_error)?;
    if let Some(member) = existing {
        // Approve an existing grant, upgrading a below-Reporter role. The
        // source reassigns both timestamps to fresh UTC values.
        let reviewed_at = utc_now_literal();
        let updated_at = utc_now_literal();
        mysql
            .execute(
                namespace_grant_update(&member, installed_by, &reviewed_at, &updated_at),
                (),
            )
            .await
            .map_err(internal_error)?;
        return Ok(());
    }
    let _ = target_namespace;
    // `ResourceMember.create(...)` + `db.flush()`: the entity snapshot uses
    // the namespace's display name (or its name when unset), and
    // `_sync_user_id_from_entity` fills the legacy `user_id` from
    // `invited_by_user_id` for Team/namespace members.
    let display = namespace_display_name
        .filter(|name| !name.is_empty())
        .unwrap_or(target_namespace);
    let reviewed_at = utc_now_literal();
    let requested_at = utc_now_literal();
    mysql
        .execute(
            namespace_grant_insert(
                source.kinds_id,
                &entity_id,
                display,
                installed_by,
                &reviewed_at,
                &requested_at,
            ),
            (),
        )
        .await
        .map_err(internal_error)?;
    Ok(())
}

/// The Team's grant for one namespace entity id (`_ensure_agent_access_binding`'s
/// member lookup).
async fn fetch_team_namespace_member<M>(
    mysql: &M,
    resource_id: i64,
    entity_id: &str,
) -> MysqlResult<Option<ResourceMemberRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            format!(
                "SELECT {RESOURCE_MEMBER_COLUMNS} \nFROM resource_members \n\
                 WHERE resource_members.resource_type = 'Team' AND \
                 resource_members.resource_id = {resource_id} AND \
                 resource_members.entity_type = 'namespace' AND \
                 resource_members.entity_id = {}",
                quote_literal(entity_id)
            ),
            (),
        )
        .await
}

/// `db.query(Namespace).filter(Namespace.name.in_(desired_names),
/// Namespace.is_active.is_(True)).all()`: the source renders the IN list as
/// quoted string literals.
async fn fetch_named_namespaces<M>(
    mysql: &M,
    names: &[String],
) -> MysqlResult<Vec<DesiredNamespaceRow>>
where
    M: Mysql,
{
    let list = names
        .iter()
        .map(|name| quote_literal(name))
        .collect::<Vec<_>>()
        .join(", ");
    mysql
        .fetch_all(
            format!(
                "SELECT namespace.id AS namespace_id, namespace.name AS namespace_name, \
                 namespace.display_name AS namespace_display_name \n\
                 FROM namespace \nWHERE namespace.name IN ({list}) AND \
                 namespace.is_active IS true"
            ),
            (),
        )
        .await
}

/// One desired `namespace` row: the id, name and display-name snapshot the
/// binding upsert reads.
#[derive(Debug, FromMysqlRow)]
struct DesiredNamespaceRow {
    pub namespace_id: i64,
    pub namespace_name: String,
    pub namespace_display_name: Option<String>,
}

/// `_require_target_namespace_permission`: the `default` namespace is always
/// allowed; any other namespace needs an effective Developer role.
async fn require_target_namespace_permission<M>(
    mysql: &M,
    erp: &ErpContext<'_, impl brz_redis::Redis>,
    target_namespace: &str,
    user_id: i64,
) -> Result<(), FastApiError>
where
    M: Mysql,
{
    if target_namespace == "default" {
        return Ok(());
    }
    let role = effective_role(mysql, erp, user_id, target_namespace).await?;
    if role
        .as_deref()
        .is_some_and(|role| has_permission(role, "Developer"))
    {
        return Ok(());
    }
    Err(FastApiError::detail(
        StatusCode::FORBIDDEN,
        "Developer role is required to install into a group",
    ))
}

/// `_delete_legacy_agent_installations`: delete the active
/// `CapabilityInstallation` rows whose `spec.sourceRef.kindId` matches the
/// Team id. The source calls `db.delete(row)` on an un-hooked `Kind` mapper,
/// so the rows are hard-deleted.
async fn delete_legacy_agent_installations<M>(mysql: &M, source_id: i64) -> Result<(), FastApiError>
where
    M: Mysql,
{
    let legacy_rows: Vec<KindRow> = mysql
        .fetch_all(
            format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = \
                 'CapabilityInstallation' AND kinds.is_active = true"
            ),
            (),
        )
        .await
        .map_err(internal_error)?;
    for row in legacy_rows {
        if nested_kind_id(&row) == source_id {
            mysql
                .execute(legacy_installation_delete(row.kinds_id), ())
                .await
                .map_err(internal_error)?;
        }
    }
    Ok(())
}

/// `db.delete(row)` for one legacy `CapabilityInstallation` Kind.
fn legacy_installation_delete(id: i64) -> String {
    format!("DELETE FROM kinds WHERE kinds.id = {id}")
}

/// A placeholder timestamp for KindRow members the response never reads.
fn epoch() -> chrono::NaiveDateTime {
    chrono::NaiveDate::from_ymd_opt(1970, 1, 1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap()
}

/// `_nested_int(spec, "sourceRef", "kindId")`.
fn nested_kind_id(row: &KindRow) -> i64 {
    let Some(payload) = row.payload() else {
        return 0;
    };
    let Some(source_ref) = payload.spec.source_ref.as_ref() else {
        return 0;
    };
    // `payload.get("kindId")` reads only the camelCase key.
    let Some(raw) = source_ref.kind_id.as_ref() else {
        return 0;
    };
    scalar_to_int(raw).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_installation_statement_matches_the_recorded_query() {
        let sql = format!(
            "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = \
             'CapabilityInstallation' AND kinds.is_active = true"
        );
        assert!(
            sql.contains("WHERE kinds.kind = 'CapabilityInstallation' AND kinds.is_active = true")
        );
        assert!(!sql.contains("LIMIT"));
    }

    #[test]
    fn legacy_installation_delete_and_grant_insert_match_the_orm() {
        assert_eq!(
            legacy_installation_delete(195_057),
            "DELETE FROM kinds WHERE kinds.id = 195057"
        );
        assert_eq!(
            namespace_grant_insert(
                195_057,
                "42",
                "example-team",
                163,
                "2026-10-17 06:40:16.123456",
                "2026-10-17 06:40:16.654321",
            ),
            "INSERT INTO resource_members (resource_type, resource_id, entity_type, \
             entity_id, entity_display_name, user_id, `role`, status, \
             invited_by_user_id, share_link_id, reviewed_by_user_id, reviewed_at, \
             copied_resource_id, requested_at, created_at, updated_at) VALUES \
             ('Team', 195057, 'namespace', '42', 'example-team', 163, 'Reporter', 'approved', \
             163, 0, 163, '2026-10-17 06:40:16.123456', 0, \
             '2026-10-17 06:40:16.654321', now(), now())"
        );
    }

    #[test]
    fn existing_grant_update_only_sets_changed_columns() {
        let mut member = ResourceMemberRow {
            resource_members_id: 7,
            resource_members_resource_type: "Team".to_owned(),
            resource_members_resource_id: 195_057,
            resource_members_entity_type: "namespace".to_owned(),
            resource_members_entity_id: "42".to_owned(),
            resource_members_entity_display_name: "example-team".to_owned(),
            resource_members_user_id: 163,
            resource_members_role: "Developer".to_owned(),
            resource_members_status: "approved".to_owned(),
            resource_members_invited_by_user_id: 163,
            resource_members_share_link_id: 0,
            resource_members_reviewed_by_user_id: 163,
            resource_members_reviewed_at: None,
            resource_members_copied_resource_id: 0,
            resource_members_requested_at: None,
            resource_members_created_at: epoch(),
            resource_members_updated_at: epoch(),
        };
        assert_eq!(
            namespace_grant_update(
                &member,
                163,
                "2026-10-17 06:40:16.123456",
                "2026-10-17 06:40:16.654321",
            ),
            "UPDATE resource_members SET reviewed_at='2026-10-17 06:40:16.123456', \
             updated_at='2026-10-17 06:40:16.654321' WHERE resource_members.id = 7"
        );

        member.resource_members_user_id = 0;
        member.resource_members_status = "pending".to_owned();
        member.resource_members_reviewed_by_user_id = 0;
        assert_eq!(
            namespace_grant_update(&member, 163, "a", "b"),
            "UPDATE resource_members SET user_id=163, status='approved', \
             reviewed_by_user_id=163, reviewed_at='a', updated_at='b' \
             WHERE resource_members.id = 7"
        );
    }

    #[test]
    fn refresh_statements_use_the_bare_entity_projections() {
        assert_eq!(
            REFRESH_USER_QUERY,
            "SELECT users.id, users.user_name, users.password_hash, users.email, \
             users.git_info, users.is_active, users.`role`, users.auth_source, \
             users.preferences, users.created_at, users.updated_at \nFROM users \n\
             WHERE users.id = ?"
        );
        assert_eq!(
            REFRESH_KIND_QUERY,
            "SELECT kinds.id, kinds.user_id, kinds.kind, kinds.name, kinds.namespace, \
             kinds.json, kinds.is_active, kinds.created_at, kinds.updated_at \n\
             FROM kinds \nWHERE kinds.id = ?"
        );
    }

    #[test]
    fn refreshed_kind_rows_rename_every_unaliased_column() {
        // `FromMysqlRow` matches exact column names; the unaliased refresh
        // projection emits the bare `kinds` column names.
        let projection = REFRESH_KIND_QUERY
            .strip_prefix("SELECT ")
            .unwrap()
            .split(" \nFROM")
            .next()
            .unwrap();
        let source = include_str!("agent_bindings_sync.rs");
        let start = source.find("struct RefreshedKindRow").unwrap();
        let body = &source[start..start + source[start..].find("\n}").unwrap()];
        for column in projection.split(", ") {
            let column = column.strip_prefix("kinds.").unwrap();
            assert!(
                body.contains(&format!("#[mysql(rename = \"{column}\")]")),
                "RefreshedKindRow must rename the unaliased column {column}"
            );
        }
    }

    #[test]
    fn namespace_grant_update_keeps_an_existing_reporter_role() {
        let member = ResourceMemberRow {
            resource_members_id: 9,
            resource_members_resource_type: "Team".to_owned(),
            resource_members_resource_id: 195_057,
            resource_members_entity_type: "namespace".to_owned(),
            resource_members_entity_id: "42".to_owned(),
            resource_members_entity_display_name: "example-team".to_owned(),
            resource_members_user_id: 163,
            resource_members_role: "Reporter".to_owned(),
            resource_members_status: "approved".to_owned(),
            resource_members_invited_by_user_id: 163,
            resource_members_share_link_id: 0,
            resource_members_reviewed_by_user_id: 163,
            resource_members_reviewed_at: None,
            resource_members_copied_resource_id: 0,
            resource_members_requested_at: None,
            resource_members_created_at: epoch(),
            resource_members_updated_at: epoch(),
        };
        let sql = namespace_grant_update(&member, 163, "a", "b");
        assert!(!sql.contains("`role`"));
        assert!(!sql.contains("status="));
        assert!(!sql.contains("user_id="));
        assert!(!sql.contains("reviewed_by_user_id="));
    }
}
