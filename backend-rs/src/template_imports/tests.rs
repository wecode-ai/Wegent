use super::*;

fn input(intent: Value, steps: Value) -> Begin {
    serde_json::from_value(json!({"protocolVersion":1,"intent":intent,"steps":steps})).unwrap()
}

#[test]
fn identity_normalizes_nested_object_keys_without_reordering_arrays() {
    let first: Value = serde_json::from_str(r#"{"b":{"z":1,"a":2},"a":[2,1]}"#).unwrap();
    let second: Value = serde_json::from_str(r#"{"a":[2,1],"b":{"a":2,"z":1}}"#).unwrap();
    let steps = input(json!({}), json!([{"key":"group:delivery","kind":"group"}])).steps;
    assert_eq!(
        digest(&first, &steps).unwrap(),
        digest(&second, &steps).unwrap()
    );
    assert_ne!(
        digest(&first, &steps).unwrap(),
        digest(&json!({"a":[1,2],"b":{"a":2,"z":1}}), &steps).unwrap()
    );
    let changed = input(json!({}), json!([{"key":"group:delivery","kind":"agent"}])).steps;
    assert_ne!(
        digest(&first, &steps).unwrap(),
        digest(&first, &changed).unwrap()
    );
}

#[test]
fn validates_version_object_and_exact_unique_step_manifest() {
    let valid = input(
        json!({"name":"产品全流程小组"}),
        json!([
            {"key":"agent:review","kind":"agent"},
            {"key":"group:delivery","kind":"group"},
            {"key":"automation:task-assignment","kind":"automation"},
            {"key":"board:project-board","kind":"board"}
        ]),
    );
    assert!(valid.validate().is_ok());
    for steps in [
        json!([]),
        json!([{"key":"","kind":"group"}]),
        json!([{"key":"same","kind":"group"},{"key":"same","kind":"agent"}]),
        json!([{"key":"a".repeat(201),"kind":"group"}]),
    ] {
        assert_eq!(
            input(json!({}), steps).validate().unwrap_err().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let mut invalid = valid;
    invalid.protocol_version = 2;
    assert!(invalid.validate().is_err());
    invalid.protocol_version = 1;
    invalid.intent = json!([]);
    assert!(invalid.validate().is_err());
    invalid.intent = json!({});
    invalid.steps = (0..201)
        .map(|index| Step {
            key: index.to_string(),
            kind: StepKind::Group,
        })
        .collect();
    assert!(invalid.validate().is_err());
    for previous in [json!(null), json!(1), json!(""), json!("x".repeat(65))] {
        assert!(
            input(
                json!({"previousImportId":previous}),
                json!([{"key":"group:delivery","kind":"group"}])
            )
            .validate()
            .is_err()
        );
    }
    assert!(
        serde_json::from_value::<Begin>(
            json!({"protocolVersion":1,"intent":{},"steps":[{"key":"x","kind":"unknown"}]})
        )
        .is_err()
    );
}

#[test]
fn explicit_reimport_identity_is_bound_to_the_completed_predecessor() {
    let original = input(
        json!({"name":"Delivery"}),
        json!([{"key":"group:delivery","kind":"group"}]),
    );
    let mut repeated = input(
        json!({"name":"Delivery","previousImportId":"original"}),
        json!([{"key":"group:delivery","kind":"group"}]),
    );
    assert!(repeated.validate().is_ok());
    assert_ne!(
        digest(&original.intent, &original.steps).unwrap(),
        digest(&repeated.intent, &repeated.steps).unwrap()
    );
    let previous = digest(&repeated.intent, &repeated.steps).unwrap();
    repeated.intent["previousImportId"] = json!("another-generation");
    assert_ne!(previous, digest(&repeated.intent, &repeated.steps).unwrap());
}

#[test]
fn normalizes_numeric_project_identity_and_rejects_invalid_projects() {
    assert_eq!(project_number("001001").unwrap(), 1001);
    for project in ["", "none", "-1", "0"] {
        assert_eq!(
            project_number(project).unwrap_err().status(),
            StatusCode::NOT_FOUND
        );
    }
}

#[test]
fn summaries_never_disclose_intent_and_only_matching_receipts_complete_steps() {
    let operation = Operation {
        id: "operation".into(),
        project_id: "1001".into(),
        actor_user_id: 8,
        kind: TEMPLATE_IMPORT_KIND.into(),
        data: Json(OperationData {
            protocol_version: 1,
            intent_sha256: "a".repeat(64),
            intent_encrypted: "encrypted".into(),
            manifest: vec![Step {
                key: "group:delivery".into(),
                kind: StepKind::Group,
            }],
            receipts: BTreeMap::from([(
                "group:delivery".into(),
                Receipt {
                    kind: StepKind::Agent,
                    request_sha256: "b".repeat(64),
                    resource_id: "unrelated".into(),
                    completed_at: None,
                },
            )]),
        }),
    };
    let pending = summary(&operation);
    assert_eq!(pending["status"], "pending");
    assert!(pending["steps"][0].get("resourceId").is_none());
    assert!(pending.get("intent").is_none());
    let completed_operation = Operation {
        id: operation.id.clone(),
        project_id: operation.project_id.clone(),
        actor_user_id: operation.actor_user_id,
        kind: operation.kind.clone(),
        data: Json(OperationData {
            protocol_version: operation.data.0.protocol_version,
            intent_sha256: operation.data.0.intent_sha256.clone(),
            intent_encrypted: operation.data.0.intent_encrypted.clone(),
            manifest: operation.data.0.manifest.clone(),
            receipts: BTreeMap::from([(
                "group:delivery".into(),
                Receipt {
                    kind: StepKind::Group,
                    request_sha256: "b".repeat(64),
                    resource_id: "confirmed".into(),
                    completed_at: None,
                },
            )]),
        }),
    };
    let completed = summary(&completed_operation);
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["steps"][0]["resourceId"], "confirmed");
}
