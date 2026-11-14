// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn native_catalog_fixture() -> Value {
    json!({"models":[{
        "slug":"native-default", "visibility":"list", "priority":1,
        "base_instructions":"Native Codex base instructions",
        "model_messages":{"instructions_template":"Native canonical template", "permissions":{"read_only":"Native permission guidance"}},
        "include_skills_usage_instructions":true,
        "include_plugin_usage_instructions":false,
        "include_apps_usage_instructions":false
    }]})
}

#[tokio::test]
async fn rejects_malformed_catalog_without_replacing_it_with_base_models() {
    let mut catalog = json!({ "data": [] });
    let original = catalog.clone();
    assert!(
        merge_base_models(&mut catalog, Some(&native_catalog_fixture()))
            .await
            .is_err()
    );
    assert_eq!(catalog, original);
}

#[tokio::test]
async fn rejects_uneditable_model_entries_before_merging() {
    for model in [
        Value::Null,
        json!({}),
        json!({"slug": " "}),
        json!({"slug": 42}),
    ] {
        let mut catalog = json!({"models": [model]});
        let original = catalog.clone();
        assert!(
            merge_base_models(&mut catalog, Some(&native_catalog_fixture()))
                .await
                .is_err()
        );
        assert_eq!(catalog, original);
    }
    assert!(validate_catalog(&json!({"models": []})).is_ok());
    assert!(validate_catalog(&json!({"models": [{"slug": "gpt-6.1-sol"}]})).is_ok());
}

#[tokio::test]
async fn compatibility_catalogs_keep_tools_and_configured_windows_without_official_auth() {
    let official = json!({
        "slug": "gpt-6.1-sol",
        "tool_mode": "code_mode_only",
        "use_responses_lite": true,
        "max_context_window": 872_000,
    });
    let mut catalog = json!({"models": [official.clone()]});
    merge_base_models(&mut catalog, Some(&native_catalog_fixture()))
        .await
        .unwrap();
    let models = catalog["models"].as_array().unwrap();
    assert_eq!(models[0], official);
    for slug in [
        "wework-gpt-5.6-sol",
        "wework-gpt-6.1-sol",
        "wework-gpt-6-astra",
    ] {
        let model = models.iter().find(|model| model["slug"] == slug).unwrap();
        assert_eq!(model["tool_mode"], "code_mode_only", "{slug}");
        assert_eq!(model["use_responses_lite"], false, "{slug}");
        assert_eq!(model["max_context_window"], Value::Null, "{slug}");
        assert_eq!(model["shell_type"], "shell_command", "{slug}");
        assert_eq!(model["apply_patch_tool_type"], "freeform", "{slug}");
        assert_eq!(model["supports_search_tool"], true, "{slug}");
    }
}

#[test]
fn cloud_model_identity_resolves_to_protocol_independent_compatibility_profiles() {
    for (model_id, expected) in [
        (" GPT-6.1-Sol ", "wework-gpt-6.1-sol"),
        ("gpt-6-astra", "wework-gpt-6-astra"),
        ("moonshot-kimi-k3.1-pro-highspeed", "wework-kimi-k3-1-pro"),
        ("kimi-k3", "wework-kimi-k3"),
        ("huoshan-deepseek-v4.1-flash", "wework-deepseek-v4-1-flash"),
    ] {
        assert_eq!(
            catalog_model_id_for_upstream(model_id).as_deref(),
            Some(expected)
        );
    }
    assert_eq!(catalog_model_id_for_upstream("unknown-model"), None);
    assert_eq!(catalog_model_id_for_upstream("  "), None);
}

#[cfg(unix)]
fn catalog_export_fixture(mode: &str) -> (tempfile::TempDir, String) {
    use std::os::unix::fs::symlink;

    let home = tempfile::tempdir().expect("isolated Codex home");
    let binary = home.path().join("codex");
    // A parallel fork can inherit the writer of a newly written executable.
    // Execute a checked-in script; only its non-executable input varies per test.
    fs::write(home.path().join("catalog-fixture-mode"), mode).expect("fixture mode");
    symlink(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex-bundled-catalog.sh"),
        &binary,
    )
    .expect("Codex fixture symlink");
    (home, binary.to_string_lossy().into_owned())
}

