//! Deltas avoid global scans without weakening full reconciliation or recovery.
use super::*;

#[tokio::test]
async fn single_plugin_operations_never_scan_global_content_and_invalidate_full_evidence() {
    for params in [
        json!({"action":"install","targetId":8}),
        json!({"action":"update","targetId":8,"payload":{"releaseId":3}}),
        json!({"action":"uninstall","targetId":8}),
        json!({"action":"ensure_builtin","targetId":"example"}),
        json!({"installedPluginId":8}),
    ] {
        let fixture = Fixture::new(Plan::Valid, true).await;
        let mut journal = load_journal(&fixture.path).unwrap();
        let original = journal["pending"][0].clone();
        journal["revision"] = json!("a".repeat(64));
        journal["verifiedDigest"] = json!("actual");
        persist(&fixture.path, &journal).unwrap();

        let result = fixture.sync(params.clone()).await.unwrap();
        assert_eq!(result["localCompleted"], true, "{params}");
        assert_eq!(result["result"]["scope"], "plugin_delta");
        assert_eq!(result["result"]["plugin_sync"]["generation"], 1);
        assert_eq!(
            result["result"]["plugins"][0]["status"],
            if params["action"] == "uninstall" {
                "removed"
            } else {
                "synced"
            }
        );
        assert_eq!(
            fixture.installer.digest_calls.load(Ordering::SeqCst),
            0,
            "{params}"
        );
        assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 1);
        let journal = load_journal(&fixture.path).unwrap();
        assert_eq!(journal["pending"], json!([original]), "{params}");
        assert!(journal["revision"].is_null());
        assert!(journal["verifiedDigest"].is_null());
        assert!(journal.get("snapshot").is_none());
        assert_eq!(journal["reconcilePending"], true);
        let plans = fixture.plans.lock().unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0]["targeted"], true);
        assert!(plans[0]["knownRevision"].is_null());
        assert!(plans[0]["actualRevision"].is_null());
    }
}

#[tokio::test]
async fn full_reconciliation_rechecks_content_after_a_delta_or_local_damage() {
    let fixture = Fixture::new(Plan::Valid, true).await;
    persist(&fixture.path, &json!({"version":1,"pending":[]})).unwrap();
    fixture.sync(json!({"full":true})).await.unwrap();
    assert_eq!(fixture.installer.digest_calls.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 1);
    let unchanged = fixture.sync(json!({"full":true})).await.unwrap();
    assert_eq!(unchanged["unchanged"], true);
    assert_eq!(fixture.installer.digest_calls.load(Ordering::SeqCst), 3);
    assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 1);

    fixture.sync(json!({"installedPluginId":8})).await.unwrap();
    assert_eq!(fixture.installer.digest_calls.load(Ordering::SeqCst), 3);
    fixture.sync(json!({"full":true})).await.unwrap();
    assert!(fixture.plans.lock().unwrap().last().unwrap()["knownRevision"].is_null());
    assert_eq!(fixture.installer.digest_calls.load(Ordering::SeqCst), 5);
    assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 3);

    *fixture.installer.digest.lock().unwrap() = Some("damaged".into());
    fixture.sync(json!({"full":true})).await.unwrap();
    assert!(fixture.plans.lock().unwrap().last().unwrap()["knownRevision"].is_null());
    assert_eq!(fixture.installer.digest_calls.load(Ordering::SeqCst), 7);
    assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn failed_delta_keeps_accepted_intent_until_full_reconciliation_without_losing_uncertain_work(
) {
    let mut fixture = Fixture::new(Plan::FailedApplication, true).await;
    let original = load_journal(&fixture.path).unwrap()["pending"][0].clone();
    let failure = fixture
        .sync(json!({"action":"update","targetId":8,"payload":{"releaseId":3}}))
        .await
        .unwrap_err();
    assert_eq!(failure.code, "plugin_local_apply_failed");
    assert_eq!(fixture.installer.digest_calls.load(Ordering::SeqCst), 0);
    let journal = load_journal(&fixture.path).unwrap();
    assert_eq!(journal["pending"][0], original);
    let accepted = journal["pending"][1].clone();
    assert_eq!(accepted["accepted"], true);
    assert_eq!(accepted["payload"], json!({"releaseId":3}));
    assert_eq!(journal["reconcilePending"], true);
    assert!(journal.get("snapshot").is_none());

    fixture.installer.plan = Plan::Valid;
    fixture.sync(json!({"full":true})).await.unwrap();
    assert_eq!(fixture.installer.digest_calls.load(Ordering::SeqCst), 2);
    tokio::time::timeout(Duration::from_secs(3), fixture.recovery_entered.notified())
        .await
        .unwrap();
    fixture.recovery_release.notify_one();
    let journal = fixture.wait_for_merge(true).await;
    assert_eq!(journal["pending"].as_array().unwrap().len(), 1);
    for field in [
        "operationId",
        "intentOrder",
        "action",
        "targetId",
        "payload",
        "accepted",
    ] {
        assert_eq!(journal["pending"][0][field], original[field], "{field}");
    }
    assert_eq!(
        journal["pending"][0]["lastErrorCode"],
        "plugin_local_acceptance_unconfirmed"
    );
    assert_eq!(journal["reconcilePending"], true);
    assert!(journal.get("snapshot").is_none());
}
