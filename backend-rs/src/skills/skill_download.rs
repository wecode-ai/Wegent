// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Skill download resolution for `GET /api/v1/kinds/skills/{id}/download`.
//!
//! Mirrors `app.api.endpoints.kind.skills.download_skill` and the service
//! lookups it composes:
//!
//! 1. `get_skill_by_id(user_id=current_user)`
//! 2. personal-default `SkillBinding` (`list_user_default_skill_ids`) or
//!    group-shared `SkillBinding` (`list_user_group_skill_ids`)
//! 3. group Skill / group binding (Reporter access in the group namespace)
//! 4. task-authorized lookups (`task_id` query parameter)
//! 5. system Skill (`user_id=0`), restricted to admins and executor
//!    credentials
use super::input::{SkillInput, TeamReference};
use crate::json_compat::JsonProjection;
use brz_mysql::{FromMysqlRow, Json, MysqlResult};
#[cfg(test)]
use serde_json::Value;
use std::collections::HashSet;

use crate::teams::group_membership::ErpContext;

use super::entity_resolution::EntityResolution;

/// A `kinds` row restricted to the columns the download path needs.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct KindRow {
    pub id: i32,
    pub user_id: i32,
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub(super) json: Option<Json<JsonProjection<SkillInput>>>,
}

impl KindRow {
    /// `Skill.metadata.name` (`_kind_to_skill` keeps the Kind name).
    pub fn skill_metadata_name(&self) -> String {
        self.name.clone()
    }
}

/// `skill_binaries` row.
#[derive(Debug, FromMysqlRow)]
pub struct SkillBinaryRow {
    pub binary_data: Vec<u8>,
}

/// `tasks_{:04}` row (`TaskResource`).
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct TaskRow {
    pub id: i64,
    pub user_id: i32,
    pub(super) json: Option<Json<JsonProjection<SkillInput>>>,
}

impl TaskRow {
    fn team_ref(&self) -> Option<&TeamReference> {
        self.json
            .as_ref()?
            .0
            .value
            .as_ref()?
            .spec
            .as_ref()?
            .team_ref
            .as_ref()
    }
    pub fn team_owner_user_id(&self) -> Option<i32> {
        self.team_ref()?.user_id.as_ref()?.team_owner()
    }
    pub fn team_namespace(&self) -> String {
        self.team_ref()
            .and_then(|reference| reference.namespace.as_deref())
            .unwrap_or("default")
            .to_owned()
    }
}

/// `resource_members` row for a task membership check.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
pub struct MemberRow {
    pub id: i32,
    pub role: Option<String>,
}

/// `resource_members.role`-only row (`get_group_member` projection).
#[derive(Debug, FromMysqlRow)]
struct RoleRow {
    #[mysql(rename = "resource_members_role")]
    role: Option<String>,
}

/// One entity-type `resource_members` row for namespace entity resolution
/// (`resolve_entity_roles_for_resource`). The core registers no external
/// entity resolvers, so matched rows contribute no roles, but the lookup is
/// still observed like the source's.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
struct EntityMemberRow {
    #[mysql(rename = "resource_members_entity_type")]
    entity_type: String,
    #[mysql(rename = "resource_members_entity_id")]
    entity_id: String,
    #[mysql(rename = "resource_members_role")]
    role: Option<String>,
}

impl EntityMemberRow {
    /// Decode one row by its `resource_members_*` aliased columns.
    fn from_row(row: &brz_mysql::MysqlRow) -> brz_mysql::MysqlResult<Self> {
        Ok(Self {
            entity_type: row.get_required("resource_members_entity_type")?,
            entity_id: row.get_required("resource_members_entity_id")?,
            role: row.get("resource_members_role")?,
        })
    }
}

/// Minimal `id`-only row for existence checks.
#[derive(Debug, FromMysqlRow)]
#[allow(dead_code)]
struct OwnedRow {
    #[allow(dead_code)]
    id: i32,
}

