// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use crate::{agents::git_workspace::prepare_git_workspace, protocol::ExecutionRequest};

struct RestoreEnvironment(Vec<(&'static str, Option<OsString>)>);

impl RestoreEnvironment {
    fn isolate(root: &Path) -> Self {
        let keys = [
            "HOME",
            "USERPROFILE",
            "WEGENT_WORKBENCH_HOME",
            "WEGENT_EXECUTOR_HOME",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_NOSYSTEM",
            "GIT_SSH",
            "GIT_SSH_COMMAND",
            "GIT_SSH_VARIANT",
            "DEVICE_TYPE",
        ];
        let guard = Self(
            keys.into_iter()
                .map(|key| {
                    let old = env::var_os(key);
                    env::remove_var(key);
                    (key, old)
                })
                .collect(),
        );
        for key in &keys[..4] {
            env::set_var(key, root);
        }
        env::set_var("GIT_CONFIG_NOSYSTEM", "1");
        env::set_var("DEVICE_TYPE", "local");
        guard
    }
}

impl Drop for RestoreEnvironment {
    fn drop(&mut self) {
        for (key, value) in &self.0 {
            match value {
                Some(value) => env::set_var(key, value),
                None => env::remove_var(key),
            }
        }
    }
}

fn git(args: &[&str], root: &Path) {
    let mut command = Command::new("git");
    super::super::native_git::clear_local_git_env(&mut command);
    let output = command.args(args).current_dir(root).output().unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn configure_transport(root: &Path) -> PathBuf {
    let source = root.join("source");
    fs::create_dir(&source).unwrap();
    git(&["init"], &source);
    fs::write(source.join("fixture.txt"), "native SSH transport").unwrap();
    git(&["add", "fixture.txt"], &source);
    git(
        &[
            "-c",
            "user.name=SSH fixture",
            "-c",
            "user.email=ssh@example.test",
            "commit",
            "-m",
            "test: seed repository",
        ],
        &source,
    );
    let wrapper = root.join("ssh transport.sh");
    fs::write(
        &wrapper,
        // Git may probe variants with -G. Only real SSH requests serve upload-pack.
        r#"set -eu
test "$1" = "--fixture-key"
shift
source=$1
log=$2
shift 2
for arg in "$@"; do
  test "$arg" != "-G" || exit 1
done
printf '%s\n' "$*" >> "$log"
exec git-upload-pack "$source"
"#,
    )
    .unwrap();
    let config = root.join("native.gitconfig");
    let ssh_command = format!(
        "sh '{}' --fixture-key '{}' '{}'",
        wrapper.display(),
        source.display(),
        root.join("ssh-invocations.log").display()
    );
    git(
        &[
            "config",
            "--file",
            config.to_str().unwrap(),
            "core.sshCommand",
            &ssh_command,
        ],
        root,
    );
    env::set_var("GIT_CONFIG_GLOBAL", &config);
    config
}

#[test]
fn core_ssh_command_is_used_by_standalone_and_task_clones() {
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _environment = RestoreEnvironment::isolate(root.path());
    let config = configure_transport(root.path());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let url = "git@native-ssh.invalid:fixture.git";
        let standalone = root.path().join("standalone");
        let result = super::execute_clone(
            &[url.into(), standalone.display().to_string()],
            &HashMap::from([("GIT_CONFIG_GLOBAL".into(), config.display().to_string())]),
            10.0,
            4096,
        )
        .await;
        assert!(result.success, "{:?}", result.error);
        let task = root.path().join("task");
        let request = ExecutionRequest {
            task_id: "native-ssh-fixture".into(),
            project_workspace_path: Some(task.display().to_string()),
            extra: serde_json::Map::from_iter([("git_url".into(), serde_json::json!(url))]),
            ..ExecutionRequest::default()
        };
        let prepared = prepare_git_workspace(request).await.unwrap();
        assert_eq!(prepared.project_workspace_path.as_deref(), task.to_str());
        for checkout in [standalone, task] {
            assert!(checkout.join(".git").is_dir());
            assert_eq!(
                fs::read_to_string(checkout.join("fixture.txt")).unwrap(),
                "native SSH transport"
            );
        }
        let calls = fs::read_to_string(root.path().join("ssh-invocations.log")).unwrap();
        assert_eq!(
            calls.lines().count(),
            4,
            "both preflights and clones use SSH"
        );
    });
}
