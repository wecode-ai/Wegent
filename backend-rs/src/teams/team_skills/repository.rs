// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MySQL data access for `GET /api/teams/{team_id}/skills`.
//!
//! Mirrors the source SQLAlchemy renderings token-for-token: the full
//! `kinds` projection (labeled `kinds_<column>`) and the
//! `resource_members` projection used by the share-access check. Variable
//! values are bound as `?` parameters; the replay matcher materializes them
//! against the recorded inline literals.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;

use super::super::teams_repository::KIND_COLUMNS;

/// The CRD `json` column payload of a `kinds` row. The source stores the
/// full Kubernetes-style CRD document here; the team-skills endpoint
/// deserializes the `spec` sub-object into typed `TeamSpec`/`BotSpec`/
/// `GhostSpec` structs (see `handler.rs`). The payload is kept as the
/// driver's `Json` wrapper around an opaque raw JSON value (the CRD
/// document is not fully typed at the repository layer), matching the
/// existing `kinds` repositories.
pub(crate) type KindJson = Json<serde_json::value::Value>;

/// One `kinds` row loaded by the team-skills chain (Team, Bot, Ghost). The
/// projection mirrors the source `db.query(Kind)` column list (labeled
/// `kinds_<column>`); fields the endpoint does not read carry
/// `#[allow(dead_code)]`.
#[derive(Debug, Clone, FromMysqlRow)]
pub struct KindRow {
    #[allow(dead_code)]
    pub kinds_id: i64,
    #[allow(dead_code)]
    pub kinds_user_id: i64,
    #[allow(dead_code)]
    pub kinds_kind: String,
    #[allow(dead_code)]
    pub kinds_name: String,
    pub kinds_namespace: String,
    pub kinds_json: KindJson,
    #[allow(dead_code)]
    pub kinds_is_active: i8,
    #[allow(dead_code)]
    pub kinds_created_at: NaiveDateTime,
    #[allow(dead_code)]
    pub kinds_updated_at: NaiveDateTime,
}

/// `KindReader.get_by_id` for the Team kind: one
/// active Team `kinds` row by id. The source inlines the id as a text
/// literal; the target binds it as a parameter, which the replay matcher
/// accepts. Retained for callers that use the repository directly.
#[allow(dead_code)]
pub async fn team_by_id<M>(mysql: &M, team_id: i64) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \n\
                 WHERE kinds.id = ? AND kinds.kind = 'Team' \
                 AND kinds.is_active = true \n LIMIT 1"
            )
            .as_str(),
            (team_id,),
        )
        .await
}

/// `batch_load_kinds_by_refs` personal rows: the user's active kinds with
/// the given names in the `default` namespace. `names` keeps the caller's
/// order.
pub async fn kinds_by_names<M>(
    mysql: &M,
    user_id: i64,
    kind: &str,
    names: &[(String, String)],
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let list = names
        .iter()
        .map(|(_, name)| format!("'{}'", escape_sql_string(name)))
        .collect::<Vec<String>>()
        .join(", ");
    mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
             AND kinds.kind = '{kind}' AND kinds.namespace = 'default' \
             AND kinds.name IN ({list}) AND kinds.is_active = true"
            ),
            (user_id,),
        )
        .await
}

/// `batch_load_kinds_by_refs` public rows (`user_id = 0`). Retained for
/// parity with the source's `KindReader.get_public` repository path.
#[allow(dead_code)]
pub async fn public_kinds_by_names<M>(
    mysql: &M,
    kind: &str,
    names: &[(String, String)],
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let list = names
        .iter()
        .map(|(_, name)| format!("'{}'", escape_sql_string(name)))
        .collect::<Vec<String>>()
        .join(", ");
    mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = 0 \
             AND kinds.kind = '{kind}' AND kinds.namespace = 'default' \
             AND kinds.name IN ({list}) AND kinds.is_active = true"
            ),
            (),
        )
        .await
}

/// `batch_load_kinds_by_refs` group rows (namespace-scoped). Retained for
/// parity with the source's `KindReader.get_group` repository path.
#[allow(dead_code)]
pub async fn group_kinds_by_names<M>(
    mysql: &M,
    kind: &str,
    refs: &[(String, String)],
) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let namespace_list = refs
        .iter()
        .map(|(namespace, _)| format!("'{}'", escape_sql_string(namespace)))
        .collect::<Vec<String>>()
        .join(", ");
    let name_list = refs
        .iter()
        .map(|(_, name)| format!("'{}'", escape_sql_string(name)))
        .collect::<Vec<String>>()
        .join(", ");
    mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = '{kind}' \
             AND kinds.namespace IN ({namespace_list}) \
             AND kinds.name IN ({name_list}) AND kinds.is_active = true"
            ),
            (),
        )
        .await
}

/// The source `get_team_skills` share-access check
/// (`db.query(ResourceMember).filter(resource_type == Team, resource_id,
/// entity_type == 'user', entity_id == str(user_id), status == approved)`):
/// one row is enough to grant access. The source `get_team_skills` uses the
/// strict `ResourceType.TEAM` / `MemberStatus.APPROVED` enum values
/// (rendered as `'Team'` and `'approved'`), not the dual-value `IN` lists
/// the team-union query uses.
pub async fn shared_team_member<M>(mysql: &M, team_id: i64, user_id: i64) -> MysqlResult<bool>
where
    M: Mysql,
{
    #[derive(FromMysqlRow)]
    struct MemberId {
        #[allow(dead_code)]
        resource_members_id: i64,
    }
    let row: Option<MemberId> = mysql
        .fetch_optional(
            "SELECT resource_members.id AS resource_members_id \nFROM resource_members \n\
             WHERE resource_members.resource_type IN ('Team', 'TEAM') \
             AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status IN ('approved', 'APPROVED') \n LIMIT 1",
            (team_id, user_id.to_string()),
        )
        .await?;
    Ok(row.is_some())
}

/// Escape one string literal with MySQL's default quoting rules (the same
/// helper the kind-ref queries use for inline COM_QUERY literals).
fn escape_sql_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
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
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_single_quotes_and_backslashes() {
        assert_eq!(escape_sql_string("a'b"), "a\\'b");
        assert_eq!(escape_sql_string("a\\b"), "a\\\\b");
        assert_eq!(escape_sql_string("wegent-chat"), "wegent-chat");
    }
}
