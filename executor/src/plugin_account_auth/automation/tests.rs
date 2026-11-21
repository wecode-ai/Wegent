// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::local::backend::{EventHandler, LocalBackendConfig};
use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

#[derive(Clone)]
struct Transport(Arc<Mutex<VecDeque<(&'static str, Value)>>>);

impl LocalBackendTransport for Transport {
    fn connect<'a>(&'a self, _: &'a LocalBackendConfig) -> TransportFuture<'a, ()> {
        panic!("reconciliation uses an established transport")
    }
    fn disconnect<'a>(&'a self) -> TransportFuture<'a, ()> {
        panic!("reconciliation must not disconnect")
    }
    fn call<'a>(&'a self, event: &'a str, _: Value, _: Duration) -> TransportFuture<'a, Value> {
        let (expected, response) = self.0.lock().unwrap().pop_front().expect("unexpected call");
        assert_eq!(event, expected);
        Box::pin(async move { Ok(response) })
    }
    fn emit<'a>(&'a self, _: &'a str, _: Value) -> TransportFuture<'a, ()> {
        panic!("reconciliation uses request/reply")
    }
    fn on(&self, _: &str, _: EventHandler) {
        panic!("no subscription")
    }
    fn on_close(&self, _: crate::local::backend::ConnectionClosedHandler) {
        panic!("no subscription")
    }
}

#[tokio::test(start_paused = true)]
async fn temporary_discovery_failure_keeps_priority_until_the_target_is_resolved() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir(home.path().join("capabilities")).unwrap();
    fs::write(
        home.path().join("capabilities/manifest-v2.json"),
        json!({"plugins":{
            "mail":{"installed_plugin_id":42,"managed":true,"enabled":true},
        }})
        .to_string(),
    )
    .unwrap();
    let transport = Transport(Arc::new(Mutex::new(VecDeque::from([
        (
            "plugin.auth.automatic",
            json!({"success":false,"error":"plugin_auth_exchange_failed"}),
        ),
        (
            "plugin.auth.automatic",
            json!({"success":false,"error":"plugin_auth_invalid_request"}),
        ),
    ]))));
    let logins = Arc::new(PendingLogins::default());
    logins.submit(42, "mail".into());
    let mut reconciler = Reconciler::new(logins.clone());
    let actions = Arc::new(Semaphore::new(1));
    let error = reconciler
        .reconcile_logins(
            transport.clone(),
            home.path(),
            logins.take(),
            actions.clone(),
        )
        .await
        .unwrap_err();
    assert_eq!(error, AuthError("plugin_auth_exchange_failed"));
    assert!(logins.contains_installation(42));
    assert_eq!(
        logins.next_ready(),
        Some(tokio::time::Instant::now() + Duration::from_secs(30))
    );
    assert_eq!(logins.take().targets().count(), 0);
    tokio::time::advance(Duration::from_secs(30)).await;
    let error = reconciler
        .reconcile_logins(transport, home.path(), logins.take(), actions)
        .await
        .unwrap_err();

    assert_eq!(error, AuthError("plugin_auth_invalid_request"));
    assert!(!logins.contains_installation(42));
}

#[test]
fn completed_targets_and_failed_registrations_release_only_their_own_reservations() {
    let logins = Arc::new(PendingLogins::default());
    let first = (42, "mail".to_owned());
    let second = (43, "mail".to_owned());
    logins.submit(first.0, first.1.clone());
    logins.submit(second.0, second.1.clone());
    let mut batch = logins.take();
    batch.finish(&first, LoginOutcome::Registered);
    assert!(!logins.contains_installation(first.0));
    assert!(logins.contains_installation(second.0));
    assert!(logins.recently_registered(batch.revision, &first));
    assert!(!logins.recently_registered(batch.revision, &second));

    // A 409 during the registration must leave room for the old grant's revocation.
    batch.finish(&second, LoginOutcome::RetryRegistration);
    assert!(!logins.contains_installation(second.0));
    assert!(logins.next_ready().is_some());
}

