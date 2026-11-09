// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Repository reads for `GET /api/v1/resources`.
//!
//! Mirrors `app/services/workspaces/personal_resources.py`
//! (`_list_owned_kinds`, `workspace_ids_for_resources`) and
//! `app/services/workspaces/storage.py`.
use brz_mysql::{FromMysqlRow, MysqlResult, MysqlService};

pub use wegent_resource_store::owned_kind::{KIND_COLUMNS, OwnedKindRow};

/// `_list_owned_kinds`: active owned kinds of one type, ordered by name then id.
pub async fn list_owned_kinds(
    mysql: &MysqlService,
    user_id: i64,
    kind: &str,
) -> MysqlResult<Vec<OwnedKindRow>> {
    let sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.kind = ? AND kinds.user_id = ? AND kinds.is_active IS true \
         ORDER BY kinds.name, kinds.id"
    );
    mysql.fetch_all(sql.as_str(), (kind, user_id)).await
}

/// `workspace_ids_for_resources`: the approved workspace `entity_id`s bound to
/// each resource, ordered by `entity_id`. Returns `(resource_id, entity_id)` in
/// the statement's row order.
pub async fn workspace_ids_for_resources(
    mysql: &MysqlService,
    resource_type: &str,
    resource_ids: &[i64],
) -> MysqlResult<Vec<(i64, String)>> {
    if resource_ids.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        resource_id: i64,
        entity_id: String,
    }
    let placeholders = crate::teams::teams_repository::placeholders(resource_ids.len());
    let sql = format!(
        "SELECT resource_members.resource_id AS resource_members_resource_id, \
         resource_members.entity_id AS resource_members_entity_id \
         FROM resource_members \
         WHERE resource_members.resource_type = ? \
         AND resource_members.resource_id IN ({placeholders}) \
         AND resource_members.entity_type = 'workspace' \
         AND resource_members.status = 'approved' \
         ORDER BY resource_members.entity_id"
    );
    let mut args: Vec<MysqlValue> = Vec::with_capacity(resource_ids.len() + 1);
    args.push(MysqlValue::Str(resource_type.to_string()));
    for id in resource_ids {
        args.push(MysqlValue::Int(*id));
    }
    let rows: Vec<Row> = mysql.fetch_all(sql.as_str(), args).await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.resource_id, row.entity_id))
        .collect())
}

/// A bound SQL value preserving the recorded token kind (integer columns bind
/// as `Int`, string literals as `Str`).
#[derive(Debug, Clone)]
pub enum MysqlValue {
    Int(i64),
    Str(String),
}

impl brz_mysql::MysqlValue for MysqlValue {
    fn write(self, writer: &mut brz_mysql::MysqlValueWriter) -> MysqlResult<()> {
        match self {
            Self::Int(value) => value.write(writer),
            Self::Str(value) => value.write(writer),
        }
    }
    fn encoded_size_hint(&self) -> usize {
        match self {
            Self::Int(value) => value.encoded_size_hint(),
            Self::Str(value) => value.encoded_size_hint(),
        }
    }
}
