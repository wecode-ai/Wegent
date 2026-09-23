// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for the all-grouped membership resolution in `membership.rs`.
//!
//! `src/knowledge_bases_all_grouped/membership.rs` is kept below the repository
//! source-file limit by living here behind `#[path = "membership_tests.rs"]`.

use super::*;

/// `[... for b in all_dept_bindings if b.entity_id]` drops falsy entity
/// ids, so a binding set of only empty ids becomes empty and the caller's
/// `if bindings.is_empty()` mirrors the source's `if not dept_ids:
/// return []` branch: no membership check, no namespace-entity query.
#[test]
fn entity_id_bindings_drop_falsy_values_like_the_source() {
    assert_eq!(
        non_empty_entity_ids(vec![
            "100430".to_string(),
            String::new(),
            "Z02333".to_string(),
        ]),
        vec!["100430".to_string(), "Z02333".to_string()]
    );
    assert!(non_empty_entity_ids(vec![String::new(), String::new()]).is_empty());
    // The query's distinct row order and any duplicates are preserved.
    assert_eq!(
        non_empty_entity_ids(vec!["b".to_string(), "a".to_string(), "b".to_string()]),
        vec!["b".to_string(), "a".to_string(), "b".to_string()]
    );
}

/// Both group-membership call sites must request the with-fallback
/// membership path.
///
/// The provider maps `ResolutionPurpose::CachedResourceAccess` to
/// `ErpProvider::cached_membership`, which returns no membership on a
/// cache miss or a failed read and performs no cache write, while the
/// source's single membership path falls back to
/// `batch_check_membership` and stores the rebuilt map. Reverting
/// `GROUP_ENTITY_PURPOSE` to the cache-only variant silently drops
/// entity-derived groups and the ERP requests the source performs.
///
/// A behavioural test would have to drive `user_group_role_map` past the
/// binding queries, and `brz_mysql` exposes no way to construct result
/// rows (`MysqlRow::new` is crate-private) for a fake `Mysql`, so this
/// test pins the purpose itself.
#[test]
fn group_entity_calls_use_the_with_fallback_membership_purpose() {
    assert!(matches!(
        GROUP_ENTITY_PURPOSE,
        ResolutionPurpose::ResourceAccess
    ));
}

