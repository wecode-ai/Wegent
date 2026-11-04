// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shell resolution for the dispatch bot config
//! (`_resolve_shell_info` -> `app/services/adapters/shell_utils.get_shell_by_name`).
//!
//! Search order: the owner's private Shell, a Shell referenced into the
//! namespace, a group Shell (non-default namespace), then the public Shell
//! (`user_id = 0`, `default`). The recorded `queued` case resolves
//! `ClaudeCode` through a zero-row private read, a zero-row referenced read,
//! and the public Shell, so its `shell_type` comes from the public Shell CRD's
//! `spec.shellType`.
use brz_mysql::{MysqlResult, MysqlRow, MysqlService};
use brz_redis::Redis;

use super::resolution::{
    KindRow, first_requested_row, named_kind_rows, named_kind_rows_statement,
    namespace_ids_by_names_statement, referenced_listing, referenced_namespace_listing_statement,
    referenced_user_listing_statement,
};
use crate::permissions::{EntityResolvers, user_groups};
use crate::task_store_statements::StatementArg;
use crate::teams::teams_repository::placeholders;

/// `get_shell_by_name`'s owner read, through the Source's requested-names
/// relation (`resource_lookup_queries.py:30-42`).
pub fn shell_named_owner_statement(name_count: usize) -> String {
    named_kind_rows_statement(
        name_count,
        "kinds.kind = 'Shell' AND kinds.user_id = ? AND kinds.namespace = ?",
    )
}

/// `get_shell_by_name`'s group read, through the requested-names relation.
pub fn shell_named_group_statement(name_count: usize, group_count: usize) -> String {
    named_kind_rows_statement(
        name_count,
        &format!(
            "kinds.kind = 'Shell' AND kinds.namespace IN ({})",
            placeholders(group_count)
        ),
    )
}

/// `get_shell_by_name`'s public read (`user_id = 0`, `default`), through the
/// requested-names relation.
pub fn shell_named_public_statement(name_count: usize) -> String {
    named_kind_rows_statement(
        name_count,
        "kinds.kind = 'Shell' AND kinds.user_id = 0 AND kinds.namespace = 'default'",
    )
}

/// `ExecutionCapabilityLookup.referenced` for Shell: the scope's listing, then
/// the exact-name index (`capability_lookup.py:80-95,135-141`). A non-`Model`
/// reference is indexed by `source.name`, so the requested name is an exact
/// dictionary lookup rather than the database collation match.
async fn referenced_shell_lookup(
    mysql: &MysqlService,
    user_id: i64,
    name: &str,
    namespace: &str,
) -> MysqlResult<Option<KindRow>> {
    let (statement, arguments) = if namespace == "default" {
        (
            referenced_user_listing_statement("Shell"),
            vec![StatementArg::Str(user_id.to_string())],
        )
    } else {
        // `referenced("Shell", name, namespace)` before `lookup.groups` is
        // evaluated: only the requested namespace is a target.
        let ids = mysql
            .fetch_all::<_, _, MysqlRow>(
                &namespace_ids_by_names_statement(1),
                vec![StatementArg::Str(namespace.to_string())],
            )
            .await?;
        let mut target_ids = Vec::with_capacity(ids.len());
        for row in &ids {
            target_ids.push(row.get_at::<i64>(0)?.to_string());
        }
        if target_ids.is_empty() {
            return Ok(None);
        }
        (
            referenced_namespace_listing_statement("Shell", target_ids.len()),
            target_ids.into_iter().map(StatementArg::Str).collect(),
        )
    };
    let rows = referenced_listing(mysql, &statement, arguments).await?;
    Ok(rows
        .into_iter()
        .find(|row| row.kind.name == name)
        .map(|row| row.kind))
}

/// `get_shell_by_name`'s search, returning the resolved Shell row.
pub async fn resolve_shell<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    name: &str,
    namespace: &str,
) -> MysqlResult<Option<KindRow>> {
    let owner_rows = named_kind_rows(
        mysql,
        &shell_named_owner_statement(1),
        vec![
            StatementArg::Str(name.to_string()),
            StatementArg::Int(user_id),
            StatementArg::Str(namespace.to_string()),
        ],
    )
    .await?;
    if let Some(shell) = first_requested_row(owner_rows, name) {
        return Ok(Some(shell));
    }
    if let Some(shell) = referenced_shell_lookup(mysql, user_id, name, namespace).await? {
        return Ok(Some(shell));
    }
    // `get_shell_by_name` (`shell_utils.py:132-160`): the group read runs only
    // for a non-default namespace the caller belongs to.
    if namespace != "default" {
        let groups = user_groups(mysql, resolvers, redis, user_id).await?;
        if groups.iter().any(|group| group == namespace) {
            let group_rows = named_kind_rows(
                mysql,
                &shell_named_group_statement(1, 1),
                vec![
                    StatementArg::Str(name.to_string()),
                    StatementArg::Str(namespace.to_string()),
                ],
            )
            .await?;
            if let Some(shell) = first_requested_row(group_rows, name) {
                return Ok(Some(shell));
            }
        }
    }
    let public_rows = named_kind_rows(
        mysql,
        &shell_named_public_statement(1),
        vec![StatementArg::Str(name.to_string())],
    )
    .await?;
    Ok(first_requested_row(public_rows, name))
}

/// `_resolve_shell_info`'s extraction from the Shell CRD: `spec.shellType`
/// (default `Chat`) and `spec.baseImage`.
pub fn shell_info(shell_json: &serde_json::Value) -> (String, Option<String>) {
    let spec = shell_json.get("spec");
    let shell_type = spec
        .and_then(|spec| spec.get("shellType"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("Chat")
        .to_string();
    let base_image = spec
        .and_then(|spec| spec.get("baseImage"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    (shell_type, base_image)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn shell_reads_match_the_recorded_named_relation() {
        // Recorded seq 69/79: the requested name is the derived relation's
        // key, the filters follow, and every row is fetched in `Kind.id`
        // order for the first-row-per-name selection.
        let owner = normalize(&shell_named_owner_statement(1));
        assert!(owner.starts_with("SELECT anon_1.name AS anon_1_name, kinds.id AS kinds_id"));
        assert!(owner.contains("FROM (SELECT ? AS name) AS anon_1"));
        assert!(owner.contains("INNER JOIN kinds ON kinds.name = anon_1.name"));
        assert!(owner.contains(
            "WHERE kinds.is_active IS true AND kinds.kind = 'Shell' \
             AND kinds.user_id = ? AND kinds.namespace = ?"
        ));
        assert!(owner.ends_with("ORDER BY kinds.id"), "{owner}");
        let group = normalize(&shell_named_group_statement(1, 1));
        assert!(group.contains("AND kinds.namespace IN (?)"), "{group}");
        let public = normalize(&shell_named_public_statement(1));
        assert!(public.contains(
            "AND kinds.kind = 'Shell' AND kinds.user_id = 0 AND kinds.namespace = 'default'"
        ));
        // `referenced("Shell", …)` now uses the shared namespace/user listing
        // (`referenced_listing_matches_the_source_scope_queries`).
    }

    #[test]
    fn shell_info_reads_type_and_image() {
        assert_eq!(
            shell_info(&json!({"spec": {"shellType": "ClaudeCode", "baseImage": "img"}})),
            ("ClaudeCode".to_string(), Some("img".to_string()))
        );
        // Missing shellType defaults to Chat; a null baseImage is none.
        assert_eq!(
            shell_info(&json!({"spec": {"baseImage": null}})),
            ("Chat".to_string(), None)
        );
    }
}
