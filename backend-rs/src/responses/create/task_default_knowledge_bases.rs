// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The create flow's task-default knowledge-base resolver
//! (`app/services/chat/task_default_knowledge_bases.py`) and the inherited
//! selected-knowledge refs built on it (`chat/selected_knowledge.py:214-241`).
//!
//! Split from [`super::knowledge`] to keep both files under the source-review
//! size limit; the statements and their ordering contracts are unchanged.
use brz_mysql::{Json, MysqlResult};
use brz_redis::Redis;
use serde_json::Value;

use super::knowledge::{
    AclContextSource, deduplicate, get_acl_accessible_knowledge_base_ids,
    team_member_default_knowledge_base_ids,
};
use super::knowledge_prompt::SelectedKnowledgeRef;
use super::resolution::{KindRow, resolve_task_ref_team};
use super::selected_knowledge::{
    build_wegent_refs_for_ids, index_refs_by_integer_id, parse_knowledge_base_scopes,
};
use super::team_access::team_shared_for_use;
use crate::task_store_traits::TaskStore;

/// `_resolve_task_default_knowledge_bases`: the active task re-read, the
/// task's current team (the `teamRef` resolution, owner-scoped when the ref
/// carries `user_id`) gated by the share check, then the team-member default
/// ids filtered by the ACL, then the `knowledge_base_id` pin when one is
/// selected.
///
/// Returns `(Some(team), ids)` on success; `None` for the team when the task
/// is missing, the team is missing, or the share check denies use.
pub async fn resolve_task_default_knowledge_bases<R: Redis>(
    acl: &AclContextSource<'_, R>,
    store: &dyn TaskStore,
    task_id: i64,
    viewer_user_id: i64,
    knowledge_base_id: Option<i64>,
) -> MysqlResult<Option<(Option<KindRow>, Vec<i64>)>> {
    let mysql = acl.mysql();
    // `task_store.get_active_task`: the resolver re-reads the active task it is
    // given the id of and resolves the team from the stored CRD. The store owns
    // the statement and its shard routing (`task_table_for_lookup` +
    // `route(ByUserId/ByTaskId)`); an unrouted handle would render the generic
    // base table and never match the recorded shard. A missing row (or a row
    // whose CRD carries no `teamRef`) yields no team and no ids.
    let Some(task) = store.get_active_task(task_id).await? else {
        return Ok(Some((None, Vec::new())));
    };
    let Some(task_json) =
        crate::internal_callback::completion::task_column::<Json<Value>>(&task, "json")
            .map(|json| json.0)
    else {
        return Ok(Some((None, Vec::new())));
    };
    let Some(team_ref) = task_json.get("spec").and_then(|spec| spec.get("teamRef")) else {
        return Ok(Some((None, Vec::new())));
    };
    let team = resolve_task_ref_team(
        mysql,
        team_ref.get("user_id").and_then(Value::as_i64),
        team_ref
            .get("namespace")
            .and_then(Value::as_str)
            .unwrap_or(""),
        team_ref.get("name").and_then(Value::as_str).unwrap_or(""),
        viewer_user_id,
    )
    .await?;
    let Some(team) = team else {
        return Ok(Some((None, Vec::new())));
    };
    // `TeamShareService._get_resource(for_use=True)`: a Team owned by the
    // caller — or the public `user_id = 0` Team — is usable without any share
    // read, so the member/entity checks and the group-role fallback run only
    // for a Team someone else owns.
    if !team_shared_for_use(acl, team.id, viewer_user_id).await? {
        return Ok(Some((None, Vec::new())));
    }

    let candidate_ids = team_member_default_knowledge_base_ids(mysql, &team).await?;
    let candidates = deduplicate(&candidate_ids);
    let candidates = match knowledge_base_id {
        Some(selected) if !candidates.contains(&selected) => {
            return Ok(Some((Some(team), Vec::new())));
        }
        Some(selected) => vec![selected],
        None => candidates,
    };

    let allowed = get_acl_accessible_knowledge_base_ids(acl, team.user_id, &candidates).await?;
    Ok(Some((
        Some(team),
        candidates
            .into_iter()
            .filter(|id| allowed.contains(id))
            .collect(),
    )))
}

/// `resolve_task_default_knowledge_base_ids`: the accessible default ids.
pub async fn resolve_task_default_knowledge_base_ids<R: Redis>(
    acl: &AclContextSource<'_, R>,
    store: &dyn TaskStore,
    task_id: i64,
    viewer_user_id: i64,
) -> MysqlResult<Vec<i64>> {
    match resolve_task_default_knowledge_bases(acl, store, task_id, viewer_user_id, None).await? {
        Some((_, ids)) => Ok(ids),
        None => Ok(Vec::new()),
    }
}

/// `build_inherited_selected_knowledge_refs` (`chat/selected_knowledge.py`):
/// the task's persisted `knowledgeBaseRefs`/`knowledgeBaseScopes` ids plus the
/// agent defaults, resolved into `wegent` refs and merged over the task's
/// external refs.
pub async fn build_inherited_selected_knowledge_refs<R: Redis>(
    acl: &AclContextSource<'_, R>,
    store: &dyn TaskStore,
    task_id: i64,
    task_json: &Value,
    viewer_user_id: i64,
    external_refs: &[Value],
) -> MysqlResult<Vec<SelectedKnowledgeRef>> {
    let mysql = acl.mysql();
    let spec = task_json.get("spec").cloned().unwrap_or(Value::Null);
    let mut persisted: Vec<i64> = index_refs_by_integer_id(
        &spec
            .get("knowledgeBaseRefs")
            .cloned()
            .unwrap_or(Value::Null),
    )
    .keys()
    .copied()
    .collect();
    persisted.extend(
        index_refs_by_integer_id(
            &spec
                .get("knowledgeBaseScopes")
                .cloned()
                .unwrap_or(Value::Null),
        )
        .keys()
        .copied(),
    );
    let default_ids =
        resolve_task_default_knowledge_base_ids(acl, store, task_id, viewer_user_id).await?;
    let selected_ids = deduplicate(&[persisted, default_ids].concat());

    let wegent = build_wegent_refs_for_ids(
        mysql,
        task_json,
        &selected_ids,
        &parse_knowledge_base_scopes(&Value::Null),
        false,
    )
    .await?;
    let mut refs = wegent;
    refs.extend(external_refs_from_values(external_refs));
    Ok(super::selected_knowledge::resolve_selected_knowledge_context(&refs, &[]).refs)
}

/// `_build_external_refs_from_values`: the external refs of the task's
/// `externalKnowledgeRefs`, each with its provider and id. The recorded create
/// case carries an empty list, so this only passes through well-formed entries.
fn external_refs_from_values(values: &[Value]) -> Vec<SelectedKnowledgeRef> {
    values
        .iter()
        .filter_map(|value| {
            let provider = value.get("provider")?.as_str()?.trim().to_string();
            let knowledge_base_id = value.get("knowledge_base_id")?.as_str()?.trim().to_string();
            if provider.is_empty() || knowledge_base_id.is_empty() {
                return None;
            }
            Some(SelectedKnowledgeRef {
                provider,
                knowledge_base_id,
                knowledge_base_name: value
                    .get("knowledge_base_name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                ..Default::default()
            })
        })
        .collect()
}
