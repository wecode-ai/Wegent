//! Source-device confirmation is part of completion, including journal recovery.
use super::*;

async fn registered_fixture(plan: Plan) -> Fixture {
    let fixture = Fixture::new(plan, false).await;
    *fixture.controller.device_route_id.lock().unwrap() = Some("app-record-92".into());
    fixture
        .controller
        .connection_status
        .store(true, Ordering::Release);
    let mut journal = load_journal(&fixture.path).unwrap();
    journal["pending"] = json!([]);
    persist(&fixture.path, &journal).unwrap();
    fixture
}

#[tokio::test]
async fn successful_full_application_confirms_once_and_repairs_an_old_journal() {
    let fixture = registered_fixture(Plan::Valid).await;
    assert_eq!(
        fixture.sync(json!({"full":true})).await.unwrap()["localCompleted"],
        true
    );
    let journal = load_journal(&fixture.path).unwrap();
    assert_eq!(
        journal["confirmedDeviceRevision"]["deviceId"],
        "app-record-92"
    );
    assert_eq!(fixture.completions.lock().unwrap().len(), 1);
    assert_eq!(
        fixture.sync(json!({"full":true})).await.unwrap()["unchanged"],
        true
    );
    assert_eq!(fixture.completions.lock().unwrap().len(), 1);
    assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 1);

    let mut legacy = load_journal(&fixture.path).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("confirmedDeviceRevision");
    persist(&fixture.path, &legacy).unwrap();
    assert_eq!(
        fixture.sync(json!({"full":true})).await.unwrap()["unchanged"],
        false,
        "Device-state repair must notify the UI even when files are unchanged"
    );
    assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 1);
    let completions = fixture.completions.lock().unwrap();
    assert_eq!(completions.len(), 2);
    assert_eq!(
        completions[1]["completion"]["installedRevisions"],
        json!({"8":1})
    );
    assert_eq!(
        completions[1]["completion"]["result"]["plugins"][0]["status"],
        "synced"
    );
}

#[tokio::test]
async fn failed_confirmation_keeps_the_accepted_intent_until_full_recovery() {
    let fixture = registered_fixture(Plan::Valid).await;
    *fixture.completion_failures.lock().unwrap() = 1;
    fixture
        .sync(json!({"action":"update","targetId":8,"payload":{"releaseId":3}}))
        .await
        .expect_err("An unconfirmed device must not claim local completion");
    let journal = load_journal(&fixture.path).unwrap();
    assert_eq!(journal["pending"].as_array().unwrap().len(), 1);
    assert_eq!(journal["pending"][0]["accepted"], true);
    assert_eq!(journal["reconcilePending"], true);
    assert!(journal["confirmedDeviceRevision"].is_null());

    assert_eq!(
        fixture.sync(json!({"full":true})).await.unwrap()["localCompleted"],
        true
    );
    let recovered = load_journal(&fixture.path).unwrap();
    assert!(recovered["pending"].as_array().unwrap().is_empty());
    assert_eq!(recovered["reconcilePending"], false);
    assert_eq!(fixture.completions.lock().unwrap().len(), 2);
    let submissions = fixture.submissions.lock().unwrap();
    assert_eq!(submissions.len(), 2);
    assert_eq!(
        submissions[0], submissions[1],
        "Recovery must reuse the original intent identity"
    );
}

#[tokio::test]
async fn failed_materialization_never_confirms_an_installed_device() {
    let fixture = registered_fixture(Plan::FailedApplication).await;
    assert_eq!(
        fixture.sync(json!({"full":true})).await.unwrap_err().code,
        "plugin_local_apply_failed"
    );
    assert!(fixture.completions.lock().unwrap().is_empty());
    assert_eq!(
        load_journal(&fixture.path).unwrap()["reconcilePending"],
        true
    );
}

#[tokio::test]
async fn full_refresh_confirms_preserved_author_source_without_claiming_a_cloud_runtime() {
    let fixture = registered_fixture(Plan::AuthorSource).await;
    let result = fixture.sync(json!({"full":true})).await.unwrap();
    assert_eq!(result["localCompleted"], true);
    let completions = fixture.completions.lock().unwrap();
    assert_eq!(completions.len(), 1);
    let item = &completions[0]["completion"]["result"]["plugins"][0];
    assert_eq!(item["status"], "source_preserved");
    assert_eq!(item["source"]["version"], "1.1.0");
    assert_eq!(item["version"], "1.0.0");
    assert_eq!(
        load_journal(&fixture.path).unwrap()["reconcilePending"],
        false
    );
}

