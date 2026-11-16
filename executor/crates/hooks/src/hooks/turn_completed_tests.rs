// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::path::Path;

#[cfg(windows)]
use base64::Engine;
use serde_json::{json, Value};
use tempfile::tempdir;

use super::*;

fn command() -> Value {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hook-stdin-reader.sh");
    let config = json!({"type":"command","command":fixture});
    #[cfg(windows)]
    let config = {
        let mut config = config;
        let script = "[Console]::Out.Write('{\"received\":' + [Console]::In.ReadToEnd() + '}')";
        let bytes = script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        config["commandWindows"] = json!(format!(
            "powershell.exe -NoProfile -EncodedCommand {}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
        config
    };
    config
}

fn service(home: &Path, config: Value, rollout: bool) -> (HookService, broadcast::Receiver<Value>) {
    let registry = HookRegistryStore::new(home.to_path_buf());
    registry
        .create(
            serde_json::from_value(
                json!({"schemaVersion":1,"id":"reporter","name":"Reporter","version":"1",
        "subscriptions": if rollout {vec![CODEX_ROLLOUT_SUBSCRIPTION]} else {vec![]}}),
            )
            .unwrap(),
            serde_json::from_value(config).unwrap(),
        )
        .unwrap();
    let service = HookService::new(registry, home.join("codex"));
    let (sender, receiver) = broadcast::channel(32);
    *service.event_tx.lock().unwrap() = Some(sender);
    (service, receiver)
}

fn input(cwd: &Path) -> TurnCompletedInput {
    TurnCompletedInput {
        event_id: String::new(),
        sequence: 0,
        user: HookUser {
            id: Some("7".to_owned()),
            name: "alice".to_owned(),
        },
        session_id: "session-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        cwd: cwd.to_path_buf(),
        hook_event_name: HookEventName::TurnCompleted,
        model: Some("codex".to_owned()),
        permission_mode: "workspace-write".to_owned(),
        status: "completed".to_owned(),
        file_changes: json!({"version":2,"status":"error","error":"Git capture failed"}),
    }
}

fn received(event: &Value) -> Value {
    let run = &event["payload"]["run"];
    assert_eq!(run["status"], "succeeded", "{run}");
    serde_json::from_str::<Value>(run["stdoutPreview"].as_str().unwrap()).unwrap()["received"]
        .clone()
}

#[tokio::test]
async fn durable_completion_delivers_once_per_handler_including_rollout_subscribers() {
    let home = tempdir().unwrap();
    let (service, mut receiver) = service(
        home.path(),
        json!({
            "PostToolUse":[{"matcher":".*","hooks":[command()]}],
            "TurnCompleted":[{"hooks":[command(),command()]}],
        }),
        true,
    );
    assert!(service.has_turn_completed_hooks());
    let payload = input(home.path());

    let receipt = service
        .enqueue_turn_completed(payload.clone(), None)
        .await
        .unwrap();
    assert_eq!(
        service
            .enqueue_turn_completed(payload.clone(), None)
            .await
            .unwrap(),
        receipt
    );
    tokio::time::timeout(Duration::from_secs(10), service.flush_turn_hooks())
        .await
        .unwrap()
        .unwrap();

    assert_eq!(receipt.queued_handlers, 2);
    for _ in 0..2 {
        let event = receiver.try_recv().unwrap();
        assert!(event["payload"]["run"]["handlerId"]
            .as_str()
            .unwrap()
            .starts_with("turn-completed-"));
        let mut expected = payload.clone();
        expected.event_id = receipt.event_id.clone();
        expected.sequence = receipt.sequence;
        assert_eq!(received(&event), serde_json::to_value(expected).unwrap());
    }
    assert!(receiver.try_recv().is_err());
    let run = service
        .test("reporter", "turn-completed-0-0", home.path().to_path_buf())
        .await
        .unwrap();
    let tested: Value = serde_json::from_str(&run.stdout_preview).unwrap();
    assert_eq!(tested["received"]["hook_event_name"], "TurnCompleted");
    assert!(tested["received"]["file_changes"].get("diff").is_none());
}

#[tokio::test]
async fn completion_status_matching_and_session_turn_identity_are_preserved() {
    let home = tempdir().unwrap();
    let (service, mut receiver) = service(
        home.path(),
        json!({
            "TurnCompleted":[{"matcher":"^(failed|cancelled)$","hooks":[command()]}],
        }),
        false,
    );
    let unmatched = service
        .enqueue_turn_completed(input(home.path()), None)
        .await
        .unwrap();
    assert_eq!(unmatched.queued_handlers, 0);
    let mut previous = unmatched.sequence;
    for (session, status) in [("session-1", "failed"), ("session-2", "cancelled")] {
        let mut payload = input(home.path());
        payload.session_id = session.to_owned();
        payload.turn_id = status.to_owned();
        payload.status = status.to_owned();
        let receipt = service.enqueue_turn_completed(payload, None).await.unwrap();
        assert!(receipt.sequence > previous);
        previous = receipt.sequence;
    }
    tokio::time::timeout(Duration::from_secs(10), service.flush_turn_hooks())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received(&receiver.try_recv().unwrap())["status"], "failed");
    assert_eq!(
        received(&receiver.try_recv().unwrap())["status"],
        "cancelled"
    );
    assert!(receiver.try_recv().is_err());
    service.registry.set_enabled("reporter", false).unwrap();
    assert!(!service.has_turn_completed_hooks());
}

#[tokio::test]
async fn hookless_runtime_does_not_create_or_poll_a_turn_database() {
    let home = tempdir().unwrap();
    let service = HookService::new(
        HookRegistryStore::new(home.path().to_path_buf()),
        home.path().join("codex"),
    );

    service.flush_turn_hooks().await.unwrap();

    assert!(!home.path().join("hooks/turn-completed.sqlite").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn disabling_or_deleting_a_failed_plugin_stops_retry_and_keeps_other_plugins_delivering() {
    for delete in [false, true] {
        let home = tempdir().unwrap();
        let gate = home.path().join("ready");
        let mut guarded = command();
        guarded["command"] = json!(format!(
            "test -f '{}' || exit 1\n{}",
            gate.display(),
            guarded["command"].as_str().unwrap()
        ));
        let (service, mut receiver) = service(
            home.path(),
            json!({"TurnCompleted":[{"hooks":[guarded]}]}),
            false,
        );
        service
            .enqueue_turn_completed(input(home.path()), None)
            .await
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(5), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first["payload"]["run"]["status"], "failed");
        if delete {
            service.registry.delete("reporter").unwrap();
        } else {
            service.registry.set_enabled("reporter", false).unwrap();
        }
        service
            .registry
            .create(
                serde_json::from_value(
                    json!({"schemaVersion":1,"id":"healthy","name":"Healthy","version":"1"}),
                )
                .unwrap(),
                serde_json::from_value(json!({"TurnCompleted":[{"hooks":[command()]}]})).unwrap(),
            )
            .unwrap();
        let mut next = input(home.path());
        next.turn_id = "turn-2".into();
        service.enqueue_turn_completed(next, None).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), service.flush_turn_hooks())
            .await
            .unwrap()
            .unwrap();
        let delivered = receiver.try_recv().unwrap();
        assert_eq!(delivered["payload"]["run"]["pluginId"], "healthy");
        assert_eq!(received(&delivered)["turn_id"], "turn-2");
        assert!(
            receiver.try_recv().is_err(),
            "an unavailable plugin must not be invoked"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(1100), receiver.recv())
                .await
                .is_err(),
            "the unavailable plugin must stay paused across its retry deadline"
        );

        std::fs::write(&gate, "ready").unwrap();
        if delete {
            service
                .registry
                .create(
                    serde_json::from_value(
                        json!({"schemaVersion":1,"id":"reporter","name":"Reporter","version":"1"}),
                    )
                    .unwrap(),
                    serde_json::from_value(json!({"TurnCompleted":[{"hooks":[command()]}]}))
                        .unwrap(),
                )
                .unwrap();
        } else {
            service.registry.set_enabled("reporter", true).unwrap();
        }
        tokio::time::timeout(Duration::from_secs(5), service.flush_turn_hooks())
            .await
            .unwrap()
            .unwrap();
        let resumed = receiver.try_recv().unwrap();
        assert_eq!(resumed["payload"]["run"]["pluginId"], "reporter");
        assert_eq!(
            received(&resumed)["turn_id"],
            "turn-1",
            "original event survives pause and reinstallation"
        );
        assert!(receiver.try_recv().is_err());
    }
}

#[tokio::test]
async fn completion_rejects_inline_source_instead_of_buffering_it() {
    let home = tempdir().unwrap();
    let (service, _) = service(
        home.path(),
        json!({"TurnCompleted":[{"hooks":[command()]}]}),
        false,
    );
    let mut payload = input(home.path());
    payload.file_changes = json!({"diff":"source code","files":[]});

    assert!(service
        .enqueue_turn_completed(payload, None)
        .await
        .unwrap_err()
        .contains("artifact"));
    service.flush_turn_hooks().await.unwrap();
}
