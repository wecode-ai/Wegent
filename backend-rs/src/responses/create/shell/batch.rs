// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The shared Shell lookup for dispatch and task/team response summaries.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use brz_mysql::{FromMysqlRow, MysqlResult, MysqlRow, MysqlService};
use brz_redis::Redis;

use super::shell_named_public_statement;
use crate::permissions::{EntityResolvers, active_namespace_names, user_groups_for_names};
use crate::responses::create::resolution::{
    KIND_COLUMNS, KindRow, named_kind_rows, referenced_listing, referenced_listing_statement,
};
use crate::task_store_statements::StatementArg;
use crate::teams::teams_repository::placeholders;

type ShellKey = (i64, String, String);
type ResolvedShells = HashMap<ShellKey, Arc<KindRow>>;

/// Resolve by owner, approved reference, authorized group, then public Shell.
/// Keys retain the requested namespace even when a reference points elsewhere.
pub(crate) async fn resolve_shells<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    refs: &[ShellKey],
) -> MysqlResult<ResolvedShells> {
    let refs: Vec<_> = refs
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut resolved = scoped_shells(mysql, &refs, true).await?;
    resolve_references(mysql, &missing_keys(&resolved, &refs), &mut resolved).await?;
    resolve_groups(mysql, resolvers, redis, &refs, &mut resolved).await?;

    let names: Vec<_> = missing_keys(&resolved, &refs)
        .into_iter()
        .map(|key| key.1)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if !names.is_empty() {
        let rows = named_kind_rows(
            mysql,
            &shell_named_public_statement(names.len()),
            names.into_iter().map(StatementArg::Str).collect(),
        )
        .await?;
        for row in rows {
            let shell = Arc::new(row.kind);
            for key in refs.iter().filter(|key| key.1 == row.requested_name) {
                resolved.entry(key.clone()).or_insert_with(|| shell.clone());
            }
        }
    }
    Ok(resolved)
}

fn missing_keys(resolved: &ResolvedShells, refs: &[ShellKey]) -> Vec<ShellKey> {
    refs.iter()
        .filter(|key| !resolved.contains_key(*key))
        .cloned()
        .collect()
}

/// Include the entire requested identity in the relation and projection:
/// database collation matches must retain the caller's name/namespace bytes.
fn scoped_shells_statement(count: usize, owner_only: bool) -> String {
    let relation =
        vec!["SELECT ? AS owner_id, ? AS name, ? AS namespace"; count].join(" UNION ALL ");
    let owner_filter = if owner_only {
        " AND kinds.user_id = anon_1.owner_id"
    } else {
        ""
    };
    format!(
        "SELECT anon_1.owner_id AS requested_owner_id, anon_1.name AS requested_name, \
         anon_1.namespace AS requested_namespace, {KIND_COLUMNS} \n\
         FROM ({relation}) AS anon_1 \n\
         INNER JOIN kinds ON kinds.name = anon_1.name AND kinds.namespace = anon_1.namespace \n\
         WHERE kinds.is_active IS true AND kinds.kind = 'Shell'{owner_filter} \n\
         ORDER BY kinds.id"
    )
}

async fn scoped_shells(
    mysql: &MysqlService,
    refs: &[ShellKey],
    owner_only: bool,
) -> MysqlResult<ResolvedShells> {
    let mut resolved = HashMap::new();
    if refs.is_empty() {
        return Ok(resolved);
    }
    let arguments: Vec<_> = refs
        .iter()
        .flat_map(|(owner, name, namespace)| {
            [
                StatementArg::Int(*owner),
                StatementArg::Str(name.clone()),
                StatementArg::Str(namespace.clone()),
            ]
        })
        .collect();
    let rows = mysql
        .fetch_all::<_, _, MysqlRow>(scoped_shells_statement(refs.len(), owner_only), arguments)
        .await?;
    for row in rows {
        let key = (
            row.get_at::<i64>(0)?,
            row.get_at::<String>(1)?,
            row.get_at::<String>(2)?,
        );
        if let std::collections::hash_map::Entry::Vacant(entry) = resolved.entry(key) {
            entry.insert(Arc::new(KindRow::from_mysql_row(row)?));
        }
    }
    Ok(resolved)
}

