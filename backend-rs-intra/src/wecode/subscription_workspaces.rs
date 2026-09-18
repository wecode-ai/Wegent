//! Internal sharded Workspace lookup for `GET /api/subscriptions`.
use std::collections::{BTreeMap, HashMap, HashSet};

use async_trait::async_trait;
use brz_mysql::{FromMysqlRow, Mysql, MysqlService};
use serde_json::Value;
use wegent_backend_rs::subscription_workspaces::{
    RepoFields, WorkspaceRepository, extract_repo_fields, query_workspace_rows,
};

use super::sharding::{
    is_new_task_id, physical_shard_for_slot, shard_count_from_env, slot_from_new_id,
    slot_from_user_id,
};

/// Internal task-store adapter selected by application startup.
pub struct ShardedWorkspaceRepository;

#[async_trait]
impl WorkspaceRepository for ShardedWorkspaceRepository {
    async fn fetch_repo_fields(
        &self,
        mysql: &MysqlService,
        workspace_ids: &[i64],
    ) -> Result<HashMap<i64, RepoFields>, brz_mysql::MysqlError> {
        fetch_workspace_repo_fields(mysql, workspace_ids).await
    }
}

/// `build_workspace_repo_cache` + `extract_workspace_repo_fields`: load the
/// active Workspace rows for the given ids and keep the repository fields.
///
/// `ShardedTaskStore.list_active_workspaces_by_ids` splits the ids: legacy
/// ids query the base `tasks` table (migrated legacy rows are read from
/// their shard, index rows excluded), new-format ids query their
/// `tasks_{slot % shard_count:04}` shard; results are deduplicated by id
/// and ordered by the input id list.
async fn fetch_workspace_repo_fields<M: Mysql>(
    mysql: &M,
    workspace_ids: &[i64],
) -> Result<HashMap<i64, RepoFields>, brz_mysql::MysqlError> {
    if workspace_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut legacy_ids: Vec<i64> = Vec::new();
    let mut shard_ids: BTreeMap<u32, Vec<i64>> = BTreeMap::new();
    for &workspace_id in workspace_ids {
        if is_new_task_id(workspace_id as u64) {
            let slot = slot_from_new_id(workspace_id as u64);
            shard_ids
                .entry(physical_shard_for_slot(slot, shard_count_from_env()))
                .or_default()
                .push(workspace_id);
        } else {
            legacy_ids.push(workspace_id);
        }
    }

    let mut rows: Vec<(i64, Value)> = Vec::new();
    if !legacy_ids.is_empty() {
        rows.extend(resolve_legacy_workspaces(mysql, &legacy_ids).await?);
    }
    for (shard, ids) in &shard_ids {
        let table = format!("tasks_{shard:04}");
        rows.extend(query_workspace_rows(mysql, &table, ids).await?);
    }

    // Deduplicate by id (first occurrence wins) and order by the input ids.
    let mut by_id: HashMap<i64, (i64, Value)> = HashMap::new();
    for (workspace_id, json) in rows {
        by_id.entry(workspace_id).or_insert((workspace_id, json));
    }
    let mut cache: HashMap<i64, RepoFields> = HashMap::new();
    for &workspace_id in workspace_ids {
        if let Some((_, json)) = by_id.get(&workspace_id) {
            cache.insert(workspace_id, extract_repo_fields(json));
        }
    }
    Ok(cache)
}

/// Legacy workspace resolution: base-table rows plus owner-shard migrated
/// rows, with migrated base index rows excluded.
///
/// `_list_migrated_legacy_tasks_by_ids` reads `(id, user_id)` index rows
/// from the base table, groups them by the owner's shard table, and loads
/// any migrated rows from that shard. `_exclude_migrated_legacy_index_rows`
/// then drops the base index rows whose ids also exist in the shard table
/// (the shard row wins).
async fn resolve_legacy_workspaces<M: Mysql>(
    mysql: &M,
    legacy_ids: &[i64],
) -> Result<Vec<(i64, Value)>, brz_mysql::MysqlError> {
    // `(id, user_id)` index rows provide each row's owner for shard routing.
    let owner_rows = query_workspace_owners(mysql, legacy_ids).await?;
    if owner_rows.is_empty() {
        return Ok(Vec::new());
    }
    // Group the legacy ids by owner shard table; migrated rows are read
    // from the shard, and their ids are excluded from the base rows.
    let mut ids_by_shard: BTreeMap<u32, Vec<i64>> = BTreeMap::new();
    for (workspace_id, owner_user_id) in &owner_rows {
        let slot = slot_from_user_id(*owner_user_id as u64);
        ids_by_shard
            .entry(physical_shard_for_slot(slot, shard_count_from_env()))
            .or_default()
            .push(*workspace_id);
    }
    let mut migrated_ids: HashSet<i64> = HashSet::new();
    let mut shard_rows: Vec<(i64, Value)> = Vec::new();
    for (shard, ids) in &ids_by_shard {
        let table = format!("tasks_{shard:04}");
        let rows = query_workspace_rows(mysql, &table, ids).await?;
        for (workspace_id, _) in &rows {
            migrated_ids.insert(*workspace_id);
        }
        shard_rows.extend(rows);
    }

    let mut result: Vec<(i64, Value)> = shard_rows;
    // Base index rows that were not migrated to a shard.
    let unmigrated: Vec<i64> = legacy_ids
        .iter()
        .copied()
        .filter(|workspace_id| !migrated_ids.contains(workspace_id))
        .collect();
    result.extend(query_workspace_rows(mysql, "tasks", &unmigrated).await?);
    Ok(result)
}

/// Query only `(id, user_id)` of base-table rows for owner grouping.
async fn query_workspace_owners<M: Mysql>(
    mysql: &M,
    ids: &[i64],
) -> Result<Vec<(i64, i64)>, brz_mysql::MysqlError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    let sql = format!("SELECT id, user_id FROM tasks WHERE id IN ({placeholders})");
    let rows: Vec<WorkspaceOwnerRow> = mysql.fetch_all(sql, ids.to_vec()).await?;
    Ok(rows.into_iter().map(|row| (row.id, row.user_id)).collect())
}

/// An `(id, user_id)` projection of a `tasks` row.
#[derive(Debug, FromMysqlRow)]
struct WorkspaceOwnerRow {
    id: i64,
    user_id: i64,
}
