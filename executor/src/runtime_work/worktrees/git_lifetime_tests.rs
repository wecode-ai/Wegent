use super::*;
use std::time::Duration;

struct ReleaseOnDrop(PathBuf);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        let _ = fs::write(&self.0, "release");
    }
}

fn shell_path(path: &Path) -> String {
    format!(
        "'{}'",
        path.to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''")
    )
}

#[tokio::test]
async fn cleanup_waits_for_owned_git_on_exit_timeout_and_cancellation() {
    assert_git_cleanup_waits(false).await;
}

#[tokio::test]
async fn cleanup_waits_for_owned_git_in_nested_directories() {
    assert_git_cleanup_waits(true).await;
}

async fn assert_git_cleanup_waits(nested: bool) {
    for completion in ["exit", "timeout", "cancel"] {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        super::tests::initialize_repository(&source);
        let manager = WorktreeManager::new(root.path().join("runtime-work/worktrees.json"));
        manager
            .update_settings(WorktreeSettingsPatch {
                worktree_root: Some(root.path().join("managed").display().to_string()),
                ..Default::default()
            })
            .unwrap();
        let record = manager.prepare(&source, "task-1", None, false).unwrap();
        let path = PathBuf::from(&record.path);
        let ready = root.path().join("ready");
        let release = root.path().join("release");
        let _release_on_failure = ReleaseOnDrop(release.clone());
        let alias = format!(
            "alias.hold=!f() {{ printf ready > {}; while test ! -f {}; do sleep 0.01; done; }}; f",
            shell_path(&ready),
            shell_path(&release)
        );
        let query_path = if nested {
            path.join("nested/directory")
        } else {
            path.clone()
        };
        fs::create_dir_all(&query_path).unwrap();
        let query = tokio::spawn(async move {
            wegent_workspace::native_git::run_git_capture(
                &["-c".to_owned(), alias, "hold".to_owned()],
                Some(&query_path),
                &std::env::vars().collect(),
                Duration::from_secs(30),
                4096,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(10), async {
            while !ready.is_file() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Git did not reach its hold point");
        fs::remove_file(path.join(".git")).unwrap();
        let delete_path = path.clone();
        let (started, starting) = tokio::sync::oneshot::channel();
        let (finished, mut finishing) = tokio::sync::oneshot::channel();
        tokio::task::spawn_blocking(move || {
            let _ = started.send(());
            let _ = finished.send(manager.delete(&delete_path, false));
        });
        starting.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut finishing)
                .await
                .is_err(),
            "Deletion raced an executor-owned Git working directory ({completion})"
        );
        match completion {
            "exit" => {
                fs::write(&release, "release").unwrap();
                assert!(query.await.unwrap().unwrap().success);
            }
            "cancel" => {
                query.abort();
                assert!(query.await.unwrap_err().is_cancelled());
                fs::write(&release, "release").unwrap();
            }
            "timeout" => {
                tokio::time::pause();
                tokio::time::advance(Duration::from_secs(31)).await;
                tokio::time::resume();
                fs::write(&release, "release").unwrap();
                assert!(query.await.unwrap().unwrap_err().timed_out);
            }
            _ => unreachable!(),
        }
        tokio::time::timeout(Duration::from_secs(10), finishing)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(!path.exists());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cleanup_revalidates_parent_after_waiting_for_git() {
    assert_cleanup_revalidates_parent(false).await;
}

#[cfg(unix)]
#[tokio::test]
async fn cleanup_revalidates_managed_root_after_waiting_for_git() {
    assert_cleanup_revalidates_parent(true).await;
}

#[cfg(unix)]
async fn assert_cleanup_revalidates_parent(replace_root: bool) {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    super::tests::initialize_repository(&source);
    let manager = WorktreeManager::new(root.path().join("runtime-work/worktrees.json"));
    manager
        .update_settings(WorktreeSettingsPatch {
            worktree_root: Some(root.path().join("managed").display().to_string()),
            ..Default::default()
        })
        .unwrap();
    let record = manager.prepare(&source, "task-1", None, false).unwrap();
    let path = PathBuf::from(record.path);
    fs::remove_file(path.join(".git")).unwrap();
    let access = wegent_workspace::workspace_lifetime::use_directory(&path)
        .await
        .unwrap();
    let target = root.path().join("unrelated");
    let replaced = if replace_root {
        root.path().join("managed")
    } else {
        path.parent().unwrap().to_path_buf()
    };
    let victim = target.join(path.strip_prefix(&replaced).unwrap());
    fs::create_dir_all(&victim).unwrap();
    let sentinel = victim.join("preserve.txt");
    fs::write(&sentinel, "unrelated data").unwrap();
    let delete_path = path.clone();
    let (finished, mut finishing) = tokio::sync::oneshot::channel();
    tokio::task::spawn_blocking(move || {
        let _ = finished.send(manager.delete(&delete_path, false));
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut finishing)
            .await
            .is_err()
    );
    fs::rename(&replaced, replaced.with_extension("original")).unwrap();
    std::os::unix::fs::symlink(&target, &replaced).unwrap();
    drop(access);
    let result = tokio::time::timeout(Duration::from_secs(10), finishing)
        .await
        .unwrap()
        .unwrap();
    let expected = if replace_root {
        "path changed while waiting"
    } else {
        "outside managed roots"
    };
    assert!(result.unwrap_err().contains(expected));
    assert_eq!(fs::read_to_string(sentinel).unwrap(), "unrelated data");
}