#[tokio::test]
async fn receipt_contention_retries_with_the_same_result_without_reapplying() {
    let fixture = registered_fixture(Plan::Valid).await;
    *fixture.completion_error.lock().unwrap() = "plugin_write_busy".into();
    *fixture.completion_failures.lock().unwrap() = 1;
    assert_eq!(
        fixture
            .sync(json!({"action":"update","targetId":8,"payload":{"releaseId":3}}))
            .await
            .unwrap()["localCompleted"],
        true
    );
    assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.submissions.lock().unwrap().len(), 1);
    let confirmations = fixture.completions.lock().unwrap();
    assert_eq!(confirmations.len(), 2);
    assert_eq!(confirmations[0], confirmations[1]);
}

#[tokio::test]
async fn transient_confirmation_failures_preserve_actual_results_and_recover() {
    for code in ["plugin_write_busy", "plugin_write_lease_lost"] {
        let fixture = registered_fixture(Plan::Valid).await;
        *fixture.completion_error.lock().unwrap() = code.into();
        *fixture.completion_failures.lock().unwrap() = 3;
        let failure = fixture
            .sync(json!({"action":"update","targetId":8,"payload":{"releaseId":3}}))
            .await
            .unwrap_err();
        assert_eq!(failure.code, "plugin_local_confirmation_pending");
        let journal = load_journal(&fixture.path).unwrap();
        assert_eq!(journal["lastResult"]["plugins"][0]["status"], "synced");
        assert_eq!(journal["reconcilePending"], true);
        assert_eq!(journal["pending"][0]["accepted"], true);
        assert!(journal["confirmedDeviceRevision"].is_null());
        assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 1);

        assert_eq!(
            fixture.sync(json!({"full":true})).await.unwrap()["localCompleted"],
            true
        );
        let recovered = load_journal(&fixture.path).unwrap();
        assert_eq!(recovered["reconcilePending"], false);
        assert!(recovered["pending"].as_array().unwrap().is_empty());
        assert_eq!(
            recovered["confirmedDeviceRevision"]["deviceId"],
            "app-record-92"
        );
    }
}

#[tokio::test]
async fn failed_unchanged_confirmation_is_durable_and_recovers() {
    let fixture = registered_fixture(Plan::Valid).await;
    fixture.sync(json!({"full":true})).await.unwrap();
    let mut journal = load_journal(&fixture.path).unwrap();
    journal["confirmedDeviceRevision"] = Value::Null;
    persist(&fixture.path, &journal).unwrap();
    *fixture.completion_error.lock().unwrap() = "plugin_write_busy".into();
    *fixture.completion_failures.lock().unwrap() = 1;
    assert_eq!(
        fixture.sync(json!({"full":true})).await.unwrap_err().code,
        "plugin_local_confirmation_pending"
    );
    assert_eq!(
        load_journal(&fixture.path).unwrap()["reconcilePending"],
        true
    );
    assert_eq!(
        fixture.sync(json!({"full":true})).await.unwrap()["localCompleted"],
        true
    );
    assert_eq!(
        load_journal(&fixture.path).unwrap()["reconcilePending"],
        false
    );
}

#[tokio::test]
async fn confirmation_ownership_failures_remain_errors() {
    let fixture = registered_fixture(Plan::Valid).await;
    *fixture.completion_error.lock().unwrap() = "SNAPSHOT_NOT_OWNED".into();
    *fixture.completion_failures.lock().unwrap() = 1;
    assert_eq!(
        fixture.sync(json!({"full":true})).await.unwrap_err().code,
        "SNAPSHOT_NOT_OWNED"
    );
    assert!(load_journal(&fixture.path).unwrap()["confirmedDeviceRevision"].is_null());
}

#[tokio::test]
async fn unchanged_confirmation_cannot_clear_a_newer_plugins_pending_recovery() {
    let fixture = registered_fixture(Plan::Valid).await;
    fixture.sync(json!({"full":true})).await.unwrap();
    let mut journal = load_journal(&fixture.path).unwrap();
    journal["confirmedDeviceRevision"] = Value::Null;
    persist(&fixture.path, &journal).unwrap();
    fixture.completion_hold.store(true, Ordering::SeqCst);
    let (older, _) = tokio::join!(fixture.sync(json!({"full":true})), async {
        tokio::time::timeout(EVENT_WAIT_TIMEOUT, fixture.completion_entered.notified())
            .await
            .unwrap();
        *fixture.completion_error.lock().unwrap() = "plugin_write_busy".into();
        *fixture.completion_failures.lock().unwrap() = 3;
        let failure = fixture
            .sync(json!({"installedPluginId":9}))
            .await
            .unwrap_err();
        assert_eq!(failure.code, "plugin_local_confirmation_pending");
        assert_eq!(
            load_journal(&fixture.path).unwrap()["lastResult"]["plugins"][0]["id"],
            9
        );
        fixture.completion_release.notify_one();
    });
    assert_eq!(older.unwrap_err().code, "plugin_local_sync_busy");
    let pending = load_journal(&fixture.path).unwrap();
    assert_eq!(pending["reconcilePending"], true);
    assert!(pending["confirmedDeviceRevision"].is_null());
}
