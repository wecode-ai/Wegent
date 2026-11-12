//! Recovery needs the original request and a marker, never an old server plan.
use super::*;

#[test]
fn old_plan_entries_become_reconciliation_markers_without_changing_requests() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("journal.json");
    let request = json!({"operationId":"uncertain","intentOrder":7,"action":"install","targetId":8,"payload":{"releaseId":3},"accepted":false});
    for plan in [
        json!({"payload":{"plugins":[{"download_path":"/old-package"}]}}),
        Value::Null,
        json!("obsolete-id"),
    ] {
        for reconcile in [false, true] {
            let previous = json!({"version":1,"nextIntentOrder":7,"pending":[request],"snapshot":plan,"receipts":[{"obsolete":true}],"reconcilePending":reconcile});
            persist(&path, &previous).unwrap();
            let current = load_journal(&path).unwrap();
            assert_eq!(current["pending"], previous["pending"]);
            assert_eq!(current["nextIntentOrder"], 7);
            assert_eq!(current["reconcilePending"], reconcile || plan.is_object());
            assert!(current.get("snapshot").is_none());
            assert!(current.get("receipts").is_none());
            persist(&path, &current).unwrap();
            assert_eq!(load_journal(&path).unwrap(), current);
        }
    }
}

#[tokio::test]
async fn an_old_plan_forces_fresh_reconciliation_without_pending_requests() {
    let fixture = Fixture::new(Plan::Valid, true).await;
    persist(&fixture.path, &json!({"version":1,"pending":[],"revision":"a".repeat(64),"verifiedDigest":"actual","snapshot":{"payload":{"plugins":[]}}})).unwrap();
    let result = fixture.sync(json!({"full":true})).await.unwrap();
    assert_eq!(result["localCompleted"], true);
    assert_ne!(result["unchanged"], true);
    assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.plans.lock().unwrap()[0]["recoveryPending"], true);
    let current = load_journal(&fixture.path).unwrap();
    assert!(current.get("snapshot").is_none());
    assert_eq!(current["reconcilePending"], false);
    assert_eq!(current["verifiedDigest"], "actual");
}

#[tokio::test]
async fn unfinished_reconciliation_cannot_accept_an_unchanged_response() {
    let fixture = Fixture::new(Plan::UnexpectedUnchanged, true).await;
    let journal = json!({"version":1,"pending":[],"revision":"a".repeat(64),"verifiedDigest":"actual","reconcilePending":true});
    persist(&fixture.path, &journal).unwrap();
    let result = fixture.sync(json!({"full":true})).await.unwrap_err();
    assert_eq!(result.code, "plugin_local_invalid_response");
    assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 0);
    assert_eq!(load_journal(&fixture.path).unwrap(), journal);
}

#[tokio::test]
async fn interrupted_application_recovers_from_the_marker_and_original_requests() {
    let fixture = Arc::new(Fixture::new(Plan::HeldApplication, true).await);
    let original = load_journal(&fixture.path).unwrap()["pending"][0].clone();
    let operation = tokio::spawn({
        let fixture = fixture.clone();
        async move {
            fixture
                .sync(json!({"action":"update","targetId":8,"payload":{"releaseId":3}}))
                .await
        }
    });
    tokio::time::timeout(Duration::from_secs(3), fixture.installer.entered.notified())
        .await
        .unwrap();
    operation.abort();
    assert!(operation.await.unwrap_err().is_cancelled());
    let interrupted = load_journal(&fixture.path).unwrap();
    assert_eq!(interrupted["reconcilePending"], true);
    assert!(interrupted.get("snapshot").is_none());
    assert_eq!(interrupted["pending"][0], original);
    assert_eq!(interrupted["pending"][1]["accepted"], true);
    assert_eq!(interrupted["pending"][1]["payload"], json!({"releaseId":3}));
    fixture.installer.release.notify_one();
    assert_eq!(
        fixture.sync(json!({"full":true})).await.unwrap()["localCompleted"],
        true
    );
    fixture.recovery_release.notify_one();
    let recovered = fixture.wait_for_merge(true).await;
    assert_eq!(recovered["pending"].as_array().unwrap().len(), 1);
    for field in [
        "operationId",
        "intentOrder",
        "action",
        "targetId",
        "payload",
        "accepted",
    ] {
        assert_eq!(recovered["pending"][0][field], original[field]);
    }
    assert_eq!(recovered["nextIntentOrder"], interrupted["nextIntentOrder"]);
    assert!(recovered.get("snapshot").is_none());
    assert_eq!(recovered["verifiedDigest"], "actual");
    let plans = fixture.plans.lock().unwrap();
    assert_eq!(plans.len(), 2);
    assert_eq!(plans[1]["targeted"], false);
    assert_eq!(plans[1]["recoveryPending"], true);
}
