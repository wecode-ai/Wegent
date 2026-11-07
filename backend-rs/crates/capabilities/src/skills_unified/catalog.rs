// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Final catalog assembly shared by the handler and its regression tests.
use super::*;

pub(super) struct CatalogSelection<'a> {
    pub bound_ids: &'a HashSet<i32>,
    pub shared_ids: &'a HashSet<i32>,
    pub default_ids: &'a HashSet<i32>,
    pub skip: usize,
    pub limit: usize,
}

pub(super) async fn assemble<F, Fut>(
    mut kinds: Vec<KindRow>,
    selection: CatalogSelection<'_>,
    mut fetch: F,
) -> MysqlResult<Vec<SkillItem>>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = MysqlResult<Vec<KindRow>>>,
{
    let direct_ids: HashSet<i32> = kinds.iter().map(|kind| kind.kinds_id).collect();
    let mut missing: Vec<i32> = selection
        .bound_ids
        .difference(&direct_ids)
        .copied()
        .collect();
    missing.sort_unstable();
    if !missing.is_empty() {
        let list = missing
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {KIND_COLUMNS} \
             FROM kinds \
             WHERE kinds.id IN ({list}) AND kinds.kind = 'Skill' \
             AND kinds.is_active = true ORDER BY kinds.created_at DESC"
        );
        kinds.extend(fetch(sql).await?);
    }

    let mut skills = Vec::new();
    let mut keys = HashSet::new();
    let mut names = HashSet::new();
    for kind in &kinds {
        let key = (kind.kinds_namespace.clone(), kind.kinds_name.clone());
        if keys.insert(key) {
            names.insert(kind.kinds_name.clone());
            skills.push(user_skill_item(
                kind,
                selection.shared_ids.contains(&kind.kinds_id),
                selection.default_ids,
            ));
        }
    }

    let public_sql = format!(
        "SELECT {KIND_COLUMNS} \
         FROM kinds \
         WHERE kinds.user_id = 0 AND kinds.kind = 'Skill' \
         AND kinds.namespace = 'default' AND kinds.is_active = true \
         ORDER BY kinds.created_at DESC"
    );
    for kind in fetch(public_sql).await? {
        if names.insert(kind.kinds_name.clone()) {
            let mut item = user_skill_item(
                &kind,
                selection.shared_ids.contains(&kind.kinds_id),
                selection.default_ids,
            );
            item.is_public = true;
            item.source = None;
            skills.push(item);
        }
    }
    Ok(skills
        .into_iter()
        .skip(selection.skip)
        .take(selection.limit)
        .collect())
}
