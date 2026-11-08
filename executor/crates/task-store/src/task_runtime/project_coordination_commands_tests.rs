use super::*;

#[test]
fn coordination_assignment_emits_its_actual_status_transition_once() {
    let mut fixture = Fixture::new();
    fixture.project = fixture.store.update_project(&fixture.project.id, ProjectUpdate {
        version: fixture.project.version,
        automatic_processing_rules: Some(json!([{
            "id": "running", "name": "Running", "triggerType": "event", "eventType": "task.status_changed",
            "eventConfig": {"statuses": ["in_progress"], "transition": "any"},
            "targetKind": "human", "targetId": "7", "enabled": true,
        }])),
        ..Default::default()
    }).unwrap();
    fixture.body["projectVersion"] = json!(fixture.project.version);
    let receipt = fixture.dispatch("status-event").unwrap();
    assert_eq!(fixture.row(&receipt).status, "queued");
    let runs = fixture
        .store
        .list_project_automation_runs(&fixture.project.id, "running")
        .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["status"], "failed");
    assert!(runs[0]["error"]
        .as_str()
        .unwrap()
        .contains("active execution"));
    assert_eq!(fixture.dispatch("status-event").unwrap(), receipt);
    assert_eq!(
        fixture
            .store
            .list_project_automation_runs(&fixture.project.id, "running")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn coordination_assignment_preserves_a_custom_board_column_through_completion() {
    let mut fixture = Fixture::new();
    fixture.project = fixture
        .store
        .update_project(
            &fixture.project.id,
            ProjectUpdate {
                version: fixture.project.version,
                board_config: Some(
                    json!({"statuses": [{"id":"inbox"},{"id":"acceptance"},{"id":"completed"}]}),
                ),
                ..Default::default()
            },
        )
        .unwrap();
    fixture.issue = fixture
        .store
        .update_task(
            &fixture.project.id,
            &fixture.issue.id,
            TaskUpdate {
                version: fixture.issue.version,
                status: Some("acceptance".into()),
                ..Default::default()
            },
        )
        .unwrap();
    fixture.body["projectVersion"] = json!(fixture.project.version);
    fixture.body["issueVersion"] = json!(fixture.issue.version);
    let receipt = fixture.dispatch("custom-status").unwrap();
    let execution = fixture.row(&receipt);
    assert!(execution.execution_payload.as_ref().unwrap()["message"]
        .as_str()
        .unwrap()
        .contains("Issue 状态：acceptance"));
    let claimed = fixture.claim();
    fixture.start(&claimed);
    fixture
        .store
        .complete_execution(claimed.id, Some("Done"))
        .unwrap();
    let task = fixture
        .store
        .get_task(&fixture.project.id, &fixture.issue.id)
        .unwrap();
    assert_eq!(task.status.as_deref(), Some("acceptance"));
    fixture
        .store
        .update_task(
            &fixture.project.id,
            &task.id,
            TaskUpdate {
                version: task.version,
                status: task.status,
                ..Default::default()
            },
        )
        .unwrap();
}

struct Fixture {
    _directory: tempfile::TempDir,
    store: LocalTaskStore,
    project: LoopItem,
    issue: LoopItem,
    body: Value,
    leader: String,
    member: String,
    catalog: Value,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Coordination"})).unwrap())
            .unwrap();
        let model = json!({"runtime":"codex","provider":"test","model_id":"model-a"});
        let mut agents = Vec::new();
        for name in ["Leader", "Member"] {
            agents.push(
                store
                    .create_chat_agent(
                        &project.id,
                        serde_json::from_value(json!({"name":name,
                "execution_mode":"auto","execution_policy":{"mode":"project_pool"},
                "model_policy":{"mode":"fixed","model":model}}))
                        .unwrap(),
                    )
                    .unwrap(),
            );
        }
        let project = store.update_project(&project.id, ProjectUpdate { version:project.version,
            execution_environment:Some(json!({"repositories":[],"setup_steps":[],"devices":{}})),
            collaboration_groups:Some(json!([{"id":"group","name":"Team","leader":{"kind":"agent","id":agents[0].id},
                "members":[{"kind":"agent","id":agents[1].id}]}])), ..Default::default() }).unwrap();
        let binding = store
            .set_project_coordination_binding(
                &project.id,
                "group",
                7,
                "runner-a",
                &json!({"enabled":true,"expectedGeneration":null}),
            )
            .unwrap();
        let project = store.get_project(&project.id).unwrap();
        let issue = store.create_task(&project.id,serde_json::from_value(json!({"title":"Shared work","description":"Keep this description","tags":["keep"]})).unwrap()).unwrap();
        let group = collaboration_group(&project, "group").unwrap();
        let body = json!({"generation":binding["generation"],"projectVersion":project.version,"groupVersion":LocalTaskStore::coordination_event_version(&group),
            "issueId":issue.id,"issueVersion":issue.version,"userId":999,"deviceId":"forged-host"});
        let catalog = json!({"models":[{"runtime":"codex","provider":"test","model_id":"model-a","local_model_id":"native-model","account_label":"Shared account"}]});
        Self {
            _directory: directory,
            store,
            project,
            issue,
            body,
            leader: agents[0].id.clone(),
            member: agents[1].id.clone(),
            catalog,
        }
    }
    fn dispatch(&self, command: &str) -> Result<Value, TaskRuntimeError> {
        self.store.dispatch_project_coordination_command(
            7,
            "runner-a",
            &self.project.id,
            "group",
            command,
            &self.body,
        )
    }
    fn row(&self, receipt: &Value) -> LocalExecution {
        execution_row(
            &self.store.connection().unwrap(),
            receipt["execution"]["id"].as_i64().unwrap(),
        )
        .unwrap()
    }
    fn count(&self) -> i64 {
        self.store
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM loop_item_executions", [], |row| {
                row.get(0)
            })
            .unwrap()
    }
    fn stop(&self) {
        let previous = self
            .store
            .project_coordination_binding(&self.project.id, "group")
            .unwrap();
        self.store
            .set_project_coordination_binding(
                &self.project.id,
                "group",
                7,
                "runner-a",
                &json!({"enabled":false,"expectedGeneration":previous["generation"]}),
            )
            .unwrap();
    }
    fn claim(&self) -> LocalExecution {
        self.store
            .claim_next_execution_with_catalog(
                Some("runner-a"),
                "runner-a",
                300,
                Some(&self.catalog),
            )
            .unwrap()
            .unwrap()
    }
    fn start(&self, execution: &LocalExecution) {
        let task = execution.runtime_task_id.as_deref().unwrap();
        self.store
            .request_runtime_start(execution.id, "runner-a", task, 300)
            .unwrap()
            .unwrap();
        self.store
            .confirm_runtime_accepted(execution.id, "runner-a", task, 300)
            .unwrap()
            .unwrap();
        self.store.mark_runtime_running(task).unwrap();
    }
}

