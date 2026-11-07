// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Kind row projections and the Source's batch-lookup SQL.
//!
//! These builders mirror the recorded SQLAlchemy statements: the ORM-style
//! `kinds_*` projection, the requested-names derived relation
//! (`resource_lookup_queries.py:30-42`), the approved-reference listing
//! (`capability_reference_service.py:99-156`), and the `Kind.id IN (...)` name
//! matcher. Visibility and selection policy remain with the consuming domain.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlRow};
use serde_json::Value;

use wegent_backend_persistence::sql_support::StatementArg;
use wegent_backend_persistence::sql_support::placeholders;

/// `kinds` columns as rendered by `db.query(Kind)`.
pub const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// One `kinds` row, decoded from [`KIND_COLUMNS`].
#[derive(Debug, FromMysqlRow)]
pub struct KindRow {
    #[mysql(rename = "kinds_id")]
    pub id: i64,
    #[mysql(rename = "kinds_user_id")]
    pub user_id: i64,
    #[mysql(rename = "kinds_kind")]
    pub kind: String,
    #[mysql(rename = "kinds_name")]
    pub name: String,
    #[mysql(rename = "kinds_namespace")]
    pub namespace: String,
    #[mysql(rename = "kinds_json")]
    pub json: Json<serde_json::Value>,
    #[mysql(rename = "kinds_is_active")]
    pub is_active: i8,
    #[mysql(rename = "kinds_created_at")]
    pub created_at: Option<chrono::NaiveDateTime>,
    #[mysql(rename = "kinds_updated_at")]
    pub updated_at: Option<chrono::NaiveDateTime>,
}

/// One `named_kind_rows` row (`resource_lookup_queries.py:30-42`): the
/// derived `requested.name` lookup key plus the physical `kinds` row.
pub struct NamedKindRow {
    pub requested_name: String,
    pub kind: KindRow,
}

/// `named_kind_rows`: the parameterized requested-names relation joined to
/// `kinds`.
///
/// The derived column is the lookup key; `Kind.name` cannot replace it because
/// the database collation may match different bytes (`'A'`/`'a'`), and the
/// Source's dictionary is keyed by the requested name. The derived literals
/// bind as `?`; `ORDER BY kinds.id` is the Source's first-row selection order.
pub fn named_kind_rows_statement(name_count: usize, filters: &str) -> String {
    let relation = vec!["SELECT ? AS name"; name_count].join(" UNION ALL ");
    format!(
        "SELECT anon_1.name AS anon_1_name, {KIND_COLUMNS} \n\
         FROM ({relation}) AS anon_1 \n\
         INNER JOIN kinds ON kinds.name = anon_1.name \n\
         WHERE kinds.is_active IS true AND {filters} \nORDER BY kinds.id"
    )
}

/// Fetch every `named_kind_rows` row for one scope.
pub async fn named_kind_rows<M: Mysql>(
    mysql: &M,
    statement: &str,
    arguments: Vec<StatementArg>,
) -> MysqlResult<Vec<NamedKindRow>> {
    let rows = mysql
        .fetch_all::<_, _, MysqlRow>(statement, arguments)
        .await?;
    rows.into_iter()
        .map(|row| {
            let requested_name = row.get_at::<String>(0)?;
            Ok(NamedKindRow {
                requested_name,
                kind: KindRow::from_mysql_row(row)?,
            })
        })
        .collect()
}

/// `capability_lookup.py:139-141`: the first row in `Kind.id` order wins for
/// the requested name.
pub fn first_requested_row(rows: Vec<NamedKindRow>, name: &str) -> Option<KindRow> {
    rows.into_iter()
        .find(|row| row.requested_name == name)
        .map(|row| row.kind)
}

/// `_include_model_pointers` (`capability_lookup.py:145-160`): a row whose
/// `modelConfig` carries no inline `env` points at another Model through
/// `bind_model`, and that target joins the next batched read — so trailing rows
/// still affect the subsequent name set.
pub fn bind_model_pointers(rows: &[NamedKindRow]) -> Vec<String> {
    pointers_from_rows(rows.iter().map(|row| &row.kind))
}

