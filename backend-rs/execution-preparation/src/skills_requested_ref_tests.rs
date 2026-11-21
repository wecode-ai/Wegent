// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `find_skill_by_ref` (`skill_resolution.py:116-233`): the lookup order the
//! request's `{"type": "skill"}` names and the late preload re-resolution both
//! walk. Each branch is its own recorded read, so the tests pin the statement
//! sequence, the predicate order, and which side of the reference each
//! parameter binds.

use super::*;
use serde_json::json;

/// `request_builder.py:366-383`: a bare name from the request's
/// `{"type": "skill"}` settings is read as `{"name": name}`, so
/// `find_skill_by_ref` probes the personal `default` namespace and then
/// the team namespace (`skill_resolution.py:168-204`). Both recorded
/// reads bind their values in the source's predicate order.
#[tokio::test]
async fn a_bare_skill_name_probes_the_personal_then_the_team_namespace() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let reference = Value::String("weather-app-100d-analysis-glm".to_string());
    let reference = RequestedSkillRef::parse(&reference).expect("name ref");

    let skill = find_skill_by_ref(&mysql, &reference, 6499, "tqt-weather")
        .await
        .expect("read");
    assert!(skill.is_none());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 2, "{queries:?}");
    assert!(
        queries[0].sql.contains(
            "WHERE kinds.user_id = ? AND kinds.kind = 'Skill' AND kinds.name = ? \
             AND kinds.namespace = ? AND kinds.is_active = true LIMIT 1"
        ),
        "{}",
        queries[0].sql
    );
    assert_eq!(queries[0].args, 3);
    assert_eq!(queries[0].first_integer, Some(6499));
    assert!(
        queries[1].sql.contains(
            "WHERE kinds.kind = 'Skill' AND kinds.name = ? AND kinds.namespace = ? \
             AND kinds.is_active = true LIMIT 1"
        ),
        "{}",
        queries[1].sql
    );
    assert_eq!(queries[1].args, 2);
    // The team branch binds no `user_id`.
    assert_eq!(queries[1].first_integer, None);
}

/// `find_skill_by_ref` skips the team lookup when it would repeat the
/// reference's own namespace (`skill_resolution.py:189-204`), so a
/// `default`-namespace team issues only the personal read.
#[tokio::test]
async fn the_team_lookup_never_repeats_the_reference_namespace() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let reference = Value::String("weather-app-100d-analysis-glm".to_string());
    let reference = RequestedSkillRef::parse(&reference).expect("name ref");

    let skill = find_skill_by_ref(&mysql, &reference, 6499, "default")
        .await
        .expect("read");
    assert!(skill.is_none());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1, "{queries:?}");
    assert_eq!(queries[0].first_integer, Some(6499));
}

/// A reference with an explicit namespace walks the source's full chain:
/// the personal namespace, the namespace's group read, and finally the
/// personal `default` fallback.
#[tokio::test]
async fn an_explicit_namespace_reads_the_group_then_the_personal_default() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let reference = json!({"name": "bairi100analysis-SKILL2", "namespace": "tqt-weather"});
    let reference = RequestedSkillRef::parse(&reference).expect("dict ref");

    let skill = find_skill_by_ref(&mysql, &reference, 6499, "tqt-weather")
        .await
        .expect("read");
    assert!(skill.is_none());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 3, "{queries:?}");
    assert_eq!(queries[0].first_integer, Some(6499));
    assert_eq!(queries[1].first_integer, None);
    assert_eq!(queries[2].first_integer, Some(6499));
    assert!(
        queries[2].sql.contains("kinds.namespace = ?"),
        "{}",
        queries[2].sql
    );
}