#[test]
fn command_admits_real_group_work_with_verified_actor_and_original_issue() {
    let fixture = Fixture::new();
    let receipt = fixture.dispatch("one").unwrap();
    assert!(receipt["accepted"].as_bool().unwrap());
    assert_eq!(fixture.count(), 1);
    let execution = fixture.row(&receipt);
    assert_eq!(execution.assigner_user_id, 7);
    assert_eq!(execution.agent_id, fixture.leader);
    assert_eq!(
        execution.execution_scope,
        format!("project_robot:{}", fixture.issue.id)
    );
    let payload = execution.execution_payload.as_ref().unwrap();
    assert_eq!(payload["project_coordination"]["userId"], 7);
    assert_eq!(payload["project_coordination"]["deviceId"], "runner-a");
    assert!(payload.get("automation_run_id").is_none());
    assert_eq!(
        payload["memberRuntimeProfiles"].as_array().unwrap().len(),
        2
    );
    let issue = fixture
        .store
        .get_task(&fixture.project.id, &fixture.issue.id)
        .unwrap();
    assert_eq!(issue.description, fixture.issue.description);
    assert_eq!(issue.metadata["tags"], fixture.issue.metadata["tags"]);
    assert_eq!(issue.metadata["assignment_history"][0]["by_user_id"], 7);
    assert_eq!(issue.status.as_deref(), Some("in_progress"));
    let claimed = fixture.claim();
    let payload = claimed.execution_payload.as_ref().unwrap();
    assert_eq!(
        payload["origin"]["project_coordination"],
        execution.execution_payload.as_ref().unwrap()["project_coordination"]
    );
    assert_eq!(payload["executionRequest"]["extra"]["user_id"], 7);
    let decoded: crate::protocol::ExecutionRequest =
        serde_json::from_value(payload["executionRequest"].clone()).unwrap();
    assert_eq!(decoded.extra["user_id"], 7);
    fixture
        .store
        .authorize_project_coordination_request(
            &payload["origin"]["project_coordination"],
            "runner-a",
            claimed.runtime_task_id.as_deref().unwrap(),
        )
        .unwrap();
}