#[cfg(unix)]
#[tokio::test]
async fn bundled_catalog_export_reports_failures_without_substituting_models() {
    for (mode, expected) in [
        ("exit", "Codex bundled catalog export failed"),
        ("invalid-json", "Invalid Codex bundled catalog"),
        ("missing-models", "must contain a models array"),
    ] {
        let (home, binary) = catalog_export_fixture(mode);
        let error = export_bundled_catalog(&binary, home.path())
            .await
            .unwrap_err();
        assert!(error.contains(expected), "{error}");
    }
}

#[test]
fn validates_complete_custom_catalog_entries_without_accepting_official_slugs() {
    let mut entry = model_entry(
        "wework-custom-registration-test",
        "Registration test",
        Some("freeform"),
    );
    entry["supports_parallel_tool_calls"] = Value::Bool(true);

    assert!(validate_custom_model(&entry).is_ok());

    entry["slug"] = Value::String("gpt-5.6-sol".to_owned());
    assert!(validate_custom_model(&entry).is_err());
}

#[test]
fn persists_custom_catalog_entries_atomically() {
    let root = tempfile::tempdir().expect("temporary catalog directory");
    let path = root.path().join("capabilities/model-catalog.json");
    let entry = model_entry(
        "wework-custom-persistence-test",
        "Persistence test",
        Some("freeform"),
    );

    write_custom_models_to(&path, std::slice::from_ref(&entry))
        .expect("custom model catalog should be written");

    let stored: Vec<Value> =
        serde_json::from_slice(&fs::read(path).expect("custom model catalog should be readable"))
            .expect("custom model catalog should contain JSON");
    assert_eq!(stored, vec![entry]);
}

#[test]
fn persists_catalog_overrides_atomically() {
    let root = tempfile::tempdir().expect("temporary catalog directory");
    let path = root
        .path()
        .join("capabilities/model-catalog-overrides.json");
    let overrides = vec![CatalogOverride {
        slug: "gpt-test".to_owned(),
        fields: BTreeMap::from([("context_window".to_owned(), json!(300_000))]),
    }];

    write_catalog_overrides_to(&path, &overrides).expect("catalog overrides should be written");

    assert_eq!(
        read_catalog_overrides_from(&path).expect("catalog overrides should be readable")[0].fields,
        overrides[0].fields
    );
}

#[test]
fn invalidates_models_cache_and_accepts_missing_cache() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("models_cache.json");
    fs::write(&path, b"cached").expect("cache fixture");

    invalidate_models_cache_at(&path).expect("cache should be removed");
    assert!(!path.exists());
    invalidate_models_cache_at(&path).expect("missing cache should be accepted");
}

#[tokio::test]
async fn native_defaults_preserve_the_canonical_template_permissions_and_metadata() {
    let permissions = json!({"danger_full_access":"native permission guidance"});
    let mut catalog = json!({"models":[{"slug":"native-template-fixture", "base_instructions":"legacy provider prompt", "model_messages":{"instructions_template":"canonical provider prompt", "permissions":permissions.clone()}, "context_window":500000}]});
    let original = catalog["models"][0].clone();
    merge_base_models(&mut catalog, Some(&native_catalog_fixture()))
        .await
        .unwrap();
    let model = &catalog["models"][0];
    assert_eq!(*model, original);
    assert_eq!(model["base_instructions"], "legacy provider prompt");
    assert_eq!(
        model["model_messages"]["instructions_template"],
        "canonical provider prompt"
    );
    assert_eq!(model["model_messages"]["permissions"], permissions);
    assert_eq!(model["context_window"], 500000);
}

