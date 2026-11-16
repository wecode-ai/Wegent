use super::*;
use crate::artifact_workspace::ArtifactQuery;
use sha2::{Digest, Sha256};

struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    workspace: PathBuf,
    outside: PathBuf,
    previous_home: Option<std::ffi::OsString>,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("executor");
        let workspace = temp.path().join("custom-worktree");
        let outside = temp.path().join("another-task");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(workspace.join("report.txt"), "original bytes").unwrap();
        fs::write(outside.join("report.txt"), "private bytes").unwrap();
        crate::artifact_workspace::bind_at(
            &home,
            &ExecutionRequest {
                task_id: "42".into(),
                subtask_id: "7".into(),
                ..Default::default()
            },
            "http-test-token",
            &workspace,
        )
        .unwrap();
        let previous_home = env::var_os("WEGENT_EXECUTOR_HOME");
        env::set_var("WEGENT_EXECUTOR_HOME", &home);
        Self {
            _temp: temp,
            home,
            workspace,
            outside,
            previous_home,
        }
    }

    fn query(&self) -> ArtifactQuery {
        ArtifactQuery {
            binding_id: format!("{:x}", Sha256::digest(b"http-test-token")),
            task_id: "42".into(),
            subtask_id: "7".into(),
            root_path: Some(self.workspace.canonicalize().unwrap().display().to_string()),
            path: Some("report.txt".into()),
            offset: None,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        match &self.previous_home {
            Some(value) => env::set_var("WEGENT_EXECUTOR_HOME", value),
            None => env::remove_var("WEGENT_EXECUTOR_HOME"),
        }
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn http_artifacts_reject_forged_existing_absolute_roots_and_wrong_task_identity() {
    let _lock = crate::test_env::lock();
    let fixture = Fixture::new();
    let runtime = runtime();
    let mut forged = fixture.query();
    forged.root_path = Some(
        fixture
            .outside
            .canonicalize()
            .unwrap()
            .display()
            .to_string(),
    );
    assert_eq!(
        runtime
            .block_on(download_workspace_artifact(Query(forged)))
            .unwrap_err()
            .status,
        StatusCode::FORBIDDEN
    );
    for (task_id, subtask_id) in [("43", "7"), ("42", "8")] {
        let mut query = fixture.query();
        query.task_id = task_id.into();
        query.subtask_id = subtask_id.into();
        assert_eq!(
            runtime
                .block_on(download_workspace_artifact(Query(query)))
                .unwrap_err()
                .status,
            StatusCode::FORBIDDEN
        );
    }
    let response = runtime
        .block_on(download_workspace_artifact(Query(fixture.query())))
        .unwrap();
    assert_eq!(
        runtime
            .block_on(axum::body::to_bytes(response.into_body(), 1024))
            .unwrap(),
        "original bytes"
    );
}

#[test]
fn http_workspace_metadata_and_download_survive_new_execution_binding() {
    let _lock = crate::test_env::lock();
    let fixture = Fixture::new();
    crate::artifact_workspace::bind_at(
        &fixture.home,
        &ExecutionRequest {
            task_id: "42".into(),
            subtask_id: "8".into(),
            ..Default::default()
        },
        "new-execution-token",
        &fixture.outside,
    )
    .unwrap();
    let runtime = runtime();
    let mut metadata = fixture.query();
    metadata.root_path = None;
    metadata.path = None;
    let response = runtime
        .block_on(download_workspace_artifact(Query(metadata)))
        .unwrap();
    let bytes = runtime
        .block_on(axum::body::to_bytes(response.into_body(), 8192))
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        body["workspace_root"],
        fixture
            .workspace
            .canonicalize()
            .unwrap()
            .display()
            .to_string()
    );
    let response = runtime
        .block_on(download_workspace_artifact(Query(fixture.query())))
        .unwrap();
    assert_eq!(
        runtime
            .block_on(axum::body::to_bytes(response.into_body(), 1024))
            .unwrap(),
        "original bytes"
    );
}

#[cfg(unix)]
#[test]
fn artifact_download_rejects_a_file_replaced_with_an_outside_symlink() {
    let _lock = crate::test_env::lock();
    let fixture = Fixture::new();
    let runtime = runtime();
    let original = runtime.block_on(download_workspace_artifact(Query(fixture.query())));
    let artifact = fixture.workspace.join("report.txt");
    fs::remove_file(&artifact).unwrap();
    std::os::unix::fs::symlink(fixture.outside.join("report.txt"), &artifact).unwrap();
    let replaced = runtime.block_on(download_workspace_artifact(Query(fixture.query())));
    assert!(original.is_ok());
    match replaced {
        Err(error) => assert_eq!(error.status, StatusCode::FORBIDDEN),
        Ok(_) => panic!("artifact download followed a symlink outside its original workspace"),
    }
}
