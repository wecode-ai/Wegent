// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::{sync::mpsc, time::Duration};

#[test]
fn normalization_waits_for_plugin_configuration_publication() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().to_path_buf();
    let publication = crate::local::personal_marketplace_lock::acquire_personal_marketplace_lock(
        &home.join("plugins/cache/wework-personal"),
    )
    .unwrap();
    let (started, starting) = mpsc::channel();
    let (finished, completion) = mpsc::channel();
    let worker_home = home.clone();
    let worker = std::thread::spawn(move || {
        started.send(()).unwrap();
        let result = normalize_wework_codex_config(&worker_home);
        finished.send(result).unwrap();
    });
    starting.recv_timeout(Duration::from_secs(5)).unwrap();
    let premature = completion.recv_timeout(Duration::from_millis(100));
    fs::write(
        home.join("config.toml"),
        "[plugins.'python@wework-personal']\nenabled = true\n",
    )
    .unwrap();
    drop(publication);
    worker.join().unwrap();
    assert!(
        premature.is_err(),
        "Normalization bypassed plugin publication"
    );
    completion
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    let config = fs::read_to_string(home.join("config.toml")).unwrap();
    assert!(config.contains("python@wework-personal"));
    assert!(config.contains("pragmatic"));
}
