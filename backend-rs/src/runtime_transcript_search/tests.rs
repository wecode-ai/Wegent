use std::{
    collections::{BTreeSet, HashMap},
    io::Write,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use brz_http_server::StatusCode;
use serde_json::{Value, json};

use super::{
    access::{self, Activity, Execution},
    request::SearchRequest,
    response, rpc,
};

fn request() -> Value {
    json!({"deviceId": "runner-alias", "taskId": "bound-task", "query": "needle", "limit": 250})
}

#[test]
fn project_bound_search_discards_untrusted_workspace_and_runtime_identity() {
    let mut body = request();
    body["workspacePath"] = json!("/workspace/unrelated");
    body["runtimeHandle"] = json!({"threadId": "private-thread", "wegentTeam": {"id": 12}});
    body["projectSession"] = json!({"projectId": "1001", "issueId": "issue-1"});
    let request = SearchRequest::validated(&body).unwrap();
    assert_eq!(
        request.project_session,
        Some(("1001".into(), "issue-1".into()))
    );
    assert_eq!(
        request.payload("canonical-manager", true),
        json!({
            "deviceId": "runner-alias", "taskId": "canonical-manager", "query": "needle", "limit": 250,
        })
    );
}

#[test]
fn owned_search_normalizes_address_and_only_preserves_verified_team_shape() {
    let request = SearchRequest::validated(&json!({
        "device_id": "own-runner", "localTaskId": " task ", "query": "针", "limit": "2",
        "workspace_path": " /workspace/search/// ",
        "runtime_handle": {"threadId": "untrusted", "wegentTeam": {"id": 12}, "other": true},
    }))
    .unwrap();
    assert_eq!(
        request.payload(&request.task_id, false),
        json!({
            "deviceId": "own-runner", "taskId": "task", "query": "针", "limit": 2,
            "workspacePath": "/workspace/search", "runtimeHandle": {"wegentTeam": {"id": 12}},
        })
    );
}

#[test]
fn runtime_team_ids_are_not_coerced_from_handle_strings_or_floats() {
    for id in [json!("12"), json!(12.0), json!(0), json!(false)] {
        let mut body = request();
        body["runtimeHandle"] = json!({"wegentTeam": {"id": id}});
        let request = SearchRequest::validated(&body).unwrap();
        assert!(
            request
                .payload("bound-task", false)
                .get("runtimeHandle")
                .is_none()
        );
    }
}

#[test]
fn invalid_search_request_is_a_validation_failure() {
    for input in [
        json!({}),
        json!([]),
        json!({"deviceId": "d", "taskId": "t", "query": ""}),
        json!({"deviceId": "d", "taskId": "t", "query": "n", "limit": 0}),
        json!({"deviceId": "d", "taskId": "t", "query": "n", "limit": 251}),
        json!({"deviceId": "d", "taskId": "t", "query": "n", "projectSession": {"projectId": "p"}}),
    ] {
        assert_eq!(
            SearchRequest::validated(&input).unwrap_err().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
}

#[test]
fn response_preserves_cursor_occurrence_and_omits_null_ids() {
    let value = json!({"matches": [{"itemId": "i-1", "turnId": "t-1", "occurrence": 2, "cursor": "opaque:cursor", "messageId": null}],
        "totalMatches": 7, "isCapped": true, "privateExtra": "not part of the contract"});
    assert_eq!(
        serde_json::to_value(response(value).unwrap()).unwrap(),
        json!({
            "matches": [{"itemId": "i-1", "turnId": "t-1", "occurrence": 2, "cursor": "opaque:cursor"}],
            "totalMatches": 7, "isCapped": true,
        })
    );
    let empty = json!({"matches": [], "totalMatches": 0, "isCapped": false});
    assert_eq!(
        serde_json::to_value(response(empty.clone()).unwrap()).unwrap(),
        empty
    );
}

#[test]
fn response_preserves_async_reply_question_context() {
    let value = json!({
        "matches": [{"messageId": "reply", "itemId": "provider-reply", "occurrence": 1,
            "cursor": "opaque:cursor", "replyQuestions": ["needle?", "**Keep Markdown**?"]}],
        "totalMatches": 2, "isCapped": false,
    });
    assert_eq!(
        serde_json::to_value(response(value.clone()).unwrap()).unwrap(),
        value
    );
}

#[test]
fn invalid_runtime_results_are_explicit_gateway_failures() {
    for result in [
        json!({"success": false, "error": "device lost"}),
        json!({}),
        json!({"matches": [{"cursor": "", "occurrence": 0}], "totalMatches": 1, "isCapped": false}),
        json!({"matches": [{"cursor": "c", "occurrence": -1}], "totalMatches": 1, "isCapped": false}),
        json!({"matches": [{"cursor": "c", "occurrence": 0, "replyQuestions": [false]}], "totalMatches": 1, "isCapped": false}),
    ] {
        assert_eq!(
            response(result).unwrap_err().status(),
            StatusCode::BAD_GATEWAY
        );
    }
}

fn execution() -> Execution {
    Execution { id: 10, executor_owner_user_id: 52, runtime_device_id: "runner-canonical".into(), runtime_task_id: "bound-task".into(),
        execution_payload: json!({"runtime_selection": {"executor_kind": "collaboration_group_dispatch"}, "origin_context": {"dispatch_id": "dispatch"}}).to_string() }
}

#[test]
fn exact_binding_keeps_original_owner_and_canonical_manager_task() {
    let execution = execution();
    let aliases = HashMap::from([(
        52,
        vec!["runner-canonical".to_owned(), "runner-alias".to_owned()],
    )]);
    for task in ["bound-task", "bound-task-manager-initial"] {
        assert!(access::execution_matches(&execution, task, &aliases));
        let target = access::finish_target(
            BTreeSet::from([52]),
            BTreeSet::from([execution.conversation_id()]),
            task,
        )
        .unwrap();
        assert_eq!(target.owner_id, 52);
        assert_eq!(target.task_id, "bound-task-manager-initial");
        assert!(target.project_bound);
    }
    assert!(!access::execution_matches(
        &execution,
        "private-task",
        &aliases
    ));
    assert!(!access::execution_matches(
        &execution,
        "bound-task",
        &HashMap::from([(2300, vec!["runner-canonical".into()])])
    ));
    assert!(!access::execution_matches(
        &execution,
        "bound-task",
        &HashMap::from([(52, vec!["other-device".into()])])
    ));
}

#[test]
fn missing_and_conflicting_bindings_never_dispatch() {
    for owners in [BTreeSet::new(), BTreeSet::from([0])] {
        assert_eq!(
            access::finish_target(owners, BTreeSet::new(), "t")
                .err()
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        access::finish_target(BTreeSet::from([52, 2300]), BTreeSet::new(), "t")
            .err()
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        access::finish_target(
            BTreeSet::from([52]),
            BTreeSet::from(["a".into(), "b".into()]),
            "t"
        )
        .err()
        .unwrap()
        .status(),
        StatusCode::CONFLICT
    );
    let target =
        access::finish_target(BTreeSet::from([52]), BTreeSet::new(), "manual-task").unwrap();
    assert_eq!(target.task_id, "manual-task");
}

#[tokio::test]
async fn project_grants_use_cp_catalog_policy_without_creator_or_device_catalog_grants() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    assert!(
        crate::cloud_projects::authorized_project(&mysql, 1001, 52)
            .await
            .unwrap()
            .is_none()
    );
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    let sql = &queries[0].sql;
    for clause in [
        "HAVING COUNT(DISTINCT entity_id) = 1",
        "caller.is_active = true",
        "kinds.is_active = true",
        "membership_mode",
        "public_priority",
        "AND loop_items.id = '1001'",
        "entity_id = '52'",
    ] {
        assert!(sql.contains(clause), "missing {clause}");
    }
    assert!(!sql.contains("loop_items.created_by_user_id = 52"));
    assert!(mysql.writes().is_empty());
}

#[tokio::test]
async fn absent_binding_queries_only_the_exact_project_issue_and_active_manual_bindings() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    assert_eq!(
        access::bound_target(&mysql, "1001", "issue-1", "device-1", "private-task")
            .await
            .err()
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let queries = mysql.queries();
    assert!(
        queries
            .iter()
            .all(|query| query.sql.contains("project_id = ? AND")
                || query.sql.contains("cloud_project_id = ? AND"))
    );
    let binding = queries
        .iter()
        .find(|query| query.sql.contains("resource_type = 'execution'"))
        .unwrap();
    assert_eq!(binding.args, 3);
    assert!(binding.sql.contains("task_id = ?"));
    assert!(binding.sql.contains("deleted_at IS NULL"));
    assert!(binding.sql.contains("unlinked_at IS NULL"));
    assert!(mysql.writes().is_empty());
}

fn activity(metadata: Value, task: &str) -> Activity {
    Activity {
        agent_id: "agent-1".into(),
        runtime_device_id: "runner-canonical".into(),
        runtime_task_id: task.into(),
        metadata,
        active: 1,
    }
}

#[test]
fn member_session_requires_the_latest_exact_manager_assignment() {
    let target = activity(
        json!({"activity_type": "member_execution", "dispatch_id": "dispatch", "coordination_round_id": "round", "assignment_id": "assignment"}),
        "bound-task-member-round-assignment",
    );
    let manager = activity(
        json!({"activity_type": "manager_assignment", "dispatch_id": "dispatch", "coordination_round_id": "round", "dispatch_assignments": [{
            "assignment_id": "assignment", "assignee_type": "agent", "agent_id": "agent-1", "runtime_task_id": target.runtime_task_id,
        }]}),
        "manager",
    );
    access::member_assignment(&execution(), &target, std::slice::from_ref(&manager)).unwrap();
    let newer = activity(
        json!({"activity_type": "manager_assignment", "dispatch_id": "dispatch", "coordination_round_id": "round", "dispatch_assignments": []}),
        "manager",
    );
    assert_eq!(
        access::member_assignment(&execution(), &target, &[newer, manager])
            .unwrap_err()
            .status(),
        StatusCode::CONFLICT
    );
    let mut wrong = target;
    wrong.agent_id = "other-agent".into();
    assert!(access::member_assignment(&execution(), &wrong, &[]).is_err());
}

#[test]
fn socket_resolution_rejects_offline_missing_and_stale_routes() {
    let identity = crate::device_identity::RuntimeRouteIdentity {
        logical_device_id: "logical".into(),
        runtime_device_id: "transport".into(),
        runtime_instance_id: Some("current".into()),
        device_type: crate::device_identity::DeviceType::Cloud,
    };
    for online in [
        Value::Null,
        json!({}),
        json!({"socket_id": "sid", "runtime_instance_id": "old"}),
    ] {
        assert_eq!(
            rpc::socket(&identity, &online).unwrap_err().status(),
            StatusCode::BAD_GATEWAY
        );
    }
    assert_eq!(
        rpc::socket(
            &identity,
            &json!({"socket_id": " sid ", "runtime_instance_id": " current "})
        )
        .unwrap(),
        "sid"
    );
}

#[test]
fn device_controls_reject_app_and_unknown_types_before_rpc() {
    for kind in [json!("app"), json!("future-type"), Value::Null, json!(17)] {
        let device = crate::device_identity::DeviceKindRow {
            id: 12,
            name: "runner".into(),
            json: json!({"spec": {"deviceType": kind}}),
        };
        assert!(!device.remote_control_enabled());
        let identity = crate::device_identity::identity_from_device(&device).unwrap();
        assert!(!rpc::task_read_allowed(&device, &identity, false));
        assert_eq!(
            rpc::task_read_allowed(&device, &identity, true),
            kind == json!("app")
        );
    }
    for spec in [
        json!({}),
        json!({"deviceType": "local"}),
        json!({"deviceType": "cloud"}),
        json!({"deviceType": "remote"}),
    ] {
        let device = crate::device_identity::DeviceKindRow {
            id: 12,
            name: "runner".into(),
            json: json!({"spec": spec}),
        };
        assert!(device.remote_control_enabled());
        let identity = crate::device_identity::identity_from_device(&device).unwrap();
        assert!(rpc::task_read_allowed(&device, &identity, false));
    }
}

#[test]
fn shared_device_identity_keeps_transport_and_runtime_installation() {
    let device = crate::device_identity::DeviceKindRow {
        id: 12,
        name: "logical-cloud".into(),
        json: json!({"spec": {"deviceType": "cloud", "deviceId": " transport-cloud ", "runtimeInstanceId": " current-instance "}}),
    };
    let identity = crate::device_identity::identity_from_device(&device).unwrap();
    assert_eq!(identity.logical_device_id, "logical-cloud");
    assert_eq!(identity.runtime_device_id, "transport-cloud");
    assert_eq!(
        identity.runtime_instance_id.as_deref(),
        Some("current-instance")
    );
}

#[test]
fn compressed_runtime_acknowledgements_obey_the_same_response_contract() {
    let expected = json!({"matches": [], "totalMatches": 0, "isCapped": false});
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(expected.to_string().as_bytes()).unwrap();
    let encoded = json!({"__runtimeRpcEncoding": "gzip+base64+json", "payload": STANDARD.encode(encoder.finish().unwrap())});
    assert_eq!(rpc::decode(encoded).unwrap(), expected);
    for invalid in [
        json!([]),
        json!({"__runtimeRpcEncoding": "gzip+base64+json", "payload": "invalid"}),
    ] {
        assert_eq!(
            rpc::decode(invalid).unwrap_err().status(),
            StatusCode::BAD_GATEWAY
        );
    }
}

#[test]
fn application_registers_the_new_search_route_and_keeps_transcript_on_python() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
    let table =
        crate::RouteTable::compile(crate::hybrid::load_routes_config(&path).unwrap()).unwrap();
    assert!(table.matches(&http::Method::POST, "/api/runtime-work/transcript/search"));
    assert!(!table.matches(&http::Method::GET, "/api/runtime-work/transcript/search"));
    assert!(!table.matches(&http::Method::POST, "/api/runtime-work/transcript"));
    const POST: u16 = 1 << 5;
    assert!(
        brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)())
            .any(|route| route.path == "/api/runtime-work/transcript/search"
                && route.methods & POST != 0)
    );
}