/// Collapse the template line continuations into the single line
/// SQLAlchemy renders, so the expected text below is the recorded source
/// SQL verbatim.
fn rendered(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn resolver_contract_queries_render_recorded_source_sql() {
    // `ErpEntityResolver.get_resource_ids_by_entity` defaults to
    // `resource_type="KnowledgeBase"` and `MemberStatus.APPROVED.value`,
    // and SQLAlchemy renders scalar equality, not the `KNOWLEDGE_BASE_
    // RESOURCE_TYPE_VALUES` / `APPROVED_MEMBER_STATUS_VALUES` value lists.
    // `list_resources_by_entity_match` carries the same scalar filters and
    // a `distinct()`, so the rendered `SELECT DISTINCT` must not be lost
    // either.
    assert_eq!(
        rendered(&distinct_kb_external_entities_sql("org_department")),
        "SELECT DISTINCT resource_members.entity_id AS resource_members_entity_id \
         FROM resource_members WHERE resource_members.resource_type = 'KnowledgeBase' \
         AND resource_members.entity_type = 'org_department' \
         AND resource_members.entity_id IS NOT NULL \
         AND resource_members.status = 'approved'"
    );
    assert_eq!(
        rendered(&kb_ids_for_external_entities_sql(
            "org_department",
            "'101178'"
        )),
        "SELECT DISTINCT resource_members.resource_id AS resource_members_resource_id \
         FROM resource_members WHERE resource_members.resource_type = 'KnowledgeBase' \
         AND resource_members.entity_type = 'org_department' \
         AND resource_members.entity_id IN ('101178') \
         AND resource_members.status = 'approved'"
    );
    assert_eq!(
        rendered(&namespace_ids_for_external_ids_sql(
            "org_department",
            "'101597'"
        )),
        "SELECT DISTINCT resource_members.resource_id AS resource_members_resource_id \
         FROM resource_members WHERE resource_members.resource_type = 'Namespace' \
         AND resource_members.entity_type = 'org_department' \
         AND resource_members.entity_id IN ('101597') \
         AND resource_members.status = 'approved'"
    );
}

// ---------------------------------------------------------------------------
// `collect_entity_authorized_kbs` second resolver pass
// ---------------------------------------------------------------------------
// `get_resource_ids_by_entity` resolves every department bound to a
// KnowledgeBase; `collect_entity_authorized_kbs` then resolves the entity ids of
// the member rows those resource ids returned. The two lists differ, so the
// source issues a second membership resolution and keeps only the rows it
// matches. These tests drive that pass through a recording resolver, which needs
// no ERP dependency.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use brz_redis::RedisService;

use crate::permissions::EntityResolver;

/// Records the entity ids of every resolver call and matches a fixed id set,
/// like `ErpEntityResolver` would against a warm membership cache.
struct RecordingResolver {
    calls: Arc<Mutex<Vec<Vec<String>>>>,
    matched: Vec<String>,
}

#[async_trait]
impl EntityResolver<RedisService> for RecordingResolver {
    async fn match_bindings(
        &self,
        _: &EntityResolvers<RedisService>,
        _: Option<&RedisService>,
        _: i64,
        entity_ids: &[String],
        _: ResolutionPurpose,
    ) -> MysqlResult<Vec<String>> {
        self.calls.lock().unwrap().push(entity_ids.to_vec());
        Ok(entity_ids
            .iter()
            .filter(|entity_id| self.matched.contains(entity_id))
            .cloned()
            .collect())
    }
}

/// A registry with the `org_department` resolver under test. The MySQL handle is
/// lazy and never connects: these tests reach the resolver, not the database.
fn registry(resolver: RecordingResolver) -> EntityResolvers {
    let mut registry = EntityResolvers::public(
        brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test").unwrap(),
    );
    registry.register("org_department", resolver);
    registry
}

/// A member row as the entity-authorized KB query decodes it.
fn member_row(resource_id: i64, entity_id: &str) -> MemberRow {
    MemberRow {
        resource_members_resource_id: resource_id,
        resource_members_entity_type: "org_department".into(),
        resource_members_entity_id: entity_id.into(),
        resource_members_role: "Reporter".into(),
        resource_members_invited_by_user_id: 0,
    }
}

/// The recorded `95c8d05d` member row (`resource_id=317487`,
/// `entity_id=101178`) is the only recorded row whose first pass matched, so it
/// is the only case that reaches this second pass. The resolver must see exactly
/// the source's `[member.entity_id for member in members if member.entity_id]`
/// list, and only the rows it matches may be appended.
#[tokio::test]
async fn collected_member_rows_are_resolved_a_second_time_and_filtered() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let registry = registry(RecordingResolver {
        calls: calls.clone(),
        matched: vec!["101178".into()],
    });
    let members = vec![member_row(317487, "101178"), member_row(317487, "100430")];

    let matched = matched_member_rows(None, &registry, 1696, "org_department", &members)
        .await
        .unwrap();

    assert_eq!(
        calls.lock().unwrap().as_slice(),
        [vec!["101178".to_string(), "100430".to_string()]]
    );
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].resource_members_entity_id, "101178");
}

/// The pass issues no membership request for rows without entity ids or for an
/// empty row set: `match_bindings` reports no match for an empty list, exactly
/// like `ErpEntityResolver`'s `if not dept_ids: return []`. The twelve recorded
/// cases whose first pass matched nothing therefore stay on their recorded
/// invocation count.
#[tokio::test]
async fn collected_member_rows_without_entity_ids_issue_no_second_resolution() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let registry = registry(RecordingResolver {
        calls: calls.clone(),
        matched: vec!["101178".into()],
    });

    let falsy_only_rows = [member_row(317487, ""), member_row(317488, "")];
    let falsy_only = matched_member_rows(None, &registry, 1696, "org_department", &falsy_only_rows)
        .await
        .unwrap();
    let no_rows = matched_member_rows(None, &registry, 1696, "org_department", &[])
        .await
        .unwrap();

    assert!(falsy_only.is_empty());
    assert!(no_rows.is_empty());
    assert!(calls.lock().unwrap().is_empty());
}

/// The source's comprehension preserves member order and duplicates; only the
/// empty entity id is dropped. Order matters because the resolver rebuilds its
/// cached map in the requested order.
#[test]
fn second_pass_input_preserves_member_order_and_drops_falsy_ids() {
    let members = vec![
        member_row(1, "101178"),
        member_row(2, ""),
        member_row(3, "Z02333"),
        member_row(4, "101178"),
    ];

    assert_eq!(
        member_entity_ids(&members),
        [
            "101178".to_string(),
            "Z02333".to_string(),
            "101178".to_string()
        ]
    );
}
