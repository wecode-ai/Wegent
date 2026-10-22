// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for the `GET /api/tasks/{task_id}/skills` resolution chain,
//! including the user-default skill-binding merge.

use super::*;

fn skill_row(user_id: i64, spec: serde_json::Value) -> repo::KindRow {
    skill_row_in_namespace(user_id, "default", spec)
}

fn skill_row_in_namespace(user_id: i64, namespace: &str, spec: serde_json::Value) -> repo::KindRow {
    repo::KindRow {
        kinds_id: 274676,
        kinds_user_id: user_id,
        kinds_kind: "Skill".to_string(),
        kinds_name: "chaoneng-xiadanya-suicai-analysis".to_string(),
        kinds_namespace: namespace.to_string(),
        kinds_json: brz_mysql::Json(OpaqueJson::from_serializable(spec)),
        kinds_is_active: 1,
        kinds_created_at: chrono::NaiveDateTime::default(),
        kinds_updated_at: chrono::NaiveDateTime::default(),
    }
}

/// The capture handle the access check runs against: no cache client and no
/// ERP provider, so every role read reaches the SQL capture.
fn capture_store(
    mysql: &crate::sql_test_support::KindQueryCapture,
) -> KindCacheStore<'_, crate::sql_test_support::KindQueryCapture> {
    KindCacheStore {
        mysql,
        redis: None,
        erp: None,
        resolvers: None,
    }
}

#[test]
fn group_bindings_match_their_namespace_target() {
    let binding = OpaqueJson::from_serializable(serde_json::json!({
        "kind": "SkillBinding",
        "spec": {"targetType": "group", "targetId": "example/example_community"}
    }));
    assert!(is_group_binding(&binding, "example/example_community"));
    assert!(!is_group_binding(&binding, "default"));
    assert!(!is_user_default_binding(&binding, "user:6013"));
}

#[tokio::test]
async fn accessibility_admits_own_and_public_skills_without_a_role_read() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store = capture_store(&mysql);
    let own = skill_row(4751, serde_json::json!({"kind": "Skill", "spec": {}}));
    assert!(
        can_user_access_skill(&store, &own, 4751)
            .await
            .expect("the owner check reads nothing")
    );
    let public = skill_row(0, serde_json::json!({"kind": "Skill", "spec": {}}));
    assert!(
        can_user_access_skill(&store, &public, 4751)
            .await
            .expect("the public check reads nothing")
    );
    assert!(mysql.queries().is_empty(), "{:?}", mysql.queries());
}

#[tokio::test]
async fn accessibility_requires_a_published_public_capability_for_foreign_skills() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store = capture_store(&mysql);
    let foreign = skill_row(999, serde_json::json!({"kind": "Skill", "spec": {}}));
    assert!(
        !can_user_access_skill(&store, &foreign, 4751)
            .await
            .expect("a default-namespace Skill reads no role")
    );
    let published = skill_row(
        999,
        serde_json::json!({"kind": "Skill", "spec": {"capability": {
            "visibility": "public", "publishStatus": "published"}}}),
    );
    assert!(
        can_user_access_skill(&store, &published, 4751)
            .await
            .expect("a published capability reads no role")
    );
    assert!(mysql.queries().is_empty(), "{:?}", mysql.queries());
}

/// A foreign Skill in a group namespace is admitted through the requester's
/// Reporter-or-above role there (`get_effective_role_in_group`): the check
/// reads that namespace instead of answering from the row alone.
#[tokio::test]
async fn accessibility_reads_the_group_role_for_a_foreign_group_skill() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let store = capture_store(&mysql);
    let foreign = skill_row_in_namespace(
        166,
        "Feed-Monitor",
        serde_json::json!({"kind": "Skill", "spec": {}}),
    );
    assert!(
        !can_user_access_skill(&store, &foreign, 1202)
            .await
            .expect("the role read runs and answers")
    );
    // `get_effective_role_in_group`: the direct-membership namespace lookup
    // and the entity-role namespace lookup. The capture answers no namespace
    // row, so both lookup branches stop before their member reads — the
    // two probes the branch itself issues.
    let queries: Vec<String> = mysql.queries().into_iter().map(|query| query.sql).collect();
    assert_eq!(queries.len(), 2, "{queries:?}");
    for query in &queries {
        assert!(
            query.contains("FROM namespace") && query.contains("namespace.name = 'Feed-Monitor'"),
            "{queries:?}"
        );
    }
}

