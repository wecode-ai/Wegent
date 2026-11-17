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
    fixture.completion_failures.store(1, Ordering::SeqCst);
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
