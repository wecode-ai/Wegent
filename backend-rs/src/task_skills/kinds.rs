// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Team resolution for the task-scoped APIs that consume
//! `kindReader.get_by_name_and_namespace`'s Team branch
//! (`GET /api/tasks/{task_id}/skills`, `GET /api/tasks/{task_id}` and
//! `GET /api/tasks/{task_id}/pipeline-stage-info`).
//!
//! A deployment whose `SERVICE_EXTENSION` configures a Redis client replaces
//! every reader this branch composes with its cached counterpart
//! (`CachedKindReader`, `CachedSharedTeamReader`, `CachedGroupReader`,
//! `CachedGroupMemberReader`), so each step probes its cache document first
//! and only a miss reaches the SQL reader.
use crate::json_compat::python_json_value;
use crate::remote_workspace_tree::error::{ApiError, database_query_failed};
use crate::remote_workspace_tree::kinds::{KindRecord, KindStore};
use crate::request_sql::RequestSql;
use brz_json::OpaqueJson;
use serde_json::Value;

use super::repository as repo;
use super::repository::KindRow;
use brz_mysql::{Mysql, MysqlResult};
use brz_redis::Redis;

/// The cached kind-reader failure mapping: a MySQL failure keeps the driver
/// error (callers with their own mapping reuse it); the read itself has no
/// other failure mode.
fn kind_read_failed(error: ApiError) -> brz_mysql::MysqlError {
    brz_mysql::MysqlError::InvalidQuery {
        reason: format!("kind read failed: {}", error.detail()),
    }
}

/// Cache TTL of the deployment's cached-reader contract.
const CACHE_TTL_SECONDS: u64 = 300;

/// The marker for the cached absence of every document.
const NULL_MARKER: &str = "__NULL__";

/// `app.services.readers.groups.VISIBILITY_PUBLIC`.
const VISIBILITY_PUBLIC: &str = "public";

/// `CachedSharedTeamReader._key_idx_user_teams`: the shared-team list key.
fn shared_team_list_key(user_id: i64) -> String {
    format!("shared_team:v2:idx:user_teams:{user_id}")
}

/// `CachedGroupReader._key_data`: the group document key.
fn group_document_key(namespace: &str) -> String {
    format!("group:v2:data:{namespace}")
}

/// `CachedGroupMemberReader._key_idx_group_user`: the membership-role key.
fn group_member_role_key(namespace: &str, user_id: i64) -> String {
    format!("group_member:v2:idx:group_user:{namespace}:{user_id}")
}

/// One cached-reader document read. The cached readers use the same
/// contract for every document: a Redis failure is a miss, `__NULL__` is a
/// cached absence that must skip the SQL fallback, and any other payload is
/// the stored value (which the caller decodes, treating an undecodable
/// payload as a miss like the source's `except` clauses).
enum CachedEntry {
    Hit(String),
    Negative,
    Miss,
}

/// Read one cached-reader document.
async fn cached_entry<R: Redis>(redis: Option<&R>, key: &str) -> CachedEntry {
    let Some(redis) = redis else {
        return CachedEntry::Miss;
    };
    let value: Option<brz_redis::RedisBytes> = redis
        .get(key)
        .await
        .map_err(|error| {
            tracing::warn!(%error, key = %key, "[team_resolution] redis read failed");
            error
        })
        .ok()
        .flatten();
    let Some(value) = value else {
        return CachedEntry::Miss;
    };
    if value.as_ref() == NULL_MARKER.as_bytes() {
        return CachedEntry::Negative;
    }
    match std::str::from_utf8(value.as_ref()) {
        Ok(text) => CachedEntry::Hit(text.to_owned()),
        Err(_) => CachedEntry::Miss,
    }
}

/// The provider a store without ERP context resolves entity bindings with
/// (no memberships), matching an unavailable employee directory.
static NOOP_ERP: crate::erp_provider::NoopErpProvider = crate::erp_provider::NoopErpProvider;

