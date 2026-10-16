// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::models_unified::{models::UnifiedModel, mysql::KindRow};
use protocol::Protocol;
use schema::DecisionRequest;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/decisions.json")).unwrap()
}

pub(super) fn request() -> DecisionRequest {
    DecisionRequest::parse(br#"{"model":"catalog-id","state":{"comment":"urgent"},"questions":{"urgent":{"type":"noul","instructions":"Is it urgent?"}}}"#).unwrap()
}

fn model(scope: &'static str, namespace: &str, owner: i64, name: &str) -> catalog::ModelResource {
    let time = chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc();
    let row = KindRow {
        id: 12,
        user_id: owner as i32,
        kind: "Model".into(),
        name: name.into(),
        namespace: namespace.into(),
        json: brz_mysql::Json(
            json!({"spec": {"private": "secret", "modelConfig": {"env": {"api_key": "private-key", "base_url": "https://private.example/v1"}}}}),
        ),
        is_active: true,
        created_at: time,
        updated_at: time,
    };
    (
        UnifiedModel {
            name: name.into(),
            model_type: scope,
            namespace: namespace.into(),
            resource_user_id: Some(owner),
            display_name: Some("Decision".into()),
            provider: Some("systemone".into()),
            model_id: Some("provider-model".into()),
            config: json!({"protocol": "systemone", "env": {"api_key": "private-key"}})
                .as_object()
                .unwrap()
                .clone(),
            is_active: true,
            model_category_type: "decision".into(),
            is_advanced: false,
            model_group: None,
            model_sub_group: None,
            context_window: None,
            max_output_tokens: None,
            cost_index: None,
            capability: None,
            model_capabilities: None,
            resource_id: Some(12),
            created_at: None,
            updated_at: None,
            is_reference: false,
        },
        row,
    )
}

#[test]
fn protocol_contract_matches_python_for_all_question_types_and_refusals() {
    for case in fixtures()["cases"].as_array().unwrap() {
        let request =
            DecisionRequest::parse(&serde_json::to_vec(&case["request"]).unwrap()).unwrap();
        let protocol = Protocol::parse(case["protocol"].as_str().unwrap()).unwrap();
        assert_eq!(
            protocol::payload(&request, protocol, "provider-model"),
            case["payload"]
        );
        assert_eq!(
            protocol::normalize(&case["response"], &request, protocol).unwrap(),
            case["normalized"]
        );
    }
}

#[test]
fn catalog_ids_match_python_including_unicode_and_resource_scope() {
    for case in fixtures()["identities"].as_array().unwrap() {
        let identity = &case["identity"];
        let scope = match identity[0].as_str().unwrap() {
            "user" => "user",
            "group" => "group",
            _ => "public",
        };
        let (entry, _) = model(
            scope,
            identity[1].as_str().unwrap(),
            identity[2].as_i64().unwrap(),
            identity[3].as_str().unwrap(),
        );
        assert_eq!(catalog::model_key(&entry), case["id"]);
    }
}

#[test]
fn catalog_projects_only_safe_fields_and_selection_uses_fresh_authorization() {
    let models = vec![
        model("user", "default", 17, "same"),
        model("public", "default", 0, "same"),
    ];
    let catalog = catalog::project(&models);
    assert_ne!(catalog["models"][0]["id"], catalog["models"][1]["id"]);
    assert_eq!(catalog["defaultModel"], catalog["models"][0]["id"]);
    let rendered = catalog.to_string();
    for private in [
        "api_key",
        "private-key",
        "private.example",
        "secret",
        "resourceUserId",
    ] {
        assert!(!rendered.contains(private));
    }
    assert_eq!(
        catalog::select(models, catalog["models"][1]["id"].as_str().unwrap())
            .unwrap()
            .user_id,
        0
    );
    // The caller's next visibility read can revoke a grant or remove a model.
    assert_eq!(
        catalog::select(vec![], catalog["defaultModel"].as_str().unwrap())
            .unwrap_err()
            .status,
        404
    );
    assert_eq!(
        catalog::project(&[]),
        json!({"protocolVersion": 1, "defaultModel": "", "models": []})
    );
}

#[test]
fn rejects_undeclared_fields_invalid_criteria_and_non_structured_state() {
    let base: Value = serde_json::from_slice(
        br#"{"model":"m","state":"","questions":{"q":{"type":"noul","instructions":"q"}}}"#,
    )
    .unwrap();
    let mut mutations = Vec::new();
    for (field, value) in [
        ("model", json!("bad model")),
        ("state", json!(null)),
        ("state", json!(3)),
        ("extra", json!(true)),
        ("questions", json!({})),
    ] {
        let mut value_mut = base.clone();
        value_mut[field] = value;
        mutations.push(value_mut);
    }
    for question in [
        json!({"type":"predicate","instructions":"q"}),
        json!({"type":"noul","instructions":" "}),
        json!({"type":"noul","instructions":[]}),
        json!({"type":"noul","instructions":"q","extra":1}),
        json!({"type":"noul","instructions":"q","criteria":{"unknown":"x"}}),
        json!({"type":"choice","instructions":"q","criteria":{}}),
        json!({"type":"choice","instructions":"q","criteria":{" ":null}}),
        json!({"type":"score","instructions":"q","criteria":["only"]}),
        json!(["noul", "q", null]),
    ] {
        let mut value = base.clone();
        value["questions"]["q"] = question;
        mutations.push(value);
    }
    for value in mutations {
        assert!(
            DecisionRequest::parse(&serde_json::to_vec(&value).unwrap()).is_err(),
            "{value}"
        );
    }
    for count in [20, 21] {
        let mut value = base.clone();
        value["questions"] = Value::Object(
            (0..count)
                .map(|index| (index.to_string(), base["questions"]["q"].clone()))
                .collect(),
        );
        assert_eq!(
            DecisionRequest::parse(&serde_json::to_vec(&value).unwrap()).is_ok(),
            count == 20
        );
    }
    assert!(DecisionRequest::parse(&serde_json::to_vec(&base).unwrap()).is_ok());
    assert!(
        DecisionRequest::parse(br#"["m", "state", {"q":{"type":"noul","instructions":"q"}}]"#)
            .is_err()
    );
}

#[test]
fn rejects_invalid_response_shapes_values_and_probability_distributions() {
    let cases = fixtures();
    for case in cases["cases"].as_array().unwrap().iter().take(2) {
        let request =
            DecisionRequest::parse(&serde_json::to_vec(&case["request"]).unwrap()).unwrap();
        let protocol = Protocol::parse(case["protocol"].as_str().unwrap()).unwrap();
        for answers in [json!({}), json!([]), json!(null), json!("provider secret")] {
            assert!(protocol::normalize(&json!({"answers": answers}), &request, protocol).is_err());
        }
        let mut bad = case["response"].clone();
        let urgent = if protocol == Protocol::SystemOne {
            &mut bad["answers"]["urgent"]
        } else {
            &mut bad["answers"][1]
        };
        urgent[if protocol == Protocol::SystemOne {
            "noul"
        } else {
            "probability"
        }] = json!(true);
        assert!(protocol::normalize(&bad, &request, protocol).is_err());
    }
    let request = request();
    for number in [
        json!(-0.1),
        json!(1.1),
        json!("0.9"),
        json!(true),
        json!(null),
    ] {
        assert!(
            protocol::normalize(
                &json!({"answers":{"urgent":{"type":"noul","noul":number}}}),
                &request,
                Protocol::SystemOne
            )
            .is_err()
        );
    }
    let mut case = cases["cases"][0].clone();
    let full_request =
        DecisionRequest::parse(&serde_json::to_vec(&case["request"]).unwrap()).unwrap();
    for distribution in [
        json!({"yes":0.9,"no":0.9}),
        json!({"yes":1.1,"no":-0.1}),
        json!({"yes":1}),
        json!({"yes":1,"other":0}),
    ] {
        case["response"]["answers"]["route"]["probabilities"] = distribution;
        assert!(
            protocol::normalize(&case["response"], &full_request, Protocol::SystemOne).is_err()
        );
    }
    let mut duplicate = cases["cases"][1]["response"].clone();
    duplicate["answers"][0] = duplicate["answers"][1].clone();
    assert!(protocol::normalize(&duplicate, &full_request, Protocol::OpenAi).is_err());
}

#[test]
fn endpoint_accepts_only_https_api_roots_or_the_declared_endpoint() {
    for (base, expected) in [
        ("https://example.test", "https://example.test/v1/systemone"),
        (
            "https://example.test/api/v1/",
            "https://example.test/api/v1/systemone",
        ),
        (
            "https://example.test/custom/systemone/",
            "https://example.test/custom/systemone",
        ),
    ] {
        assert_eq!(
            config::endpoint(base, Protocol::SystemOne).unwrap(),
            expected
        );
    }
    for base in [
        "http://example.test/v1",
        "https://user:pass@example.test/v1",
        "https://@example.test/v1",
        "https://example.test/v1?",
        "https://example.test/v1#",
        "https://example.test/v1/decisions",
        "https://example.test/path",
        "https://example.test:bad/v1",
    ] {
        assert!(
            config::endpoint(base, Protocol::SystemOne).is_err(),
            "{base}"
        );
    }
}

#[test]
fn request_limits_and_error_envelope_match_python() {
    use brz_http_server::{EphemeralBytesArena, IntoHttpError, ResponseBody};
    assert_eq!(parse_request(None, b"{}").unwrap_err().status, 415);
    assert_eq!(
        parse_request(Some("application/json"), &vec![b' '; MAX_BYTES + 1])
            .unwrap_err()
            .status,
        413
    );
    assert_eq!(
        parse_request(Some("application/json"), b"not json")
            .unwrap_err()
            .status,
        400
    );
    let fixture = fixtures();
    assert!(
        parse_request(
            Some(" Application/JSON ; charset=utf-8"),
            &serde_json::to_vec(&fixture["cases"][0]["request"]).unwrap()
        )
        .is_ok()
    );
    let error = DecisionError::credential().response("decision_test");
    assert_eq!(error.status(), StatusCode::SERVICE_UNAVAILABLE);
    let response = error.into_http_error(&EphemeralBytesArena::new(512));
    let ResponseBody::Arena(body) = response.body() else {
        panic!("expected JSON error")
    };
    assert_eq!(
        serde_json::from_slice::<Value>(body.as_ref()).unwrap(),
        json!({"error": {
            "code": "credential_unavailable", "message": "Decision credential is unavailable", "retryable": true, "requestId": "decision_test",
        }})
    );
}

#[test]
fn decision_models_are_excluded_from_every_chat_shell() {
    use crate::models_unified::models::is_model_compatible_with_shell;
    for shell in ["Agno", "ClaudeCode", "Codex", "Chat", "Dify", "CustomShell"] {
        for provider in ["systemone", "openai", "claude"] {
            let support = vec![provider.to_string()];
            let config = json!({"protocol":"openai-responses", "apiFormat":"responses"})
                .as_object()
                .unwrap()
                .clone();
            for support in [&support[..], &[][..]] {
                assert!(!is_model_compatible_with_shell(
                    "decision",
                    Some(provider),
                    shell,
                    support,
                    &config
                ));
            }
            assert!(is_model_compatible_with_shell(
                "llm",
                Some(provider),
                shell,
                &support,
                &config
            ));
        }
    }
}

#[test]
fn decision_routes_are_selected_and_registered_in_the_application() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
    let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
    for method in [http::Method::GET, http::Method::POST] {
        assert!(table.matches(&method, "/api/models/decisions"));
    }
    // Inspect emitted registrations from the collection used by Application.
    let methods: Vec<_> =
        brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
            .into_iter()
            .flat_map(|entry| (entry.0.routes)())
            .filter(|route| route.path == "/api/models/decisions")
            .map(|route| route.methods)
            .collect();
    assert_eq!(methods.len(), 2);
    assert_eq!(
        methods.into_iter().fold(0, |all, method| all | method),
        2 | 32
    );
}

#[test]
fn encrypted_keys_and_custom_headers_use_the_request_user() {
    const CHILD: &str = "WEGENT_DECISION_CRYPTO_TEST";
    if std::env::var_os(CHILD).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "decisions::tests::encrypted_keys_and_custom_headers_use_the_request_user",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("GIT_TOKEN_AES_KEY", "12345678901234567890123456789012")
            .env("GIT_TOKEN_AES_IV", "1234567890123456")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let encrypted =
        crate::git_repositories::crypto::encrypt_git_token("updated-private-key").unwrap();
    let spec = json!({"protocol":"systemone", "modelConfig":{"DEFAULT_HEADERS":{"x-tenant":"old"}, "env": {
        "api_key": encrypted, "base_url":"https://example.test/v1", "model_id":"provider-model",
        "custom_headers":{"x-tenant":"${user.user_name}", "x-user-id":"${user.id}"}
    }}});
    let (_, config, _) = config::resolve(&spec, 17, "caller").unwrap();
    assert_eq!(config.api_key, "updated-private-key");
    assert!(
        config
            .default_headers
            .contains(&("x-tenant".into(), "caller".into()))
    );
    assert!(
        config
            .default_headers
            .contains(&("x-user-id".into(), "17".into()))
    );
}