/// A public reference is the single `user_id = 0` read (`skill_resolution.py:154-164`);
/// an explicit `skill_id` is the attached-Skill read (`:118-135`).
#[tokio::test]
async fn public_and_explicit_id_references_use_their_own_single_read() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let public_ref = json!({"name": "wegent-knowledge", "is_public": true});
    let public_ref = RequestedSkillRef::parse(&public_ref).expect("public ref");
    find_skill_by_ref(&mysql, &public_ref, 6499, "tqt-weather")
        .await
        .expect("read");
    let attached_ref = json!({"name": "weather-app-100d-analysis-glm", "skill_id": 271925});
    let attached_ref = RequestedSkillRef::parse(&attached_ref).expect("id ref");
    find_skill_by_ref(&mysql, &attached_ref, 6499, "tqt-weather")
        .await
        .expect("read");

    let queries = mysql.queries();
    assert_eq!(queries.len(), 2, "{queries:?}");
    assert!(queries[0].sql.contains("kinds.user_id = 0"), "{queries:?}");
    assert!(
        queries[1].sql.contains("kinds.id = ?") && queries[1].sql.contains("kinds.name = ?"),
        "{queries:?}"
    );
    assert_eq!(queries[1].args, 2);
    assert_eq!(queries[1].first_integer, Some(271925));
}

/// The token service the Skill compiler consults for OAuth-mode servers; the
/// miss fixtures carry no provider Skill row, so it is never called.
struct StubTokens;

#[async_trait::async_trait]
impl UserMcpAccessTokens for StubTokens {
    async fn ensure_access_token(&self, _: &str, _: &str, _: &str) -> Result<String, FastApiError> {
        Ok("stub-token".to_string())
    }
}

/// `_get_bot_skills`' requested stage (`request_builder.py:1782-1810`) for a
/// name that only the available/binding pass resolved: `existing_skill_names`
/// holds Ghost-resolved names only (`:1709,1719`) and the available refs are
/// read afterwards (`:1814`), so both lookups run and their zero rows keep the
/// name out of the preload lists. Promoting it would add
/// `metadata.preload_skill_refs`, `preload_skills` and `user_selected_skills`
/// entries the source never sends.
#[tokio::test]
async fn a_requested_lookup_miss_never_promotes_an_available_skill() {
    let name = "weather-app-100d-analysis-glm";
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let tokens = StubTokens;
    let mut result = BotSkills {
        // The available pass resolved this Skill's row in the source; the
        // stage under test must not treat that as a Ghost origin.
        skills: vec![json!({"name": name})],
        skill_refs: json!({name: {"skill_id": 271925, "namespace": "default"}})
            .as_object()
            .cloned()
            .unwrap_or_default(),
        ..Default::default()
    };

    append_requested_skills(
        &mysql,
        &mut result,
        &[json!(name)],
        6499,
        None,
        &tokens,
        "tqt-weather",
        None,
    )
    .await
    .expect("requested stage");

    // Both source lookups were issued, in order.
    let queries = mysql.queries();
    assert_eq!(queries.len(), 2, "{queries:?}");
    assert_eq!(queries[0].first_integer, Some(6499));
    assert_eq!(queries[1].first_integer, None);
    assert!(
        result.preload_skills.is_empty(),
        "{:?}",
        result.preload_skills
    );
    assert!(result.user_selected_skills.is_empty());
    assert!(preload_skill_refs(&result).get(name).is_none());
}

/// A name the Ghost already resolved keeps its preload marking when the
/// lookup misses (`request_builder.py:1755-1780`); the lookups still run.
#[tokio::test]
async fn a_ghost_skill_stays_preloaded_when_the_lookup_misses() {
    let name = "weather-app-100d-analysis-glm";
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let tokens = StubTokens;
    let mut result = BotSkills {
        existing_skill_names: vec![name.to_string()],
        ..Default::default()
    };

    append_requested_skills(
        &mysql,
        &mut result,
        &[json!(name)],
        6499,
        None,
        &tokens,
        "tqt-weather",
        None,
    )
    .await
    .expect("requested stage");

    assert_eq!(mysql.queries().len(), 2, "{:?}", mysql.queries());
    assert_eq!(result.preload_skills, vec![name.to_string()]);
    assert_eq!(result.user_selected_skills, vec![name.to_string()]);
    assert_eq!(
        result.existing_skill_names,
        vec![name.to_string()],
        "a miss must not grow the resolved set"
    );
}