/// Team resolution through the deployment's reader contract: the cached
/// readers whenever the store has a Redis client, the public SQL readers
/// otherwise.
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
    ///
    /// The personal and public steps go through the deployment's cached
    /// reader (`CachedKindReader.get_personal` / `get_public`): the
    /// `kind:v2` index and data documents decide the outcome, and only a
    /// cache miss queries the `kinds` table. The shared-team list and the
    /// share-permission candidates stay on their SQL readers, exactly like
    /// the source.
    pub async fn resolve_team(
        &self,
        user_id: i64,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRow>, brz_mysql::MysqlError> {
        if namespace != "default" {
            return self.group_team(user_id, namespace, name).await;
        }

        let kinds = self.cached_kinds();

        // 1. The user's own Team.
        if user_id != 0 {
            if let Some(team) = kinds.get_personal_team(user_id, namespace, name).await? {
                return Ok(Some(kind_row(team)));
            }

            // 2. Teams shared directly to the user (the cached list, then
            //    the shared-id row query).
            let shared_ids = self.shared_team_list(user_id).await?;
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
        Ok(kinds.get_public_team(namespace, name).await?.map(kind_row))
    }

    /// [`resolve_team`](Self::resolve_team) on the caller's request SQL
    /// handle: the same cached-reader decision and the same statements, with
    /// every cache miss and every shared-team fallback read issued on `sql`
    /// so the reads join the request's transaction.
    ///
    /// The non-`default` group branch runs the same chain on `sql`: the group
    /// Team read, the namespace visibility fallback and the membership reads
    /// keep the source's transaction membership instead of splitting onto the
    /// pool. Its native group-role pass stays on the pool (see
    /// [`Self::team_share_permission_on`]).
    pub async fn resolve_team_on(
        &self,
        sql: &mut dyn RequestSql,
        user_id: i64,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRow>, brz_mysql::MysqlError> {
        if namespace != "default" {
            return self.group_team_on(sql, user_id, namespace, name).await;
        }

        let kinds = self.cached_kinds();

        // 1. The user's own Team.
        if user_id != 0 {
            if let Some(team) = kinds
                .get_personal_team_on(sql, user_id, namespace, name)
                .await?
            {
                return Ok(Some(kind_row(team)));
            }

            // 2. Teams shared directly to the user (the cached list, then
            //    the shared-id row query).
            let shared_ids = self.shared_team_list_on(sql, user_id).await?;
            if !shared_ids.is_empty()
                && let Some(team) =
                    repo::team_by_shared_ids_on(sql, &shared_ids, namespace, name).await?
            {
                return Ok(Some(team));
            }

            // 3. Entity-derived sharing: every other owner's active Team
            //    with the name, newest first, each checked with
            //    `team_share_service.check_permission`.
            let candidates = repo::shared_team_candidates_on(sql, user_id, namespace, name).await?;
            for candidate in &candidates {
                if self
                    .team_share_permission_on(sql, candidate.kinds_id, user_id)
                    .await?
                {
                    return Ok(Some(candidate.clone()));
                }
            }
        }

        // 4. Public team (user_id = 0).
        Ok(kinds
            .get_public_team_on(sql, namespace, name)
            .await?
            .map(kind_row))
    }

    /// `kindReader.get_by_name_and_namespace`'s Team branch for the
    /// configured reader (`IKindReader._get_team`,
    /// `app/services/readers/kinds.py`): personal -> shared teams ->
    /// share-permission candidates -> public. Returns the resolved Team's id,
    /// the value `resolve_task_ref_team`'s callers consume.
    pub(crate) async fn get_team_id_by_name_and_namespace(
        &self,
        user_id: i64,
        namespace: &str,
        name: &str,
    ) -> Result<Option<i64>, ApiError> {
        Ok(self
            .resolve_team(user_id, namespace, name)
            .await
            .map_err(database_query_failed)?
            .map(|team| team.kinds_id))
    }

    /// `kindReader.get_by_name_and_namespace` for a non-Team kind through the
    /// cached reader: the group read for a non-`default` namespace, else the
    /// personal read with the public fallback (Bot and Ghost support it).
    pub async fn get_by_name_and_namespace_row(
        &self,
        user_id: i64,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> MysqlResult<Option<KindRow>> {
        self.cached_kinds()
            .get_by_name_and_namespace(user_id, kind, namespace, name)
            .await
            .map_err(kind_read_failed)
            .map(|record| record.map(kind_row))
    }

    /// [`get_by_name_and_namespace_row`](Self::get_by_name_and_namespace_row)
    /// on the caller's request SQL handle: a cache miss runs its `kinds` read
    /// on `sql`, and a cache hit issues no statement.
    pub async fn get_by_name_and_namespace_row_on(
        &self,
        sql: &mut dyn RequestSql,
        user_id: i64,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> MysqlResult<Option<KindRow>> {
        self.cached_kinds()
            .get_by_name_and_namespace_on(sql, user_id, kind, namespace, name)
            .await
            .map_err(kind_read_failed)
            .map(|record| record.map(kind_row))
    }

    /// The cached kind reader over the same clients: `None` keeps every read
    /// on the direct SQL path, exactly like the extension's `wrap`.
    fn cached_kinds(&self) -> KindStore<'_, M, R> {
        KindStore {
            mysql: self.mysql,
            redis: self.redis,
        }
    }

    /// `sharedTeamReader.get_shared_team_ids`: the cached user-team list
    /// (`__NULL__` caches an empty list), falling back to the SQL reader and
    /// writing the list back with `SETEX` like `CachedSharedTeamReader`.
    async fn shared_team_list(&self, user_id: i64) -> MysqlResult<Vec<i64>> {
        let key = shared_team_list_key(user_id);
        match cached_entry(self.redis, &key).await {
            CachedEntry::Hit(text) => {
                if let Ok(ids) = serde_json::from_str::<Vec<i64>>(&text) {
                    return Ok(ids);
                }
            }
            CachedEntry::Negative => return Ok(Vec::new()),
            // A missing or undecodable list falls through to the SQL reader.
            CachedEntry::Miss => {}
        }
        let ids = repo::shared_team_ids(self.mysql, user_id).await?;
        if let Some(redis) = self.redis {
            let payload = shared_team_list_payload(&ids);
            if let Err(error) = redis.set_ex(key.as_str(), CACHE_TTL_SECONDS, payload).await {
                tracing::warn!(%error, key = %key, "[team_resolution] shared team list write failed");
            }
        }
        Ok(ids)
    }

    /// [`shared_team_list`](Self::shared_team_list) on the caller's request
    /// SQL handle: only a cache miss reads, and that read runs on `sql`.
    async fn shared_team_list_on(
        &self,
        sql: &mut dyn RequestSql,
        user_id: i64,
    ) -> MysqlResult<Vec<i64>> {
        let key = shared_team_list_key(user_id);
        match cached_entry(self.redis, &key).await {
            CachedEntry::Hit(text) => {
                if let Ok(ids) = serde_json::from_str::<Vec<i64>>(&text) {
                    return Ok(ids);
                }
            }
            CachedEntry::Negative => return Ok(Vec::new()),
            // A missing or undecodable list falls through to the SQL reader.
            CachedEntry::Miss => {}
        }
        let ids = repo::shared_team_ids_on(sql, user_id).await?;
        if let Some(redis) = self.redis {
            let payload = shared_team_list_payload(&ids);
            if let Err(error) = redis.set_ex(key.as_str(), CACHE_TTL_SECONDS, payload).await {
                tracing::warn!(%error, key = %key, "[team_resolution] shared team list write failed");
            }
        }
        Ok(ids)
    }

    /// `TeamShareService.check_permission`: the direct member row's
    /// effective role, then the entity bindings through the registered
    /// resolvers, then the native group-role pass for non-default
    /// namespaces. `get_effective_role` defaults an empty role to Reporter.
    ///
    /// Shared with `GET /api/teams/{team_id}/skills`, whose
    /// `team_share_service.get_resource_for_use` runs the same check.
    pub(crate) async fn team_share_permission(
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
        if let Some(team) = repo::team_share_active_team(self.mysql, team_id).await?
            && team.kinds_namespace != "default"
            && let Some(erp) = self.erp
        {
            let role = crate::skills::skills_unified::effective_role_in_group(
                self.mysql,
                &crate::teams::group_membership::ErpContext {
                    erp,
                    redis: self.redis,
                },
                i32::try_from(user_id).unwrap_or(i32::MAX),
                &team.kinds_namespace,
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

    /// [`team_share_permission`](Self::team_share_permission) on the caller's
    /// request SQL handle: the member row, the entity bindings and the active
    /// Team read all run on `sql`. The native group-role pass keeps its pool
    /// path; it only runs for non-`default` namespaces, which the create flow
    /// does not resolve through this entry.
    pub(crate) async fn team_share_permission_on(
        &self,
        sql: &mut dyn RequestSql,
        team_id: i64,
        user_id: i64,
    ) -> Result<bool, brz_mysql::MysqlError> {
        // `UnifiedShareService.check_permission`: direct member row first.
        if let Some(role) = repo::team_share_member_row_on(sql, team_id, user_id).await? {
            let effective = if role.is_empty() {
                "Reporter"
            } else {
                role.as_str()
            };
            return Ok(reporter_or_above(effective));
        }

        // `check_entity_permission`: the entity bindings, matched through
        // the registered resolvers in first-appearance order.
        let entity_rows = repo::team_share_entity_rows_on(sql, team_id).await?;
        if self.entity_permission(user_id, &entity_rows).await? {
            return Ok(true);
        }

        // The native group-role pass only applies to non-default namespaces.
        if let Some(team) = repo::team_share_active_team_on(sql, team_id).await?
            && team.kinds_namespace != "default"
            && let Some(erp) = self.erp
        {
            let role = crate::skills::skills_unified::effective_role_in_group(
                self.mysql,
                &crate::teams::group_membership::ErpContext {
                    erp,
                    redis: self.redis,
                },
                i32::try_from(user_id).unwrap_or(i32::MAX),
                &team.kinds_namespace,
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
        let Some(team) = self.cached_kinds().get_group_team(namespace, name).await? else {
            return Ok(None);
        };
        // A public namespace grants access.
        if self.group_is_public(namespace).await? {
            return Ok(Some(kind_row(team)));
        }
        // Any approved group membership admits the member.
        if user_id != 0 && self.group_member_role(namespace, user_id).await?.is_some() {
            return Ok(Some(kind_row(team)));
        }
        // `team_share_service.get_resource_for_use(team.id, user_id)`:
        // `_get_resource(for_use=True)` reads the active Team row first, then
        // admits its owner or the system account, then runs the share check.
        if user_id != 0 {
            let Some(active) = repo::team_share_active_team(self.mysql, team.id).await? else {
                return Ok(None);
            };
            if active.kinds_user_id == user_id || active.kinds_user_id == 0 {
                return Ok(Some(kind_row(team)));
            }
            if self.team_share_permission(team.id, user_id).await? {
                return Ok(Some(kind_row(team)));
            }
        }
        Ok(None)
    }

    /// [`group_team`](Self::group_team) on the caller's request SQL handle:
    /// the group Team read, the visibility fallback, the membership read, the
    /// active Team read and the share check all run on `sql`, so the group
    /// branch keeps the source's transaction membership. A cache hit still
    /// skips its SQL, exactly like the pooled path.
    async fn group_team_on(
        &self,
        sql: &mut dyn RequestSql,
        user_id: i64,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRow>, brz_mysql::MysqlError> {
        let Some(team) = self
            .cached_kinds()
            .get_group_team_on(sql, namespace, name)
            .await?
        else {
            return Ok(None);
        };
        // A public namespace grants access.
        if self.group_is_public_on(sql, namespace).await? {
            return Ok(Some(kind_row(team)));
        }
        // Any approved group membership admits the member.
        if user_id != 0
            && self
                .group_member_role_on(sql, namespace, user_id)
                .await?
                .is_some()
        {
            return Ok(Some(kind_row(team)));
        }
        // `team_share_service.get_resource_for_use(team.id, user_id)`.
        if user_id != 0 {
            let Some(active) = repo::team_share_active_team_on(sql, team.id).await? else {
                return Ok(None);
            };
            if active.kinds_user_id == user_id || active.kinds_user_id == 0 {
                return Ok(Some(kind_row(team)));
            }
            if self.team_share_permission_on(sql, team.id, user_id).await? {
                return Ok(Some(kind_row(team)));
            }
        }
        Ok(None)
    }

    /// [`group_is_public`](Self::group_is_public) on the caller's handle: the
    /// cached group document decides a hit, and a miss runs the namespace
    /// query on `sql` before writing the document back.
    async fn group_is_public_on(
        &self,
        sql: &mut dyn RequestSql,
        namespace: &str,
    ) -> Result<bool, brz_mysql::MysqlError> {
        let key = group_document_key(namespace);
        match cached_entry(self.redis, &key).await {
            CachedEntry::Hit(text) => {
                if let Ok(document) = serde_json::from_str::<Value>(&text) {
                    return Ok(document
                        .get("visibility")
                        .and_then(Value::as_str)
                        .is_some_and(|visibility| visibility == VISIBILITY_PUBLIC));
                }
            }
            CachedEntry::Negative => return Ok(false),
            CachedEntry::Miss => {}
        }
        let row = repo::namespace_by_name_on(sql, namespace).await?;
        self.cache_group_document(&key, row.as_ref()).await;
        Ok(row.is_some_and(|row| row.namespace_visibility == VISIBILITY_PUBLIC))
    }

    /// [`group_member_role`](Self::group_member_role) on the caller's handle:
    /// the cached role document decides a hit, and a miss runs the namespace
    /// id and member reads on `sql`.
    async fn group_member_role_on(
        &self,
        sql: &mut dyn RequestSql,
        namespace: &str,
        user_id: i64,
    ) -> Result<Option<String>, brz_mysql::MysqlError> {
        let key = group_member_role_key(namespace, user_id);
        match cached_entry(self.redis, &key).await {
            CachedEntry::Hit(role) => return Ok(Some(role)),
            CachedEntry::Negative => return Ok(None),
            CachedEntry::Miss => {}
        }
        let role = crate::skills::skills_unified::direct_member_role_on(
            sql,
            i32::try_from(user_id).unwrap_or(i32::MAX),
            namespace,
        )
        .await?;
        if let Some(redis) = self.redis {
            let value = match role.as_deref() {
                Some(role) if !role.is_empty() => role.to_owned(),
                _ => NULL_MARKER.to_owned(),
            };
            if let Err(error) = redis.set_ex(key.as_str(), CACHE_TTL_SECONDS, value).await {
                tracing::warn!(%error, key = %key, "[team_resolution] group member write failed");
            }
        }
        Ok(role)
    }

    /// `groupReader.is_public`: `CachedGroupReader.get_visibility` reads the
    /// group document's `visibility`, and a missing (or undecodable)
    /// document falls back to the namespace query and writes the document
    /// back; `__NULL__` caches an absent group.
    async fn group_is_public(&self, namespace: &str) -> Result<bool, brz_mysql::MysqlError> {
        let key = group_document_key(namespace);
        match cached_entry(self.redis, &key).await {
            CachedEntry::Hit(text) => {
                if let Ok(document) = serde_json::from_str::<Value>(&text) {
                    return Ok(document
                        .get("visibility")
                        .and_then(Value::as_str)
                        .is_some_and(|visibility| visibility == VISIBILITY_PUBLIC));
                }
            }
            CachedEntry::Negative => return Ok(false),
            CachedEntry::Miss => {}
        }
        let row = repo::namespace_by_name(self.mysql, namespace).await?;
        self.cache_group_document(&key, row.as_ref()).await;
        Ok(row.is_some_and(|row| row.namespace_visibility == VISIBILITY_PUBLIC))
    }

    /// `groupMemberReader.is_member`: `CachedGroupMemberReader.get_role`
    /// reads the membership role document (`__NULL__` caches a
    /// non-member), and a missing document falls back to the member query
    /// and writes the role (or the marker) back.
    async fn group_member_role(
        &self,
        namespace: &str,
        user_id: i64,
    ) -> Result<Option<String>, brz_mysql::MysqlError> {
        let key = group_member_role_key(namespace, user_id);
        match cached_entry(self.redis, &key).await {
            CachedEntry::Hit(role) => return Ok(Some(role)),
            CachedEntry::Negative => return Ok(None),
            CachedEntry::Miss => {}
        }
        let role = crate::skills::skills_unified::direct_member_role(
            self.mysql,
            i32::try_from(user_id).unwrap_or(i32::MAX),
            namespace,
        )
        .await?;
        if let Some(redis) = self.redis {
            // `_set_idx(key, result if result else NULL_MARKER)`: an empty
            // role is falsy in the source and caches the marker.
            let value = match role.as_deref() {
                Some(role) if !role.is_empty() => role.to_owned(),
                _ => NULL_MARKER.to_owned(),
            };
            if let Err(error) = redis.set_ex(key.as_str(), CACHE_TTL_SECONDS, value).await {
                tracing::warn!(%error, key = %key, "[team_resolution] group member write failed");
            }
        }
        Ok(role)
    }

    /// `CachedGroupReader._set_data`: `SETEX group:v2:data:{name} 300
    /// <namespace json | __NULL__>`.
    async fn cache_group_document(&self, key: &str, row: Option<&repo::NamespaceRow>) {
        let Some(redis) = self.redis else {
            return;
        };
        let value = match row {
            Some(row) => python_namespace_json(row),
            None => NULL_MARKER.to_owned(),
        };
        if let Err(error) = redis.set_ex(key, CACHE_TTL_SECONDS, value).await {
            tracing::warn!(%error, key = %key, "[team_resolution] group document write failed");
        }
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
    pub(crate) fn erp_context(&self) -> crate::teams::group_membership::ErpContext<'_, R> {
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

/// `CachedSharedTeamReader._set_list`: `__NULL__` caches an empty list,
/// otherwise `json.dumps(ids)` with Python's default separators.
fn shared_team_list_payload(ids: &[i64]) -> String {
    if ids.is_empty() {
        return "__NULL__".to_owned();
    }
    python_json_value(&Value::Array(
        ids.iter()
            .map(|id| Value::Number(serde_json::Number::from(*id)))
            .collect(),
    ))
}

/// Project a cached-reader record onto the SQL row shape the skills chain
/// consumes: the same `kinds` projection, so a `kind:v2:data` hit and a
/// driver row are interchangeable downstream.
fn kind_row(record: KindRecord) -> KindRow {
    KindRow {
        kinds_id: record.id,
        kinds_user_id: record.user_id,
        kinds_kind: record.kind,
        kinds_name: record.name,
        kinds_namespace: record.namespace,
        kinds_json: brz_mysql::Json(OpaqueJson::from(record.json.0)),
        kinds_is_active: record.is_active,
        kinds_created_at: record.created_at,
        kinds_updated_at: record.updated_at,
    }
}

/// `CachedGroupReader._set_data`'s payload: `json.dumps(model_to_dict(group))`
/// — the `namespace` columns in table order with Python's default separators
/// and `ensure_ascii=True` escaping.
fn python_namespace_json(row: &repo::NamespaceRow) -> String {
    python_json_value(&serde_json::json!({
        "id": row.namespace_id,
        "name": row.namespace_name,
        "display_name": row.namespace_display_name,
        "owner_user_id": row.namespace_owner_user_id,
        "visibility": row.namespace_visibility,
        "description": row.namespace_description,
        "level": row.namespace_level,
        "is_active": row.namespace_is_active.map(|value| value != 0),
        "created_at": row.namespace_created_at.map(python_isoformat),
        "updated_at": row.namespace_updated_at.map(python_isoformat),
    }))
}

/// `datetime.isoformat()`: microseconds appear only when they are nonzero.
fn python_isoformat(value: chrono::NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_micros() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

#[cfg(test)]
#[path = "kinds_tests.rs"]
mod tests;
