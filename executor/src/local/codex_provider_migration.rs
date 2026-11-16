// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Target-owned offline upgrade entry. It exits before the managed executor and
//! its Goal recovery scheduler are started; no account credentials are opened.

use std::{
    fs,
    path::{Path, PathBuf},
};

use fs2::FileExt;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::file_lease::FileLease;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    codex_home: PathBuf,
    agents_root: PathBuf,
    #[serde(default)]
    wait_for_writers: bool,
}

pub fn run(input: &str) -> Result<Value, String> {
    let request: Request =
        serde_json::from_str(input).map_err(|_| "Invalid Codex provider migration request")?;
    for root in [&request.codex_home, &request.agents_root] {
        if !root.is_absolute()
            || root
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err("Codex provider migration requires absolute owned Home paths".into());
        }
    }
    let mut homes = Vec::new();
    if request.codex_home.try_exists().map_err(|e| e.to_string())? {
        homes.push(request.codex_home);
    }
    if request
        .agents_root
        .try_exists()
        .map_err(|e| e.to_string())?
    {
        if fs::symlink_metadata(&request.agents_root)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Agent migration root must not be a symlink".into());
        }
        homes.extend(crate::agents::agent_homes(&request.agents_root)?);
    }
    homes.sort();
    homes.dedup();
    let mut checked = 0;
    for home in homes {
        // Claude-only Homes and new empty Homes have no Codex state to migrate.
        if !has_codex_history(&home)? {
            continue;
        }
        let _execution = acquire_execution(&home, request.wait_for_writers)?;
        crate::agents::prepare_provider_migration(&home, request.wait_for_writers)?;
        checked += 1;
    }
    Ok(json!({"codex_provider_migration":1, "complete":true, "checked_homes":checked}))
}

fn has_codex_history(home: &Path) -> Result<bool, String> {
    if home
        .join("sessions")
        .try_exists()
        .map_err(|e| e.to_string())?
        || home
            .join("archived_sessions")
            .try_exists()
            .map_err(|e| e.to_string())?
        || home
            .join(".wework-provider-migration.json")
            .try_exists()
            .map_err(|e| e.to_string())?
    {
        return Ok(true);
    }
    for entry in fs::read_dir(home).map_err(|e| e.to_string())? {
        let name = entry.map_err(|e| e.to_string())?.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("state_") && name.ends_with(".sqlite") {
            return Ok(true);
        }
    }
    Ok(false)
}

fn acquire_execution(home: &Path, wait_for_writers: bool) -> Result<FileLease, String> {
    let path = home.join(".execution.lock");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => Some(metadata),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if metadata.is_some_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink()) {
        return Err("Invalid native Home execution lease".into());
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())?;
    (if wait_for_writers {
        FileExt::lock_exclusive(&file)
    } else {
        file.try_lock_exclusive()
    })
    .map_err(|_| "Codex migration is waiting for an active Agent execution")?;
    Ok(FileLease(file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopped_wait_mode_waits_for_the_existing_execution_lease_without_rewriting_early() {
        use std::{sync::mpsc, thread, time::Duration};
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("codex");
        fs::create_dir_all(home.join("sessions")).unwrap();
        let writer = acquire_execution(&home, false).unwrap();
        let path = home.join("sessions/rollout-00000000-0000-4000-8000-000000000001.jsonl");
        let before = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"00000000-0000-4000-8000-000000000001\",\"model_provider\":\"old\"}}\n";
        fs::write(&path, before).unwrap();
        let input = json!({"codex_home":home,"agents_root":root.path().join("agents"),"wait_for_writers":true}).to_string();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let preparation = thread::spawn(move || {
            started_tx.send(()).unwrap();
            done_tx.send(run(&input)).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        drop(writer);
        assert_eq!(
            done_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap()["complete"],
            true
        );
        preparation.join().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(fs::read_to_string(path).unwrap().trim()).unwrap()
                ["payload"]["model_provider"],
            "~"
        );
    }

    #[test]
    fn absent_execution_lock_is_created_and_held_until_migration_exits() {
        let root = tempfile::tempdir().unwrap();
        let lease = acquire_execution(root.path(), false).unwrap();
        assert!(root.path().join(".execution.lock").is_file());
        assert!(acquire_execution(root.path(), false).is_err());
        drop(lease);
        acquire_execution(root.path(), false).unwrap();
    }

    #[test]
    fn fresh_install_and_claude_only_homes_do_not_create_codex_state() {
        let root = tempfile::tempdir().unwrap();
        let input = json!({"codex_home":root.path().join("codex"),"agents_root":root.path().join("agents")}).to_string();
        assert_eq!(run(&input).unwrap()["checked_homes"], 0);
        assert!(!root.path().join("codex").exists());
        let agent = root.path().join("agents/u/n/a");
        fs::create_dir_all(&agent).unwrap();
        fs::write(agent.join("config.json"), "{}").unwrap();
        assert_eq!(run(&input).unwrap()["checked_homes"], 0);
        assert!(!agent.join(".wework-provider-migration.json").exists());
    }

    #[test]
    fn active_agent_execution_blocks_upgrade_before_any_session_rewrite() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("codex");
        fs::create_dir_all(home.join("sessions")).unwrap();
        let file = fs::File::create(home.join(".execution.lock")).unwrap();
        file.try_lock_exclusive().unwrap();
        let input = json!({"codex_home":home,"agents_root":root.path().join("agents")}).to_string();
        assert!(run(&input).unwrap_err().contains("active Agent execution"));
        assert!(!home.join(".wework-provider-migration.json").exists());
        drop(file);
        assert_eq!(run(&input).unwrap()["complete"], true);
    }
}
