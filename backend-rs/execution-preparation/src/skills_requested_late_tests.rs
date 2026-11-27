// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `resolve_request_preload_skills` (`request_builder.py:828-975`): the late
//! provider-Skill re-resolution.

use super::*;
use serde_json::json;
use wegent_protocol::dispatch::ExecutionRequest;

fn request_with(
    preload: Vec<Value>,
    selected: Vec<Value>,
    refs: Value,
    knowledge_base_ids: Option<Value>,
) -> ExecutionRequest {
    ExecutionRequest {
        preload_skills: preload,
        user_selected_skills: selected,
        skill_refs: refs,
        knowledge_base_ids,
        ..ExecutionRequest::default()
    }
}

/// `request_builder.py:842-848`: preload and user-selected names dedupe in
/// first-seen order.
#[test]
fn requested_names_dedupe_preload_and_user_selected() {
    let request = request_with(
        vec![json!("a"), json!("b")],
        vec![json!("b"), json!("c")],
        json!({}),
        None,
    );
    assert_eq!(requested_skill_names(&request), vec!["a", "b", "c"]);
}

/// `request_builder.py:885-887`: the knowledge provider Skill is resolved
/// as the public `default` Skill whenever the request carries knowledge
/// bases, so the ordinary loader (not a stored ref) supplies its row.
#[test]
fn the_provider_skill_ref_becomes_the_public_default() {
    let request = request_with(
        vec![json!("wegent-knowledge")],
        vec![json!("wegent-knowledge")],
        json!({}),
        Some(json!([157464, 161644])),
    );
    let references = user_preload_skill_refs(&request, &["wegent-knowledge".to_string()]);
    assert_eq!(references.len(), 1);
    assert_eq!(references[0]["name"], json!("wegent-knowledge"));
    assert_eq!(references[0]["namespace"], json!("default"));
    assert_eq!(references[0]["is_public"], json!(true));
    // No stored id/hash is injected; the loader reads the live row.
    assert!(references[0].get("skill_id").is_none());
    assert!(references[0].get("content_hash").is_none());
}

/// Without knowledge bases the same name keeps its stored identity.
#[test]
fn a_stored_ref_supplies_its_identity_and_a_bare_name_stays_private() {
    let request = request_with(
        vec![json!("wegent-knowledge"), json!("bare")],
        vec![],
        json!({"wegent-knowledge": {"skill_id": 7, "namespace": "ns", "is_public": true}}),
        None,
    );
    let references = user_preload_skill_refs(
        &request,
        &["wegent-knowledge".to_string(), "bare".to_string()],
    );
    assert_eq!(references[0]["skill_id"], json!(7));
    assert_eq!(references[0]["namespace"], json!("ns"));
    assert_eq!(references[0]["is_public"], json!(true));
    assert_eq!(references[1]["namespace"], json!("default"));
    assert_eq!(references[1]["is_public"], json!(false));
    assert!(references[1].get("skill_id").is_none());
}

/// `_skill_refs_match` (`request_builder.py:2336-2339`): only a ref that
/// agrees on `skill_id` and `namespace` is replaced, and the namespace
/// defaults to `"default"` only when the member is absent.
#[test]
fn a_stale_bot_skill_ref_is_preserved() {
    let resolved = json!({"skill_id": 9, "namespace": "default"});
    assert!(skill_refs_match(&resolved.clone(), &resolved));
    // Same id in another namespace is stale and preserved.
    assert!(!skill_refs_match(
        &json!({"skill_id": 9, "namespace": "group"}),
        &resolved
    ));
    // A different id is stale and preserved.
    assert!(!skill_refs_match(
        &json!({"skill_id": 3, "namespace": "default"}),
        &resolved
    ));
    // A missing namespace defaults to `default`.
    assert!(skill_refs_match(&json!({"skill_id": 9}), &resolved));
    // A present `null` (or non-string) namespace is a real value, not the
    // default, so it does not match.
    assert!(!skill_refs_match(
        &json!({"skill_id": 9, "namespace": null}),
        &resolved
    ));
    assert!(!skill_refs_match(
        &json!({"skill_id": 9, "namespace": 7}),
        &resolved
    ));
    // Two explicit nulls agree with each other.
    assert!(skill_refs_match(
        &json!({"skill_id": 9, "namespace": null}),
        &json!({"skill_id": 9, "namespace": null})
    ));
}

/// `_sync_skill_refs_to_bot_configs` (`:2312-2333`): a no-skill bot keeps
/// its field presence, and a falsey stored ref (`null` or `{}`) receives
/// the resolved ref while a stale one is preserved.
#[test]
fn bot_ref_sync_skips_empty_skills_and_replaces_falsey_refs() {
    let mut resolved = serde_json::Map::new();
    resolved.insert(
        "a".to_string(),
        json!({"skill_id": 9, "namespace": "default"}),
    );
    resolved.insert(
        "b".to_string(),
        json!({"skill_id": 4, "namespace": "default"}),
    );

    // No string skill names: the existing field presence is untouched.
    let mut no_skills = json!({"skills": [], "skill_refs": {"stale": {"skill_id": 1}}});
    sync_bot_skill_refs(&mut no_skills, &resolved);
    assert_eq!(no_skills["skill_refs"], json!({"stale": {"skill_id": 1}}));
    // A bot with no `skill_refs` field gains none either.
    let mut absent = json!({"skills": []});
    sync_bot_skill_refs(&mut absent, &resolved);
    assert!(absent.get("skill_refs").is_none());

    // Falsey refs are replaced; a stale truthy ref is kept.
    let mut bot = json!({
        "skills": ["a", "b"],
        "skill_refs": {"a": null, "b": {"skill_id": 3, "namespace": "default"}},
    });
    sync_bot_skill_refs(&mut bot, &resolved);
    assert_eq!(
        bot["skill_refs"]["a"],
        json!({"skill_id": 9, "namespace": "default"})
    );
    assert_eq!(
        bot["skill_refs"]["b"],
        json!({"skill_id": 3, "namespace": "default"})
    );

    // An empty-object ref is falsey too.
    let mut empty = json!({"skills": ["a"], "skill_refs": {"a": {}}});
    sync_bot_skill_refs(&mut empty, &resolved);
    assert_eq!(
        empty["skill_refs"]["a"],
        json!({"skill_id": 9, "namespace": "default"})
    );
}
