// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::ffi::OsString;

use serde_json::{json, Value};

use super::AppIpcServer;

struct ExecutorHome {
    _directory: tempfile::TempDir,
    previous: Option<OsString>,
}

impl ExecutorHome {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("WEGENT_EXECUTOR_HOME");
        std::env::set_var("WEGENT_EXECUTOR_HOME", directory.path());
        Self {
            _directory: directory,
            previous,
        }
    }
}

impl Drop for ExecutorHome {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("WEGENT_EXECUTOR_HOME", value),
            None => std::env::remove_var("WEGENT_EXECUTOR_HOME"),
        }
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

async fn project_with_rule(server: &AppIpcServer, target_id: &str) -> (Value, Value) {
    let project = server
        .dispatch("projects.create", json!({"name": "Automation IPC"}))
        .await
        .unwrap();
    let project = server
        .dispatch(
            "projects.update",
            json!({
                "project_id": project["id"],
                "project": {
                    "version": project["version"],
                    "automatic_processing_rules": [{
                        "id": "review-rule", "name": "Review",
                        "triggerType": "event", "eventType": "task.tag_added",
                        "eventConfig": {"tags": ["review"]},
                        "targetKind": "human", "targetId": target_id, "enabled": true,
                    }],
                },
            }),
        )
        .await
        .unwrap();
    let issue = server
        .dispatch(
            "todos.create",
            json!({"project_id": project["id"], "todo": {"title": "Review Issue"}}),
        )
        .await
        .unwrap();
    (project, issue)
}

#[test]
fn project_automation_rpc_runs_lists_and_cancels_persisted_run() {
    let _lock = crate::test_env::lock();
    let _home = ExecutorHome::new();
    runtime().block_on(async {
        let server = AppIpcServer::new();
        let (project, issue) = project_with_rule(&server, "7").await;

        let runs = server
            .dispatch(
                "projects.automation.run",
                json!({
                    "project_id": project["id"],
                    "automation_id": "review-rule",
                    "issue_id": issue["id"],
                }),
            )
            .await
            .unwrap();
        assert_eq!(runs.as_array().unwrap().len(), 1);
        assert_eq!(runs[0]["issueId"], issue["id"]);
        assert_eq!(runs[0]["status"], "succeeded");
        let listed = server
            .dispatch(
                "projects.automation.runs",
                json!({"project_id": project["id"], "automation_id": "review-rule"}),
            )
            .await
            .unwrap();
        assert_eq!(listed[0]["id"], runs[0]["id"]);
        let cancelled = server
            .dispatch(
                "projects.automation.cancel",
                json!({"project_id": project["id"], "run_id": runs[0]["id"]}),
            )
            .await
            .unwrap();
        assert_eq!(cancelled["run"]["id"], runs[0]["id"]);
        assert_eq!(cancelled["run"]["status"], "succeeded");
        assert_eq!(cancelled["executions"], json!([]));
    });
}

#[test]
fn project_automation_rpc_retries_failed_run_and_enforces_project_scope() {
    let _lock = crate::test_env::lock();
    let _home = ExecutorHome::new();
    runtime().block_on(async {
        let server = AppIpcServer::new();
        let (project, _) = project_with_rule(&server, "invalid-user").await;
        let runs = server
            .dispatch(
                "projects.automation.run",
                json!({"project_id": project["id"], "automation_id": "review-rule"}),
            )
            .await
            .unwrap();
        assert_eq!(runs[0]["status"], "failed");
        let retried = server
            .dispatch(
                "projects.automation.retry",
                json!({"project_id": project["id"], "run_id": runs[0]["id"]}),
            )
            .await
            .unwrap();
        assert_eq!(retried.as_array().unwrap().len(), 1);
        assert_ne!(retried[0]["id"], runs[0]["id"]);
        assert_eq!(retried[0]["issueId"], runs[0]["issueId"]);
        let other_project = server
            .dispatch("projects.create", json!({"name": "Other project"}))
            .await
            .unwrap();
        for method in ["projects.automation.cancel", "projects.automation.retry"] {
            let error = server
                .dispatch(
                    method,
                    json!({"project_id": other_project["id"], "run_id": runs[0]["id"]}),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "bad_request");
            assert!(error.message.contains("does not belong to this project"));
        }
    });
}

#[test]
fn project_automation_rpc_validates_identifiers_before_store_calls() {
    let _lock = crate::test_env::lock();
    let _home = ExecutorHome::new();
    runtime().block_on(async {
        let server = AppIpcServer::new();
        for (method, identifier) in [
            ("projects.automation.run", "automation_id"),
            ("projects.automation.runs", "automation_id"),
            ("projects.automation.cancel", "run_id"),
            ("projects.automation.retry", "run_id"),
        ] {
            let error = server.dispatch(method, json!({})).await.unwrap_err();
            assert_eq!(error.code, "bad_request");
            assert_eq!(error.message, "project_id is required");
            for invalid in [Value::Null, json!(" "), json!(123)] {
                let mut params = json!({"project_id": "project-1"});
                params[identifier] = invalid;
                let error = server.dispatch(method, params).await.unwrap_err();
                assert_eq!(error.code, "bad_request");
                assert_eq!(error.message, format!("{identifier} is required"));
            }
        }
        let error = server
            .dispatch(
                "projects.automation.run",
                json!({"project_id": "project-1", "automation_id": "rule-1", "issue_id": 42}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "bad_request");
        assert_eq!(error.message, "issue_id must be a string or null");
    });
}
