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
use brz_mysql::{Mysql, MysqlResult};

use super::resolution::{KIND_COLUMNS, KindRow};
use crate::teams::teams_repository::placeholders;

/// `get_shell_by_name`: the owner's private Shell.
pub fn shell_by_owner_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
         AND kinds.kind = 'Shell' AND kinds.name = ? AND kinds.namespace = ? \
         AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `get_referenced_capability(kind='Shell')`: a Shell shared into the caller's
/// namespace through an approved membership.
pub fn shell_referenced_statement() -> String {
    format!(
        "SELECT resource_members.entity_type AS resource_members_entity_type, \
         resource_members.entity_id AS resource_members_entity_id, \
         {KIND_COLUMNS} \nFROM resource_members \
         INNER JOIN kinds ON kinds.id = resource_members.resource_id \n\
         WHERE resource_members.resource_type = 'Shell' \
         AND resource_members.status = 'approved' \
         AND resource_members.entity_type = 'user' \
         AND resource_members.entity_id IN ({entity}) \
         AND kinds.kind = 'Shell' AND kinds.user_id != 0 \
         AND kinds.is_active IS true \nORDER BY kinds.id",
        entity = placeholders(1)
    )
}

/// `get_shell_by_name`: a group Shell in one namespace (non-default).
pub fn shell_group_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'Shell' \
         AND kinds.name = ? AND kinds.namespace = ? AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `get_shell_by_name`: the public Shell (`user_id = 0`, `default`).
pub fn shell_public_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = 0 \
         AND kinds.kind = 'Shell' AND kinds.name = ? AND kinds.namespace = 'default' \
         AND kinds.is_active = true \n LIMIT 1"
    )
}

/// `get_shell_by_name`'s search, returning the resolved Shell row.
pub async fn resolve_shell<M: Mysql>(
    mysql: &M,
    user_id: i64,
    name: &str,
    namespace: &str,
) -> MysqlResult<Option<KindRow>> {
    if let Some(shell) = mysql
        .fetch_optional::<_, _, KindRow>(shell_by_owner_statement(), (user_id, name, namespace))
        .await?
    {
        return Ok(Some(shell));
    }
    if let Some(shell) = mysql
        .fetch_optional::<_, _, KindRow>(shell_referenced_statement(), (user_id.to_string(),))
        .await?
    {
        return Ok(Some(shell));
    }
    if namespace != "default"
        && let Some(shell) = mysql
            .fetch_optional::<_, _, KindRow>(shell_group_statement(), (name, namespace))
            .await?
    {
        return Ok(Some(shell));
    }
    mysql
        .fetch_optional::<_, _, KindRow>(shell_public_statement(), (name,))
        .await
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
    fn shell_reads_match_the_recorded_statements() {
        let owner = normalize(&shell_by_owner_statement());
        assert!(owner.contains(
            "WHERE kinds.user_id = ? AND kinds.kind = 'Shell' AND kinds.name = ? \
             AND kinds.namespace = ? AND kinds.is_active = true LIMIT 1"
        ));
        let public = normalize(&shell_public_statement());
        assert!(public.contains("WHERE kinds.user_id = 0 AND kinds.kind = 'Shell'"));
        assert!(public.contains("AND kinds.namespace = 'default'"));
        let referenced = normalize(&shell_referenced_statement());
        assert!(referenced.contains(
            "FROM resource_members INNER JOIN kinds ON kinds.id = resource_members.resource_id"
        ));
        assert!(referenced.contains("resource_members.resource_type = 'Shell'"));
        assert!(referenced.contains("resource_members.entity_id IN (?)"));
        assert!(referenced.contains("kinds.user_id != 0"));
        assert!(referenced.contains("ORDER BY kinds.id"));
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
