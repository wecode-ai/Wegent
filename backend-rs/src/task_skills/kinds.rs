// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Team resolution for `GET /api/tasks/{task_id}/skills`.
//!
//! The implementation follows the open-source reader contract and performs
//! direct SQL reads.
use super::repository as repo;
use super::repository::KindRow;
use brz_mysql::Mysql;
use brz_redis::Redis;

/// The provider a store without ERP context resolves entity bindings with
/// (no memberships), matching an unavailable employee directory.
static NOOP_ERP: crate::erp_provider::NoopErpProvider = crate::erp_provider::NoopErpProvider;

/// Team resolution through the public SQL readers.
pub struct KindCacheStore<'a, M: Mysql, R: Redis = brz_redis::RedisService> {
    pub mysql: &'a M,
    pub redis: Option<&'a R>,
    /// ERP employee directory for the native group-role pass of
    /// `TeamShareService.check_permission`.
    pub erp: Option<&'a dyn crate::erp_provider::ErpProvider<R>>,
    /// Registered entity resolvers for `check_entity_permission`'s entity
    /// pass (`namespace`, then any configured external entity type).
    pub resolvers: Option<&'a crate::permissions::EntityResolvers<R>>,
}

impl<M: Mysql, R: Redis> KindCacheStore<'_, M, R> {
    /// `batch_load_kinds_by_refs` (`app.services.kind_ref_resolver`): the
    /// default-namespace refs load personal rows first, then the still
    /// missing ones fall back to public rows; group refs load by namespace.
    /// The returned rows keep the database order (the source indexes them
    /// by `(namespace, name)`).
    pub async fn batch_load_kinds_by_refs(
        &self,
        user_id: i64,
        kind: &str,
        refs: &[(String, String)],
    ) -> Result<Vec<KindRow>, brz_mysql::MysqlError> {
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        let mut loaded: Vec<KindRow> = Vec::new();
        let mut default_refs: Vec<(String, String)> = Vec::new();
        let mut group_refs: Vec<(String, String)> = Vec::new();
        for (namespace, name) in refs {
            if namespace == "default" {
                if !default_refs.contains(&(namespace.clone(), name.clone())) {
                    default_refs.push((namespace.clone(), name.clone()));
                }
            } else if !group_refs.contains(&(namespace.clone(), name.clone())) {
                group_refs.push((namespace.clone(), name.clone()));
            }
        }
        if !default_refs.is_empty() && user_id != 0 {
            loaded.extend(repo::kinds_by_names(self.mysql, user_id, kind, &default_refs).await?);
        }
        let resolved: std::collections::HashSet<(String, String)> = loaded
            .iter()
            .map(|row| (row.kinds_namespace.clone(), row.kinds_name.clone()))
            .collect();
        let missing: Vec<(String, String)> = default_refs
            .into_iter()
            .filter(|r| !resolved.contains(r))
            .collect();
        if !missing.is_empty() {
            loaded.extend(repo::public_kinds_by_names(self.mysql, kind, &missing).await?);
        }
        if !group_refs.is_empty() {
            loaded.extend(repo::group_kinds_by_names(self.mysql, kind, &group_refs).await?);
        }
        Ok(loaded)
    }

    /// `_get_team` for the `default` namespace: personal -> shared teams ->
    /// share-permission candidates -> public. Non-default namespaces use
    /// the group-team branch.
    pub async fn resolve_team(
        &self,
        user_id: i64,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRow>, brz_mysql::MysqlError> {
        if namespace != "default" {
            return self.group_team(user_id, namespace, name).await;
        }

        // 1. The user's own Team.
        if user_id != 0 {
            if let Some(row) = repo::team_personal(self.mysql, user_id, namespace, name).await? {
                return Ok(Some(row));
            }

            // 2. Teams shared directly to the user.
            let shared_ids = repo::shared_team_ids(self.mysql, user_id).await?;
            if !shared_ids.is_empty()
                && let Some(team) =
                    repo::team_by_shared_ids(self.mysql, &shared_ids, namespace, name).await?
            {
                return Ok(Some(team));
            }

            // 3. Entity-derived sharing: every other owner's active Team
            //    with the name, newest first, each checked with
            //    `team_share_service.check_permission` (direct member row,
            //    entity bindings through the registered resolvers, then the
            //    native group-role pass).
            let candidates =
                repo::shared_team_candidates(self.mysql, user_id, namespace, name).await?;
            for candidate in &candidates {
                if self
                    .team_share_permission(candidate.kinds_id, user_id)
                    .await?
                {
                    return Ok(Some(candidate.clone()));
                }
            }
        }

        // 4. Public team (user_id = 0).
        repo::team_public(self.mysql, namespace, name).await
    }

    /// `TeamShareService.check_permission`: the direct member row's
    /// effective role, then the entity bindings through the registered
    /// resolvers, then the native group-role pass for non-default
    /// namespaces. `get_effective_role` defaults an empty role to Reporter.
    async fn team_share_permission(
        &self,
        team_id: i64,
        user_id: i64,
    ) -> Result<bool, brz_mysql::MysqlError> {
        // `UnifiedShareService.check_permission`: direct member row first.
        if let Some(role) = repo::team_share_member_row(self.mysql, team_id, user_id).await? {
            let effective = if role.is_empty() {
                "Reporter"
            } else {
                role.as_str()
            };
            // A matched member row decides the whole check in the source
            // (`if member: return has_permission(...)`); the entity fallback
            // only runs when no member row matched.
            return Ok(reporter_or_above(effective));
        }

        // `check_entity_permission`: the entity bindings, matched through
        // the registered resolvers in first-appearance order.
        let entity_rows = repo::team_share_entity_rows(self.mysql, team_id).await?;
        if self.entity_permission(user_id, &entity_rows).await? {
            return Ok(true);
        }

        // The native group-role pass only applies to non-default namespaces.
        if let Some(namespace) = repo::team_share_active_team(self.mysql, team_id).await?
            && namespace != "default"
            && let Some(erp) = self.erp
        {
            let role = crate::skills::skills_unified::effective_role_in_group(
                self.mysql,
                &crate::teams::group_membership::ErpContext {
                    erp,
                    redis: self.redis,
                },
                i32::try_from(user_id).unwrap_or(i32::MAX),
                &namespace,
            )
            .await;
            if let Ok(Some(role)) = role
                && reporter_or_above(&role)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `UnifiedShareService.check_entity_permission`: group the approved
    /// non-user bindings by entity type (first-appearance order), match each
    /// group through its registered resolver, and accept when a matched
    /// binding's role clears Reporter.
    async fn entity_permission(
        &self,
        user_id: i64,
        rows: &[(String, String, Option<String>)],
    ) -> Result<bool, brz_mysql::MysqlError> {
        let Some(resolvers) = self.resolvers else {
            return Ok(false);
        };
        // Group by entity type preserving first-appearance order
        // (`defaultdict` iteration in the source).
        type EntityEntry<'a> = &'a (String, String, Option<String>);
        let mut order: Vec<String> = Vec::new();
        let mut groups: std::collections::HashMap<&str, Vec<EntityEntry<'_>>> =
            std::collections::HashMap::new();
        for row in rows {
            if !row.0.is_empty() && !row.1.is_empty() {
                groups.entry(row.0.as_str()).or_insert_with(|| {
                    order.push(row.0.clone());
                    Vec::new()
                });
                groups
                    .get_mut(row.0.as_str())
                    .expect("entry was just inserted")
                    .push(row);
            }
        }
        for entity_type in order {
            let entries = &groups[entity_type.as_str()];
            let ids = entries.iter().map(|row| row.1.clone()).collect::<Vec<_>>();
            let matched = resolvers
                .match_bindings(
                    self.redis,
                    user_id,
                    &entity_type,
                    &ids,
                    crate::permissions::ResolutionPurpose::ResourceAccess,
                )
                .await?;
            let matched_set: std::collections::HashSet<&str> =
                matched.iter().map(String::as_str).collect();
            for (_, entity_id, role) in entries {
                if matched_set.contains(entity_id.as_str())
                    && let Some(role) = role
                    && !role.is_empty()
                    && reporter_or_above(role)
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// The group-team branch (`_get_team` for non-default namespaces): the
    /// group index and data document, then the namespace-visibility and
    /// membership checks, then the share-permission fallback.
    async fn group_team(
        &self,
        user_id: i64,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRow>, brz_mysql::MysqlError> {
        let Some(team) = repo::team_group(self.mysql, namespace, name).await? else {
            return Ok(None);
        };
        // A public namespace grants access.
        if self.group_is_public(namespace).await? {
            return Ok(Some(team));
        }
        // Any approved group membership admits the member.
        if user_id != 0 && self.group_member_role(namespace, user_id).await?.is_some() {
            return Ok(Some(team));
        }
        // `team_share_service.check_permission(team.id, user_id, Reporter)`.
        if user_id != 0 && self.team_share_permission(team.kinds_id, user_id).await? {
            return Ok(Some(team));
        }
        Ok(None)
    }

    async fn group_is_public(&self, namespace: &str) -> Result<bool, brz_mysql::MysqlError> {
        let row = repo::namespace_by_name(self.mysql, namespace).await?;
        Ok(row.is_some_and(|row| row.namespace_visibility == "public"))
    }

    async fn group_member_role(
        &self,
        namespace: &str,
        user_id: i64,
    ) -> Result<Option<String>, brz_mysql::MysqlError> {
        crate::skills::skills_unified::direct_member_role(
            self.mysql,
            i32::try_from(user_id).unwrap_or(i32::MAX),
            namespace,
        )
        .await
    }

    /// `group_permission.get_effective_role_in_group`: direct membership,
    /// entity-derived memberships resolved through the registered resolvers,
    /// then parent-group inheritance.
    pub async fn effective_role_in_group(
        &self,
        user_id: i64,
        group_name: &str,
    ) -> Result<Option<String>, brz_mysql::MysqlError> {
        crate::skills::skills_unified::effective_role_in_group(
            self.mysql,
            &self.erp_context(),
            i32::try_from(user_id).unwrap_or(i32::MAX),
            group_name,
        )
        .await
    }

    /// `skill_binding_service.list_group_skill_ids`: the Reporter role gate
    /// over `list_group_skill_ids_for_authorized_namespaces`.
    pub async fn list_group_skill_ids(
        &self,
        group_namespace: &str,
        user_id: i64,
    ) -> Result<Vec<i64>, brz_mysql::MysqlError> {
        if !self
            .has_group_reporter_role(group_namespace, user_id)
            .await?
        {
            return Ok(Vec::new());
        }
        let ids = crate::skills::skills_unified::group_skill_ids_for_namespaces(
            self.mysql,
            &[group_namespace.to_owned()],
        )
        .await?;
        let mut ids: Vec<i64> = ids.into_iter().map(i64::from).collect();
        ids.sort_unstable();
        Ok(ids)
    }

    /// `skill_binding_service.list_group_bindings`: the Reporter role gate
    /// over the group namespace's active SkillBinding rows, newest first.
    pub async fn list_group_bindings(
        &self,
        group_namespace: &str,
        user_id: i64,
    ) -> Result<Vec<KindRow>, brz_mysql::MysqlError> {
        if !self
            .has_group_reporter_role(group_namespace, user_id)
            .await?
        {
            return Ok(Vec::new());
        }
        repo::group_bindings(self.mysql, group_namespace).await
    }

    /// `has_permission(role, GroupRole.Reporter)` over the effective role.
    async fn has_group_reporter_role(
        &self,
        group_namespace: &str,
        user_id: i64,
    ) -> Result<bool, brz_mysql::MysqlError> {
        Ok(self
            .effective_role_in_group(user_id, group_namespace)
            .await?
            .as_deref()
            .is_some_and(reporter_or_above))
    }

    /// The ERP context for the group-role passes. `runtime-check` builds its
    /// store without a provider; the no-op provider resolves no entity
    /// bindings, which matches an unavailable directory.
    fn erp_context(&self) -> crate::teams::group_membership::ErpContext<'_, R> {
        crate::teams::group_membership::ErpContext {
            erp: self.erp.unwrap_or(&NOOP_ERP),
            redis: self.redis,
        }
    }
}

/// `has_permission(role, MemberRole.Reporter)`: the role hierarchy from
/// `app.schemas.base_role` (lower rank is more privileged).
fn reporter_or_above(role: &str) -> bool {
    fn rank(role: &str) -> Option<u8> {
        match role {
            "Owner" => Some(0),
            "Maintainer" => Some(1),
            "Developer" => Some(2),
            "Reporter" => Some(3),
            "RestrictedAnalyst" => Some(4),
            _ => None,
        }
    }
    rank(role).is_some_and(|level| level <= 3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reporter_gate_admits_reporter_and_above() {
        for role in ["Owner", "Maintainer", "Developer", "Reporter"] {
            assert!(reporter_or_above(role));
        }
        assert!(!reporter_or_above("RestrictedAnalyst"));
    }
}