/// Namespace targets are shared across owners. Keep the requested namespace
/// in this SQL relation as well, rather than matching its stored name in Rust.
async fn reference_namespace_targets(
    mysql: &MysqlService,
    refs: &[ShellKey],
) -> MysqlResult<BTreeMap<String, Vec<String>>> {
    let names: BTreeSet<_> = refs
        .iter()
        .map(|key| &key.2)
        .filter(|ns| *ns != "default")
        .collect();
    let mut targets: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if names.is_empty() {
        return Ok(targets);
    }
    let relation = vec!["SELECT ? AS name"; names.len()].join(" UNION ALL ");
    let statement = format!(
        "SELECT anon_1.name AS requested_namespace, namespace.id AS namespace_id \n\
         FROM ({relation}) AS anon_1 \n\
         INNER JOIN namespace ON namespace.name = anon_1.name \n\
         WHERE namespace.is_active IS true"
    );
    let arguments: Vec<_> = names.into_iter().cloned().map(StatementArg::Str).collect();
    for row in mysql
        .fetch_all::<_, _, MysqlRow>(statement, arguments)
        .await?
    {
        targets
            .entry(row.get_at::<i64>(1)?.to_string())
            .or_default()
            .push(row.get_at(0)?);
    }
    Ok(targets)
}

async fn resolve_references(
    mysql: &MysqlService,
    refs: &[ShellKey],
    resolved: &mut ResolvedShells,
) -> MysqlResult<()> {
    let namespaces = reference_namespace_targets(mysql, refs).await?;
    let owners: BTreeSet<_> = refs
        .iter()
        .filter(|key| key.2 == "default")
        .map(|key| key.0.to_string())
        .collect();
    let mut filters = Vec::new();
    let mut arguments = Vec::new();
    let mut targets: HashMap<(&str, String), Vec<&ShellKey>> = HashMap::new();
    if !owners.is_empty() {
        filters.push(format!(
            "(resource_members.entity_type = 'user' AND resource_members.entity_id IN ({}))",
            placeholders(owners.len())
        ));
        arguments.extend(owners.into_iter().map(StatementArg::Str));
        for key in refs.iter().filter(|key| key.2 == "default") {
            targets
                .entry(("user", key.0.to_string()))
                .or_default()
                .push(key);
        }
    }
    if !namespaces.is_empty() {
        filters.push(format!(
            "(resource_members.entity_type = 'namespace' AND resource_members.entity_id IN ({}))",
            placeholders(namespaces.len())
        ));
        arguments.extend(namespaces.keys().cloned().map(StatementArg::Str));
        for (id, names) in namespaces {
            targets.insert(
                ("namespace", id),
                refs.iter().filter(|key| names.contains(&key.2)).collect(),
            );
        }
    }
    if filters.is_empty() {
        return Ok(());
    }
    let statement = referenced_listing_statement("Shell", &format!("({})", filters.join(" OR ")));
    for row in referenced_listing(mysql, &statement, arguments).await? {
        let Some(keys) = targets.get(&(row.entity_type.as_str(), row.entity_id)) else {
            continue;
        };
        let shell = Arc::new(row.kind);
        // Shell references use an exact source-name dictionary lookup, unlike
        // owner/group/public reads, which deliberately use database collation.
        for key in keys.iter().filter(|key| key.1 == shell.name) {
            resolved
                .entry((*key).clone())
                .or_insert_with(|| shell.clone());
        }
    }
    Ok(())
}

async fn resolve_groups<R: Redis>(
    mysql: &MysqlService,
    resolvers: &EntityResolvers<R>,
    redis: Option<&R>,
    refs: &[ShellKey],
    resolved: &mut ResolvedShells,
) -> MysqlResult<()> {
    let missing: Vec<_> = missing_keys(resolved, refs)
        .into_iter()
        .filter(|key| key.2 != "default")
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let names = active_namespace_names(mysql).await?;
    let mut groups_by_owner = HashMap::new();
    let mut authorized = Vec::new();
    for key in missing {
        if let std::collections::hash_map::Entry::Vacant(entry) = groups_by_owner.entry(key.0) {
            entry.insert(user_groups_for_names(mysql, resolvers, redis, key.0, &names).await?);
        }
        if groups_by_owner[&key.0].contains(&key.2) {
            authorized.push(key);
        }
    }
    // A group Shell does not depend on the owner after authorization. Resolve
    // each requested name/namespace once, then share its row across those owners.
    let group_refs: Vec<_> = authorized
        .iter()
        .map(|key| (0, key.1.clone(), key.2.clone()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let groups = scoped_shells(mysql, &group_refs, false).await?;
    for key in authorized {
        if let Some(shell) = groups.get(&(0, key.1.clone(), key.2.clone())) {
            resolved.insert(key, shell.clone());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
