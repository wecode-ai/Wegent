// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::json;

#[path = "../../../shared/issue_follow_test_provider.rs"]
mod provider;

fn due(store: &LocalTaskStore) {
    rusqlite::Connection::open(store.path()).unwrap().execute(
        "UPDATE loop_items SET metadata=json_set(metadata,'$.follow_poll.next_at',0) WHERE resource_type='external_issue_identity'", [],
    ).unwrap();
}

async fn verify_provider(source: &'static str, kind: TaskProviderKind) {
    let provider = provider::Provider::start(source).await;
    for _ in 0..101 {
        provider.state.lock().unwrap().push("comment");
    }
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(path.clone()).unwrap();
    let project = store.create_project(ProjectCreate {
        name:source.into(), project_key:Some("EXT".into()), description:String::new(), task_provider:kind,
        provider_config:json!({"repository":"acme/repo","domain":"127.0.0.1","api_base":provider.base,"token":"test-token"}),
    }).unwrap();
    let runtime = TaskRuntime::new(store.clone()).unwrap();
    let issue = runtime
        .set_task_following(&project.id, "EXT-7", 42, true)
        .await
        .unwrap();
    assert_eq!(issue.assignee_user_id, None);
    runtime.poll_followed_external_issues().await.unwrap();
    assert!(
        store.list_issue_notifications(42).unwrap().is_empty(),
        "following must baseline every history page"
    );
    // Exceed the per-pass page budget, then construct a fresh runtime on the same database.
    for _ in 0..805 {
        provider.state.lock().unwrap().push("comment");
    }
    provider.state.lock().unwrap().push("status");
    provider.state.lock().unwrap().push("assignee");
    due(&store);
    runtime.poll_followed_external_issues().await.unwrap();
    assert_eq!(store.list_issue_notifications(42).unwrap().len(), 699);
    drop(runtime);
    let reopened = LocalTaskStore::open(path).unwrap();
    let runtime = TaskRuntime::new(reopened.clone()).unwrap();
    runtime.poll_followed_external_issues().await.unwrap();
    let notifications = reopened.list_issue_notifications(42).unwrap();
    assert_eq!(notifications.len(), 807);
    for kind in ["comment", "status", "assignee"] {
        assert!(notifications
            .iter()
            .any(|row| row["payload"]["event"] == kind));
    }
    assert!(reopened.list_issue_notifications(43).unwrap().is_empty());
    due(&reopened);
    runtime.poll_followed_external_issues().await.unwrap();
    assert_eq!(
        reopened.list_issue_notifications(42).unwrap().len(),
        807,
        "replaying pages after restart must be idempotent"
    );
    assert!(provider
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|path| path.ends_with("page=10")));
    provider.state.lock().unwrap().push("comment");
    provider.state.lock().unwrap().allowed = false;
    due(&reopened);
    runtime.poll_followed_external_issues().await.unwrap();
    assert_eq!(
        reopened.list_issue_notifications(42).unwrap().len(),
        807,
        "revoked provider access must prevent delivery"
    );
    provider.state.lock().unwrap().allowed = true;
    runtime
        .set_task_following(&project.id, "EXT-7", 42, false)
        .await
        .unwrap();
    due(&reopened);
    let requests = provider.state.lock().unwrap().requests.len();
    runtime.poll_followed_external_issues().await.unwrap();
    assert_eq!(
        provider.state.lock().unwrap().requests.len(),
        requests,
        "unfollowed Issues must not be scanned"
    );
    runtime
        .set_task_following(&project.id, "EXT-7", 42, true)
        .await
        .unwrap();
    runtime.poll_followed_external_issues().await.unwrap();
    assert_eq!(
        reopened.list_issue_notifications(42).unwrap().len(),
        807,
        "refollowing must baseline intervening events"
    );
    provider.state.lock().unwrap().push("comment");
    due(&reopened);
    runtime.poll_followed_external_issues().await.unwrap();
    assert_eq!(reopened.list_issue_notifications(42).unwrap().len(), 807);
    // A fresh scan yields after eight pages; the next pass resumes at page nine.
    runtime.poll_followed_external_issues().await.unwrap();
    assert_eq!(reopened.list_issue_notifications(42).unwrap().len(), 808);
}

#[tokio::test]
async fn github_polling_persists_pages_and_enforces_subscription_lifecycle() {
    verify_provider("github", TaskProviderKind::Github).await;
}

#[tokio::test]
async fn gitlab_polling_persists_pages_and_enforces_subscription_lifecycle() {
    verify_provider("gitlab", TaskProviderKind::Gitlab).await;
}
