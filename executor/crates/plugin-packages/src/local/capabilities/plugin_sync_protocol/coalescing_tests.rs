// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn account_switch_discards_the_previous_equivalence_range() {
    let (_root, previous, _entered) = gated_fixture(false, &[]);
    previous.package_provider.fail.store(true, Ordering::SeqCst);
    let target = plugin("alpha", 1);
    let mut changed = target.clone();
    changed["version"] = json!("0.9.0");
    for (generation, spec) in [(90, changed), (100, target.clone())] {
        assert_eq!(
            previous
                .apply_sync(delta(generation, vec![spec], vec![]))
                .await
                .unwrap()["plugins"][0]["status"],
            "failed"
        );
    }
    let current = CapabilitySyncHandler::with_package_provider(
        "other-account",
        previous.store.clone(),
        Provider::default(),
        Arc::new(crate::NoRunningSessions),
    );
    let (first, second) = tokio::join!(
        current.apply_sync(delta(10, vec![target.clone()], vec![])),
        current.apply_sync(delta(9, vec![target], vec![])),
    );
    for result in [first, second] {
        assert_eq!(result.unwrap()["plugins"][0]["status"], "synced");
    }
    assert_eq!(current.package_provider.calls.load(Ordering::SeqCst), 1);
}

async fn shared_target(handler: &CapabilitySyncHandler<GatedPackages>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting =
                handler
                    .plugin_sync_inflight
                    .0
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(key, pending)| {
                        key.starts_with("target:") && Arc::strong_count(pending) >= 3
                    });
            if waiting {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("The duplicate did not join the same target publication");
}

#[tokio::test]
async fn http_and_socket_targets_share_publication_in_both_arrival_orders() {
    for shared in [false, true] {
        for (first_generation, second_generation) in [(10, 11), (11, 10)] {
            let (_root, handler, mut entered) = gated_fixture(shared, &["/alpha/new"]);
            let mut native = desired("alpha", "new");
            native["component_states"] = json!({"skills":{"alpha":true,"beta":false}});
            let first = start(&handler, delta(first_generation, vec![native], vec![]));
            assert_eq!(next_download(&mut entered).await, "/alpha/new");
            let mut socket = desired("alpha", "new");
            socket["download_path"] = json!("/alpha/new?signature=renewed");
            socket["componentStates"] = json!({"skills":{"beta":false,"alpha":true}});
            socket["checksum"] = json!(socket["checksum"]
                .as_str()
                .unwrap()
                .strip_prefix("sha256:")
                .unwrap()
                .to_uppercase());
            socket["source"] = json!({"marketplace":"wework"});
            let second = start(&handler, delta(second_generation, vec![socket], vec![]));
            shared_target(&handler).await;
            handler.package_provider.gates["/alpha/new"].add_permits(1);
            for (task, generation) in [(first, first_generation), (second, second_generation)] {
                let result = completed(task).await;
                assert_eq!(result["plugins"][0]["status"], "synced");
                assert_eq!(result["plugins"][0]["generation"], generation);
            }
            assert_eq!(handler.package_provider.calls.load(Ordering::SeqCst), 1);
            let manifest = handler.store.manifest.load().unwrap();
            assert_eq!(
                manifest["plugins"]["alpha@wework"]["plugin_sync_generation"],
                11
            );
            assert_eq!(
                manifest["plugin_sync"]["entries"]["alpha@wework"]["generation"],
                11
            );
            assert_eq!(
                manifest["plugin_sync"]["entries"]["alpha@wework"]["pending"],
                false
            );
        }
    }
}

