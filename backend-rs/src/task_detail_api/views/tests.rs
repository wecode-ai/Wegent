// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for the task-detail secondary view conversions. Kept beside the
//! module they exercise.

use super::*;

/// The stored team placeholder (`model_dump(exclude_none=True)`) has no
/// entry for an unset locale; the response model re-serializes every
/// locale and device override, so they become explicit nulls.
#[test]
fn team_placeholder_serializes_unset_locales_as_null() {
    let placeholder = OpaqueJson::from(json!({"zh": "提示"}))
        .project::<TeamInputPlaceholder>()
        .expect("stored placeholder projects");
    assert_eq!(
        serde_json::to_value(placeholder).unwrap(),
        json!({"en": null, "zh": "提示", "mobile": null, "desktop": null})
    );
}

/// A device override is a nested locale pair that serializes both keys.
#[test]
fn team_placeholder_keeps_device_overrides() {
    let placeholder = OpaqueJson::from(json!({"mobile": {"zh": "手机"}, "desktop": {}}))
        .project::<TeamInputPlaceholder>()
        .expect("stored placeholder projects");
    assert_eq!(
        serde_json::to_value(placeholder).unwrap(),
        json!({
            "en": null,
            "zh": null,
            "mobile": {"en": null, "zh": "手机"},
            "desktop": {"en": null, "zh": null},
        })
    );
}

/// A stored `displayConfig` object is compacted to its non-null keys and then
/// re-serialized as `TeamDisplayConfig`, so an unset `show_final_answer_only`
/// is an explicit null instead of an absent key.
#[test]
fn team_display_config_serializes_unset_show_final_answer_only_as_null() {
    let from_empty = OpaqueJson::from(json!({}))
        .project::<TeamDisplayConfig>()
        .unwrap_or_default();
    assert_eq!(
        serde_json::to_value(from_empty).unwrap(),
        json!({"show_final_answer_only": null})
    );

    let unset_key = OpaqueJson::from(json!({"show_final_answer_only": null}))
        .project::<TeamDisplayConfig>()
        .unwrap_or_default();
    assert_eq!(
        serde_json::to_value(unset_key).unwrap(),
        json!({"show_final_answer_only": null})
    );

    let disabled = OpaqueJson::from(json!({"show_final_answer_only": false}))
        .project::<TeamDisplayConfig>()
        .unwrap_or_default();
    assert_eq!(
        serde_json::to_value(disabled).unwrap(),
        json!({"show_final_answer_only": false})
    );
}

/// A team without a stored placeholder serializes the field as null.
#[test]
fn missing_team_placeholder_serializes_null() {
    assert_eq!(
        serde_json::to_value(Option::<TeamInputPlaceholder>::None).unwrap(),
        Value::Null
    );
}

fn cached_with_preferences(raw: &str) -> Value {
    serde_json::to_value(render_cached_user(
        UserCacheDocument {
            id: 1,
            user_name: "user".into(),
            _password_hash: String::new(),
            email: None,
            git_info: None,
            is_active: true,
            role: "user".into(),
            auth_source: "test".into(),
            preferences: Some(raw.into()),
            created_at: None,
            updated_at: None,
        },
        crate::user_profile::UserViewExt::empty(),
    ))
    .unwrap()
}

#[test]
fn cached_user_response_materializes_git_info_defaults() {
    let document = serde_json::from_value::<UserCacheDocument>(json!({
        "id": 1001,
        "user_name": "lucy",
        "email": "lucy@example.invalid",
        "git_info": [{"git_domain": "git.example.invalid", "git_token": "t", "type": "gitlab"}],
        "is_active": true,
        "role": "user",
        "auth_source": "oidc",
        "preferences": "{}",
        "created_at": "2025-12-10T10:43:00",
        "updated_at": "2026-07-02T10:24:25"
    }))
    .unwrap();
    let view = serde_json::to_value(render_cached_user(
        document,
        crate::user_profile::UserViewExt::empty(),
    ))
    .unwrap();
    let entry = &view["git_info"][0];
    assert!(entry["auth_type"].is_null());
    assert!(entry["user_name"].is_null());
    assert_eq!(entry["git_login"], Value::Null);
}

