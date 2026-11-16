//! Check downloaded bytes before the archive extractor can mutate runtime state.
use super::{
    archive::{restore_runtime_archive_with_roots, ArchiveError, ArchiveMode, RestoreResult},
    archive_sessions::SessionArchiveRoots,
};
use sha2::{Digest, Sha256};
use std::path::Path;

pub(crate) struct RestorePaths<'a> {
    pub mode: ArchiveMode,
    pub task: &'a str,
    pub workspace: &'a Path,
    pub home: &'a Path,
    pub roots: &'a SessionArchiveRoots,
}

pub(crate) fn restore_checked(
    bytes: &[u8],
    expected_sha256: Option<&str>,
    paths: RestorePaths<'_>,
) -> Result<(RestoreResult, Option<String>), ArchiveError> {
    let verified = expected_sha256
        .map(|expected| {
            let actual = format!("{:x}", Sha256::digest(bytes));
            if expected.len() != 64
                || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !actual.eq_ignore_ascii_case(expected)
            {
                return Err(ArchiveError::IntegrityMismatch);
            }
            Ok(actual)
        })
        .transpose()?;
    let result = restore_runtime_archive_with_roots(
        bytes,
        paths.mode,
        paths.task,
        paths.workspace,
        paths.home,
        paths.roots,
    )?;
    Ok((result, verified))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envd::archive::{create_runtime_archive, ArchiveOptions};
    use std::fs;

    #[test]
    fn active_agent_home_prevents_restore_before_workspace_overwrite() {
        let source = tempfile::tempdir().unwrap();
        let workspace = source.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("user.txt"), "archived").unwrap();
        let archive = create_runtime_archive(ArchiveOptions {
            mode: ArchiveMode::Executor,
            task_id: "42".into(),
            workspace_path: workspace,
            home_path: source.path().join("home"),
            max_size_bytes: 1_000_000,
        })
        .unwrap();
        let target = tempfile::tempdir().unwrap();
        let workspace = target.path().join("workspace");
        let home = target.path().join("home");
        let roots = SessionArchiveRoots::for_home(&home);
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("user.txt"), "current").unwrap();
        let agent = roots.workbench.join("agents/realm/user/agent");
        fs::create_dir_all(agent.join("runtime/tasks")).unwrap();
        fs::write(agent.join("runtime/tasks/42.json"), "{}").unwrap();
        let held = fs::File::create(agent.join(".execution.lock")).unwrap();
        fs2::FileExt::lock_exclusive(&held).unwrap();
        let paths = || RestorePaths {
            mode: ArchiveMode::Executor,
            task: "42",
            workspace: &workspace,
            home: &home,
            roots: &roots,
        };
        assert!(restore_checked(&archive.bytes, Some(&archive.receipt.sha256), paths()).is_err());
        assert_eq!(
            fs::read_to_string(workspace.join("user.txt")).unwrap(),
            "current"
        );
        drop(held);
        assert!(
            restore_checked(&archive.bytes, Some(&archive.receipt.sha256), paths())
                .unwrap()
                .0
                .success
        );
        assert_eq!(
            fs::read_to_string(workspace.join("user.txt")).unwrap(),
            "archived"
        );
    }

    #[test]
    fn verified_restore_reports_the_actual_bot_sessions_after_source_home_is_deleted() {
        let source = tempfile::tempdir().unwrap();
        let workspace = source.path().join("workspace");
        let home = source.path().join("home");
        let roots = SessionArchiveRoots::for_home(&home);
        fs::create_dir_all(&workspace).unwrap();
        let markers = roots.executor.join("sessions/42");
        let sessions = roots.codex.join("sessions");
        fs::create_dir_all(&markers).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        for (bot, id) in [(23, "original-thread"), (24, "peer-thread")] {
            fs::write(markers.join(format!(".codex_thread_id_{bot}")), id).unwrap();
            fs::write(
                sessions.join(format!("rollout-test-{id}.jsonl")),
                format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\"}}}}\n"),
            )
            .unwrap();
        }
        let archive = create_runtime_archive(ArchiveOptions {
            mode: ArchiveMode::Executor,
            task_id: "42".into(),
            workspace_path: workspace,
            home_path: home.clone(),
            max_size_bytes: 1_000_000,
        })
        .unwrap();
        fs::remove_dir_all(&home).unwrap();
        let target = tempfile::tempdir().unwrap();
        let home = target.path().join("home");
        let roots = SessionArchiveRoots::for_home(&home);
        let (result, digest) = restore_checked(
            &archive.bytes,
            Some(&archive.receipt.sha256),
            RestorePaths {
                mode: ArchiveMode::Executor,
                task: "42",
                workspace: &target.path().join("workspace"),
                home: &home,
                roots: &roots,
            },
        )
        .unwrap();
        assert!(result.session_restored);
        assert_eq!(digest.as_deref(), Some(archive.receipt.sha256.as_str()));
        assert_eq!(
            result.restored_sessions.len(),
            archive.receipt.sessions.len()
        );
        for expected in &archive.receipt.sessions {
            assert!(result.restored_sessions.contains(expected));
        }
    }

    #[test]
    fn invalid_or_changed_downloads_cannot_overwrite_existing_workspace_or_session_state() {
        let source = tempfile::tempdir().unwrap();
        let workspace = source.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("user.txt"), "archived content").unwrap();
        let archive = create_runtime_archive(ArchiveOptions {
            mode: ArchiveMode::Executor,
            task_id: "42".into(),
            workspace_path: workspace,
            home_path: source.path().join("home"),
            max_size_bytes: 1_000_000,
        })
        .unwrap();
        let target = tempfile::tempdir().unwrap();
        let workspace = target.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("user.txt"), "current content").unwrap();
        let home = target.path().join("home");
        let roots = SessionArchiveRoots::for_home(&home);
        let restore = |bytes: &[u8], expected: &str| {
            restore_checked(
                bytes,
                Some(expected),
                RestorePaths {
                    mode: ArchiveMode::Executor,
                    task: "42",
                    workspace: &workspace,
                    home: &home,
                    roots: &roots,
                },
            )
        };
        let mut changed = archive.bytes.clone();
        *changed.last_mut().unwrap() ^= 1;
        for (bytes, digest) in [
            (&archive.bytes, "invalid"),
            (&changed, archive.receipt.sha256.as_str()),
        ] {
            assert!(matches!(
                restore(bytes, digest),
                Err(ArchiveError::IntegrityMismatch)
            ));
            assert_eq!(
                fs::read_to_string(workspace.join("user.txt")).unwrap(),
                "current content"
            );
            assert!(!roots.executor.exists());
        }
        let (result, verified) =
            restore(&archive.bytes, &archive.receipt.sha256.to_uppercase()).unwrap();
        assert!(result.success);
        assert_eq!(verified.as_deref(), Some(archive.receipt.sha256.as_str()));
        assert_eq!(
            fs::read_to_string(workspace.join("user.txt")).unwrap(),
            "archived content"
        );
    }
}
