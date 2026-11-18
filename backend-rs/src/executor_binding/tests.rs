// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn binding_credential_only_applies_to_its_turn() {
    let mut claims = BindingClaims {
        purpose: PURPOSE.into(),
        task_id: 42,
        subtask_id: 43,
        user_id: 7,
        exp: 100,
    };
    assert!(claims.matches(42, 43, 99));
    assert!(!claims.matches(42, 43, 100));
    assert!(!claims.matches(41, 43, 99));
    assert!(!claims.matches(42, 44, 99));
    claims.purpose = "task_token".into();
    assert!(!claims.matches(42, 43, 99));
}

#[test]
fn only_a_running_assistant_can_acquire_or_reuse_its_binding() {
    let request = BindingRequest {
        executor_name: "wegent-task-runner".into(),
        executor_namespace: "workloads".into(),
    };
    let mut row = BoundSubtask {
        status: "RUNNING".into(),
        executor_name: None,
        executor_namespace: None,
        executor_deleted_at: 0,
    };
    assert_eq!(row.binding_decision(&request), BindingDecision::Write);
    row.executor_name = Some(request.executor_name.clone());
    assert_eq!(row.binding_decision(&request), BindingDecision::Write);
    row.executor_namespace = Some(request.executor_namespace.clone());
    assert_eq!(
        row.binding_decision(&request),
        BindingDecision::AlreadyBound
    );
    row.executor_name = Some("different-executor".into());
    assert_eq!(row.binding_decision(&request), BindingDecision::Conflict);
    row.executor_name = Some(request.executor_name.clone());
    row.status = "CANCELLED".into();
    assert_eq!(row.binding_decision(&request), BindingDecision::Obsolete);
}

#[test]
fn executor_binding_is_registered_and_selected() {
    let path = "/api/internal/tasks/:task_id/subtasks/:subtask_id/executor-binding";
    let config = crate::hybrid::load_routes_config(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml"),
    )
    .unwrap();
    let table = crate::RouteTable::compile(config).unwrap();
    assert!(table.matches(
        &http::Method::POST,
        "/api/internal/tasks/42/subtasks/43/executor-binding",
    ));
    assert!(
        brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)())
            .any(|route| route.path == path && route.methods & (1 << 5) != 0)
    );
}
