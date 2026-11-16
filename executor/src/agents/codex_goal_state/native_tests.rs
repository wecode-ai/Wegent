//! Real packaged Codex compatibility, with model-only doubles for execution tests.
#[path = "native_tests/event_turn.rs"]
mod event_turn;
use super::*;
use crate::{
    agents::CodexAppServerClient,
    envd::{
        archive::{create_runtime_archive, restore_runtime_archive, ArchiveMode, ArchiveOptions},
        archive_sessions::SessionArchiveRoots,
    },
};
use futures_util::FutureExt;
use serde_json::json;

#[tokio::test]
#[ignore = "requires the repository-pinned Codex binary; invoked by the Executor CI job"]
async fn native_goal_archive_protocol() {
    let binary =
        std::env::var("WEWORK_GOAL_TEST_CODEX_BINARY").expect("pinned Codex binary is required");
    assert!(Path::new(&binary).is_absolute() && Path::new(&binary).is_file());
    let _environment = crate::agents::CodexLaunchEnvironment::new();
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let source_home = source.path().join("home");
    let target_home = target.path().join("home");
    let source_roots = SessionArchiveRoots::for_home(&source_home);
    let target_roots = SessionArchiveRoots::for_home(&target_home);
    let source_client =
        CodexAppServerClient::isolated_for_test(&binary, source_roots.codex.clone());
    let target_client =
        CodexAppServerClient::isolated_for_test(&binary, target_roots.codex.clone());
    let result = std::panic::AssertUnwindSafe(async {
        for status in ["paused", "blocked"] {
        eprintln!("Native Goal archive case: {status}");
        let workspace = source.path().join("workspace/42");
        fs::create_dir_all(&workspace).unwrap();
        let thread = source_client.request("thread/start", json!({"cwd":workspace,"model":"gpt-5.1-codex-mini","approvalPolicy":"never","sandbox":"read-only","persistExtendedHistory":true})).await.unwrap();
        let id = thread["thread"]["id"].as_str().unwrap();
        source_client.request("thread/goal/set", json!({"threadId":id,"objective":"Preserve the waiting archive Goal","status":status,"tokenBudget":20000})).await.unwrap();
        let original = source_client.request("thread/goal/get", json!({"threadId":id})).await.unwrap();
        assert!(original["goal"].is_object());
        assert_eq!(original["goal"]["status"], status);
        let captured = Snapshot::decode(&capture(&source_roots.codex,id).unwrap().unwrap()).unwrap();
        assert_eq!(captured.token_budget,Some(20000));
        assert_native_wait_context(&source_roots.codex, id, &original["goal"], &captured);
        source_client.restart().await;
        fs::create_dir_all(source_roots.executor.join("sessions/42")).unwrap();
        fs::write(source_roots.executor.join("sessions/42/.codex_thread_id"),id).unwrap();
        let archive = create_runtime_archive(ArchiveOptions{mode:ArchiveMode::Executor,task_id:"42".into(),workspace_path:workspace,home_path:source_home.clone(),max_size_bytes:10_000_000}).unwrap();
        fs::remove_dir_all(&source_home).unwrap();
        restore_runtime_archive(&archive.bytes,ArchiveMode::Executor,"42",&target.path().join("workspace/42"),&target_home).unwrap();
        assert_eq!(target_roots.codex.join("goals_1.sqlite").exists(),status == "blocked","the first schema belongs to native startup; later tasks reuse it");
        // A rejected mutation must leave the restored original Goal available.
        let rejected = target_client.request("thread/goal/set",json!({"threadId":id,"objective":"","status":"paused"})).await;
        assert!(rejected.is_err(),"Native must reject an empty objective");
        let restored = target_client.request("thread/goal/get",json!({"threadId":id})).await.unwrap();
        assert_eq!(restored["goal"],original["goal"]);
        assert_eq!(Snapshot::decode(&capture(&target_roots.codex,id).unwrap().unwrap()).unwrap(),captured);
        assert_native_wait_context(&target_roots.codex, id, &restored["goal"], &captured);
        target_client.request("thread/resume",json!({"threadId":id,"cwd":target.path().join("workspace/42"),"model":"gpt-5.1-codex-mini","approvalPolicy":"never","sandbox":"read-only","excludeTurns":true})).await.unwrap();
        assert_eq!(target_client.request("thread/goal/get",json!({"threadId":id})).await.unwrap()["goal"],original["goal"],"loading a paused or waiting Goal cannot reactivate it");
        target_client.request("thread/goal/clear",json!({"threadId":id})).await.unwrap();
        assert!(target_client.request("thread/goal/get",json!({"threadId":id})).await.unwrap()["goal"].is_null());
        assert_eq!(wait_context(&target_roots.codex,id,&Value::Null).unwrap(),json!({"kind":"none"}));
        assert!(!pending_path(&target_roots.codex,id).unwrap().exists());
        }
    }).catch_unwind().await;
    source_client.restart().await;
    target_client.restart().await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

fn assert_native_wait_context(home: &Path, id: &str, api: &Value, snapshot: &Snapshot) {
    if snapshot.status == "paused" {
        assert_eq!(wait_context(home, id, api), Err("native_goal_not_waitable"));
        return;
    }
    let context = wait_context(home, id, api).unwrap();
    let bytes = capture(home, id).unwrap().unwrap();
    assert_eq!(context["kind"], "goal");
    assert_eq!(context["status"], "blocked");
    assert_eq!(
        context["identity"],
        json!(snapshot.archive_evidence(&bytes).identity())
    );
}
