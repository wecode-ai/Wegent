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
        let query_path = path.clone();
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
