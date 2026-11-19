// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlError, MysqlExecution};

use super::*;

fn advertised_role(owner: i64) -> Value {
    json!({"id":"@primary","userId":owner,"enabled":true,
        "enabledSince":"2026-11-01T00:00:00Z","version":3,
        "collaboration":{"enabled":true,"allProjects":true},
        "handlingPolicy":{"automatic":true}})
}

fn declared_device(value: Value) -> DeviceKindRow {
    DeviceKindRow {
        id: 9,
        name: "owned-device".into(),
        json: json!({"spec":{"personalAssistantDispatch":{"version":1,"roles":[value]}}}),
    }
}

#[test]
fn policy_receipts_explain_the_same_denial_that_prevents_execution() {
    for (field, value, expected) in [
        ("enabled", json!(false), "assistant_disabled"),
        (
            "collaboration",
            json!({"enabled":false}),
            "assistant_disabled",
        ),
        (
            "collaboration",
            json!({"enabled":true,"allProjects":false}),
            "project_not_authorized",
        ),
        (
            "handlingPolicy",
            json!({"automatic":false}),
            "automatic_disabled",
        ),
        (
            "collaboration",
            json!({"enabled":true,"allProjects":true,"tags":["engineering"]}),
            "tag_mismatch",
        ),
    ] {
        let mut value_role = advertised_role(7);
        value_role[field] = value;
        let parsed = role(value_role.clone());
        assert_eq!(parsed.denial_reason(7, "1001", &json!([])), Some(expected));
        assert!(!parsed.permits(7, "1001", &json!([])));
        let resolution = select_endpoint(vec![declared_device(value_role)], &issue(), 7);
        assert!(resolution.endpoint.is_none());
        assert_eq!(resolution.reason, expected);
    }
}

#[test]
fn policy_receipts_prefer_an_authorized_endpoint_or_the_closest_denial() {
    let mut disabled = advertised_role(7);
    disabled["enabled"] = json!(false);
    let mut tagged = advertised_role(7);
    tagged["collaboration"]["tags"] = json!(["engineering"]);
    let resolution = select_endpoint(
        vec![
            declared_device(disabled.clone()),
            declared_device(tagged.clone()),
        ],
        &issue(),
        7,
    );
    assert!(resolution.endpoint.is_none());
    assert_eq!(resolution.reason, "tag_mismatch");
    let mut matching_issue = issue();
    matching_issue.metadata.0["tags"] = json!(["engineering"]);
    let resolution = select_endpoint(
        vec![declared_device(disabled), declared_device(tagged)],
        &matching_issue,
        7,
    );
    assert!(resolution.endpoint.is_some());
    assert_eq!(resolution.reason, "waiting_device");
    let mut workspace_device = declared_device(advertised_role(7));
    workspace_device.json["spec"]["workspaceOwnerId"] = json!(7);
    let resolution = select_endpoint(vec![workspace_device], &issue(), 7);
    assert!(resolution.endpoint.is_none());
    assert_eq!(resolution.reason, "no_authorized_assistant");
}

fn role(value: Value) -> schema::Role {
    schema::declaration(&json!({"version":1,"roles":[value]}))
        .expect("valid declaration")
        .roles
        .remove(0)
}

#[test]
fn consent_projection_drops_all_private_configuration() {
    let mut value = advertised_role(7);
    value["prompt"] = json!("private instruction");
    value["model"] = json!({"apiKey":"private token"});
    value["preferences"] = json!({"workspace":"private path"});
    value["collaboration"]["secret"] = json!("private scope detail");
    let declaration = normalize(&json!({"version":1,"roles":[value],"secret":"root secret"}));
    let text = declaration.to_string();
    for secret in ["private", "apiKey", "prompt", "preferences", "root secret"] {
        assert!(!text.contains(secret), "{text}");
    }
    assert!(role(declaration["roles"][0].clone()).permits(7, "1001", &json!([])));
}

