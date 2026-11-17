use super::super::tests::ScalarEnv;
use super::*;

#[test]
fn catalog_provider_rejects_an_unreadable_configuration() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_CODEX_HOME", home.path().to_str().unwrap());
    // A directory yields a deterministic read error on Unix and Windows.
    fs::create_dir(home.path().join("config.toml")).unwrap();
    assert_invalid_catalog_provider();
    assert_snapshot_provider("fixture-custom");
}

#[test]
fn catalog_provider_rejects_invalid_toml() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _home = ScalarEnv::set("WEGENT_CODEX_HOME", home.path().to_str().unwrap());
    fs::write(home.path().join("config.toml"), "model_provider = [").unwrap();
    assert_invalid_catalog_provider();
    assert_snapshot_provider("fixture-custom");
}

fn assert_invalid_catalog_provider() {
    let result = current_codex_model_provider_from_config(&json!({"config": {
        "model_provider": crate::server::codex_model_catalog::PROVIDER_ID,
        "model": "selected-model"
    }}));
    match result {
        Ok(provider) => {
            let models = codex_models_with_provider(
                &json!({"data":[{"model":"selected-model","isDefault":true}]}),
                &provider,
            );
            panic!("An invalid configuration advertised selectable models: {models:?}");
        }
        Err(error) => assert_eq!(error.code, "codex_models_unavailable"),
    }
}

fn snapshot(layers: Value) -> Value {
    json!({"config":{"model_provider":"~","model":"selected-model",
        "model_providers":{"fixture-custom":{"name":"Fixture custom provider"}}},
        "layers":layers})
}

fn assert_snapshot_provider(expected: &str) {
    let response = snapshot(json!([
        {"name":{"type":"sessionFlags"},"config":{"model_provider":"~"}},
        {"name":{"type":"user","profile":null},"config":{"model_provider":expected}},
        {"name":{"type":"system"},"config":{}}
    ]));
    let provider = current_codex_model_provider_from_config(&response).unwrap();
    assert_eq!(provider.id, expected);
    assert_eq!(provider.display_name, "Fixture custom provider");
    let models = codex_models_with_provider(
        &json!({"data":[{"model":"selected-model","isDefault":true}]}),
        &provider,
    );
    assert_eq!(models[0]["providerId"], expected);
}

#[test]
fn catalog_provider_uses_layer_precedence_and_skips_disabled_layers() {
    for (name, mut layer) in [
        ("sessionFlags", json!({"name":{"type":"sessionFlags"}})),
        ("profile", json!({"name":{"type":"user","profile":"work"}})),
        ("project", json!({"name":{"type":"project"}})),
        ("system", json!({"name":{"type":"system"}})),
    ] {
        layer["config"] = json!({"model_provider":name});
        let mut response = snapshot(json!([
            {"name":{"type":"sessionFlags"},"config":{"model_provider":"~"}},
            layer,
            {"name":{"type":"user"},"config":{"model_provider":"lower-priority"}}
        ]));
        assert_eq!(
            current_codex_model_provider_from_config(&response)
                .unwrap()
                .id,
            name
        );
        response["layers"][1]["disabledReason"] = json!("Project is not trusted");
        assert_eq!(
            current_codex_model_provider_from_config(&response)
                .unwrap()
                .id,
            "lower-priority"
        );
    }
}

#[test]
fn catalog_provider_preserves_effective_external_selection() {
    let provider = current_codex_model_provider_from_config(&json!({"config":{
        "model_provider":"selected-session-provider"
    }}))
    .unwrap();
    assert_eq!(provider.id, "selected-session-provider");
}

#[test]
fn catalog_provider_keeps_a_valid_default_openai_configuration() {
    for response in [
        json!({"config":{}}),
        json!({"config":{"model_provider":"openai"}}),
        snapshot(json!([
            {"name":{"type":"sessionFlags"},"config":{"model_provider":"~"}},
            {"name":{"type":"user"},"config":{}}
        ])),
    ] {
        let provider = current_codex_model_provider_from_config(&response).unwrap();
        assert_eq!(provider.id, "openai");
        assert_eq!(provider.kind, "official");
    }
}

#[test]
fn catalog_provider_rejects_malformed_snapshots() {
    for response in [
        json!({}),
        json!({"config":[]}),
        json!({"config":{"model_provider":123}}),
        json!({"config":{"model_provider":""}}),
        snapshot(json!({})),
        snapshot(json!([])),
        snapshot(json!([{"config":[]} ])),
        snapshot(json!([{"config":{"model_provider":123}}])),
        snapshot(json!([{"config":{},"disabledReason":true}])),
    ] {
        let error = current_codex_model_provider_from_config(&response).unwrap_err();
        assert_eq!(error.code, "codex_models_unavailable");
    }
}

#[test]
fn catalog_provider_never_advertises_internal_router_identities() {
    for internal in ["~", "wework-router", "wework-catalog"] {
        let mut response = snapshot(json!([
            {"name":{"type":"sessionFlags"},"config":{"model_provider":internal}},
            {"name":{"type":"user"},"config":{"model_provider":"actual-provider"}}
        ]));
        response["config"]["model_provider"] = json!(internal);
        assert_eq!(
            current_codex_model_provider_from_config(&response)
                .unwrap()
                .id,
            "actual-provider"
        );
    }
}

#[test]
fn catalog_provider_changes_still_reject_a_previously_selected_provider() {
    let mut payload = json!({
        "runnerPolicy":{"runtime":"codex",
            "execution_policy":{"mode":"fixed","environment_id":"device-1"},
            "model_policy":{"mode":"user_select"}},
        "runnerSelection":{"model":{"runtime":"codex","provider":"old-provider",
            "model_id":"selected-model","local_model_id":"selected-model"}}
    });
    let catalog = json!({"models":[{"runtime":"codex","provider":"new-provider",
        "model_id":"selected-model","local_model_id":"selected-model"}]});
    let error = crate::task_runtime::runner_routing::resolve_pending(
        &mut payload,
        Some(&catalog),
        "device-1",
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("RUNNER_MODEL_UNAVAILABLE"),
        "{error}"
    );
}