#[test]
fn legacy_default_identity_preserves_user_edits() {
    let legacy = include_str!("../tests/fixtures/legacy-base-instructions.md");
    assert!(is_legacy_base_instructions(legacy));
    assert!(!is_legacy_base_instructions(&format!(
        "{legacy}\nUser edit"
    )));
    assert!(!is_legacy_base_instructions(&legacy.replacen(
        "You are Codex, an agent based on GPT-5.",
        "You are Codex, a coding agent.",
        1,
    )));
    let progressive = include_str!("../tests/fixtures/legacy-progressive-instructions.md");
    assert!(is_legacy_base_instructions(progressive));
    assert!(!is_legacy_base_instructions(&format!(
        "{progressive}\nUser edit"
    )));
}

#[test]
fn compatibility_profiles_inherit_the_native_default_without_overwriting_user_instructions() {
    let native = native_catalog_fixture()["models"][0].clone();
    for legacy in [
        None,
        Some(include_str!(
            "../tests/fixtures/legacy-base-instructions.md"
        )),
        Some(include_str!(
            "../tests/fixtures/legacy-progressive-instructions.md"
        )),
    ] {
        let mut model = model_entry("wework-custom-inherited", "Inherited", None);
        if let Some(legacy) = legacy {
            model["base_instructions"] = json!(legacy);
        }
        inherit_native_instructions(&mut model, &native).unwrap();
        assert_eq!(model["base_instructions"], native["base_instructions"]);
        assert_eq!(model["model_messages"], native["model_messages"]);
        assert_eq!(model["include_skills_usage_instructions"], true);
        assert_eq!(model["slug"], "wework-custom-inherited");
        assert_eq!(model["tool_mode"], "code_mode_only");
    }
    for explicit in [
        json!({"base_instructions":"User instructions", "model_messages":null}),
        json!({"model_messages":{"instructions_template":"User canonical template", "permissions":{"read_only":"User permission guidance"}}}),
        json!({"base_instructions":""}),
    ] {
        let mut model = explicit.clone();
        let mut expected = explicit;
        expected["include_skills_usage_instructions"] = json!(true);
        expected["include_plugin_usage_instructions"] = json!(false);
        expected["include_apps_usage_instructions"] = json!(false);
        inherit_native_instructions(&mut model, &native).unwrap();
        assert_eq!(model, expected);
    }
    let mut edited = json!({
        "base_instructions":"User-edited base instructions",
        "model_messages":{"instructions_template":include_str!("../tests/fixtures/legacy-progressive-instructions.md"), "permissions":{"read_only":"Preserved"}}
    });
    inherit_native_instructions(&mut edited, &native).unwrap();
    assert_eq!(
        edited["model_messages"]["instructions_template"],
        edited["base_instructions"]
    );
    assert_eq!(
        edited["model_messages"]["permissions"]["read_only"],
        "Preserved"
    );
    let mut explicit_usage = json!({"include_skills_usage_instructions":false});
    inherit_native_instructions(&mut explicit_usage, &native).unwrap();
    assert_eq!(explicit_usage["include_skills_usage_instructions"], false);
    assert_eq!(explicit_usage["model_messages"], native["model_messages"]);
}

#[test]
fn legacy_instruction_edits_update_native_templates_without_dropping_other_messages() {
    let mut model = json!({"base_instructions":"default", "model_messages":{"instructions_template":"default", "permissions":{"read_only":"native permission text"}}});
    apply_override_fields(
        &mut model,
        &BTreeMap::from([("base_instructions".into(), json!("User instructions"))]),
    );
    assert_eq!(
        model["model_messages"]["instructions_template"],
        "User instructions"
    );
    assert_eq!(
        model["model_messages"]["permissions"]["read_only"],
        "native permission text"
    );
    apply_override_fields(
        &mut model,
        &BTreeMap::from([
            ("base_instructions".into(), json!("legacy")),
            (
                "model_messages".into(),
                json!({"instructions_template":"Explicit canonical instructions"}),
            ),
        ]),
    );
    assert_eq!(
        model["model_messages"]["instructions_template"],
        "Explicit canonical instructions"
    );
}
