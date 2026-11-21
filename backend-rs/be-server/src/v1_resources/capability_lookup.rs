// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Request-local batched capability reads (`ExecutionCapabilityLookup`).
//!
//! Mirrors `app/services/capability_lookup.py` and the SQL that
//! `app/services/resource_lookup_queries.py` and
//! `app/services/capability_reference_service.py` render. The endpoint builds
//! one lookup per execution identity; every `personal`/`public`/`group` read
//! batches the names still missing from its scope, and every `referenced`
//! read loads the approved-reference listing for a namespace group once.
//! That batching is observable: the recorded Ready check issues one Shell
//! batch, one Model batch and one reference listing rather than one statement
//! per name.

use std::collections::{BTreeSet, HashMap};

use brz_mysql::MysqlRow;
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::sql_support::{StatementArg, placeholders};
use crate::state::AppState;
use wegent_access::group_membership::{ErpContext, effective_roles, user_group_memberships};
use wegent_resource_store::kind_rows::{
    KindRow, ReferencedCapabilityRow, bind_model_pointers, named_kind_rows,
    named_kind_rows_statement, named_reference_match_statement, named_rows_arguments,
    namespace_ids_by_names_statement, pointers_from_rows, referenced_listing,
    referenced_listing_statement,
};

/// Kinds `list_referenced_capabilities_by_namespace` resolves.
const REFERENCE_KINDS: [&str; 4] = ["Model", "Shell", "Retriever", "Template"];

/// Scope key for one `_read_direct` name index.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum DirectScope {
    Personal(Option<String>),
    Public,
    Group(Vec<String>),
}

/// Request-local `ExecutionCapabilityLookup` for one execution identity.
pub struct CapabilityLookup<'a> {
    state: &'a AppState,
    pub user_id: i64,
    /// `names`: pending/resolved lookup names per kind (sorted like the
    /// source's `sorted(names)` before each batch).
    names: HashMap<String, BTreeSet<String>>,
    /// `_direct`: per-kind and scope name -> resolved row or recorded miss.
    direct: HashMap<(String, DirectScope), HashMap<String, Option<KindRow>>>,
    /// `_references[kind][namespace]`: target-visible name -> source row.
    references: HashMap<(String, String), HashMap<String, KindRow>>,
    /// `_model_reference_sources`: per-namespace Model sources, in listing
    /// order.
    model_reference_sources: Vec<(String, Vec<KindRow>)>,
    /// `_model_reference_names`: names already matched by the reference read.
    model_reference_names: BTreeSet<String>,
    /// `_group_names`: `get_user_groups`, resolved once per lookup.
    group_names: Option<Vec<String>>,
}

impl<'a> CapabilityLookup<'a> {
    pub fn new(state: &'a AppState, user_id: i64) -> Self {
        Self {
            state,
            user_id,
            names: HashMap::new(),
            direct: HashMap::new(),
            references: HashMap::new(),
            model_reference_sources: Vec::new(),
            model_reference_names: BTreeSet::new(),
            group_names: None,
        }
    }

    /// `self.names[kind].add(name)`: collect a dependency name without a read.
    pub fn add_name(&mut self, kind: &str, name: &str) {
        self.names
            .entry(kind.to_string())
            .or_default()
            .insert(name.to_string());
    }

    /// `lookup.personal(kind, name, namespace)`: active kind rows owned by
    /// this identity. `namespace` is `None` for the Model search, which the
    /// source does not namespace-scope.
    pub async fn personal(
        &mut self,
        kind: &str,
        name: &str,
        namespace: Option<&str>,
    ) -> Result<Option<KindRow>, FastApiError> {
        let mut filters = format!("kinds.kind = '{kind}' AND kinds.user_id = ?");
        let mut tail = vec![StatementArg::Int(self.user_id)];
        if let Some(namespace) = namespace {
            filters.push_str(" AND kinds.namespace = ?");
            tail.push(StatementArg::Str(namespace.to_string()));
        }
        self.read_direct(
            kind,
            name,
            DirectScope::Personal(namespace.map(str::to_string)),
            filters,
            tail,
        )
        .await
    }

    /// `lookup.public(kind, name)`: the public (`user_id = 0`) row in the
    /// default namespace.
    pub async fn public(
        &mut self,
        kind: &str,
        name: &str,
    ) -> Result<Option<KindRow>, FastApiError> {
        let filters =
            format!("kinds.kind = '{kind}' AND kinds.user_id = 0 AND kinds.namespace = 'default'");
        self.read_direct(kind, name, DirectScope::Public, filters, Vec::new())
            .await
    }

