// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Batched Team/Bot/Ghost dependency reader (`TeamReadinessContext.reader`).
//!
//! Mirrors `app/services/execution/readiness_context.py::_DependencyReader`:
//! the readiness check prefetches every member Bot, then every referenced
//! Ghost, with one derived-relation read per batch of 128 references. Each
//! read carries the source's personal/public/group selection predicate, so
//! the per-member validation issues no further `kinds` reads.

use std::collections::HashMap;

use brz_mysql::{FromMysqlRow, MysqlRow};

use crate::ResourceReadinessState;
use crate::http_compat::FastApiError;
use crate::sql_support::StatementArg;
use wegent_resource_store::kind_rows::{KIND_COLUMNS, KindRow};

/// One `(owner, kind, namespace, name)` dependency reference.
pub type DependencyRef = (i64, String, String, String);

/// `lookup_batches`' batch bound.
const LOOKUP_BATCH: usize = 128;

/// Kinds that fall back to the public (`user_id = 0`) row
/// (`PUBLIC_FALLBACK_KINDS` in `app/services/readers/kinds.py`).
fn public_fallback_kind(kind: &str) -> bool {
    matches!(
        kind,
        "Model" | "Shell" | "Skill" | "Ghost" | "Retriever" | "Bot"
    )
}

/// `_DependencyReader`: prefetched rows keyed by owner identity and by group
/// scope.
#[derive(Debug, Default)]
pub struct DependencyReader {
    owned: HashMap<DependencyRef, KindRow>,
    groups: HashMap<(String, String, String), KindRow>,
}

impl DependencyReader {
    /// `reader.load(references)`: one derived-relation read per batch of 128
    /// sorted references.
    pub async fn load(
        &mut self,
        state: &ResourceReadinessState,
        references: &[DependencyRef],
    ) -> Result<(), FastApiError> {
        for batch in references.chunks(LOOKUP_BATCH) {
            let statement = dependency_load_statement(batch.len());
            let mut arguments: Vec<StatementArg> = Vec::with_capacity(batch.len() * 5);
            for (owner, kind, namespace, name) in batch {
                arguments.push(StatementArg::Int(*owner));
                arguments.push(StatementArg::Str(kind.clone()));
                arguments.push(StatementArg::Str(namespace.clone()));
                arguments.push(StatementArg::Str(name.clone()));
                arguments.push(StatementArg::Int(i64::from(namespace == "default")));
            }
            let rows: Vec<MysqlRow> = state
                .mysql
                .fetch_all::<_, _, MysqlRow>(statement.as_str(), arguments)
                .await
                .map_err(super::capability_lookup::internal)?;
            for row in rows {
                let kind = row
                    .get_at::<String>(0)
                    .map_err(super::capability_lookup::internal)?;
                let namespace = row
                    .get_at::<String>(1)
                    .map_err(super::capability_lookup::internal)?;
                let name = row
                    .get_at::<String>(2)
                    .map_err(super::capability_lookup::internal)?;
                let kind_row =
                    KindRow::from_mysql_row(row).map_err(super::capability_lookup::internal)?;
                self.owned
                    .entry((
                        kind_row.user_id,
                        kind.clone(),
                        namespace.clone(),
                        name.clone(),
                    ))
                    .or_insert_with(|| kind_row.clone());
                self.groups
                    .entry((kind, namespace, name))
                    .or_insert(kind_row);
            }
        }
        Ok(())
    }

    /// `KindReader.get_by_name_and_namespace` over the prefetched rows:
    /// group scope for a non-default namespace, then the owner's personal row,
    /// then the public fallback.
    pub fn get(&self, user_id: i64, kind: &str, namespace: &str, name: &str) -> Option<&KindRow> {
        if namespace != "default" {
            return self
                .groups
                .get(&(kind.to_string(), namespace.to_string(), name.to_string()));
        }
        if user_id != 0
            && let Some(row) = self.owned.get(&(
                user_id,
                kind.to_string(),
                namespace.to_string(),
                name.to_string(),
            ))
        {
            return Some(row);
        }
        if public_fallback_kind(kind) {
            return self
                .owned
                .get(&(0, kind.to_string(), namespace.to_string(), name.to_string()));
        }
        None
    }
}

/// `_DependencyReader.load`'s SQLAlchemy rendering: the derived reference
/// relation joined to `kinds` with the personal/public/group predicate.
fn dependency_load_statement(count: usize) -> String {
    let relation =
        vec!["SELECT ? AS owner, ? AS kind, ? AS namespace, ? AS name, ? AS personal"; count]
            .join(" UNION ALL ");
    format!(
        "SELECT anon_1.kind AS anon_1_kind, anon_1.namespace AS anon_1_namespace, \
         anon_1.name AS anon_1_name, {KIND_COLUMNS} \n\
         FROM ({relation}) AS anon_1 \n\
         INNER JOIN kinds ON kinds.kind = anon_1.kind AND kinds.namespace = anon_1.namespace \
         AND kinds.name = anon_1.name \n\
         AND (anon_1.personal = 0 OR kinds.user_id = anon_1.owner OR kinds.user_id = 0) \n\
         WHERE kinds.is_active IS true ORDER BY kinds.id"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The dependency prefetch carries the reference columns in the source's
    /// order and the oracle-free personal/public/group predicate.
    #[test]
    fn dependency_load_statement_carries_the_reference_relation() {
        let statement = dependency_load_statement(2);
        assert!(
            statement
                .contains("SELECT ? AS owner, ? AS kind, ? AS namespace, ? AS name, ? AS personal")
        );
        assert!(statement.contains(
            "AND (anon_1.personal = 0 OR kinds.user_id = anon_1.owner OR kinds.user_id = 0)"
        ));
        assert!(statement.contains("ORDER BY kinds.id"));
    }

    /// A non-default namespace resolves only through the group index, exactly
    /// like `KindReader.get_group`.
    #[test]
    fn group_scope_never_falls_back_to_public() {
        let reader = DependencyReader::default();
        assert!(reader.get(158, "Bot", "my_group", "bot").is_none());
    }
}
