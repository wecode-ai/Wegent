use super::*;

#[test]
fn local_member_payload_uses_canonical_member_instructions() {
    let manager_payload = json!({
        "memberRuntimeProfiles": [{
            "memberIds": ["member-1"],
            "runtimePayload": {
                "projectInstructions": "member system instructions",
                "executionRequest": {
                    "system_prompt": "manager system instructions"
                }
            }
        }]
    });

    let payload = collaboration_member_runtime_payload(&manager_payload, "member-1", None).unwrap();
    let system_prompt = payload["executionRequest"]["system_prompt"]
        .as_str()
        .expect("member system prompt");

    assert!(system_prompt.starts_with("member system instructions"));
    assert!(!system_prompt.contains("manager system instructions"));
    assert!(system_prompt.contains("The Executor records this run in the current Issue"));
    assert!(system_prompt.contains("Use native subagents"));
    assert!(system_prompt.contains("Delegate a single nontrivial task to one subagent"));
    assert!(system_prompt.contains("finalize_delivery"));
}

#[test]
fn local_member_payload_requires_and_validates_a_preconfigured_model() {
    let manager_payload = json!({
        "memberRuntimeProfiles": [{
            "memberIds": ["member-1"],
            "modelRuntimeProfiles": [{
                "modelId": "fast-model",
                "runtimePayload": {
                    "projectInstructions": "member instructions",
                    "executionRequest": {
                        "model_config": {"model_id": "fast-model"}
                    }
                }
            }, {
                "modelId": "deep-model",
                "runtimePayload": {
                    "projectInstructions": "member instructions",
                    "executionRequest": {
                        "model_config": {"model_id": "deep-model"}
                    }
                }
            }]
        }]
    });

    let missing =
        collaboration_member_runtime_payload(&manager_payload, "member-1", None).unwrap_err();
    assert!(missing.to_string().contains("must choose model_id"));

    let unavailable = collaboration_member_runtime_payload(
        &manager_payload,
        "member-1",
        Some("unconfigured-model"),
    )
    .unwrap_err();
    assert!(unavailable.to_string().contains("is not allowed"));

    let selected =
        collaboration_member_runtime_payload(&manager_payload, "member-1", Some("deep-model"))
            .unwrap();
    assert_eq!(
        selected["executionRequest"]["model_config"]["model_id"],
        "deep-model"
    );
}

#[test]
fn local_member_payload_validates_model_for_a_legacy_profile() {
    let manager_payload = json!({
        "memberRuntimeProfiles": [{
            "memberIds": ["member-1"],
            "runtimePayload": {
                "projectInstructions": "member instructions",
                "executionRequest": {
                    "model_config": {"model_id": "legacy-model"}
                }
            }
        }]
    });

    let selected =
        collaboration_member_runtime_payload(&manager_payload, "member-1", Some("legacy-model"))
            .unwrap();
    assert_eq!(
        selected["executionRequest"]["model_config"]["model_id"],
        "legacy-model"
    );

    let unavailable = collaboration_member_runtime_payload(
        &manager_payload,
        "member-1",
        Some("unverified-model"),
    )
    .unwrap_err();
    assert!(unavailable.to_string().contains("cannot be verified"));
}