#[test]
fn explicit_malformed_declarations_revoke_instead_of_preserving_authority() {
    for value in [
        Value::Null,
        json!({}),
        json!({"version":2,"roles":[]}),
        json!({"version":1,"roles":[{"id":"@primary","userId":7}]}),
        json!({"version":1,"roles":[{"id":"other","userId":7,"collaboration":{}}]}),
    ] {
        assert_eq!(normalize(&value), json!({"version":1,"roles":[]}));
    }
    let mut invalid = advertised_role(7);
    invalid["enabledSince"] = json!("not a timestamp");
    assert_eq!(
        normalize(&json!({"version":1,"roles":[invalid]})),
        json!({"version":1,"roles":[]})
    );
}

#[test]
fn persisted_authority_is_bound_to_the_authenticated_account() {
    let projected = schema::owned(
        &json!({"version":1,"roles":[advertised_role(7), advertised_role(8)]}),
        7,
    );
    assert_eq!(projected["roles"].as_array().unwrap().len(), 1);
    assert_eq!(projected["roles"][0]["userId"], 7);
    assert!(!role(projected["roles"][0].clone()).permits(8, "1001", &json!([])));
    assert_eq!(
        schema::owned(&json!({"version":1,"roles":[advertised_role(8)]}), 7)["roles"],
        json!([])
    );
}

#[test]
fn absence_preserves_consent_but_an_explicit_invalid_feature_revokes() {
    let absent = super::super::runtime_features::normalize(&json!({"schemaVersion":1})).unwrap();
    assert!(absent.get("personalAssistantDispatch").is_none());
    for declaration in [Value::Null, json!({"version":2,"roles":[]})] {
        let explicit = super::super::runtime_features::normalize(&json!({"schemaVersion":1,
            "personalAssistantDispatch":declaration}))
        .unwrap();
        assert_eq!(
            explicit["personalAssistantDispatch"],
            json!({"version":1,"roles":[]})
        );
    }
    let invalid_header = super::super::runtime_features::normalize(&json!({"schemaVersion":0,
        "personalAssistantDispatch":{"version":1,"roles":[advertised_role(7)]}}))
    .unwrap();
    assert_eq!(
        invalid_header["personalAssistantDispatch"],
        json!({"version":1,"roles":[]})
    );
}

#[test]
fn disabled_primary_survives_the_device_feature_envelope_without_granting_execution() {
    let declaration = json!({"version":1,"roles":[{"id":"@primary","userId":7,
        "enabled":false,"collaboration":{"enabled":false}}]});
    let invalid = super::super::runtime_features::normalize(
        &json!({"personalAssistantDispatch":declaration}),
    )
    .unwrap();
    assert_eq!(invalid["personalAssistantDispatch"]["roles"], json!([]));
    let feature = super::super::runtime_features::normalize(
        &json!({"schemaVersion":4,"personalAssistantDispatch":declaration}),
    )
    .unwrap();
    let stored = schema::owned(&feature["personalAssistantDispatch"], 7);
    assert_eq!(stored["roles"][0]["id"], "@primary");
    assert_eq!(stored["roles"][0]["enabled"], false);
    assert!(!role(stored["roles"][0].clone()).permits(7, "1001", &json!([])));
}

#[test]
fn project_override_exclusions_stores_and_tags_define_effective_authority() {
    let mut value = advertised_role(7);
    value["handlingPolicy"]["automatic"] = json!(false);
    value["collaboration"]["allProjects"] = json!(false);
    value["collaboration"]["projects"] =
        json!([{"id":"1001","store":"cloud"},{"id":"1002","store":"local"}]);
    value["collaboration"]["projectPolicies"] =
        json!([{"id":"1001","store":"cloud","policy":{"automatic":true}}]);
    value["collaboration"]["tags"] = json!(["engineering"]);
    let scoped = role(value.clone());
    assert!(scoped.permits(7, "1001", &json!(["engineering"])));
    assert!(!scoped.permits(7, "1001", &json!(["design"])));
    assert!(!scoped.permits(7, "1002", &json!(["engineering"])));
    value["collaboration"]["excludedProjects"] = json!([{"id":"1001","store":"cloud"}]);
    assert!(!role(value).permits(7, "1001", &json!(["engineering"])));
    let mut value = advertised_role(7);
    value["collaboration"]["projectPolicies"] =
        json!([{"id":"1001","store":"cloud","policy":{"automatic":false}}]);
    assert!(!role(value.clone()).permits(7, "1001", &json!([])));
    assert!(role(value).permits(7, "1002", &json!([])));
}