/// `SELECT kinds.id AS kinds_id ...` existence row.
#[derive(Debug, FromMysqlRow)]
struct OwnedAliasedRow {
    #[mysql(rename = "kinds_id")]
    id: i32,
}

/// One `kinds` SkillBinding row with the SQLAlchemy `kinds_<column>` aliases.
#[derive(Debug)]
struct GroupBindingRow {
    #[allow(dead_code)]
    id: i32,
    #[allow(dead_code)]
    user_id: i32,
    #[allow(dead_code)]
    kind: String,
    #[allow(dead_code)]
    name: String,
    #[allow(dead_code)]
    namespace: String,
    json: Option<Json<JsonProjection<SkillInput>>>,
}

impl GroupBindingRow {
    /// Decode one row by its `kinds_*` aliased columns.
    fn from_row(row: &brz_mysql::MysqlRow) -> brz_mysql::MysqlResult<Self> {
        Ok(Self {
            id: row.get_required("kinds_id")?,
            user_id: row.get_required("kinds_user_id")?,
            kind: row.get_required("kinds_kind")?,
            name: row.get_required("kinds_name")?,
            namespace: row.get_required("kinds_namespace")?,
            json: row.get("kinds_json")?,
        })
    }
}

/// Read access to the SkillBinding fields the binding filters need, shared by
/// the plain and `kinds_*`-aliased row shapes.
trait SkillBindingFields {
    fn binding_json(&self) -> Option<&Json<JsonProjection<SkillInput>>>;
}

impl SkillBindingFields for KindRow {
    fn binding_json(&self) -> Option<&Json<JsonProjection<SkillInput>>> {
        self.json.as_ref()
    }
}

impl SkillBindingFields for GroupBindingRow {
    fn binding_json(&self) -> Option<&Json<JsonProjection<SkillInput>>> {
        self.json.as_ref()
    }
}

/// Skill lookup repositories for the download path.
///
/// The task-authorized lookups read their rows from the injected `TaskStore`,
/// which owns the physical table choice; every other read stays on this
/// handle.
pub struct SkillDownloadRepository<'a> {
    mysql: &'a brz_mysql::MysqlService,
    task_store: &'a dyn crate::task_store::TaskStore,
}

impl<'a> SkillDownloadRepository<'a> {
    pub fn new(
        mysql: &'a brz_mysql::MysqlService,
        task_store: &'a dyn crate::task_store::TaskStore,
    ) -> Self {
        Self { mysql, task_store }
    }

    /// `skill_kinds_service.get_skill_by_id`.
    pub async fn get_skill_by_id(
        &self,
        skill_id: i32,
        user_id: i32,
    ) -> MysqlResult<Option<KindRow>> {
        self.mysql
            .fetch_optional(
                "SELECT id, user_id, kind, name, namespace, json FROM kinds \
                 WHERE id = ? AND user_id = ? AND kind = 'Skill' AND is_active = 1 \
                 LIMIT 1",
                (skill_id, user_id),
            )
            .await
    }

    /// `skill_kinds_service.get_skill_by_id_in_namespace`.
    pub async fn get_skill_by_id_in_namespace(
        &self,
        skill_id: i32,
        namespace: &str,
    ) -> MysqlResult<Option<KindRow>> {
        self.mysql
            .fetch_optional(
                "SELECT id, user_id, kind, name, namespace, json FROM kinds \
                 WHERE id = ? AND namespace = ? AND kind = 'Skill' AND is_active = 1 \
                 LIMIT 1",
                (skill_id, namespace),
            )
            .await
    }

    /// `skill_kinds_service.get_skill_binary`.
    pub async fn get_skill_binary(
        &self,
        skill_id: i32,
        user_id: i32,
    ) -> MysqlResult<Option<Vec<u8>>> {
        let owned: Option<OwnedRow> = self
            .mysql
            .fetch_optional(
                "SELECT id FROM kinds \
                 WHERE id = ? AND user_id = ? AND kind = 'Skill' AND is_active = 1 \
                 LIMIT 1",
                (skill_id, user_id),
            )
            .await?;
        if owned.is_none() {
            return Ok(None);
        }
        self.fetch_binary(skill_id).await
    }

