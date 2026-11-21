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
use brz_mysql::{MysqlResult, MysqlService};
use brz_redis::Redis;

use super::resolution::KindRow;
use crate::permissions::EntityResolvers;

pub(crate) use wegent_capabilities::shell_lookup::resolve_shells;

/// `get_shell_by_name`'s search, returning the resolved Shell row.
pub async fn resolve_shell<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    user_id: i64,
    name: &str,
    namespace: &str,
) -> MysqlResult<Option<KindRow>> {
    let key = (user_id, name.to_owned(), namespace.to_owned());
    Ok(
        resolve_shells(mysql, resolvers, redis, std::slice::from_ref(&key))
            .await?
            .remove(&key)
            .map(std::sync::Arc::unwrap_or_clone),
    )
}

/// `_resolve_shell_info`'s extraction from the Shell CRD: `spec.shellType`
/// (default `Chat`) and `spec.baseImage`.
///
/// `ShellSpec.shellType` is `Field(..., validation_alias=AliasChoices(
/// "shellType", "runtime"))` (`app/schemas/kind.py:497-503`), so a Shell CRD
/// that stores its type under `runtime` resolves to that value — the recorded
/// `ClaudeCode` Shell has only `{"runtime": "ClaudeCode"}`. `AliasChoices`
/// takes the first *present* alias, so an explicit `shellType` is never
/// overridden by `runtime`; an empty one becomes the source's `Chat` default
/// (`request_builder.py:1577-1582`).
pub fn shell_info(shell_json: &serde_json::Value) -> (String, Option<String>) {
    let spec = shell_json.get("spec");
    let shell_type = spec
        .and_then(|spec| spec.get("shellType").or_else(|| spec.get("runtime")))
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
    use wegent_capabilities::shell_lookup::shell_named_public_statement;

    fn normalize(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn public_shell_reads_keep_the_requested_name_relation() {
        let public = normalize(&shell_named_public_statement(1));
        assert!(public.starts_with("SELECT anon_1.name AS anon_1_name, kinds.id AS kinds_id"));
        assert!(public.contains("FROM (SELECT ? AS name) AS anon_1"));
        assert!(public.contains("INNER JOIN kinds ON kinds.name = anon_1.name"));
        assert!(public.contains(
            "AND kinds.kind = 'Shell' AND kinds.user_id = 0 AND kinds.namespace = 'default'"
        ));
        assert!(public.ends_with("ORDER BY kinds.id"));
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

    /// A Shell CRD may carry its type only under `runtime`
    /// (`AliasChoices("shellType", "runtime")`, `app/schemas/kind.py:497-503`):
    /// the recorded `ClaudeCode` Shell is `{"runtime": "ClaudeCode"}` with no
    /// `shellType`, and resolving it as `Chat` would route the request to the
    /// chat-shell SSE target instead of the executor-manager HTTP+callback one.
    #[test]
    fn shell_info_reads_the_runtime_alias() {
        assert_eq!(
            shell_info(&json!({"spec": {"runtime": "ClaudeCode", "supportModel": ["claude"]}})),
            ("ClaudeCode".to_string(), None)
        );
    }

    /// `AliasChoices` takes the first alias that is present: a real
    /// `shellType` wins over `runtime`, and an explicit empty one stays the
    /// source's `Chat` default (`request_builder.py:1577-1582`) instead of
    /// falling through to `runtime`.
    #[test]
    fn shell_info_prefers_a_present_shell_type_over_the_runtime_alias() {
        assert_eq!(
            shell_info(&json!({"spec": {"shellType": "Agno", "runtime": "ClaudeCode"}})).0,
            "Agno"
        );
        assert_eq!(
            shell_info(&json!({"spec": {"shellType": "", "runtime": "ClaudeCode"}})).0,
            "Chat"
        );
    }
}