#[derive(Default)]
struct RecordingTransaction {
    reads: Vec<(String, usize)>,
    writes: Vec<(String, usize)>,
}

impl MysqlTransaction for RecordingTransaction {
    async fn execute<S, A>(&mut self, sql: S, args: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        self.writes.push((sql.as_ref().to_owned(), args.len()));
        Ok(MysqlExecution {
            rows_affected: 1,
            last_insert_id: 17,
        })
    }
    async fn fetch_optional<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.reads.push((sql.as_ref().to_owned(), args.len()));
        Ok(None)
    }
    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        Err(MysqlError::RowNotFound)
    }
    fn fetch<'a, S, A, T>(
        &'a mut self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::empty()
    }
    async fn fetch_all<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.reads.push((sql.as_ref().to_owned(), args.len()));
        Ok(Vec::new())
    }
}

fn issue() -> store::Node {
    store::Node {
        id: "issue-1".into(),
        resource_type: "task".into(),
        cloud_project_id: "1001".into(),
        parent_id: String::new(),
        loop_item_id: String::new(),
        name: String::new(),
        project_key: String::new(),
        next_item_number: 1,
        local_project_id: 0,
        assignee_user_id: 7,
        assignee_team_id: 0,
        priority: "high".into(),
        title: "assigned work".into(),
        description: String::new(),
        status: "pending".into(),
        source: String::new(),
        created_by_user_id: 7,
        user_id: 0,
        task_user_id: 0,
        task_id: String::new(),
        task_title: String::new(),
        device_id: String::new(),
        backend_task_id: 0,
        assignee_agent_id: String::new(),
        metadata: Json(json!({})),
        due_at: None,
        version: 3,
    }
}

fn assignment() -> CommentRow {
    CommentRow {
        id: "assignment-1".into(),
        loop_item_id: Some("issue-1".into()),
        description: None,
        created_by_user_id: Some(7),
        created_at: None,
        updated_at: None,
        metadata: None,
    }
}

fn intent() -> Value {
    json!({"dispatchId":"dispatch-1","issueId":"issue-1","projectId":"1001","ownerUserId":7,
        "assignmentId":"assignment-1","assignmentVersion":3,"executionId":null,"dispatchState":"no_authorized_assistant"})
}

#[test]
fn an_intent_cannot_move_to_another_assignment_version_owner_or_issue() {
    let issue = issue();
    let dispatch = intent();
    assert!(valid_assignment(
        &dispatch,
        &issue,
        7,
        "assignment-1",
        Some(3)
    ));
    for (owner, id, version) in [
        (8, "assignment-1", Some(3)),
        (7, "assignment-2", Some(3)),
        (7, "assignment-1", Some(4)),
        (7, "assignment-1", None),
    ] {
        assert!(!valid_assignment(&dispatch, &issue, owner, id, version));
    }
    let mut other = issue;
    other.id = "issue-2".into();
    assert!(!valid_assignment(
        &dispatch,
        &other,
        7,
        "assignment-1",
        Some(3)
    ));
}

#[tokio::test]
async fn reconnect_creates_one_waiting_execution_for_the_same_durable_intent() {
    let mut tx = RecordingTransaction::default();
    let mut dispatch = intent();
    let device = DeviceKindRow {
        id: 9,
        name: "owned-device".into(),
        json: json!({}),
    };
    let role = role(advertised_role(7));
    for _ in 0..2 {
        admit_on(
            &mut tx,
            &issue(),
            &assignment(),
            &mut dispatch,
            &device,
            &role,
        )
        .await
        .unwrap();
    }
    assert_eq!(dispatch["executionId"], "17");
    assert_eq!(dispatch["dispatchState"], "waiting_device");
    assert_eq!(
        dispatch["endpointRef"],
        "wework-local:owned-device:@primary"
    );
    assert_eq!(
        tx.writes
            .iter()
            .filter(|(sql, _)| sql.starts_with("INSERT INTO loop_item_executions"))
            .count(),
        1
    );
    assert!(tx.reads.iter().any(
        |(sql, args)| sql.contains("execution_scope=? AND loop_item_id=?")
            && sql.ends_with("FOR UPDATE")
            && *args == 2
    ));
    assert!(
        tx.writes
            .iter()
            .any(|(sql, _)| sql.contains("max_retries=0,runtime_task_id=''")
                && sql.contains("status='waiting_runtime'"))
    );
}