/// [`bind_model_pointers`] over the referenced listing's source rows.
pub fn referenced_bind_model_pointers(rows: &[ReferencedCapabilityRow]) -> Vec<String> {
    pointers_from_rows(rows.iter().map(|row| &row.kind))
}

pub fn pointers_from_rows<'a>(rows: impl IntoIterator<Item = &'a KindRow>) -> Vec<String> {
    let mut pointers = Vec::new();
    for kind in rows {
        let Some(config) = kind
            .json
            .0
            .get("spec")
            .and_then(|spec| spec.get("modelConfig"))
        else {
            continue;
        };
        let has_env = config
            .get("env")
            .is_some_and(brz_json::adapters::python_truthy);
        let pointer = config.get("bind_model").and_then(Value::as_str);
        if let (false, Some(pointer)) = (has_env, pointer) {
            let pointer = pointer.trim();
            if !pointer.is_empty() && !pointers.iter().any(|known| known == pointer) {
                pointers.push(pointer.to_string());
            }
        }
    }
    pointers
}

/// Append `extra` names that the current batch has not covered yet.
pub fn extend_pending(pending: &mut Vec<String>, extra: Vec<String>) {
    for name in extra {
        if !pending.iter().any(|known| known == &name) {
            pending.push(name);
        }
    }
}

/// The bound arguments for one named-relation read: the requested names first
/// (they occupy the derived table's placeholders), then the scope filters.
pub fn named_rows_arguments(
    names: &[String],
    tail: impl IntoIterator<Item = StatementArg>,
) -> Vec<StatementArg> {
    let mut arguments: Vec<StatementArg> = names.iter().cloned().map(StatementArg::Str).collect();
    arguments.extend(tail);
    arguments
}

/// One `capability_reference_service.list_referenced_capabilities_by_namespace`
/// row: the member identity plus the referenced source Kind.
#[derive(Debug)]
pub struct ReferencedCapabilityRow {
    pub entity_type: String,
    pub entity_id: String,
    pub kind: KindRow,
}

/// `list_referenced_capabilities_by_namespace`'s `default` scope listing
/// (`capability_reference_service.py:123-149`): the approved references into
/// the caller's user target, joined to every source row and ordered by
/// `Kind.id`. All rows are fetched; the requested name is matched afterwards.
pub fn referenced_user_listing_statement(kind: &str) -> String {
    referenced_listing_statement(
        kind,
        "resource_members.entity_type = 'user' AND resource_members.entity_id IN (?)",
    )
}

/// The same listing for namespace targets (group scopes).
pub fn referenced_namespace_listing_statement(kind: &str, target_count: usize) -> String {
    referenced_listing_statement(
        kind,
        &format!(
            "resource_members.entity_type = 'namespace' AND resource_members.entity_id IN ({})",
            placeholders(target_count)
        ),
    )
}

pub fn referenced_listing_statement(kind: &str, target_filter: &str) -> String {
    format!(
        "SELECT resource_members.entity_type AS resource_members_entity_type, \
         resource_members.entity_id AS resource_members_entity_id, {KIND_COLUMNS} \n\
         FROM resource_members INNER JOIN kinds ON kinds.id = resource_members.resource_id \n\
         WHERE resource_members.resource_type = '{kind}' \
         AND resource_members.status = 'approved' \n\
         AND {target_filter} \n\
         AND kinds.kind = '{kind}' AND kinds.user_id != 0 \
         AND kinds.is_active IS true \nORDER BY kinds.id"
    )
}

/// `Namespace.id/name` batch read for the group reference targets
/// (`capability_reference_service.py:115-120`).
pub fn namespace_ids_by_names_statement(name_count: usize) -> String {
    format!(
        "SELECT namespace.id AS namespace_id, namespace.name AS namespace_name \n\
         FROM namespace \nWHERE namespace.name IN ({}) \
         AND namespace.is_active IS true",
        placeholders(name_count)
    )
}