#[test]
fn owner_change_discards_old_results_and_preserves_the_new_login() {
    let logins = Arc::new(PendingLogins::default());
    let key = (42, "mail".to_owned());
    let mut reconciler = Reconciler::new(logins.clone());
    let error = Err(AuthError("plugin_auth_backend_unavailable"));
    reconciler.record(0, key.clone(), error);
    logins.submit(key.0, key.1.clone());
    let mut old_batch = logins.take();
    logins.clear_owner();
    logins.submit(key.0, key.1.clone());
    old_batch.finish(&key, LoginOutcome::RetryDiscovery);
    reconciler.record(0, key.clone(), error);
    assert!(reconciler.next_retry().is_none());
    assert!(reconciler.retries.is_empty());
    let mut current = logins.take();
    assert!(current.contains(&key));
    current.finish(&key, LoginOutcome::Finished);
    assert!(logins.next_ready().is_none());
}

fn prepared(id: u64, slug: &str) -> PreparedPackage {
    PreparedPackage {
        installed_plugin_id: id,
        connector_slug: slug.into(),
        checksum: String::new(),
        auth_definition: Value::Null,
    }
}

#[tokio::test(start_paused = true)]
async fn connector_preparation_advances_while_its_sibling_registers() {
    let writing = Arc::new(tokio::sync::Notify::new());
    let sibling_ready = Arc::new(tokio::sync::Notify::new());
    let preparations = ["first", "second"].map(|slug| {
        let writing = writing.clone();
        let sibling_ready = sibling_ready.clone();
        async move {
            if slug == "second" {
                writing.notified().await;
                sibling_ready.notify_one();
            }
            ((42, slug.into()), prepared(42, slug), Ok(()))
        }
    });
    let register = |package: PreparedPackage| {
        let writing = writing.clone();
        let sibling_ready = sibling_ready.clone();
        async move {
            if package.connector_slug == "first" {
                writing.notify_one();
                sibling_ready.notified().await;
            }
            Ok(())
        }
    };
    let results = tokio::time::timeout(
        Duration::from_secs(1),
        register_ready_connectors(preparations.into_iter().collect(), register).collect::<Vec<_>>(),
    )
    .await
    .expect("sibling preparation must finish before the first write can return");
    assert_eq!(
        results,
        vec![
            ((42, "first".into()), Ok(())),
            ((42, "second".into()), Ok(()))
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn an_installation_waiting_on_background_does_not_take_the_foreground_slot() {
    let logins = Arc::new(PendingLogins::default());
    let occupied = logins.action_gate(0, 42).unwrap();
    let _background = occupied.lock().await;
    let lane = RegistrationLane {
        actions: Arc::new(Semaphore::new(1)),
        foreground: true,
        pending_logins: logins,
        revision: 0,
    };
    let transport = Transport(Arc::new(Mutex::new(VecDeque::from([(
        "plugin.auth.automatic",
        json!({"success":true,"migrations":[]}),
    )]))));
    let home = tempfile::tempdir().unwrap();
    let blocked = prepared(42, "mail");
    let waiting = lane.register(transport.clone(), home.path(), &blocked);
    tokio::pin!(waiting);
    assert!(futures_util::poll!(&mut waiting).is_pending());

    tokio::time::timeout(
        Duration::from_secs(1),
        lane.register(transport, home.path(), &prepared(43, "mail")),
    )
    .await
    .expect("a login for another installation must still get the foreground slot")
    .unwrap();
}

#[tokio::test(start_paused = true)]
async fn ordinary_capacity_wait_does_not_block_foreground_on_the_same_installation() {
    let logins = Arc::new(PendingLogins::default());
    let ordinary = RegistrationLane {
        actions: Arc::new(Semaphore::new(ORDINARY_CONCURRENCY)),
        foreground: false,
        pending_logins: logins.clone(),
        revision: 0,
    };
    let foreground = RegistrationLane {
        actions: Arc::new(Semaphore::new(1)),
        foreground: true,
        pending_logins: logins,
        revision: 0,
    };
    let _busy = ordinary
        .actions
        .acquire_many(ORDINARY_CONCURRENCY as u32)
        .await
        .unwrap();
    let transport = Transport(Arc::new(Mutex::new(VecDeque::from([(
        "plugin.auth.automatic",
        json!({"success":true,"migrations":[]}),
    )]))));
    let home = tempfile::tempdir().unwrap();
    let package = prepared(42, "mail");
    let waiting = ordinary.register(transport.clone(), home.path(), &package);
    tokio::pin!(waiting);
    assert!(futures_util::poll!(&mut waiting).is_pending());
    tokio::time::timeout(
        Duration::from_secs(1),
        foreground.register(transport, home.path(), &package),
    )
    .await
    .expect("the foreground write must not wait for unrelated ordinary writes")
    .unwrap();
}

#[tokio::test(start_paused = true)]
async fn a_new_connector_can_prepare_during_another_write_on_the_same_installation() {
    let logins = Arc::new(PendingLogins::default());
    let first = (42, "first".to_owned());
    let second = (42, "second".to_owned());
    logins.submit(first.0, first.1.clone());
    let mut active = logins.take();
    let gate = logins.action_gate(active.revision, first.0).unwrap();
    let first_write = gate.lock().await;

    logins.submit(second.0, second.1.clone());
    logins.submit(second.0, second.1.clone());
    assert!(logins.next_ready().is_some());
    let mut waiting = logins.take();
    assert_eq!(waiting.targets().collect::<Vec<_>>(), vec![&second]);
    assert_eq!(logins.take().targets().count(), 0);

    let calls = Arc::new(Mutex::new(VecDeque::from([(
        "plugin.auth.automatic",
        json!({"success":true,"migrations":[]}),
    )])));
    let lane = RegistrationLane {
        actions: Arc::new(Semaphore::new(1)),
        foreground: true,
        pending_logins: logins.clone(),
        revision: waiting.revision,
    };
    let home = tempfile::tempdir().unwrap();
    let (prepared_tx, prepared_rx) = tokio::sync::oneshot::channel();
    let key = second.clone();
    let preparations = [async move {
        let package = prepared(key.0, &key.1);
        prepared_tx.send(()).unwrap();
        (key, package, Ok(()))
    }];
    let registration = register_ready_connectors(preparations.into_iter().collect(), |package| {
        let lane = lane.clone();
        let transport = Transport(calls.clone());
        let home = home.path();
        async move { lane.register(transport, home, &package).await }
    });
    tokio::pin!(registration);
    let registration_result = registration.next();
    tokio::pin!(registration_result);
    tokio::select! {
        result = &mut registration_result => panic!("the second write crossed the gate: {result:?}"),
        observed = prepared_rx => observed.unwrap(),
        _ = tokio::time::sleep(Duration::from_secs(1)) => {
            panic!("the second connector did not prepare during the first write");
        }
    }
    assert!(futures_util::poll!(&mut registration_result).is_pending());
    assert_eq!(calls.lock().unwrap().len(), 1);
    drop(first_write);
    assert_eq!(registration_result.await, Some((second.clone(), Ok(()))));
    waiting.finish(&second, LoginOutcome::Registered);
    assert!(logins.contains_installation(first.0));
    active.finish(&first, LoginOutcome::Registered);
    assert!(!logins.contains_installation(first.0));
}

#[tokio::test]
async fn expired_intent_does_not_suppress_the_next_login() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir(home.path().join("capabilities")).unwrap();
    let root = home
        .path()
        .join("workbench/shared/plugins")
        .join("a".repeat(64));
    fs::create_dir_all(root.join(".codex-plugin")).unwrap();
    let definition = json!({"protocolVersion":1,"credentialType":"bearer","adapter":"auth.mjs"});
    fs::write(root.join("auth.mjs"), "// not executed").unwrap();
    fs::write(
        root.join(".codex-plugin/plugin.json"),
        json!({"connectors":[{
            "slug":"mail","accountAuth":definition
        }]})
        .to_string(),
    )
    .unwrap();
    let package = json!({"installed_plugin_id":42,"connector_slug":"mail",
        "checksum":format!("sha256:{}", "a".repeat(64)),"auth_definition":definition});
    fs::write(
        home.path().join("capabilities/manifest-v2.json"),
        json!({"plugins": {
            "mail": {"installed_plugin_id":42,"managed":true,"enabled":true,
                "checksum":package["checksum"],"store_path":root}
        }})
        .to_string(),
    )
    .unwrap();
    let intents = |id: &str| {
        json!({"success": true, "migrations": [{
            "id": id.repeat(64), "installed_plugin_id": 42, "connector_slug": "mail"
        }]})
    };
    let calls = Arc::new(Mutex::new(VecDeque::from([
        (
            "plugin.auth.automatic",
            json!({"success":true,"packages":[package.clone(),package.clone()]}),
        ),
        ("plugin.auth.automatic", intents("a")),
        (
            "plugin.auth.prepare",
            json!({"success": false, "error": "plugin_auth_migration_expired"}),
        ),
        (
            "plugin.auth.automatic",
            json!({"success":true,"packages":[package.clone()]}),
        ),
        ("plugin.auth.automatic", intents("b")),
        (
            "plugin.auth.prepare",
            json!({"success": false, "error": "plugin_auth_owner_unavailable"}),
        ),
        (
            "plugin.auth.automatic",
            json!({"success":true,"packages":[package]}),
        ),
    ])));
    let transport = Transport(calls.clone());
    let mut reconciler = Reconciler {
        retry_signal: None,
        ..Reconciler::default()
    };
    for _ in 0..3 {
        reconciler
            .reconcile(transport.clone(), home.path())
            .await
            .unwrap();
    }
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn claimed_intent_must_match_the_package_whose_runtime_was_prepared() {
    let home = tempfile::tempdir().unwrap();
    let original = json!({"installed_plugin_id":42,"connector_slug":"native",
        "checksum":format!("sha256:{}", "a".repeat(64)),
        "auth_definition":{"adapter":"auth.mjs"}});
    for field in ["checksum", "auth_definition"] {
        let mut changed = original.clone();
        changed[field] = if field == "checksum" {
            json!(format!("sha256:{}", "b".repeat(64)))
        } else {
            json!({"adapter":"new-python-auth.py"})
        };
        let calls = Arc::new(Mutex::new(VecDeque::from([(
            "plugin.auth.prepare",
            json!({"success":true,"operation":"export","package":changed}),
        )])));
        let expected = serde_json::from_value(original.clone()).unwrap();
        let result = migrate_prepared(
            Transport(calls.clone()),
            home.path(),
            &"a".repeat(64),
            &expected,
        )
        .await;
        // Reject before loading a replacement adapter or starting another wait.
        assert_eq!(
            result.err(),
            Some(AuthError("plugin_auth_definition_mismatch"))
        );
        assert!(calls.lock().unwrap().is_empty());
    }
}

#[test]
fn discovery_reads_explicit_relocated_manifest_without_legacy_home() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp
        .path()
        .join("workbench/wework/test/capabilities/manifest.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        json!({"plugins": {
            "mail": {"installed_plugin_id":42,"managed":true,"enabled":true}
        }})
        .to_string(),
    )
    .unwrap();
    assert_eq!(installed_ids_at(&path).unwrap(), vec![42]);
    assert!(!temp.path().join("capabilities").exists());
}

