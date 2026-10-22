// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `collect_external_entity_member_roles`
//! (`app.services.knowledge.knowledge_visibility_query`), the
//! extension-entity pass of `build_direct_access_query_context`.
//!
//! For each registered external entity type it resolves the KnowledgeBase
//! resource ids bound to the user's entities and then re-matches those bindings
//! to collect the roles. The endpoint passes `candidate_ids=None`, so the
//! candidate filter is never applied.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

use crate::knowledge_bases_all_grouped::{APPROVED_STATUSES, KB_RESOURCE_TYPES, quote_literal};
use crate::permissions::{EntityResolvers, ResolutionPurpose};

/// The external-entity role map, insertion-ordered:
/// `resource_id -> list of role strings`.
#[derive(Debug, Default)]
pub(crate) struct ExternalMemberRoles {
    pub(crate) role_map: Vec<(i64, Vec<String>)>,
}

impl ExternalMemberRoles {
    /// `context.external_member_role_map` keys in insertion order, matching
    /// `_shared_access_condition`'s `Kind.id.in_(tuple(role_map))`.
    pub(crate) fn kb_ids(&self) -> Vec<i64> {
        self.role_map.iter().map(|(id, _)| *id).collect()
    }
}

/// `collect_external_entity_member_roles(db, user_id, candidate_ids=None)`.
pub(crate) async fn collect_external_entity_member_roles<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
) -> MysqlResult<ExternalMemberRoles>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let mut role_map: Vec<(i64, Vec<String>)> = Vec::new();
    // `get_all_entity_types()` minus the `{"namespace", "user"}` defaults.
    for entity_type in resolvers.external_types() {
        let resource_ids =
            get_resource_ids_by_entity_kb(mysql, redis, resolvers, user_id, entity_type).await?;
        if resource_ids.is_empty() {
            continue;
        }
        let rows = external_member_rows(mysql, entity_type, &resource_ids).await?;
        let entity_ids: Vec<String> = rows
            .iter()
            .map(|row| row.resource_members_entity_id.clone())
            .filter(|id| !id.is_empty())
            .collect();
        let matched = resolvers
            .match_bindings(
                redis,
                user_id,
                entity_type,
                &entity_ids,
                ResolutionPurpose::ResourceAccess,
            )
            .await?;
        for row in &rows {
            if !matched.contains(&row.resource_members_entity_id) {
                continue;
            }
            let role = if row.resource_members_role.is_empty() {
                "Reporter".to_string()
            } else {
                row.resource_members_role.clone()
            };
            match role_map
                .iter_mut()
                .find(|(id, _)| *id == row.resource_members_resource_id)
            {
                Some((_, roles)) => roles.push(role),
                None => role_map.push((row.resource_members_resource_id, vec![role])),
            }
        }
    }
    Ok(ExternalMemberRoles { role_map })
}

/// `resolver.get_resource_ids_by_entity(db, user_id, entity_type)` with the
/// resolver default `resource_type="KnowledgeBase"`: distinct entity ids bound
/// to KnowledgeBase resources, matched through the membership check, then the
/// matching resource ids.
async fn get_resource_ids_by_entity_kb<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    entity_type: &str,
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let dept_ids = distinct_kb_external_entities(mysql, entity_type).await?;
    if dept_ids.is_empty() {
        return Ok(Vec::new());
    }
    let matched = resolvers
        .match_bindings(
            redis,
            user_id,
            entity_type,
            &dept_ids,
            ResolutionPurpose::ResourceAccess,
        )
        .await?;
    if matched.is_empty() {
        return Ok(Vec::new());
    }
    kb_ids_for_external_entities(mysql, entity_type, &matched).await
}

/// `ErpEntityResolver.get_resource_ids_by_entity` step 1
/// (`ResourceMember.entity_id` distinct, `resource_type` scalar equality).
async fn distinct_kb_external_entities<M>(mysql: &M, entity_type: &str) -> MysqlResult<Vec<String>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        resource_members_entity_id: String,
    }
    let rows: Vec<Row> = mysql
        .fetch_all(
            &format!(
                "SELECT DISTINCT resource_members.entity_id AS resource_members_entity_id \
                 FROM resource_members WHERE resource_members.resource_type = 'KnowledgeBase' \
                 AND resource_members.entity_type = {} AND resource_members.entity_id IS NOT NULL \
                 AND resource_members.status = 'approved'",
                quote_literal(entity_type),
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_entity_id)
        .collect())
}

/// `list_resources_by_entity_match` for KnowledgeBase resources.
async fn kb_ids_for_external_entities<M>(
    mysql: &M,
    entity_type: &str,
    entity_ids: &[String],
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    if entity_ids.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        resource_members_resource_id: i64,
    }
    let ids = entity_ids
        .iter()
        .map(|id| quote_literal(id))
        .collect::<Vec<_>>()
        .join(", ");
    let rows: Vec<Row> = mysql
        .fetch_all(
            &format!(
                "SELECT DISTINCT resource_members.resource_id AS resource_members_resource_id \
                 FROM resource_members WHERE resource_members.resource_type = 'KnowledgeBase' \
                 AND resource_members.entity_type = {} \
                 AND resource_members.entity_id IN ({ids}) \
                 AND resource_members.status = 'approved'",
                quote_literal(entity_type),
            ),
            (),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| row.resource_members_resource_id)
        .collect())
}

/// `db.query(ResourceMember.resource_id, ResourceMember.entity_id,
/// ResourceMember.role).filter(resource_type IN KB, resource_id IN resource_ids,
/// entity_type == entity_type, status IN approved)`.
async fn external_member_rows<M>(
    mysql: &M,
    entity_type: &str,
    resource_ids: &[i64],
) -> MysqlResult<Vec<ExternalMemberRow>>
where
    M: Mysql,
{
    if resource_ids.is_empty() {
        return Ok(Vec::new());
    }
    let joined = resource_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    mysql
        .fetch_all(
            &format!(
                "SELECT resource_members.resource_id AS resource_members_resource_id, \
                 resource_members.entity_id AS resource_members_entity_id, \
                 resource_members.`role` AS resource_members_role \n\
                 FROM resource_members \n\
                 WHERE resource_members.resource_type IN {KB_RESOURCE_TYPES} \
                 AND resource_members.resource_id IN ({joined}) \
                 AND resource_members.entity_type = {} \
                 AND resource_members.status IN {APPROVED_STATUSES}",
                quote_literal(entity_type),
            ),
            (),
        )
        .await
}

#[derive(Debug, FromMysqlRow)]
struct ExternalMemberRow {
    resource_members_resource_id: i64,
    resource_members_entity_id: String,
    resource_members_role: String,
}