/// Fetch every referenced-capability listing row for one scope.
pub async fn referenced_listing<M: Mysql>(
    mysql: &M,
    statement: &str,
    arguments: Vec<StatementArg>,
) -> MysqlResult<Vec<ReferencedCapabilityRow>> {
    let rows = mysql
        .fetch_all::<_, _, MysqlRow>(statement, arguments)
        .await?;
    rows.into_iter()
        .map(|row| {
            let entity_type = row.get_at::<String>(0)?;
            let entity_id = row.get_at::<String>(1)?;
            Ok(ReferencedCapabilityRow {
                entity_type,
                entity_id,
                kind: KindRow::from_mysql_row(row)?,
            })
        })
        .collect()
}

/// `_match_model_reference_names`'s named read
/// (`capability_lookup.py:120-134`): the pending names restricted to the
/// listed source ids.
pub fn named_reference_match_statement(name_count: usize, target_count: usize) -> String {
    named_kind_rows_statement(
        name_count,
        &format!(
            "kinds.kind = 'Model' AND kinds.id IN ({})",
            placeholders(target_count)
        ),
    )
}

/// `KindReader.get_by_id` for a Team (`kinds.id` + `kind = 'Team'`).
pub fn team_by_id_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id = ? \
         AND kinds.kind = 'Team' AND kinds.is_active IS true \n LIMIT 1"
    )
}

/// `_get_team_by_share_permission`'s candidate read: one owner's Team by
/// name/namespace (`is_active = true`).
pub fn team_by_owner_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
         AND kinds.kind = 'Team' AND kinds.namespace = ? AND kinds.name = ? \
         AND kinds.is_active = true \n LIMIT 1"
    )
}

/// The name-first variant recorded for the group path: one owner's Team by
/// name/namespace with `is_active IS true`.
pub fn team_by_owner_name_first_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = ? \
         AND kinds.kind = 'Team' AND kinds.name = ? AND kinds.namespace = ? \
         AND kinds.is_active IS true \n LIMIT 1"
    )
}

/// `resolve_model_kind`'s direct read (`shared/db/capability_reference.py`):
/// the requested Model by name/namespace. A non-`default` namespace orders by
/// `id ASC` (oldest duplicate wins); the `default` namespace restricts to the
/// caller's own or the public (`user_id = 0`) Model, newest owner first.
pub fn model_by_name_namespace_statement(namespace: &str) -> String {
    let scope = if namespace == "default" {
        " AND (kinds.user_id = ? OR kinds.user_id = 0) \
         \nORDER BY kinds.user_id DESC, kinds.id ASC"
    } else {
        "\nORDER BY kinds.id ASC"
    };
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'Model' \
         AND kinds.name = ? AND kinds.namespace = ? AND kinds.is_active IS true{scope} \
         LIMIT 1"
    )
}

/// `_reference_scope`'s namespace id read (`capability_reference.py`): the
/// scalar `namespace.id` for the referenced-capability scope of a non-default
/// namespace. A missing namespace ends the referenced resolution.
pub fn namespace_id_statement() -> String {
    "SELECT namespace.id \nFROM namespace \nWHERE namespace.name = ? \
     AND namespace.is_active IS true"
        .to_string()
}

/// `resolve_referenced_model_kind` (`capability_reference.py`): the
/// smallest-id approved Model shared into the caller-visible scope.
pub fn referenced_model_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.id IN \
         (SELECT resource_members.resource_id \nFROM resource_members \
         \nWHERE resource_members.resource_type = 'Model' \
         AND resource_members.entity_type = ? AND resource_members.entity_id = ? \
         AND resource_members.status = 'approved') \
         AND kinds.kind = 'Model' AND kinds.name = ? AND kinds.user_id != 0 \
         AND kinds.is_active IS true \nORDER BY kinds.id ASC LIMIT 1"
    )
}