/// `UserInDB.parse_preferences` keeps a stored value only when it parses to a
/// non-empty object. A falsy parse (`{}`, `[]`, `false`, `0`, `""`), a
/// non-mapping document, an unparseable one, and the `null` markers all
/// render `null`; recording `/api/tasks/908746360506865` stores the cached
/// document value `"{}"` and the source renders `"preferences": null`.
#[test]
fn cached_preferences_keep_only_non_empty_objects() {
    for raw in [
        "{}", "[]", "false", "0", "\"text\"", " null ", "", "null", "not json",
    ] {
        assert!(
            cached_with_preferences(raw)["preferences"].is_null(),
            "{raw}"
        );
    }
    assert!(cached_with_preferences(r#"{"send_key": "cmd_enter"}"#)["preferences"].is_object());
    assert!(cached_with_preferences(r#"{"runtime_configs": {}}"#)["preferences"].is_object());
}

/// `UserPreferences.composer_quick_phrases` is part of the schema, so the
/// key is always rendered: absent or stored null becomes an explicit
/// `null` (recording: the response carries the key with a null value while
/// the stored preferences JSON has no such key).
#[test]
fn cached_preferences_render_composer_quick_phrases_key() {
    let preferences =
        cached_with_preferences(r#"{"send_key": "cmd_enter"}"#)["preferences"].clone();
    assert_eq!(preferences["composer_quick_phrases"], Value::Null);
    assert_eq!(
        cached_with_preferences(r#"{"composer_quick_phrases": null}"#)["preferences"]["composer_quick_phrases"],
        Value::Null
    );

    let rendered = cached_with_preferences(
        r#"{"composer_quick_phrases": [
                {"id": "p1", "title": "Review", "content": "review this",
                 "mode": "plan", "attachmentPaths": ["/tmp/a.png"],
                 "createdAt": 1.5, "unknown": "dropped"}
            ]}"#,
    )["preferences"]["composer_quick_phrases"]
        .clone();
    assert_eq!(
        rendered,
        json!([{
            "id": "p1",
            "title": "Review",
            "content": "review this",
            "mode": "plan",
            "attachmentPaths": ["/tmp/a.png"],
            "createdAt": 1.5,
        }])
    );
}

/// `UserPreferences.quick_access` is re-rendered through
/// `QuickAccessPreference`, so `version` and `teams` always appear with
/// their schema defaults (recording: the stored object has no `version`
/// but the response renders `{"version": null, "teams": [252243]}`).
#[test]
fn cached_preferences_render_quick_access_defaults() {
    assert_eq!(
        cached_with_preferences(r#"{"quick_access": {"teams": [252243]}}"#)["preferences"]["quick_access"],
        json!({"version": null, "teams": [252243]})
    );
    assert_eq!(
        cached_with_preferences(r#"{"quick_access": {"version": 3, "extra": 1}}"#)["preferences"]["quick_access"],
        json!({"version": 3, "teams": []})
    );
    assert_eq!(
        cached_with_preferences(r#"{"quick_access": null}"#)["preferences"]["quick_access"],
        Value::Null
    );
    assert_eq!(
        cached_with_preferences(r#"{"send_key": "enter"}"#)["preferences"]["quick_access"],
        Value::Null
    );
}

fn context_with(context_type: &str, type_data: Value) -> ContextRow {
    ContextRow {
        subtask_contexts_id: 1,
        subtask_contexts_subtask_id: 7,
        subtask_contexts_context_type: context_type.to_owned(),
        subtask_contexts_name: Some("Selected Documents (2 files)".to_owned()),
        subtask_contexts_status: Some("ready".to_owned()),
        subtask_contexts_type_data: Some(brz_mysql::Json(OpaqueJson::from(type_data))),
    }
}

/// `build_context_display_fields` renders `selected_documents` as
/// `len(document_ids)` and leaves the knowledge/attachment display fields
/// unset (recording: `{"document_count": 2, ...}` for a context with two
/// document ids and no `document_count` of its own).
#[test]
fn selected_documents_context_renders_document_id_count() {
    let brief = context_brief(&context_with(
        "selected_documents",
        json!({"document_ids": [11, 12], "document_count": 99}),
    ));
    assert_eq!(brief.document_count.get(), "2");
    assert_eq!(brief.knowledge_id.get(), "null");
    assert_eq!(brief.document_ids.get(), "null");

    // A non-list (or absent) `document_ids` counts as zero, like the
    // source's `isinstance(document_ids, list)` guard.
    assert_eq!(
        context_brief(&context_with(
            "selected_documents",
            json!({"document_ids": "11,12"})
        ))
        .document_count
        .get(),
        "0"
    );
    assert_eq!(
        context_brief(&context_with("selected_documents", json!({})))
            .document_count
            .get(),
        "0"
    );
}

/// The other context types keep their knowledge-base `document_count`
/// (the stored value, not a derived count).
#[test]
fn knowledge_base_context_keeps_stored_document_count() {
    let brief = context_brief(&context_with(
        "knowledge_base",
        json!({"document_ids": [11, 12], "document_count": 99}),
    ));
    assert_eq!(brief.document_count.get(), "99");
}