#[tokio::test]
async fn terminal_intents_and_absent_issues_never_create_history_or_execution() {
    let mut tx = RecordingTransaction::default();
    let effects = refresh_issue_on(&mut tx, "missing-issue", 7, true)
        .await
        .unwrap();
    assert!(!effects.changed);
    assert!(tx.writes.is_empty());
    assert_eq!(tx.reads.len(), 1);
    assert!(tx.reads[0].0.contains("FOR UPDATE"));
    for state in [
        "completed",
        "failed",
        "cancelled",
        "superseded",
        "cancelling",
    ] {
        let mut dispatch = intent();
        dispatch["dispatchState"] = json!(state);
        admit_on(
            &mut tx,
            &issue(),
            &assignment(),
            &mut dispatch,
            &DeviceKindRow {
                id: 9,
                name: "owned-device".into(),
                json: json!({}),
            },
            &role(advertised_role(7)),
        )
        .await
        .unwrap();
    }
    assert!(tx.writes.is_empty());
}

#[tokio::test]
async fn an_unowned_or_unregistered_device_cannot_persist_consent() {
    let mut tx = RecordingTransaction::default();
    assert!(
        !persist_on(
            &mut tx,
            7,
            "foreign-device",
            &json!({"version":1,"roles":[]})
        )
        .await
        .unwrap()
    );
    assert!(tx.writes.is_empty());
    assert!(
        tx.reads
            .iter()
            .any(|(sql, _)| sql.contains("kinds.user_id = ?")
                && sql.contains("kinds.namespace = 'default'")
                && sql.contains("kinds.kind = 'Device'"))
    );
}

#[tokio::test]
async fn endpoint_authority_uses_current_locked_consent_instead_of_snapshot_grants() {
    use crate::sql_test_support::mysql_rows::{MysqlRows, Value as SqlValue};

    for current_grant in [false, true] {
        let fixture = MysqlRows::start(move |sql| {
            assert!(sql.contains("FROM kinds"), "{sql}");
            let mut role = advertised_role(7);
            // The initial alias lookup models an established repeatable-read
            // snapshot; only the locking read observes the current consent.
            role["enabled"] = json!(!sql.ends_with("FOR UPDATE") || current_grant);
            let document = json!({"spec":{"deviceType":"local",
                "personalAssistantDispatch":{"version":1,"roles":[role]}}});
            vec![
                ("kinds_id", SqlValue::I64(9)),
                ("kinds_name", SqlValue::Text("owned-device".into())),
                ("kinds_json", SqlValue::Text(document.to_string())),
            ]
        })
        .await;

        let permitted = fixture
            .mysql
            .with_transaction(async |tx| {
                endpoint_permitted_on(&mut &mut *tx, 7, "owned-device", "1001", &json!([]))
                    .await
                    .map_err(dependency_error)
            })
            .await
            .unwrap();

        assert_eq!(permitted, current_grant);
        let queries = fixture.queries();
        assert_eq!(queries.len(), 2, "{queries:?}");
        assert!(!queries[0].ends_with("FOR UPDATE"));
        let current = &queries[1];
        for filter in [
            "kinds.user_id = ?",
            "kinds.kind = 'Device'",
            "kinds.namespace = 'default'",
            "kinds.is_active = true",
            "kinds.id=?",
            "kinds.name=?",
        ] {
            assert!(current.contains(filter), "{current}");
        }
        assert!(current.ends_with("FOR UPDATE"), "{current}");
    }
}