    /// `skill_kinds_service.get_skill_binary_in_namespace`.
    pub async fn get_skill_binary_in_namespace(
        &self,
        skill_id: i32,
        namespace: &str,
    ) -> MysqlResult<Option<Vec<u8>>> {
        let in_namespace: Option<OwnedRow> = self
            .mysql
            .fetch_optional(
                "SELECT id FROM kinds \
                 WHERE id = ? AND namespace = ? AND kind = 'Skill' AND is_active = 1 \
                 LIMIT 1",
                (skill_id, namespace),
            )
            .await?;
        if in_namespace.is_none() {
            return Ok(None);
        }
        self.fetch_binary(skill_id).await
    }

    /// `_get_skill_archive_by_id`: the Kind row plus its binary in the
    /// Kind's own namespace.
    pub async fn get_skill_archive_by_id(
        &self,
        skill_id: i32,
    ) -> MysqlResult<Option<(KindRow, Option<Vec<u8>>)>> {
        let Some(kind_row): Option<KindRow> = self
            .mysql
            .fetch_optional(
                "SELECT id, user_id, kind, name, namespace, json FROM kinds \
                 WHERE id = ? AND kind = 'Skill' AND is_active = 1 LIMIT 1",
                (skill_id,),
            )
            .await?
        else {
            return Ok(None);
        };
        let namespace = kind_row.namespace.clone();
        // `_get_skill_archive_by_id` resolves the Skill in its own namespace
        // before loading the archive, so the same `kinds` row is read once
        // more than the lookup above.
        let skill = self
            .get_skill_by_id_in_namespace(skill_id, namespace.as_str())
            .await?;
        let binary = self
            .get_skill_binary_in_namespace(skill_id, namespace.as_str())
            .await?;
        Ok(skill.map(|skill| (skill, binary)))
    }

    async fn fetch_binary(&self, skill_id: i32) -> MysqlResult<Option<Vec<u8>>> {
        let row: Option<SkillBinaryRow> = self
            .mysql
            .fetch_optional(
                "SELECT binary_data FROM skill_binaries WHERE kind_id = ? LIMIT 1",
                (skill_id,),
            )
            .await?;
        Ok(row.map(|row| row.binary_data))
    }

    /// `skill_binding_service.list_user_default_skill_ids`: active
    /// SkillBinding rows in the `default` namespace for the user, filtered to
    /// user-default bindings whose referenced Skill is active and accessible.
    pub async fn list_user_default_skill_ids(
        &self,
        resolution: &EntityResolution<'_>,
    ) -> MysqlResult<Vec<i32>> {
        let user_id = resolution.user_id;
        let bindings: Vec<KindRow> = self
            .mysql
            .fetch_all(
                "SELECT id, user_id, kind, name, namespace, json FROM kinds \
                 WHERE user_id = ? AND kind = 'SkillBinding' AND namespace = 'default' \
                 AND is_active = 1 ORDER BY created_at DESC",
                (user_id,),
            )
            .await?;
        let target_id = format!("user:{user_id}");
        let mut skill_ids = Vec::new();
        for binding in bindings {
            if !is_user_default_binding(&binding, &target_id) {
                continue;
            }
            let Some(skill_id) = extract_skill_id(&binding) else {
                continue;
            };
            // `_get_active_skill` plus `can_user_access_skill`.
            let Some(skill) = self.get_active_skill(skill_id).await? else {
                continue;
            };
            if !self.can_user_access_skill(resolution, &skill).await? {
                continue;
            }
            skill_ids.push(skill_id);
        }
        Ok(skill_ids)
    }