#[test]
fn accepted_work_loses_authority_when_issue_is_reassigned_or_archived() {
    for change in ["reassign", "archive"] {
        let fixture = Fixture::new();
        let receipt = fixture.dispatch("one").unwrap();
        let claimed = fixture.claim();
        let current = fixture
            .store
            .get_task(&fixture.project.id, &fixture.issue.id)
            .unwrap();
        if change == "reassign" {
            fixture
                .store
                .update_task(
                    &fixture.project.id,
                    &fixture.issue.id,
                    serde_json::from_value(
                        json!({"version":current.version,"assignee_user_id":99}),
                    )
                    .unwrap(),
                )
                .unwrap();
        } else {
            fixture
                .store
                .update_task(
                    &fixture.project.id,
                    &fixture.issue.id,
                    serde_json::from_value(json!({"version":current.version,"status":"completed"}))
                        .unwrap(),
                )
                .unwrap();
            fixture
                .store
                .archive_task(&fixture.project.id, &fixture.issue.id)
                .unwrap();
        }
        let scope = &claimed.execution_payload.as_ref().unwrap()["origin"]["project_coordination"];
        assert!(
            fixture
                .store
                .authorize_project_coordination_request(
                    scope,
                    "runner-a",
                    claimed.runtime_task_id.as_deref().unwrap()
                )
                .is_err(),
            "{change}"
        );
        let reconciled = fixture
            .store
            .reconcile_project_coordination_authority()
            .unwrap();
        if change == "reassign" {
            assert_eq!(reconciled[0].status, "cancelled");
        } else {
            assert!(
                reconciled.is_empty(),
                "Archive cancels the run in its transaction"
            );
        }
        assert_eq!(
            execution_row(&fixture.store.connection().unwrap(), claimed.id)
                .unwrap()
                .status,
            "cancelled"
        );
        assert_eq!(
            fixture
                .store
                .project_coordination_command_receipt(7, &fixture.project.id, "group", "one")
                .unwrap()["execution"]["id"],
            receipt["execution"]["id"]
        );
    }
}

#[test]
fn stopped_or_failed_runtime_cannot_start_or_dispatch_after_members_finish() {
    for status in ["cancelled", "cancel_requested", "failed"] {
        let fixture = Fixture::new();
        fixture.dispatch("one").unwrap();
        let manager = fixture.claim();
        fixture.start(&manager);
        let plan = json!({"round_id":"round-1","items":[{"assignment_id":"member-1","assignee_type":"agent",
            "assignee_id":fixture.member,"title":"Evidence","instructions":"Inspect shared work"}]});
        let round = fixture
            .store
            .submit_collaboration_round(manager.runtime_task_id.as_deref().unwrap(), &plan)
            .unwrap();
        fixture
            .store
            .connection()
            .unwrap()
            .execute(
                "UPDATE loop_item_executions SET status=?1 WHERE id=?2",
                params![status, manager.id],
            )
            .unwrap();
        let scope = &manager.execution_payload.as_ref().unwrap()["project_coordination"];
        assert!(
            fixture
                .store
                .authorize_project_coordination_request(
                    scope,
                    "runner-a",
                    manager.runtime_task_id.as_deref().unwrap()
                )
                .is_err(),
            "{status}"
        );
        fixture
            .store
            .complete_execution(
                round["assignments"][0]["execution_id"].as_i64().unwrap(),
                Some("Done"),
            )
            .unwrap();
        assert_eq!(fixture.count(), 2, "{status}");
    }
}