#[tokio::test]
async fn personal_authority_requires_the_exact_string_execution_identity() {
    use crate::sql_test_support::mysql_rows::{MysqlRows, Value as SqlValue};

    for (execution_id, expected) in [
        (json!("17"), true),
        (json!(17), false),
        (json!("017"), false),
    ] {
        let fixture = MysqlRows::start(move |sql| {
            if sql.contains("FROM users") {
                return vec![("id", SqlValue::I64(7))];
            }
            if sql.contains("FROM loop_items") {
                let mut dispatch = intent();
                dispatch["executionId"] = execution_id.clone();
                dispatch["dispatchState"] = json!("running");
                let metadata = json!({"event_type":"assignment","action":"assign",
                    "target_type":"human","target_id":"7","assignment_version":3,
                    "human_assistant_dispatch":dispatch});
                return vec![
                    ("loop_items_id", SqlValue::Text("assignment-1".into())),
                    ("loop_items_loop_item_id", SqlValue::Text("issue-1".into())),
                    ("loop_items_description", SqlValue::Null),
                    ("loop_items_created_by_user_id", SqlValue::I32(7)),
                    ("loop_items_created_at", SqlValue::Null),
                    ("loop_items_updated_at", SqlValue::Null),
                    ("loop_items_metadata", SqlValue::Text(metadata.to_string())),
                ];
            }
            assert!(sql.contains("FROM kinds"), "{sql}");
            let document = declared_device(advertised_role(7)).json;
            vec![
                ("kinds_id", SqlValue::I64(9)),
                ("kinds_name", SqlValue::Text("owned-device".into())),
                ("kinds_json", SqlValue::Text(document.to_string())),
            ]
        })
        .await;
        let mut row = execution("running");
        row.execution_payload = json!({"origin_context":{
            "assignment_id":"assignment-1","assignment_version":3}})
        .to_string();
        let permitted = fixture
            .mysql
            .with_transaction(async |tx| {
                Ok::<_, MysqlError>(
                    require_current_on(&mut &mut *tx, &issue(), &row)
                        .await
                        .is_ok(),
                )
            })
            .await
            .unwrap();

        assert_eq!(permitted, expected);
        let queries = fixture.queries();
        assert_eq!(queries.len(), if expected { 4 } else { 2 }, "{queries:?}");
        assert!(queries[1].ends_with("FOR UPDATE"), "{queries:?}");
    }
}

#[tokio::test]
async fn personal_authority_rejects_stale_owners_and_inactive_users() {
    let mut tx = RecordingTransaction::default();
    let mut row = execution("running");
    row.assigner_user_id = 8;
    assert!(
        require_current_on(&mut &mut tx, &issue(), &row)
            .await
            .is_err()
    );
    assert!(tx.reads.is_empty());
    row.assigner_user_id = 7;
    // A missing active owner ends admission before any resource/device grant.
    assert!(
        require_current_on(&mut &mut tx, &issue(), &row)
            .await
            .is_err()
    );
    assert_eq!(tx.reads.len(), 1);
    assert!(
        tx.reads[0]
            .0
            .contains("users WHERE id=? AND is_active=true")
    );
    assert!(tx.writes.is_empty());
}

fn execution(status: &str) -> Execution {
    Execution {
        id: 17,
        loop_item_id: "issue-1".into(),
        cloud_project_id: "1001".into(),
        executor_owner_user_id: 7,
        assigner_user_id: 7,
        agent_id: String::new(),
        team_id: 0,
        automation_run_id: String::new(),
        execution_environment: "local".into(),
        execution_device_id: "owned-device".into(),
        runtime_device_id: "owned-device".into(),
        runtime_task_id: "runtime-task".into(),
        status: status.into(),
        approval_status: String::new(),
        execution_payload: json!({"runtime_selection":{"executor_kind":"human_assistant"}})
            .to_string(),
        error_message: String::new(),
        execution_note: String::new(),
        version: 1,
        start_requested_at: None,
        completed_at: None,
    }
}

#[tokio::test]
async fn revocation_waits_for_runtime_ack_when_a_task_has_started() {
    let mut pending = RecordingTransaction::default();
    assert_eq!(
        cancel_on(
            &mut pending,
            &execution("waiting_runtime"),
            "no_authorized_assistant"
        )
        .await
        .unwrap(),
        "cancelled"
    );
    assert!(
        pending.writes[0]
            .0
            .contains("status='cancelled',completed_at=?")
    );
    let mut running = RecordingTransaction::default();
    let mut row = execution("claimed");
    row.start_requested_at = Some(Utc::now().naive_utc());
    assert_eq!(
        cancel_on(&mut running, &row, "no_authorized_assistant")
            .await
            .unwrap(),
        "cancelling"
    );
    assert!(running.writes[0].0.contains("status='cancel_requested'"));
    assert!(!running.writes[0].0.contains("completed_at"));
}