#[test]
fn discovery_only_reports_enabled_managed_installations() {
    let home = tempfile::tempdir().unwrap();
    assert!(installed_ids(home.path()).unwrap().is_empty());
    fs::create_dir(home.path().join("capabilities")).unwrap();
    fs::write(
        home.path().join("capabilities/manifest-v2.json"),
        json!({"plugins": {
            "managed": {"installed_plugin_id": 12, "managed": true, "enabled": true},
            "disabled": {"installed_plugin_id": 13, "managed": true, "enabled": false},
            "personal": {"installed_plugin_id": 14, "managed": false, "enabled": true},
            "duplicate": {"installed_plugin_id": 12, "managed": true, "enabled": true}
        }})
        .to_string(),
    )
    .unwrap();
    fs::write(
        home.path().join("capabilities/manifest.json"),
        json!({"plugins": {
            "stale": {"installed_plugin_id": 99, "managed": true, "enabled": true}
        }})
        .to_string(),
    )
    .unwrap();
    assert_eq!(installed_ids(home.path()).unwrap(), vec![12]);
}

#[test]
fn e2e_retry_signal_clears_cooldowns_only_when_it_changes() {
    let home = tempfile::tempdir().unwrap();
    let signal = home.path().join("retry.signal");
    let key = (12, "mail".to_owned());
    let mut reconciler = Reconciler {
        retries: HashMap::from([(key.clone(), Instant::now() + Duration::from_secs(60))]),
        retry_signal: Some(signal.clone()),
        ..Reconciler::default()
    };

    fs::write(&signal, "1").unwrap();
    reconciler.consume_retry_signal();
    assert!(reconciler.retries.is_empty());

    reconciler
        .retries
        .insert(key.clone(), Instant::now() + Duration::from_secs(60));
    reconciler.consume_retry_signal();
    assert!(reconciler.retries.contains_key(&key));

    fs::write(signal, "2").unwrap();
    reconciler.consume_retry_signal();
    assert!(reconciler.retries.is_empty());
}

