//! Runtime credentials must not invalidate account HTTP work or its installer.
use super::*;
use crate::local::app_ipc::BackendConnectionHandler;

async fn rotate_runtime_token(fixture: &Fixture) {
    fixture
        .controller
        .configure_backend(json!({
            "backend_url":fixture.connection.backend_url,
            "auth_token":fixture.connection.auth_token,
            "runtime_auth_token":"runtime-after"
        }))
        .await
        .unwrap();
    let expected = ConnectionConfig {
        runtime_auth_token: "runtime-after".into(),
        ..fixture.connection.clone()
    };
    assert_eq!(
        fixture
            .controller
            .state
            .lock()
            .await
            .profile
            .as_ref()
            .unwrap()
            .connection,
        expected
    );
}

#[tokio::test]
async fn runtime_token_rotation_preserves_queued_foreground_mutations() {
    for params in [
        json!({"action":"install","targetId":8}),
        json!({"action":"update","targetId":8,"payload":{"releaseId":3}}),
        json!({"action":"uninstall","targetId":8}),
        json!({"action":"ensure_builtin","targetId":"example"}),
    ] {
        let fixture = Arc::new(Fixture::new(Plan::Valid, true).await);
        let serial = fixture.controller.local_sync_lock.lock().await;
        let request = tokio::spawn({
            let fixture = fixture.clone();
            async move {
                let mut params = params;
                params["backend_url"] = json!(fixture.connection.backend_url);
                params["auth_token"] = json!(fixture.connection.auth_token);
                fixture
                    .controller
                    .local_plugin_sync_at(params, fixture._temp.path())
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(3), fixture.probe_entered.notified())
            .await
            .unwrap();
        rotate_runtime_token(&fixture).await;
        drop(serial);
        let result = tokio::time::timeout(Duration::from_secs(3), request)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(result["localCompleted"], true);
        let scope = format!(
            "{:x}",
            Sha256::digest(format!("{}:1", fixture.connection.backend_url).as_bytes())
        );
        let journal = load_journal(&fixture._temp.path().join(format!("{scope}.json"))).unwrap();
        assert_eq!(journal["nextIntentOrder"], 1);
        assert_eq!(journal["pending"], json!([]));
        assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.installer.digest_calls.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.plans.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn runtime_token_rotation_preserves_prepared_recovery() {
    let fixture = Fixture::new(Plan::Valid, false).await;
    let original = load_journal(&fixture.path).unwrap()["pending"][0].clone();
    let worker = {
        let _serial = fixture.controller.local_sync_lock.lock().await;
        let _file = recovery::lock_file(&fixture.path.with_extension("lock")).unwrap();
        // Hold the worker at its actual profile check until rotation completes.
        let mut state = fixture.controller.state.lock().await;
        let mut journal = load_journal(&fixture.path).unwrap();
        let worker = fixture
            .controller
            .schedule_local_recovery(&fixture.connection, "native", &fixture.path, &mut journal)
            .unwrap()
            .unwrap();
        state
            .profile
            .as_mut()
            .unwrap()
            .connection
            .runtime_auth_token = "runtime-after".into();
        worker
    };
    fixture.recovery_release.notify_one();
    tokio::time::timeout(Duration::from_secs(3), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let journal = load_journal(&fixture.path).unwrap();
    assert_eq!(journal["pending"].as_array().unwrap().len(), 1);
    for field in [
        "operationId",
        "intentOrder",
        "action",
        "targetId",
        "payload",
    ] {
        assert_eq!(journal["pending"][0][field], original[field]);
    }
    assert_eq!(journal["pending"][0]["accepted"], true);
    assert_eq!(journal["nextIntentOrder"], 7);
    assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runtime_token_rotation_preserves_both_scan_phases() {
    for phase in [1, 2] {
        let (fixture, held, full) = super::scanning_tests::held_scan(phase, true).await;
        super::scanning_tests::settle_recovery(&fixture, true).await;
        let original = load_journal(&fixture.path).unwrap()["pending"][0].clone();
        rotate_runtime_token(&fixture).await;
        drop(held);
        assert_eq!(full.await.unwrap().unwrap()["localCompleted"], true);
        let journal = load_journal(&fixture.path).unwrap();
        assert_eq!(journal["pending"], json!([original]));
        assert_eq!(journal["nextIntentOrder"], 7);
        assert_eq!(journal["verifiedDigest"], "actual");
        assert_eq!(journal["revision"], "a".repeat(64));
        assert_eq!(fixture.installer.digest_calls.load(Ordering::SeqCst), 2);
        assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.plans.lock().unwrap().len(), 1);
    }
}

fn replacements(connection: &ConnectionConfig) -> [ConnectionConfig; 3] {
    [
        ConnectionConfig {
            auth_token: "another-account".into(),
            ..connection.clone()
        },
        ConnectionConfig {
            backend_url: "http://127.0.0.1:9".into(),
            ..connection.clone()
        },
        ConnectionConfig {
            socket_url: "http://127.0.0.1:9".into(),
            ..connection.clone()
        },
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn account_backend_or_socket_replacement_still_fences_both_scans() {
    for phase in [1, 2] {
        for replacement_index in 0..3 {
            let (fixture, held, full) = super::scanning_tests::held_scan(phase, true).await;
            super::scanning_tests::settle_recovery(&fixture, true).await;
            let journal = load_journal(&fixture.path).unwrap();
            fixture
                .controller
                .state
                .lock()
                .await
                .profile
                .as_mut()
                .unwrap()
                .connection = replacements(&fixture.connection)[replacement_index].clone();
            drop(held);
            assert_eq!(
                full.await.unwrap().unwrap_err().code,
                "plugin_route_profile_mismatch"
            );
            assert_eq!(load_journal(&fixture.path).unwrap(), journal);
        }
    }
}

#[tokio::test]
async fn prepared_recovery_checks_account_binding_independently_of_socket() {
    for replacement_index in 0..3 {
        let fixture = Fixture::new(Plan::Valid, false).await;
        let original = load_journal(&fixture.path).unwrap()["pending"][0].clone();
        let worker = {
            let _serial = fixture.controller.local_sync_lock.lock().await;
            let _file = recovery::lock_file(&fixture.path.with_extension("lock")).unwrap();
            let mut state = fixture.controller.state.lock().await;
            let mut journal = load_journal(&fixture.path).unwrap();
            let worker = fixture
                .controller
                .schedule_local_recovery(&fixture.connection, "native", &fixture.path, &mut journal)
                .unwrap()
                .unwrap();
            state.profile.as_mut().unwrap().connection =
                replacements(&fixture.connection)[replacement_index].clone();
            worker
        };
        fixture.recovery_release.notify_one();
        let result = tokio::time::timeout(Duration::from_secs(3), worker)
            .await
            .unwrap()
            .unwrap();
        // HTTP recovery uses the account only; Socket changes fence installers.
        if replacement_index == 2 {
            result.unwrap();
        } else {
            assert_eq!(result.unwrap_err().code, "plugin_route_profile_mismatch");
        }
        let journal = load_journal(&fixture.path).unwrap();
        assert_eq!(journal["pending"].as_array().unwrap().len(), 1);
        for field in [
            "operationId",
            "intentOrder",
            "action",
            "targetId",
            "payload",
        ] {
            assert_eq!(journal["pending"][0][field], original[field]);
        }
        assert_eq!(journal["pending"][0]["accepted"], replacement_index == 2);
        assert_eq!(fixture.installer.applications.load(Ordering::SeqCst), 0);
    }
}
