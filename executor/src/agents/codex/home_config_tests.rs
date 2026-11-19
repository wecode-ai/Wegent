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

#[test]
fn normalization_defaults_to_six_subagents_and_preserves_user_limits() {
    use toml_edit::DocumentMut;

    for (config, expected) in [
        ("", 6),
        ("agents = {}\n", 6),
        (
            "[features.multi_agent_v2]\nmax_concurrent_threads_per_session = 12\n",
            6,
        ),
        ("[agents]\nmax_concurrent_threads_per_session = 10\n", 10),
        ("[agents]\nmax_threads = 2\n", 2),
    ] {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("config.toml");
        fs::write(&path, config).unwrap();
        normalize_wework_codex_config(home.path()).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        let document = content.parse::<DocumentMut>().unwrap();
        let agents = &document["agents"];
        let limit = agents
            .get("max_concurrent_threads_per_session")
            .or_else(|| agents.get("max_threads"))
            .unwrap();
        assert_eq!(limit.as_integer(), Some(expected));
        normalize_wework_codex_config(home.path()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
    }

    for config in ["agents = false\n", "agents = 4\n", "agents = []\n"] {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("config.toml");
        fs::write(&path, config).unwrap();
        normalize_wework_codex_config(home.path()).unwrap();
        let updated = fs::read_to_string(&path)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        let original = config.parse::<DocumentMut>().unwrap();
        assert_eq!(
            updated["agents"].to_string(),
            original["agents"].to_string()
        );
    }

    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("config.toml");
    fs::write(&path, "[features.multi_agent_v2]\nmax_concurrent_threads_per_session = 12\n[agents]\nmax_concurrent_threads_per_session = 9\n").unwrap();
    normalize_wework_codex_config(home.path()).unwrap();
    let updated = fs::read_to_string(&path)
        .unwrap()
        .parse::<DocumentMut>()
        .unwrap();
    assert_eq!(
        updated["agents"]["max_concurrent_threads_per_session"].as_integer(),
        Some(9)
    );
    assert_eq!(
        updated["features"]["multi_agent_v2"]["max_concurrent_threads_per_session"].as_integer(),
        Some(12)
    );
}