    /// `skill_binding_service.list_user_group_skill_ids`: the Skill ids
    /// shared with any group the user can access with at least Reporter
    /// access. Runs the `get_user_groups` resolution (direct, entity-derived
    /// and inherited memberships), the per-group Reporter gate, then
    /// `list_group_skill_ids_for_authorized_namespaces`.
    pub async fn list_user_group_skill_ids(
        &self,
        resolution: &EntityResolution<'_>,
    ) -> MysqlResult<HashSet<i32>> {
        let erp = ErpContext {
            erp: resolution.state.erp.as_ref(),
            redis: resolution.state.redis.as_ref(),
        };
        // `check_group_permission` is not called for the personal `default`
        // namespace, so it stays out of the dependency sequence.
        let mut authorized: Vec<String> = Vec::new();
        for group_name in
            super::skills_unified::get_user_groups(self.mysql, &erp, resolution.user_id).await?
        {
            if group_name == "default" {
                continue;
            }
            let role = self
                .effective_role_in_group(resolution, &group_name)
                .await?;
            if role.as_deref().is_some_and(has_reporter_permission) {
                authorized.push(group_name);
            }
        }
        super::skills_unified::group_skill_ids_for_namespaces(self.mysql, &authorized).await
    }

    /// `_get_active_skill`.
    async fn get_active_skill(&self, skill_id: i32) -> MysqlResult<Option<KindRow>> {
        self.mysql
            .fetch_optional(
                "SELECT id, user_id, kind, name, namespace, json FROM kinds \
                 WHERE id = ? AND kind = 'Skill' AND is_active = 1 LIMIT 1",
                (skill_id,),
            )
            .await
    }