#[test]
fn accepted_receipt_survives_stop_and_rejects_changed_input_or_actor() {
    let fixture = Fixture::new();
    let receipt = fixture.dispatch("one").unwrap();
    fixture.stop();
    assert_eq!(fixture.dispatch("one").unwrap(), receipt);
    assert_eq!(
        fixture
            .store
            .project_coordination_command_receipt(7, &fixture.project.id, "group", "one")
            .unwrap(),
        receipt
    );
    assert!(fixture
        .store
        .project_coordination_command_receipt(8, &fixture.project.id, "group", "one")
        .is_err());
    let mut changed = fixture.body.clone();
    changed["issueVersion"] = json!(999);
    assert!(matches!(
        fixture.store.dispatch_project_coordination_command(
            7,
            "runner-a",
            &fixture.project.id,
            "group",
            "one",
            &changed
        ),
        Err(TaskRuntimeError::VersionConflict)
    ));
    assert!(fixture.dispatch("new").is_err());
    assert_eq!(fixture.count(), 1);
}

#[test]
fn stale_sources_existing_assignments_and_resource_changes_cannot_overwrite_work() {
    for change in ["project", "group", "issue", "assignee", "leader"] {
        let fixture = Fixture::new();
        let connection = fixture.store.connection().unwrap();
        match change {
            "project" => {
                connection
                    .execute(
                        "UPDATE loop_items SET version=version+1 WHERE id=?1",
                        [&fixture.project.id],
                    )
                    .unwrap();
            }
            "group" => {
                connection.execute("UPDATE loop_items SET metadata=json_set(metadata,'$.collaboration_groups[0].name','Changed') WHERE id=?1",[&fixture.project.id]).unwrap();
            }
            "issue" => {
                connection.execute("UPDATE loop_items SET description='Concurrent edit',version=version+1 WHERE id=?1",[&fixture.issue.id]).unwrap();
            }
            "assignee" => {
                connection
                    .execute(
                        "UPDATE loop_items SET assignee_user_id=99 WHERE id=?1",
                        [&fixture.issue.id],
                    )
                    .unwrap();
            }
            "leader" => {
                connection
                    .execute(
                        "UPDATE loop_items SET status='archived' WHERE id=?1",
                        [&fixture.leader],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        drop(connection);
        assert!(fixture.dispatch("one").is_err(), "{change}");
        assert_eq!(fixture.count(), 0);
        let issue = fixture
            .store
            .get_task(&fixture.project.id, &fixture.issue.id)
            .unwrap();
        assert!(
            issue.metadata.get("collaboration_group").is_none(),
            "{change}"
        );
        assert_eq!(
            issue.description,
            if change == "issue" {
                "Concurrent edit"
            } else {
                &fixture.issue.description
            }
        );
    }
}

#[test]
fn queue_write_failure_rolls_back_issue_assignment_and_command_receipt() {
    let fixture = Fixture::new();
    fixture.store.connection().unwrap().execute_batch("CREATE TRIGGER reject_command BEFORE INSERT ON loop_item_executions BEGIN SELECT RAISE(ABORT,'injected queue write failure'); END;").unwrap();
    assert!(matches!(
        fixture.dispatch("one"),
        Err(TaskRuntimeError::Database(_))
    ));
    assert_eq!(fixture.count(), 0);
    let issue = fixture
        .store
        .get_task(&fixture.project.id, &fixture.issue.id)
        .unwrap();
    assert_eq!(issue.version, fixture.issue.version);
    assert_eq!(issue.metadata, fixture.issue.metadata);
    assert_eq!(issue.status, fixture.issue.status);
    assert_eq!(
        fixture
            .store
            .project_coordination_command_receipt(7, &fixture.project.id, "group", "one")
            .unwrap()["accepted"],
        false
    );
}

#[test]
fn concurrent_command_replay_creates_one_execution_without_an_extra_queue() {
    let fixture = Fixture::new();
    let path = fixture.store.path().to_path_buf();
    let project = fixture.project.id.clone();
    let body = fixture.body.clone();
    let work = || {
        let path = path.clone();
        let project = project.clone();
        let body = body.clone();
        std::thread::spawn(move || {
            LocalTaskStore::open(path)
                .unwrap()
                .dispatch_project_coordination_command(
                    7, "runner-a", &project, "group", "one", &body,
                )
        })
    };
    let first = work();
    let second = work();
    assert_eq!(
        first.join().unwrap().unwrap(),
        second.join().unwrap().unwrap()
    );
    assert_eq!(fixture.count(), 1);
}

#[test]
fn takeover_fences_claim_and_runtime_start_and_running_cancel_needs_confirmation() {
    let queued = Fixture::new();
    queued.dispatch("queued").unwrap();
    queued.stop();
    assert!(queued
        .store
        .claim_next_execution_with_catalog(Some("runner-a"), "runner-a", 300, Some(&queued.catalog))
        .is_err());
    assert_eq!(
        queued
            .store
            .reconcile_project_coordination_authority()
            .unwrap()[0]
            .status,
        "cancelled"
    );

    let fixture = Fixture::new();
    fixture.dispatch("claimed").unwrap();
    let claimed = fixture.claim();
    fixture.stop();
    assert!(fixture
        .store
        .request_runtime_start(
            claimed.id,
            "runner-a",
            claimed.runtime_task_id.as_deref().unwrap(),
            300
        )
        .is_err());
    assert!(
        execution_row(&fixture.store.connection().unwrap(), claimed.id)
            .unwrap()
            .start_requested_at
            .is_none()
    );

    let fixture = Fixture::new();
    fixture.dispatch("running").unwrap();
    let running = fixture.claim();
    fixture.start(&running);
    let scope = &running.execution_payload.as_ref().unwrap()["origin"]["project_coordination"];
    let previous = fixture
        .store
        .project_coordination_binding(&fixture.project.id, "group")
        .unwrap();
    fixture
        .store
        .set_project_coordination_binding(
            &fixture.project.id,
            "group",
            8,
            "runner-b",
            &json!({"enabled":true,"takeover":true,"expectedGeneration":previous["generation"]}),
        )
        .unwrap();
    assert!(fixture
        .store
        .authorize_project_coordination_request(
            scope,
            "runner-a",
            running.runtime_task_id.as_deref().unwrap()
        )
        .is_err());
    let pending = fixture
        .store
        .reconcile_project_coordination_authority()
        .unwrap();
    assert_eq!(pending[0].status, "cancel_requested");
    assert!(pending[0].completed_at.is_none());
    assert_eq!(
        fixture
            .store
            .cancel_execution_observed(running.id, Some("Runtime stopped"))
            .unwrap()
            .unwrap()
            .status,
        "cancelled"
    );
}

#[test]
fn member_round_inherits_actor_scope_and_revocation_prevents_a_fresh_manager() {
    let fixture = Fixture::new();
    fixture.dispatch("round").unwrap();
    let manager = fixture.claim();
    fixture.start(&manager);
    let plan = json!({"round_id":"round-1","items":[{"assignment_id":"member-1","assignee_type":"agent",
        "assignee_id":fixture.member,"title":"Evidence","instructions":"Inspect shared work"}]});
    let round = fixture
        .store
        .submit_collaboration_round(manager.runtime_task_id.as_deref().unwrap(), &plan)
        .unwrap();
    let member = execution_row(
        &fixture.store.connection().unwrap(),
        round["assignments"][0]["execution_id"].as_i64().unwrap(),
    )
    .unwrap();
    assert_eq!(member.assigner_user_id, 7);
    assert_eq!(
        member.execution_payload.as_ref().unwrap()["project_coordination"],
        manager.execution_payload.as_ref().unwrap()["project_coordination"]
    );
    assert_eq!(member.execution_scope, "");
    fixture.stop();
    fixture
        .store
        .complete_execution(member.id, Some("Evidence captured"))
        .unwrap();
    assert_eq!(fixture.count(), 2);
    assert!(fixture
        .store
        .submit_collaboration_round(
            manager.runtime_task_id.as_deref().unwrap(),
            &json!({"round_id":"new","items":plan["items"]})
        )
        .is_err());
    assert_eq!(fixture.count(), 2);
}

#[test]
fn automatic_admission_keeps_model_readiness_and_native_approval_policy() {
    let missing = Fixture::new();
    missing
        .store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_items SET metadata=json_remove(metadata,'$.execution_policy') WHERE id=?1",
            [&missing.member],
        )
        .unwrap();
    assert!(missing
        .dispatch("missing-policy")
        .unwrap_err()
        .to_string()
        .contains("RUNNER_CONFIGURATION_REQUIRED"));
    assert_eq!(missing.count(), 0);
    assert_eq!(
        missing
            .store
            .get_task(&missing.project.id, &missing.issue.id)
            .unwrap()
            .metadata,
        missing.issue.metadata
    );
    let fixture = Fixture::new();
    fixture.store.connection().unwrap().execute("UPDATE loop_items SET metadata=json_set(metadata,'$.execution_mode','manual_approval') WHERE id=?1",[&fixture.leader]).unwrap();
    let receipt = fixture.dispatch("needs-approval").unwrap();
    let row = fixture.row(&receipt);
    assert_eq!(row.status, "pending_approval");
    assert_eq!(row.approval_status.as_deref(), Some("pending"));
    assert!(fixture
        .store
        .claim_next_execution_with_catalog(
            Some("runner-a"),
            "runner-a",
            300,
            Some(&fixture.catalog)
        )
        .unwrap()
        .is_none());
}

#[test]
fn execution_comment_reads_project_current_approval_without_copying_queue_state() {
    let fixture = Fixture::new();
    fixture.store.connection().unwrap().execute("UPDATE loop_items SET metadata=json_set(metadata,'$.execution_mode','manual_approval') WHERE id=?1",[&fixture.leader]).unwrap();
    let receipt = fixture.dispatch("approval-presentation").unwrap();
    let execution = fixture.row(&receipt);
    let comments = fixture
        .store
        .list_comments(&fixture.project.id, &fixture.issue.id, 0)
        .unwrap();
    let pending = comments
        .iter()
        .find(|comment| comment.metadata["execution_id"] == execution.id)
        .unwrap();
    assert_eq!(pending.metadata["run_status"], "waiting_approval");
    fixture.store.approve_execution(execution.id).unwrap();
    let comments = fixture
        .store
        .list_comments(&fixture.project.id, &fixture.issue.id, 0)
        .unwrap();
    let approved = comments
        .iter()
        .find(|comment| comment.message_id == pending.message_id)
        .unwrap();
    assert_eq!(approved.metadata["run_status"], "queued");
    let stored: String = fixture
        .store
        .connection()
        .unwrap()
        .query_row(
            "SELECT metadata FROM loop_item_comments WHERE message_id=?1",
            [&pending.message_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(serde_json::from_str::<Value>(&stored)
        .unwrap()
        .get("run_status")
        .is_none());
}

#[test]
fn human_round_keeps_audit_identity_and_waits_for_original_delivery() {
    let mut fixture = Fixture::new();
    let mut groups = fixture.project.metadata["collaboration_groups"].clone();
    groups[0]["members"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind":"human","id":"8","name":"Reviewer"}));
    fixture.project = fixture
        .store
        .update_project(
            &fixture.project.id,
            ProjectUpdate {
                version: fixture.project.version,
                collaboration_groups: Some(groups.clone()),
                ..Default::default()
            },
        )
        .unwrap();
    fixture.body["projectVersion"] = json!(fixture.project.version);
    fixture.body["groupVersion"] = json!(LocalTaskStore::coordination_event_version(&groups[0]));
    fixture.dispatch("human").unwrap();
    let manager = fixture.claim();
    fixture.start(&manager);
    let response=fixture.store.submit_collaboration_round(manager.runtime_task_id.as_deref().unwrap(),&json!({"round_id":"human-round","items":[{
        "assignment_id":"review","assignee_type":"human","assignee_id":"8","title":"Review evidence","instructions":"Please confirm the result"}]})).unwrap();
    let human = fixture
        .store
        .get_task(
            &fixture.project.id,
            response["assignments"][0]["human_assignment_id"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
    assert_eq!(human.created_by_user_id, 7);
    assert_eq!(
        fixture
            .store
            .get_project(&fixture.project.id)
            .unwrap()
            .version,
        fixture.project.version
    );
    assert_eq!(human.assignee_user_id, Some(8));
    assert_eq!(fixture.count(), 1);
    assert!(fixture
        .store
        .claim_next_execution_with_catalog(
            Some("runner-a"),
            "runner-a",
            300,
            Some(&fixture.catalog)
        )
        .unwrap()
        .is_none());
    let root = fixture
        .store
        .get_task(&fixture.project.id, &fixture.issue.id)
        .unwrap();
    assert_eq!(root.assignee_user_id, Some(8));
    assert_eq!(
        root.metadata["assignment_history"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["by_user_id"],
        7
    );
    assert!(root.metadata["collaboration_group"].is_null());
    assert!(root.metadata["collaboration_group_assignment_key"].is_string());
}