    /// `lookup.group(kind, name, namespaces)`: the first authorized group
    /// row by name.
    pub async fn group(
        &mut self,
        kind: &str,
        name: &str,
        namespaces: &[String],
    ) -> Result<Option<KindRow>, FastApiError> {
        if namespaces.is_empty() {
            return Ok(None);
        }
        let filters = format!(
            "kinds.kind = '{kind}' AND kinds.namespace IN ({})",
            placeholders(namespaces.len())
        );
        let tail = namespaces
            .iter()
            .cloned()
            .map(StatementArg::Str)
            .collect::<Vec<_>>();
        self.read_direct(
            kind,
            name,
            DirectScope::Group(namespaces.to_vec()),
            filters,
            tail,
        )
        .await
    }

    /// `lookup.referenced(kind, name, namespace)`: the approved reference
    /// listing for the requested namespace scope, then the name match.
    pub async fn referenced(
        &mut self,
        kind: &str,
        name: &str,
        namespace: &str,
    ) -> Result<Option<KindRow>, FastApiError> {
        let key = (kind.to_string(), namespace.to_string());
        if !self.references.contains_key(&key) {
            let candidates: Vec<String> = if namespace == "default" {
                vec!["default".to_string()]
            } else {
                let mut scopes = vec![namespace.to_string()];
                for group in self.groups().await? {
                    if !scopes.contains(&group) {
                        scopes.push(group);
                    }
                }
                scopes
            };
            let scopes_to_load: Vec<String> = candidates
                .into_iter()
                .filter(|scope| {
                    !self
                        .references
                        .contains_key(&(kind.to_string(), scope.clone()))
                })
                .collect();
            if !scopes_to_load.is_empty() {
                let listings = self.list_referenced(kind, &scopes_to_load).await?;
                for (target, sources) in listings {
                    if kind == "Model" {
                        let pointers = pointers_from_rows(&sources);
                        self.references
                            .insert((kind.to_string(), target.clone()), HashMap::new());
                        self.model_reference_sources.push((target, sources));
                        let names = self.names.entry("Model".to_string()).or_default();
                        for pointer in pointers {
                            names.insert(pointer);
                        }
                    } else {
                        let mut index: HashMap<String, KindRow> = HashMap::new();
                        for source in sources {
                            index.entry(source.name.clone()).or_insert(source);
                        }
                        self.references.insert((kind.to_string(), target), index);
                    }
                }
                if kind == "Model" {
                    self.model_reference_names.clear();
                }
            }
        }
        if kind == "Model" {
            self.match_model_reference_names(name).await?;
        }
        Ok(self
            .references
            .get(&key)
            .and_then(|index| index.get(name))
            .cloned())
    }

    /// `lookup.groups` (`get_user_groups`): sorted effective group names,
    /// resolved once per lookup.
    pub async fn groups(&mut self) -> Result<Vec<String>, FastApiError> {
        if let Some(groups) = &self.group_names {
            return Ok(groups.clone());
        }
        let state = self.state;
        let erp = ErpContext {
            erp: state.erp.as_ref(),
            redis: state.redis.as_ref(),
        };
        let resolved =
            user_group_memberships(&state.mysql, &erp, &state.entity_resolvers, self.user_id)
                .await
                .map_err(internal)?;
        let mut groups: Vec<String> =
            effective_roles(&resolved.memberships, &resolved.active_names)
                .into_keys()
                .collect();
        groups.sort();
        self.group_names = Some(groups.clone());
        Ok(groups)
    }