    /// `can_user_access_skill`: owner/system or published-public access, or
    /// Reporter access in the Skill's group namespace.
    pub async fn can_user_access_skill(
        &self,
        resolution: &EntityResolution<'_>,
        skill: &KindRow,
    ) -> MysqlResult<bool> {
        let user_id = resolution.user_id;
        if skill.user_id == user_id || skill.user_id == 0 {
            return Ok(true);
        }
        let published_public = skill
            .json
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
            .is_some_and(SkillInput::is_published_public);
        if published_public {
            return Ok(true);
        }
        if skill.namespace != "default" {
            let role = self
                .effective_role_in_group(resolution, &skill.namespace)
                .await?;
            if role.as_deref().is_some_and(has_reporter_permission) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `skill_binding_service.is_skill_available_to_group` via
    /// `list_group_skill_ids`.
    pub async fn is_skill_available_to_group(
        &self,
        resolution: &EntityResolution<'_>,
        group_namespace: &str,
        skill_id: i32,
    ) -> MysqlResult<bool> {
        let role = self
            .effective_role_in_group(resolution, group_namespace)
            .await?;
        if !role.as_deref().is_some_and(has_reporter_permission) {
            return Ok(false);
        }
        // `list_group_skill_ids_for_authorized_namespaces`: the source renders
        // the namespace list as inline literals in one text COM_QUERY
        // (`Kind.namespace.in_([group_namespace])`), selecting every mapped
        // Kind column aliased `kinds_<column>`.
        let binding_rows: Vec<brz_mysql::MysqlRow> = self
            .mysql
            .fetch_all(
                &format!(
                    "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
                     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
                     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
                     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
                     kinds.updated_at AS kinds_updated_at \
                     FROM kinds \
                     WHERE kinds.kind = 'SkillBinding' AND kinds.namespace IN ({}) \
                     AND kinds.is_active = 1",
                    quote_literal(group_namespace)
                ),
                (),
            )
            .await?;
        let bindings = binding_rows
            .iter()
            .map(GroupBindingRow::from_row)
            .collect::<MysqlResult<Vec<_>>>()?;
        let mut candidate_ids: Vec<i32> = bindings
            .iter()
            .filter(|binding| is_group_binding(*binding, group_namespace))
            .filter_map(extract_skill_id)
            .collect();
        candidate_ids.sort_unstable();
        candidate_ids.dedup();
        if candidate_ids.is_empty() {
            return Ok(false);
        }
        // Confirm the candidate Skills are still active (one inline IN query).
        let list = candidate_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let active: Vec<OwnedAliasedRow> = self
            .mysql
            .fetch_all(
                &format!(
                    "SELECT kinds.id AS kinds_id FROM kinds \
                     WHERE kinds.id IN ({list}) AND kinds.kind = 'Skill' \
                     AND kinds.is_active = 1"
                ),
                (),
            )
            .await?;
        Ok(active.iter().any(|row| row.id == skill_id))
    }

    /// `get_effective_role_in_group`: direct membership, entity-derived
    /// memberships resolved through registered entity resolvers, then parent-group inheritance.
    pub async fn effective_role_in_group(
        &self,
        resolution: &EntityResolution<'_>,
        group_name: &str,
    ) -> MysqlResult<Option<String>> {
        let user_id = resolution.user_id;
        let mut candidates: Vec<String> = Vec::new();
        if let Some(role) = self.direct_role_in_group(user_id, group_name).await? {
            candidates.push(role);
        }
        // Entity-derived memberships through the registered resolvers.
        if let Some(namespace_id) = self.namespace_id(group_name).await? {
            candidates.extend(
                self.entity_roles_in_namespace(resolution, namespace_id)
                    .await?,
            );
        }
        if let Some(role) = highest_role(&candidates) {
            return Ok(Some(role));
        }
        // Parent group inheritance (only without direct/entity hits): nearest
        // parent with a role wins. Recursion is boxed to bound the future.
        if group_name.contains('/') {
            let parts: Vec<&str> = group_name.split('/').collect();
            for index in (1..parts.len()).rev() {
                let parent = parts[..index].join("/");
                let parent_role =
                    Box::pin(self.effective_role_in_group(resolution, &parent)).await?;
                if let Some(role) = parent_role {
                    return Ok(Some(role));
                }
            }
        }
        Ok(None)
    }

    /// `get_namespace_id_by_name`.
    async fn namespace_id(&self, group_name: &str) -> MysqlResult<Option<i32>> {
        let namespace: Option<OwnedRow> = self
            .mysql
            .fetch_optional(
                "SELECT id FROM namespace WHERE name = ? AND is_active = 1 LIMIT 1",
                (group_name,),
            )
            .await?;
        Ok(namespace.map(|namespace| namespace.id))
    }

    /// Direct `resource_members` membership for the namespace
    /// (`get_group_member`: full model projection, `resource_members_*`
    /// aliases, order-insensitive predicates).
    async fn direct_role_in_group(
        &self,
        user_id: i32,
        group_name: &str,
    ) -> MysqlResult<Option<String>> {
        let namespace: Option<OwnedRow> = self
            .mysql
            .fetch_optional(
                "SELECT id FROM namespace WHERE name = ? AND is_active = 1 LIMIT 1",
                (group_name,),
            )
            .await?;
        let Some(namespace) = namespace else {
            return Ok(None);
        };
        let member: Option<RoleRow> = self
            .mysql
            .fetch_optional(
                "SELECT resource_members.`role` AS resource_members_role \
                 FROM resource_members \
                 WHERE resource_members.resource_type = 'Namespace' \
                 AND resource_members.resource_id = ? \
                 AND resource_members.entity_type = 'user' \
                 AND resource_members.entity_id = ? \
                 AND resource_members.status = 'approved' LIMIT 1",
                (namespace.id, user_id.to_string()),
            )
            .await?;
        Ok(member.and_then(|member| member.role))
    }

    /// `_resolve_entity_roles_in_namespace` ->
    /// `resolve_entity_roles_for_resource`: fetch the namespace's approved
    /// non-user entity rows, group them by type, and delegate to the
    /// application's registered resolvers. Unregistered types grant no roles.
    async fn entity_roles_in_namespace(
        &self,
        resolution: &EntityResolution<'_>,
        namespace_id: i32,
    ) -> MysqlResult<Vec<String>> {
        let rows: Vec<brz_mysql::MysqlRow> = self
            .mysql
            .fetch_all(
                "SELECT resource_members.entity_type AS resource_members_entity_type, \
                 resource_members.entity_id AS resource_members_entity_id, \
                 resource_members.`role` AS resource_members_role \
                 FROM resource_members \
                 WHERE resource_members.resource_type IN ('Namespace') \
                 AND resource_members.resource_id = ? \
                 AND (resource_members.entity_type NOT IN ('namespace', '', 'user')) \
                 AND resource_members.entity_id IS NOT NULL \
                 AND resource_members.status IN ('approved')",
                (namespace_id,),
            )
            .await?;
        let rows: Vec<EntityMemberRow> = rows
            .iter()
            .map(EntityMemberRow::from_row)
            .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;
        let mut groups = std::collections::BTreeMap::<&str, Vec<&EntityMemberRow>>::new();
        for row in &rows {
            if !row.entity_id.is_empty() {
                groups.entry(&row.entity_type).or_default().push(row);
            }
        }
        let mut roles = Vec::new();
        for (entity_type, entries) in groups {
            let ids = entries
                .iter()
                .map(|row| row.entity_id.clone())
                .collect::<Vec<_>>();
            let matched = resolution
                .state
                .entity_resolvers
                .match_bindings(
                    resolution.state.redis.as_ref(),
                    i64::from(resolution.user_id),
                    entity_type,
                    &ids,
                    crate::permissions::ResolutionPurpose::SkillDownload,
                )
                .await?;
            roles.extend(
                entries
                    .iter()
                    .filter(|row| matched.contains(&row.entity_id))
                    .filter_map(|row| row.role.clone())
                    .filter(|role| !role.is_empty()),
            );
        }
        Ok(roles)
    }

    /// `task_store.get_task_by_states` with the active states, for the
    /// task-authorized download path. The store resolves the row's table, so a
    /// deployment that shards task storage reads the migrated copy.
    pub async fn get_task_by_states(&self, task_id: i64) -> MysqlResult<Option<TaskRow>> {
        let row = self.task_store.get_active_task(task_id).await?;
        row.map(TaskRow::from_mysql_row).transpose()
    }

    /// `task_member_service.is_member` -> `task_access_store.is_member`, whose
    /// `_get_accessible_task` is the id's active task: the access store reads
    /// the table the id's own encoding selects, so a legacy id reads the base
    /// table even when the migration copied the row to its owner's shard. The
    /// owner match admits the user, otherwise an approved task resource
    /// membership does.
    pub async fn is_task_member(&self, task_id: i64, user_id: i32) -> MysqlResult<bool> {
        let Some(task) = self.task_store.get_accessible_task(task_id).await? else {
            return Ok(false);
        };
        if task.get_required::<i32>("user_id")? == user_id {
            return Ok(true);
        }
        let member: Option<MemberRow> = self
            .mysql
            .fetch_optional(
                "SELECT id, role FROM resource_members \
                 WHERE resource_type = 'Task' AND resource_id = ? \
                 AND entity_type = 'user' AND entity_id = ? AND status = 'approved' \
                 AND copied_resource_id = 0 LIMIT 1",
                (task_id, user_id.to_string()),
            )
            .await?;
        Ok(member.is_some())
    }
}

/// `has_permission(role, GroupRole.Reporter)`: Reporter is hierarchy level 3.
fn has_reporter_permission(role: &str) -> bool {
    fn hierarchy(role: &str) -> Option<u32> {
        match role {
            "Owner" => Some(0),
            "Maintainer" => Some(1),
            "Developer" => Some(2),
            "Reporter" => Some(3),
            "RestrictedAnalyst" => Some(4),
            _ => None,
        }
    }
    hierarchy(role).is_some_and(|level| level <= 3)
}

/// `get_highest_role`: the most privileged known role (unknown roles lose to
/// every known role, matching `ROLE_HIERARCHY.get(..., 999)`).
fn highest_role(roles: &[String]) -> Option<String> {
    roles
        .iter()
        .min_by_key(|role| match role.as_str() {
            "Owner" => 0,
            "Maintainer" => 1,
            "Developer" => 2,
            "Reporter" => 3,
            "RestrictedAnalyst" => 4,
            _ => 999,
        })
        .cloned()
}

/// `_extract_skill_id`: `spec.skillRef.skillId` (or `skill_id`).
fn extract_skill_id<T: SkillBindingFields + ?Sized>(binding: &T) -> Option<i32> {
    binding.binding_json()?.0.value.as_ref()?.skill_id()
}

fn is_user_default_binding(binding: &impl SkillBindingFields, target_id: &str) -> bool {
    binding
        .binding_json()
        .and_then(|json| json.0.value.as_ref())
        .is_some_and(|input| input.matches_target("user", target_id))
}

fn is_group_binding<T: SkillBindingFields + ?Sized>(binding: &T, group_namespace: &str) -> bool {
    binding
        .binding_json()
        .and_then(|json| json.0.value.as_ref())
        .is_some_and(|input| input.matches_target("group", group_namespace))
}

/// Escape one string literal with MySQL's default quoting rules
/// (SQLAlchemy's `in_` renders the values as inline literals).
fn quote_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for byte in value.bytes() {
        match byte {
            b'\'' => out.push_str("\\'"),
            b'\\' => out.push_str("\\\\"),
            b'\0' => out.push_str("\\0"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            0x1a => out.push_str("\\Z"),
            other => out.push(other as char),
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn binding(json: Value) -> KindRow {
        KindRow {
            id: 1,
            user_id: 1,
            kind: "SkillBinding".to_string(),
            name: "binding".to_string(),
            namespace: "default".to_string(),
            json: Some(Json(json.into())),
        }
    }

    #[test]
    fn extracts_skill_ids_from_bindings() {
        let row = binding(json!({
            "spec": {"targetType": "user", "targetId": "user:7",
                     "skillRef": {"skillId": 187624}}
        }));
        assert_eq!(extract_skill_id(&row), Some(187624));
        assert!(is_user_default_binding(&row, "user:7"));
        assert!(!is_group_binding(&row, "default"));

        let legacy = binding(json!({
            "spec": {"targetType": "group", "targetId": "team-a",
                     "skillRef": {"skill_id": "42"}}
        }));
        assert_eq!(extract_skill_id(&legacy), Some(42));
        assert!(is_group_binding(&legacy, "team-a"));
    }

    #[test]
    fn reporter_permission_covers_roles_at_or_above() {
        assert!(has_reporter_permission("Owner"));
        assert!(has_reporter_permission("Maintainer"));
        assert!(has_reporter_permission("Developer"));
        assert!(has_reporter_permission("Reporter"));
        assert!(!has_reporter_permission("RestrictedAnalyst"));
        assert!(!has_reporter_permission("guest"));
    }

    #[test]
    fn team_ref_is_parsed_from_task_json() {
        let task = TaskRow {
            id: 1,
            user_id: 1652,
            json: Some(Json(
                json!({
                    "spec": {"teamRef": {"name": "wegent-chat", "user_id": 0,
                                          "namespace": "default"}}
                })
                .into(),
            )),
        };
        assert_eq!(task.team_owner_user_id(), None);
        assert_eq!(task.team_namespace(), "default");

        let owned = TaskRow {
            id: 1,
            user_id: 1652,
            json: Some(Json(
                json!({
                    "spec": {"teamRef": {"name": "t", "user_id": 9, "namespace": "team-a"}}
                })
                .into(),
            )),
        };
        assert_eq!(owned.team_owner_user_id(), Some(9));
        assert_eq!(owned.team_namespace(), "team-a");
    }
}
