//! Hold the actual synchronous scan callback, without holding a Tokio worker.
use super::*;

async fn held_scan(
    phase: usize,
    unconfirmed: bool,
) -> (
    Arc<Fixture>,
    HeldDigest,
    tokio::task::JoinHandle<Result<Value, AppIpcError>>,
) {
    let fixture = Arc::new(Fixture::new(Plan::Valid, unconfirmed).await);
    fixture
        .installer
        .digest_gate
        .hold_at
        .store(phase, Ordering::SeqCst);
    let held = HeldDigest(fixture.installer.digest_gate.clone());
    let full = tokio::spawn({
        let fixture = fixture.clone();
        async move { fixture.sync(json!({"full":true})).await }
    });
    tokio::time::timeout(
        Duration::from_secs(3),
        fixture.installer.digest_gate.entered.notified(),
    )
    .await
    .expect("The full scan did not start");
    (fixture, held, full)
}

async fn settle_recovery(fixture: &Fixture, unconfirmed: bool) {
    tokio::time::timeout(Duration::from_secs(3), fixture.recovery_entered.notified())
        .await
        .expect("Pending submission waited for the content scan");
    fixture.recovery_release.notify_one();
    fixture.wait_for_merge(unconfirmed).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_scans_allow_pending_submission_and_foreground_completion() {
    for phase in [1, 2] {
        let (fixture, held, full) = held_scan(phase, true).await;
        settle_recovery(&fixture, true).await;
        let foreground = tokio::time::timeout(
            Duration::from_secs(3),
            fixture.sync(json!({"action":"update","targetId":8,"payload":{"releaseId":3}})),
        )
        .await
        .expect("Foreground operation waited for the full scan")
        .unwrap();
        assert_eq!(foreground["localCompleted"], true);
        let current = load_journal(&fixture.path).unwrap();
        assert_eq!(current["lastResult"]["scope"], "plugin_delta");
        assert!(current["verifiedDigest"].is_null());
        drop(held);
        assert_eq!(
            full.await.unwrap().unwrap_err().code,
            "plugin_local_sync_busy"
        );
        assert_eq!(load_journal(&fixture.path).unwrap(), current);
        assert_eq!(current["pending"][0]["operationId"], "original");
        assert_eq!(current["pending"][0]["payload"], json!({"releaseId":3}));
        assert_eq!(
            current["pending"][0]["lastErrorCode"],
            "plugin_local_acceptance_unconfirmed"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn account_replacement_rejects_both_scan_phases_without_writing_back() {
    for phase in [1, 2] {
        let (fixture, held, full) = held_scan(phase, true).await;
        settle_recovery(&fixture, true).await;
        let current = load_journal(&fixture.path).unwrap();
        fixture
            .controller
            .state
            .lock()
            .await
            .profile
            .as_mut()
            .unwrap()
            .connection
            .auth_token = "another-account".into();
        drop(held);
        assert_eq!(
            full.await.unwrap().unwrap_err().code,
            "plugin_route_profile_mismatch"
        );
        assert_eq!(load_journal(&fixture.path).unwrap(), current);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publication_without_a_journal_change_invalidates_scan_evidence() {
    for phase in [1, 2] {
        let (fixture, held, full) = held_scan(phase, true).await;
        settle_recovery(&fixture, true).await;
        let current = load_journal(&fixture.path).unwrap();
        // Socket or another process can publish without touching this journal.
        fixture
            .installer
            .state_revision
            .fetch_add(1, Ordering::SeqCst);
        drop(held);
        assert_eq!(
            full.await.unwrap().unwrap_err().code,
            "plugin_local_sync_busy"
        );
        assert_eq!(load_journal(&fixture.path).unwrap(), current);
        assert!(current["verifiedDigest"].is_null());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_request_without_publication_is_not_overwritten_by_a_scan() {
    for phase in [1, 2] {
        let (fixture, held, full) = held_scan(phase, true).await;
        settle_recovery(&fixture, true).await;
        let current = {
            let _lease = fixture
                .controller
                .acquire_local_sync_lease(&fixture.connection, &fixture.path)
                .await
                .unwrap();
            let mut journal = load_journal(&fixture.path).unwrap();
            journal["nextIntentOrder"] = json!(8);
            journal["pending"].as_array_mut().unwrap().push(json!({
                "operationId":"new-uncertain-request","intentOrder":8,"action":"update",
                "targetId":9,"payload":{"releaseId":5},"accepted":false
            }));
            persist(&fixture.path, &journal).unwrap();
            journal
        };
        drop(held);
        assert_eq!(
            full.await.unwrap().unwrap_err().code,
            "plugin_local_sync_busy"
        );
        assert_eq!(load_journal(&fixture.path).unwrap(), current);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_results_merge_during_either_scan_without_invalidating_it() {
    for phase in [1, 2] {
        for unconfirmed in [false, true] {
            let (fixture, held, full) = held_scan(phase, unconfirmed).await;
            settle_recovery(&fixture, unconfirmed).await;
            drop(held);
            assert_eq!(full.await.unwrap().unwrap()["localCompleted"], true);
            let journal = load_journal(&fixture.path).unwrap();
            assert_eq!(journal["verifiedDigest"], "actual");
            if phase == 1 && !unconfirmed {
                assert_eq!(journal["pending"], json!([]));
            } else {
                assert_eq!(journal["pending"][0]["operationId"], "original");
                assert_eq!(journal["pending"][0]["accepted"], !unconfirmed);
                if unconfirmed {
                    assert_eq!(
                        journal["pending"][0]["lastErrorCode"],
                        "plugin_local_acceptance_unconfirmed"
                    );
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_keeps_the_scan_slot_until_its_worker_exits() {
    let (fixture, held, full) = held_scan(1, true).await;
    settle_recovery(&fixture, true).await;
    full.abort();
    assert!(full.await.unwrap_err().is_cancelled());
    let duplicate =
        tokio::time::timeout(Duration::from_secs(3), fixture.sync(json!({"full":true})))
            .await
            .expect("The duplicate scan waited instead of yielding its slot");
    assert_eq!(duplicate.unwrap_err().code, "plugin_local_sync_busy");
    assert_eq!(fixture.installer.digest_calls.load(Ordering::SeqCst), 1);
    let foreground = tokio::time::timeout(
        Duration::from_secs(3),
        fixture.sync(json!({"installedPluginId":8})),
    )
    .await
    .expect("A cancelled full scan retained the foreground lease")
    .unwrap();
    assert_eq!(foreground["localCompleted"], true);
    drop(held);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if recovery::lock_file(&fixture.path.with_extension("scan.lock")).is_ok() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("The completed worker retained its scan slot");
}