    /// `_read_direct`: batch the pending names for one scope, then return the
    /// requested name's recorded result.
    async fn read_direct(
        &mut self,
        kind: &str,
        name: &str,
        scope: DirectScope,
        filters: String,
        tail: Vec<StatementArg>,
    ) -> Result<Option<KindRow>, FastApiError> {
        let key = (kind.to_owned(), scope);
        self.names
            .entry(kind.to_string())
            .or_default()
            .insert(name.to_string());
        let pending: Vec<String> = {
            let index = self.direct.get(&key);
            self.names[kind]
                .iter()
                .filter(|candidate| index.is_none_or(|index| !index.contains_key(*candidate)))
                .cloned()
                .collect()
        };
        if !pending.is_empty() {
            let statement = named_kind_rows_statement(pending.len(), &filters);
            let arguments = named_rows_arguments(&pending, tail);
            let rows = named_kind_rows(&self.state.mysql, &statement, arguments)
                .await
                .map_err(internal)?;
            let index = self.direct.entry(key.clone()).or_default();
            for candidate in &pending {
                index.entry(candidate.clone()).or_insert(None);
            }
            for row in &rows {
                if let Some(slot) = index.get_mut(&row.requested_name)
                    && slot.is_none()
                {
                    *slot = Some(row.kind.clone());
                }
            }
            if kind == "Model" {
                let pointers = bind_model_pointers(&rows);
                let names = self.names.entry("Model".to_string()).or_default();
                for pointer in pointers {
                    names.insert(pointer);
                }
            }
        }
        Ok(self
            .direct
            .get(&key)
            .and_then(|index| index.get(name))
            .cloned()
            .flatten())
    }

    /// `_match_model_reference_names`: match pending Model names against the
    /// listed reference sources using the database collation.
    async fn match_model_reference_names(&mut self, name: &str) -> Result<(), FastApiError> {
        self.names
            .entry("Model".to_string())
            .or_default()
            .insert(name.to_string());
        let missing: Vec<String> = self.names["Model"]
            .iter()
            .filter(|candidate| !self.model_reference_names.contains(*candidate))
            .cloned()
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        let mut targets: Vec<(i64, Vec<String>)> = Vec::new();
        for (namespace, sources) in &self.model_reference_sources {
            for source in sources {
                if let Some(entry) = targets.iter_mut().find(|(id, _)| *id == source.id) {
                    entry.1.push(namespace.clone());
                } else {
                    targets.push((source.id, vec![namespace.clone()]));
                }
            }
        }
        if !targets.is_empty() {
            let source_ids: Vec<i64> = targets.iter().map(|(id, _)| *id).collect();
            let statement = named_reference_match_statement(missing.len(), source_ids.len());
            let mut arguments: Vec<StatementArg> =
                missing.iter().cloned().map(StatementArg::Str).collect();
            arguments.extend(source_ids.iter().copied().map(StatementArg::Int));
            let rows = named_kind_rows(&self.state.mysql, &statement, arguments)
                .await
                .map_err(internal)?;
            for row in &rows {
                if let Some((_, namespaces)) = targets.iter().find(|(id, _)| *id == row.kind.id) {
                    for namespace in namespaces {
                        self.references
                            .entry(("Model".to_string(), namespace.clone()))
                            .or_default()
                            .entry(row.requested_name.clone())
                            .or_insert_with(|| row.kind.clone());
                    }
                }
            }
        }
        for candidate in missing {
            self.model_reference_names.insert(candidate);
        }
        Ok(())
    }