#[cfg(unix)]
#[test]
fn discovery_rejects_symlinked_manifests() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir(home.path().join("capabilities")).unwrap();
    fs::write(home.path().join("untrusted.json"), r#"{"plugins":{}}"#).unwrap();
    std::os::unix::fs::symlink(
        home.path().join("untrusted.json"),
        home.path().join("capabilities/manifest-v2.json"),
    )
    .unwrap();
    assert_eq!(
        installed_ids(home.path()),
        Err(AuthError("plugin_auth_invalid_package"))
    );
}
#[test]
fn failures_back_off_and_login_invalidates_only_its_own_target() {
    let mut reconciler = Reconciler::default();
    let key = (42, "mail".to_owned());
    let other = (43, "mail".to_owned());
    reconciler.record(0, other.clone(), Ok(()));
    for seconds in [30, 60, 300, 300] {
        let before = Instant::now();
        reconciler.record(
            0,
            key.clone(),
            Err(AuthError("plugin_auth_owner_unavailable")),
        );
        let due = reconciler.next_retry().unwrap();
        assert!(due >= before + Duration::from_secs(seconds));
        assert!(due <= Instant::now() + Duration::from_secs(seconds));
    }
    reconciler.invalidate(42);
    assert!(reconciler.next_retry().is_none());
    assert!(reconciler.retries.contains_key(&other));
    reconciler.record(0, key, Ok(()));
    assert!(reconciler.next_retry().is_none());
}

#[tokio::test]
async fn unchanged_or_removed_inventory_does_not_rediscover_credentials() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir(home.path().join("capabilities")).unwrap();
    let path = home.path().join("capabilities/manifest-v2.json");
    let manifest =
        json!({"plugins":{"mail":{"installed_plugin_id":42,"managed":true,"enabled":true}}});
    fs::write(&path, manifest.to_string()).unwrap();
    let calls = Arc::new(Mutex::new(VecDeque::new()));
    let mut reconciler = Reconciler {
        inventory: installed_inventory(home.path()).unwrap(),
        ..Default::default()
    };
    reconciler
        .reconcile_changes(Transport(calls.clone()), home.path())
        .await
        .unwrap();
    fs::write(path, json!({"plugins":{}}).to_string()).unwrap();
    reconciler.record(
        0,
        (42, "mail".into()),
        Err(AuthError("plugin_auth_owner_unavailable")),
    );
    reconciler
        .reconcile_changes(Transport(calls.clone()), home.path())
        .await
        .unwrap();
    assert!(reconciler.next_retry().is_none());
    assert!(calls.lock().unwrap().is_empty());
}
