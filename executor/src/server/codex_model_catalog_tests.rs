// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn rejects_malformed_catalog_without_replacing_it_with_base_models() {
    let mut catalog = json!({ "data": [] });
    let original = catalog.clone();
    assert!(merge_base_models(&mut catalog).is_err());
    assert_eq!(catalog, original);
}

#[test]
fn rejects_uneditable_model_entries_before_merging() {
    for model in [
        Value::Null,
        json!({}),
        json!({"slug": " "}),
        json!({"slug": 42}),
    ] {
        let mut catalog = json!({"models": [model]});
        let original = catalog.clone();
        assert!(merge_base_models(&mut catalog).is_err());
        assert_eq!(catalog, original);
    }
    assert!(validate_catalog(&json!({"models": []})).is_ok());
    assert!(validate_catalog(&json!({"models": [{"slug": "gpt-6.1-sol"}]})).is_ok());
}

fn catalog() -> Value {
    let mut catalog = json!({
        "models": base_models()
    });
    append_catalog_vision_sidecars(&mut catalog);
    catalog
}

#[test]
fn native_catalog_can_be_saved_without_obsolete_capability_fields() {
    let mut baseline = model_entry("gpt-6.1-sol", "GPT-6.1-Sol", None);
    let object = baseline.as_object_mut().expect("model object");
    object.remove("supports_reasoning_summaries");
    object.remove("supports_parallel_tool_calls");
    let mut edited = baseline.clone();
    edited["context_window"] = json!(600_000);
    let fields =
        catalog_override_fields(&baseline, &edited, "gpt-6.1-sol").expect("native override diff");
    assert_eq!(fields.len(), 1);
    apply_override_fields(&mut baseline, &fields);
    validate_catalog_model(&baseline).expect("current Codex schema is valid");
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
async fn bundled_catalog_preserves_native_models_and_supports_overrides() {
    let (home, binary) = catalog_export_fixture("success");
    let mut catalog = export_bundled_catalog(&binary, home.path())
        .await
        .expect("native bundled catalog");
    merge_base_models(&mut catalog).unwrap();
    let models = catalog["models"].as_array().expect("models");
    assert_eq!(
        models
            .iter()
            .filter(|model| model["slug"] == "gpt-5.6-sol")
            .count(),
        1
    );
    assert_eq!(models[1]["context_window"], 500_000);
    let baseline = models[0].clone();
    let mut edited = baseline.clone();
    edited["context_window"] = json!(600_000);
    let fields =
        catalog_override_fields(&baseline, &edited, "gpt-6.1-sol").expect("native model override");
    assert_eq!(fields.len(), 1);
    apply_catalog_overrides(
        &mut catalog,
        &[CatalogOverride {
            slug: "gpt-6.1-sol".to_owned(),
            fields,
        }],
    );
    assert_eq!(catalog["models"][0]["context_window"], 600_000);
    assert_eq!(
        catalog["models"][0]["native_field"],
        json!({"enabled": true})
    );
    let restored_fields = catalog_override_fields(&baseline, &baseline, "gpt-6.1-sol")
        .expect("restore native baseline");
    assert!(restored_fields.is_empty());
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
fn catalog_includes_verified_builtin_kimi_profiles() {
    let catalog = catalog();
    let models = catalog["models"].as_array().expect("models array");
    let k3 = models
        .iter()
        .find(|model| model["slug"] == KIMI_K3_MODEL)
        .expect("Kimi K3 entry");
    assert!(k3["base_instructions"]
        .as_str()
        .is_some_and(
            |instructions| instructions.len() > 10_000 && !instructions.contains("based on GPT-5")
        ));
    assert_eq!(k3["context_window"], 1_048_576);
    assert_eq!(k3["auto_compact_token_limit"], Value::Null);
    assert_eq!(k3["default_reasoning_level"], "low");
    assert_eq!(k3["supports_parallel_tool_calls"], false);
    assert_eq!(k3["supports_search_tool"], true);

    let k27 = models
        .iter()
        .find(|model| model["slug"] == KIMI_K27_MODEL)
        .expect("Kimi K2.7 entry");
    assert_eq!(k27["context_window"], 262_144);
    assert_eq!(k27["supports_search_tool"], true);

    let kimi_k31_pro = models
        .iter()
        .find(|model| model["slug"] == "wework-kimi-k3-1-pro")
        .expect("Kimi K3.1 Pro entry");
    assert_eq!(kimi_k31_pro["context_window"], 1_048_576);
    assert_eq!(kimi_k31_pro["max_context_window"], 1_048_576);
    assert_eq!(kimi_k31_pro["auto_compact_token_limit"], Value::Null);
}

#[test]
fn catalog_includes_wework_long_context_profiles() {
    let catalog = catalog();
    let models = catalog["models"].as_array().expect("models array");
    for (slug, context_window) in [
        ("wework-deepseek-v4-1-flash", 1_000_000),
        ("wework-glm-5-3", 1_048_576),
        ("wework-qwen-3-8-max", 1_048_576),
        ("wework-gpt-6-luna", 1_000_000),
    ] {
        let model = models
            .iter()
            .find(|model| model["slug"] == slug)
            .unwrap_or_else(|| panic!("{slug} entry"));
        assert_eq!(model["context_window"], context_window);
        assert_eq!(model["max_context_window"], context_window);
        assert_eq!(model["auto_compact_token_limit"], Value::Null);
        assert_eq!(model["apply_patch_tool_type"], "freeform");
    }
}

#[test]
fn catalog_includes_an_exact_gpt_6_astra_profile() {
    let catalog = catalog();
    let model = catalog["models"]
        .as_array()
        .expect("models array")
        .iter()
        .find(|model| model["slug"] == "gpt-6-astra")
        .expect("GPT-6 Astra entry");

    assert_eq!(model["context_window"], 272_000);
    assert_eq!(model["max_context_window"], 872_000);
    assert_eq!(model["auto_compact_token_limit"], Value::Null);
    assert_eq!(model["apply_patch_tool_type"], "freeform");
}

#[test]
fn catalog_includes_native_deepseek_v4_profiles() {
    let catalog = catalog();
    let model = catalog["models"]
        .as_array()
        .expect("models array")
        .iter()
        .find(|model| model["slug"] == DEEPSEEK_V4_FLASH_MODEL)
        .expect("DeepSeek V4 Flash entry");

    assert_eq!(model["context_window"], 1_048_576);
    assert_eq!(model["default_reasoning_level"], "high");
    assert_eq!(model["apply_patch_tool_type"], "freeform");
    assert_eq!(model["supports_parallel_tool_calls"], true);
    assert_eq!(model["multi_agent_version"], "v2");
    assert_eq!(model["supports_search_tool"], true);
    assert_eq!(model["visibility"], "none");
    assert_eq!(model["input_modalities"], json!(["text"]));

    let pro_model = catalog["models"]
        .as_array()
        .expect("models array")
        .iter()
        .find(|model| model["slug"] == DEEPSEEK_V4_PRO_MODEL)
        .expect("DeepSeek V4 Pro entry");
    assert_eq!(pro_model["context_window"], 1_048_576);
    assert_eq!(pro_model["default_reasoning_level"], "high");
    assert_eq!(pro_model["apply_patch_tool_type"], "freeform");
    assert_eq!(pro_model["supports_parallel_tool_calls"], true);
    assert_eq!(pro_model["multi_agent_version"], "v2");
    assert_eq!(pro_model["supports_search_tool"], true);
    assert_eq!(pro_model["visibility"], "none");
    assert_eq!(pro_model["input_modalities"], json!(["text"]));

    for base_slug in [DEEPSEEK_V4_FLASH_MODEL, DEEPSEEK_V4_PRO_MODEL] {
        let slug = vision_sidecar_catalog_model_id(base_slug);
        let vision_model = catalog["models"]
            .as_array()
            .expect("models array")
            .iter()
            .find(|model| model["slug"] == slug.as_str())
            .expect("DeepSeek vision delegation entry");
        assert_eq!(vision_model["context_window"], 1_048_576);
        assert_eq!(vision_model["default_reasoning_level"], "high");
        assert_eq!(vision_model["apply_patch_tool_type"], "freeform");
        assert_eq!(vision_model["supports_parallel_tool_calls"], true);
        assert_eq!(vision_model["multi_agent_version"], "v2");
        assert_eq!(vision_model["visibility"], "none");
        assert_eq!(vision_model["input_modalities"], json!(["text", "image"]));
    }
}

#[test]
fn catalog_derives_a_vision_variant_for_every_base_profile() {
    let catalog = catalog();
    let models = catalog["models"].as_array().expect("models array");
    let base_model = models
        .iter()
        .find(|model| model["slug"] == KIMI_K27_MODEL)
        .expect("Kimi base entry");
    let vision_slug = vision_sidecar_catalog_model_id(KIMI_K27_MODEL);
    let vision_model = models
        .iter()
        .find(|model| model["slug"] == vision_slug)
        .expect("derived Kimi vision entry");

    assert_eq!(vision_model["context_window"], base_model["context_window"]);
    assert_eq!(
        vision_model["supports_parallel_tool_calls"],
        base_model["supports_parallel_tool_calls"]
    );
    assert_eq!(vision_model["input_modalities"], json!(["text", "image"]));
    assert_eq!(vision_model["visibility"], "none");
}

#[test]
fn vision_derivation_preserves_arbitrary_catalog_capabilities() {
    let mut models = vec![json!({
        "slug": "operator-model",
        "display_name": "Operator Model",
        "description": "Operator-defined capabilities",
        "visibility": "list",
        "context_window": 777_777,
        "default_reasoning_level": "max",
        "supports_parallel_tool_calls": true,
        "experimental_supported_tools": ["custom_tool"],
        "input_modalities": ["text", "audio"]
    })];

    append_vision_sidecar_models(&mut models);

    let vision_model = models
        .iter()
        .find(|model| model["slug"] == "operator-model-vision-sidecar")
        .expect("derived operator vision entry");
    assert_eq!(vision_model["context_window"], 777_777);
    assert_eq!(vision_model["default_reasoning_level"], "max");
    assert_eq!(vision_model["supports_parallel_tool_calls"], true);
    assert_eq!(
        vision_model["experimental_supported_tools"],
        json!(["custom_tool"])
    );
    assert_eq!(
        vision_model["input_modalities"],
        json!(["text", "audio", "image"])
    );
    assert_eq!(vision_model["visibility"], "none");
}

#[test]
fn vision_derivation_adds_text_to_an_image_only_profile() {
    let base = json!({
        "slug": "image-only-model",
        "display_name": "Image-only Model",
        "input_modalities": ["image"]
    });

    let vision_model = vision_sidecar_catalog_model(&base).expect("derived model");

    assert_eq!(vision_model["input_modalities"], json!(["text", "image"]));
}

#[test]
fn merge_derives_vision_from_the_effective_upstream_base_profile() {
    let mut catalog = json!({
        "models": [{
            "slug": GPT_56_SOL_MODEL,
            "display_name": "Upstream Sol",
            "description": "Effective upstream profile",
            "context_window": 999_999,
            "supports_parallel_tool_calls": true,
            "input_modalities": ["text"]
        }]
    });

    merge_base_models(&mut catalog).unwrap();
    apply_catalog_overrides(&mut catalog, &read_catalog_overrides());
    append_catalog_vision_sidecars(&mut catalog);

    let vision_slug = vision_sidecar_catalog_model_id(GPT_56_SOL_MODEL);
    let vision_model = catalog["models"]
        .as_array()
        .expect("models array")
        .iter()
        .find(|model| model["slug"] == vision_slug)
        .expect("derived upstream vision entry");
    assert_eq!(
        vision_model["display_name"],
        "Upstream Sol with vision delegation"
    );
    assert_eq!(vision_model["context_window"], 999_999);
    assert_eq!(vision_model["supports_parallel_tool_calls"], true);
    assert_eq!(vision_model["input_modalities"], json!(["text", "image"]));
}

#[test]
fn catalog_includes_wework_gpt_56_compatibility_profiles() {
    let catalog = catalog();
    let models = catalog["models"].as_array().expect("models array");
    let slugs: Vec<&str> = models
        .iter()
        .filter_map(|model| model["slug"].as_str())
        .collect();
    assert!(slugs.contains(&WEWORK_GPT_56_SOL_MODEL));
    assert!(slugs.contains(&WEWORK_GPT_56_TERRA_MODEL));
    assert!(slugs.contains(&WEWORK_GPT_56_LUNA_MODEL));

    let sol = models
        .iter()
        .find(|model| model["slug"] == WEWORK_GPT_56_SOL_MODEL)
        .expect("wework gpt-5.6-sol entry");
    assert_eq!(sol["apply_patch_tool_type"], "freeform");
    assert_eq!(sol["supports_parallel_tool_calls"], false);
    assert_eq!(sol["supports_search_tool"], true);
    assert_eq!(sol["visibility"], "none");
    assert_eq!(sol["context_window"], 272_000);
    assert_eq!(sol["max_context_window"], Value::Null);
}

#[test]
fn catalog_lists_official_gpt_56_models_without_exposing_internal_profiles() {
    let catalog = catalog();
    let models = catalog["models"].as_array().expect("models array");

    for (slug, priority) in [
        (GPT_56_SOL_MODEL, 1),
        (GPT_56_TERRA_MODEL, 2),
        (GPT_56_LUNA_MODEL, 3),
    ] {
        let model = models
            .iter()
            .find(|model| model["slug"] == slug)
            .unwrap_or_else(|| panic!("missing official model {slug}"));
        assert_eq!(model["visibility"], "list");
        assert_eq!(model["priority"], priority);
        assert_eq!(model["supports_search_tool"], true);
        assert_eq!(model["max_context_window"], 272_000);
    }

    for slug in [
        KIMI_K3_MODEL,
        KIMI_K27_MODEL,
        DEEPSEEK_V4_FLASH_MODEL,
        DEEPSEEK_V4_PRO_MODEL,
        WEWORK_GPT_56_SOL_MODEL,
        WEWORK_GPT_56_TERRA_MODEL,
        WEWORK_GPT_56_LUNA_MODEL,
    ] {
        let model = models
            .iter()
            .find(|model| model["slug"] == slug)
            .unwrap_or_else(|| panic!("missing internal profile {slug}"));
        assert_eq!(model["visibility"], "none");
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
fn normalizes_reasoning_summary_fields_for_codex_versions() {
    let mut entry = model_entry(
        "wework-custom-compatibility-test",
        "Compatibility test",
        Some("freeform"),
    );
    entry
        .as_object_mut()
        .expect("catalog entry")
        .remove("supports_reasoning_summaries");
    entry["supports_reasoning_summary_parameter"] = Value::Bool(false);

    let normalized = normalize_compatibility_fields(entry);

    assert_eq!(normalized["supports_reasoning_summaries"], false);
    assert_eq!(normalized["supports_reasoning_summary_parameter"], false);
    assert!(validate_custom_model(&normalized).is_ok());
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
fn stores_only_changed_catalog_fields_and_preserves_null_values() {
    let baseline = json!({
        "slug": "gpt-test",
        "display_name": "GPT Test",
        "context_window": 272_000,
        "auto_compact_token_limit": 200_000,
        "future_capability": {"enabled": true}
    });
    let entry = json!({
        "slug": "gpt-test",
        "display_name": "GPT Test",
        "context_window": 300_000,
        "auto_compact_token_limit": null,
        "future_capability": {"enabled": true}
    });

    let fields = catalog_override_fields(&baseline, &entry, "gpt-test").expect("catalog diff");

    assert_eq!(
        fields,
        BTreeMap::from([
            ("auto_compact_token_limit".to_owned(), Value::Null),
            ("context_window".to_owned(), json!(300_000)),
        ])
    );
}

#[test]
fn applies_catalog_overrides_before_deriving_vision_sidecars() {
    let mut catalog = json!({
        "models": [{
            "slug": "gpt-test",
            "display_name": "GPT Test",
            "context_window": 272_000,
            "input_modalities": ["text"]
        }]
    });
    let overrides = vec![CatalogOverride {
        slug: "gpt-test".to_owned(),
        fields: BTreeMap::from([("context_window".to_owned(), json!(300_000))]),
    }];

    apply_catalog_overrides(&mut catalog, &overrides);
    append_catalog_vision_sidecars(&mut catalog);

    let models = catalog["models"].as_array().expect("models array");
    assert_eq!(models[0]["context_window"], 300_000);
    let sidecar = models
        .iter()
        .find(|model| model["slug"] == "gpt-test-vision-sidecar")
        .expect("vision sidecar");
    assert_eq!(sidecar["context_window"], 300_000);
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