/// `_get_bot_skills` reads the requested stage before the available refs
/// (`request_builder.py:1730-1814`): the two requested lookups precede the
/// available refs' id read, so a requested resolution claims the name before
/// the available set is resolved.
#[tokio::test]
async fn the_requested_stage_precedes_the_available_refs() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let tokens = StubTokens;
    let merged = crate::ghost::MergedGhostCapabilities::default();
    let requested = vec![json!("weather-app-100d-analysis-glm")];
    let available = vec![json!({
        "name": "bairi100analysis-SKILL2",
        "skill_id": 358643,
        "namespace": "default",
        "is_public": false
    })];

    let skills = crate::skills::get_bot_skills(
        &mysql,
        &merged,
        "manual",
        6499,
        None,
        &tokens,
        "user:6499",
        None,
        6499,
        "tqt-weather",
        &requested,
        &available,
    )
    .await
    .expect("compiled skills");

    let queries = mysql.queries();
    assert!(queries.len() >= 3, "{queries:?}");
    assert_eq!(queries[0].first_integer, Some(6499));
    assert!(queries[0].sql.contains("kinds.user_id = ?"), "{queries:?}");
    assert_eq!(queries[1].first_integer, None);
    assert!(
        queries[1].sql.contains("kinds.namespace = ?"),
        "{queries:?}"
    );
    assert!(
        queries[2].sql.contains("kinds.id = ?") && queries[2].sql.contains("kinds.name = ?"),
        "the available id read must come after the requested stage: {queries:?}"
    );
    assert!(
        skills.preload_skills.is_empty(),
        "{:?}",
        skills.preload_skills
    );
}

/// `request_builder.py:373-380`: `force_preload` binding refs join the
/// requested stage; the rest join the available refs, in binding order.
#[test]
fn force_preload_binding_refs_route_into_the_requested_stage() {
    let bindings = vec![
        json!({"name": "a", "skill_id": 1, "force_preload": true}),
        json!({"name": "b", "skill_id": 2}),
        json!({"name": "c", "skill_id": 3, "force_preload": true}),
    ];
    let mut requested = vec![json!("explicit")];
    let mut available = vec![json!({"name": "subscription-manager", "is_public": true})];

    route_binding_refs(bindings, &mut requested, &mut available);

    let names = |refs: &[Value]| {
        refs.iter()
            .map(|reference| {
                reference
                    .as_str()
                    .or_else(|| reference["name"].as_str())
                    .unwrap_or_default()
                    .to_string()
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&requested), vec!["explicit", "a", "c"]);
    assert_eq!(names(&available), vec!["subscription-manager", "b"]);
}

/// Once the requested stage resolved a name it owns the `skill_refs` entry
/// (`request_builder.py:920-924`), so the available stage issues no id read and
/// builds no second Skill for it (`:1826`).
#[tokio::test]
async fn a_claimed_name_issues_no_available_id_read() {
    let name = "weather-app-100d-analysis-glm";
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let tokens = StubTokens;
    let mut result = BotSkills::default();
    result.skill_refs.insert(
        name.to_string(),
        json!({"skill_id": 271925, "namespace": "default", "is_public": false}),
    );
    let available = vec![json!({
        "name": name,
        "skill_id": 271925,
        "namespace": "default",
        "is_public": false
    })];

    crate::skills::append_available_skills(
        &mysql,
        &mut result,
        &available,
        6499,
        None,
        &tokens,
        "user:6499",
        None,
    )
    .await
    .expect("available stage");

    assert!(mysql.queries().is_empty(), "{:?}", mysql.queries());
    assert!(result.skills.is_empty());
    assert_eq!(result.preload_skills, Vec::<String>::new());
}