    /// `list_referenced_capabilities_by_namespace`: per-namespace approved
    /// reference listings, in the requested namespace order.
    async fn list_referenced(
        &self,
        kind: &str,
        namespaces: &[String],
    ) -> Result<Vec<(String, Vec<KindRow>)>, FastApiError> {
        let mut result: Vec<(String, Vec<KindRow>)> = namespaces
            .iter()
            .map(|namespace| (namespace.clone(), Vec::new()))
            .collect();
        if !REFERENCE_KINDS.contains(&kind) || result.is_empty() {
            return Ok(result);
        }
        let mut targets: Vec<(String, String, String)> = Vec::new();
        if namespaces.iter().any(|namespace| namespace == "default") {
            targets.push((
                "user".to_string(),
                self.user_id.to_string(),
                "default".to_string(),
            ));
        }
        let group_names: Vec<String> = namespaces
            .iter()
            .filter(|namespace| namespace.as_str() != "default")
            .cloned()
            .collect();
        if !group_names.is_empty() {
            for (id, name) in self.namespace_ids(&group_names).await? {
                targets.push(("namespace".to_string(), id.to_string(), name));
            }
        }
        if targets.is_empty() {
            return Ok(result);
        }
        let mut entity_types: Vec<&str> = Vec::new();
        for (entity_type, _, _) in &targets {
            if !entity_types.contains(&entity_type.as_str()) {
                entity_types.push(entity_type);
            }
        }
        let mut clauses: Vec<String> = Vec::new();
        let mut arguments: Vec<StatementArg> = Vec::new();
        for entity_type in entity_types {
            let ids: Vec<&str> = targets
                .iter()
                .filter(|(candidate, _, _)| candidate == entity_type)
                .map(|(_, id, _)| id.as_str())
                .collect();
            clauses.push(format!(
                "resource_members.entity_type = '{entity_type}' AND \
                 resource_members.entity_id IN ({})",
                placeholders(ids.len())
            ));
            for id in ids {
                arguments.push(StatementArg::Str(id.to_string()));
            }
        }
        let filter = if clauses.len() == 1 {
            clauses.remove(0)
        } else {
            format!("({})", clauses.join(" OR "))
        };
        let statement = referenced_listing_statement(kind, &filter);
        let rows: Vec<ReferencedCapabilityRow> =
            referenced_listing(&self.state.mysql, &statement, arguments)
                .await
                .map_err(internal)?;
        let mut namespace_by_target: HashMap<(String, String), String> = HashMap::new();
        for (entity_type, entity_id, namespace) in &targets {
            namespace_by_target
                .entry((entity_type.clone(), entity_id.clone()))
                .or_insert_with(|| namespace.clone());
        }
        let mut seen: HashMap<(String, i64), ()> = HashMap::new();
        for row in rows {
            let Some(namespace) = namespace_by_target
                .get(&(row.entity_type.clone(), row.entity_id.clone()))
                .cloned()
            else {
                continue;
            };
            if seen.insert((namespace.clone(), row.kind.id), ()).is_none()
                && let Some(entry) = result
                    .iter_mut()
                    .find(|(candidate, _)| *candidate == namespace)
            {
                entry.1.push(row.kind);
            }
        }
        Ok(result)
    }

    /// The `Namespace.id/name` batch read for group reference targets.
    async fn namespace_ids(&self, names: &[String]) -> Result<Vec<(i64, String)>, FastApiError> {
        let statement = namespace_ids_by_names_statement(names.len());
        let arguments: Vec<StatementArg> = names.iter().cloned().map(StatementArg::Str).collect();
        let rows: Vec<MysqlRow> = self
            .state
            .mysql
            .fetch_all(statement.as_str(), arguments)
            .await
            .map_err(internal)?;
        let mut result = Vec::with_capacity(rows.len());
        for row in &rows {
            result.push((
                row.get_at::<i64>(0).map_err(internal)?,
                row.get_at::<String>(1).map_err(internal)?,
            ));
        }
        Ok(result)
    }
}

/// Internal dependency failure rendered like every other unhandled source
/// exception (`{"error_code": 500, "detail": "Internal server error"}`).
pub(crate) fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "personal-resource dependency failure");
    FastApiError::unhandled()
}

/// `GitHub`-independent helper: extract `spec` from a kind JSON document.
pub(crate) fn spec_of(kind: &KindRow) -> Option<Value> {
    if !brz_json::adapters::python_truthy(&kind.json.0) {
        return None;
    }
    Some(
        kind.json
            .0
            .get("spec")
            .cloned()
            .unwrap_or_else(|| Value::Object(serde_json::Map::new())),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pending-name batch renders the source's derived-names relation and
    /// binds the requested names before the scope filters.
    #[test]
    fn named_personal_statement_matches_the_source_relation() {
        let statement = named_kind_rows_statement(
            2,
            "kinds.kind = 'Shell' AND kinds.user_id = ? AND kinds.namespace = ?",
        );
        assert!(statement.contains("SELECT ? AS name UNION ALL SELECT ? AS name"));
        assert!(statement.contains("INNER JOIN kinds ON kinds.name = anon_1.name"));
        assert!(statement.contains("kinds.is_active IS true AND kinds.kind = 'Shell'"));
        assert!(statement.contains("ORDER BY kinds.id"));
    }

    /// The reference listing is ordered by `kinds.id` and keeps the approved
    /// user-target scope.
    #[test]
    fn reference_listing_uses_the_user_target_scope() {
        let statement = referenced_listing_statement(
            "Shell",
            "resource_members.entity_type = 'user' AND resource_members.entity_id IN (?)",
        );
        assert!(statement.contains("resource_members.resource_type = 'Shell'"));
        assert!(statement.contains("resource_members.entity_type = 'user'"));
        assert!(statement.contains("kinds.user_id != 0"));
        assert!(statement.contains("ORDER BY kinds.id"));
    }
}