/// A public Skill row whose CRD carries `status.fileHash`.
fn hashed_public_skill(name: &str, file_hash: &str) -> repo::KindRow {
    let mut row = skill_row(
        0,
        serde_json::json!({
            "kind": "Skill",
            "spec": {},
            "status": {"fileHash": file_hash},
        }),
    );
    row.kinds_id = 4242;
    row.kinds_name = name.to_string();
    row
}

const GHOST_HASH: &str = "sha256:ghost-resolved-hash";

fn resolved(name: &str, content_hash: Option<&str>) -> (String, SkillRefMeta) {
    (
        name.to_string(),
        SkillRefMeta {
            skill_id: 4242,
            namespace: "default".to_string(),
            is_public: true,
            content_hash: content_hash.map(str::to_string),
        },
    )
}

/// A `forcePreload` user-default binding whose name the ghost loop already
/// resolved must not drop the resolved `content_hash` from
/// `preload_skill_refs`.
#[test]
fn force_preload_binding_keeps_an_already_resolved_content_hash() {
    let mut skill_refs = HashMap::from([resolved("preloaded-tool", Some(GHOST_HASH))]);
    let mut preload_skill_refs = HashMap::new();
    let mut skills = HashSet::new();
    let mut preload_skills = HashSet::new();

    merge_user_default_skill_ref(
        &hashed_public_skill("preloaded-tool", "binding-hash-is-not-used"),
        true,
        &mut skills,
        &mut skill_refs,
        &mut preload_skills,
        &mut preload_skill_refs,
    );

    assert_eq!(
        preload_skill_refs["preloaded-tool"].content_hash.as_deref(),
        Some(GHOST_HASH)
    );
    assert_eq!(
        skill_refs["preloaded-tool"].content_hash.as_deref(),
        Some(GHOST_HASH)
    );
    assert_eq!(preload_skill_refs["preloaded-tool"].skill_id, 4242);
    assert!(preload_skill_refs["preloaded-tool"].is_public);
    assert!(skills.contains("preloaded-tool"));
    assert!(preload_skills.contains("preloaded-tool"));
}

/// A newly merged binding ref writes only the binding's own fields, so its
/// `content_hash` renders as JSON `null` until another stage resolves it.
#[test]
fn force_preload_binding_without_a_prior_ref_drops_the_hash() {
    let mut skill_refs = HashMap::new();
    let mut preload_skill_refs = HashMap::new();
    let mut skills = HashSet::new();
    let mut preload_skills = HashSet::new();

    merge_user_default_skill_ref(
        &hashed_public_skill("unresolved-tool", "binding-hash-is-not-used"),
        true,
        &mut skills,
        &mut skill_refs,
        &mut preload_skills,
        &mut preload_skill_refs,
    );

    assert_eq!(skill_refs["unresolved-tool"].content_hash, None);
    assert_eq!(preload_skill_refs["unresolved-tool"].content_hash, None);
    assert_eq!(preload_skill_refs["unresolved-tool"].skill_id, 4242);
}

/// Only `forcePreload` moves a binding into the preloaded sets.
#[test]
fn a_binding_without_force_preload_stays_out_of_the_preloaded_sets() {
    let mut skill_refs = HashMap::new();
    let mut preload_skill_refs = HashMap::new();
    let mut skills = HashSet::new();
    let mut preload_skills = HashSet::new();

    merge_user_default_skill_ref(
        &hashed_public_skill("binding-only-tool", "binding-hash-is-not-used"),
        false,
        &mut skills,
        &mut skill_refs,
        &mut preload_skills,
        &mut preload_skill_refs,
    );

    assert!(skills.contains("binding-only-tool"));
    assert!(!preload_skills.contains("binding-only-tool"));
    assert!(preload_skill_refs.is_empty());
    assert_eq!(skill_refs["binding-only-tool"].content_hash, None);
}