#[tokio::test]
async fn a_full_snapshot_and_targeted_install_share_the_same_plugin_work() {
    let (_root, handler, mut entered) = gated_fixture(false, &["/alpha/new"]);
    let first = start(&handler, delta(10, vec![desired("alpha", "new")], vec![]));
    next_download(&mut entered).await;
    let second = start(
        &handler,
        complete(11, vec![desired("alpha", "new"), desired("beta", "new")]),
    );
    shared_target(&handler).await;
    assert_eq!(next_download(&mut entered).await, "/beta/new");
    handler.package_provider.gates["/alpha/new"].add_permits(1);
    assert_eq!(completed(first).await["plugins"][0]["status"], "synced");
    assert!(completed(second).await["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["status"] == "synced"));
    assert_eq!(handler.package_provider.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_renewed_path_retries_after_an_expired_shared_download() {
    for (first_generation, second_generation) in [(10, 11), (11, 10), (10, 10)] {
        let (_root, handler, mut entered) = gated_fixture(false, &["/alpha/new?expired"]);
        let mut expired = desired("alpha", "new");
        expired["download_path"] = json!("/alpha/new?expired");
        let first = start(&handler, delta(first_generation, vec![expired], vec![]));
        assert_eq!(next_download(&mut entered).await, "/alpha/new?expired");
        let second = start(
            &handler,
            delta(second_generation, vec![desired("alpha", "new")], vec![]),
        );
        shared_target(&handler).await;
        handler.package_provider.gates["/alpha/new?expired"].add_permits(1);
        let failed = completed(first).await;
        assert_eq!(failed["plugins"][0]["status"], "failed");
        assert_eq!(failed["plugins"][0]["stage"], "download");
        let renewed = completed(second).await;
        assert_eq!(renewed["plugins"][0]["status"], "synced");
        assert_eq!(renewed["plugins"][0]["generation"], second_generation);
        assert_eq!(handler.package_provider.calls.load(Ordering::SeqCst), 2);
        let manifest = handler.store.manifest.load().unwrap();
        assert_eq!(
            manifest["plugin_sync"]["entries"]["alpha@wework"]["generation"],
            first_generation.max(second_generation)
        );
        assert_eq!(
            manifest["plugin_sync"]["entries"]["alpha@wework"]["pending"],
            false
        );
    }
}

#[tokio::test]
async fn shared_failures_are_not_reported_as_success_and_a_later_request_can_retry() {
    let (_root, handler, mut entered) = gated_fixture(false, &["/alpha/new"]);
    handler.package_provider.fail.store(true, Ordering::SeqCst);
    let first = start(&handler, delta(10, vec![desired("alpha", "new")], vec![]));
    next_download(&mut entered).await;
    let second = start(&handler, delta(11, vec![desired("alpha", "new")], vec![]));
    shared_target(&handler).await;
    handler.package_provider.gates["/alpha/new"].add_permits(1);
    for task in [first, second] {
        assert_eq!(completed(task).await["plugins"][0]["status"], "failed");
    }
    assert_eq!(handler.package_provider.calls.load(Ordering::SeqCst), 1);
    assert!(handler.store.manifest.load().unwrap()["plugins"]
        .get("alpha@wework")
        .is_none());
    handler.package_provider.fail.store(false, Ordering::SeqCst);
    handler.package_provider.gates["/alpha/new"].add_permits(1);
    let retried = completed(start(
        &handler,
        delta(12, vec![desired("alpha", "new")], vec![]),
    ))
    .await;
    assert_eq!(retried["plugins"][0]["status"], "synced");
}

#[tokio::test]
async fn a_new_uninstall_supersedes_every_waiter_for_the_shared_install() {
    let (_root, handler, mut entered) = gated_fixture(false, &["/alpha/new"]);
    let first = start(&handler, delta(10, vec![desired("alpha", "new")], vec![]));
    next_download(&mut entered).await;
    let second = start(&handler, delta(11, vec![desired("alpha", "new")], vec![]));
    shared_target(&handler).await;
    let removed = start(&handler, delta(12, vec![], vec![desired("alpha", "new")]));
    until_manifest(&handler, |manifest| {
        manifest["plugin_sync"]["removals"]["1"]["generation"] == 12
    })
    .await;
    handler.package_provider.gates["/alpha/new"].add_permits(1);
    for task in [first, second] {
        assert_eq!(completed(task).await["plugins"][0]["status"], "superseded");
    }
    assert_eq!(completed(removed).await["plugins"][0]["status"], "removed");
    assert!(handler.store.manifest.load().unwrap()["plugins"]
        .get("alpha@wework")
        .is_none());
}

#[tokio::test]
async fn a_changed_target_breaks_equivalence_even_when_the_original_target_returns() {
    let (_root, handler, mut entered) = gated_fixture(false, &["/alpha/old"]);
    let first = start(&handler, delta(10, vec![desired("alpha", "old")], vec![]));
    next_download(&mut entered).await;
    let changed = start(&handler, delta(11, vec![desired("alpha", "new")], vec![]));
    until_manifest(&handler, |manifest| {
        manifest["plugin_sync"]["entries"]["alpha@wework"]["generation"] == 11
    })
    .await;
    let last = start(&handler, delta(12, vec![desired("alpha", "old")], vec![]));
    until_manifest(&handler, |manifest| {
        manifest["plugin_sync"]["entries"]["alpha@wework"]["generation"] == 12
    })
    .await;
    handler.package_provider.gates["/alpha/old"].add_permits(2);
    assert_eq!(completed(first).await["plugins"][0]["status"], "superseded");
    assert_eq!(
        completed(changed).await["plugins"][0]["status"],
        "superseded"
    );
    assert_eq!(completed(last).await["plugins"][0]["status"], "synced");
}

#[tokio::test]
async fn identity_enabled_and_component_changes_do_not_join_an_old_target() {
    for (field, value) in [
        ("installed_plugin_id", json!(4)),
        ("enabled", json!(false)),
        ("component_states", json!({"skills":{"alpha":false}})),
    ] {
        let (_root, handler, mut entered) = gated_fixture(false, &["/alpha/new"]);
        let first = start(&handler, delta(10, vec![desired("alpha", "new")], vec![]));
        next_download(&mut entered).await;
        let mut changed = desired("alpha", "new");
        changed[field] = value.clone();
        let second = start(&handler, delta(11, vec![changed], vec![]));
        until_manifest(&handler, |manifest| {
            manifest["plugin_sync"]["entries"]["alpha@wework"]["generation"] == 11
        })
        .await;
        handler.package_provider.gates["/alpha/new"].add_permits(2);
        assert_eq!(
            completed(first).await["plugins"][0]["status"],
            "superseded",
            "{field}"
        );
        assert_eq!(
            completed(second).await["plugins"][0]["status"],
            "synced",
            "{field}"
        );
        assert_eq!(
            handler.store.manifest.load().unwrap()["plugins"]["alpha@wework"][field],
            value
        );
    }
}

#[tokio::test]
async fn cancelling_the_shared_owner_never_confirms_installation() {
    let (_root, handler, mut entered) = gated_fixture(false, &["/alpha/new"]);
    let first = start(&handler, delta(10, vec![desired("alpha", "new")], vec![]));
    next_download(&mut entered).await;
    let second = start(&handler, delta(11, vec![desired("alpha", "new")], vec![]));
    shared_target(&handler).await;
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    let failure = tokio::time::timeout(Duration::from_secs(5), second)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(failure.to_string().contains("cancelled"));
    assert!(handler.store.manifest.load().unwrap()["plugins"]
        .get("alpha@wework")
        .is_none());
    handler.package_provider.gates["/alpha/new"].add_permits(2);
    let result = completed(start(
        &handler,
        delta(12, vec![desired("alpha", "new")], vec![]),
    ))
    .await;
    assert_eq!(result["plugins"][0]["status"], "synced");
}

#[tokio::test]
async fn a_reused_url_without_a_trusted_checksum_cannot_coalesce_generations() {
    let (_root, handler, mut entered) = gated_fixture(false, &["/alpha/new"]);
    let mut unverified = desired("alpha", "new");
    unverified.as_object_mut().unwrap().remove("checksum");
    let first = start(&handler, delta(10, vec![unverified.clone()], vec![]));
    next_download(&mut entered).await;
    let second = start(&handler, delta(11, vec![unverified], vec![]));
    until_manifest(&handler, |manifest| {
        manifest["plugin_sync"]["entries"]["alpha@wework"]["generation"] == 11
    })
    .await;
    handler.package_provider.gates["/alpha/new"].add_permits(2);
    assert_eq!(completed(first).await["plugins"][0]["status"], "superseded");
    assert_eq!(completed(second).await["plugins"][0]["status"], "synced");
    assert_eq!(handler.package_provider.calls.load(Ordering::SeqCst), 2);
}
