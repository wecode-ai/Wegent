// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};

use crate::local::native_git::LOCAL_GIT_ENV_KEYS;

const MAX_CAPTURE_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;
const GIT_CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) fn git_output_vec(
    workspace: &Path,
    args: Vec<String>,
    env: Option<&BTreeMap<String, String>>,
    input: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let run = git_output_async(
        Path::new("git"),
        workspace,
        args,
        env,
        input,
        GIT_CAPTURE_TIMEOUT,
    );
    match tokio::runtime::Handle::try_current() {
        // Production captures run in spawn_blocking, outside the async worker.
        Ok(handle) => handle.block_on(run),
        Err(_) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?
            .block_on(run),
    }
}

async fn git_output_async(
    program: &Path,
    workspace: &Path,
    args: Vec<String>,
    env: Option<&BTreeMap<String, String>>,
    input: Option<&[u8]>,
    deadline: Duration,
) -> Result<Vec<u8>, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut command = tokio::process::Command::new(program);
    crate::process::hide_windows_console(&mut command);
    for key in LOCAL_GIT_ENV_KEYS {
        command.env_remove(key);
    }
    command
        .args(["-c", "core.quotePath=false", "-C"])
        .arg(workspace);
    if args.first().map(String::as_str) == Some("diff") {
        // Stored patches must be applicable and match the parser's path format.
        command
            .args([
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--src-prefix=a/",
                "--dst-prefix=b/",
            ])
            .args(&args[1..]);
    } else {
        command.args(args);
    }
    if let Some(env) = env {
        // This explicit override points to the capture's temporary index.
        command.envs(env);
    }
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let capture = async {
        if let Some(input) = input {
            let mut stdin = child.stdin.take().expect("piped Git stdin");
            stdin
                .write_all(input)
                .await
                .map_err(|error| error.to_string())?;
        }
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .expect("piped Git stdout")
            .take(MAX_CAPTURE_OUTPUT_BYTES + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|error| error.to_string())?;
        if output.len() as u64 > MAX_CAPTURE_OUTPUT_BYTES {
            let _ = child.kill().await;
            return Err("Git capture output exceeds 8 MiB".to_owned());
        }
        let status = child.wait().await.map_err(|error| error.to_string())?;
        status
            .success()
            .then_some(output)
            .ok_or_else(|| "Git capture command failed".to_owned())
    };
    let result = tokio::time::timeout(deadline, capture)
        .await
        .unwrap_or_else(|_| Err("Git capture timed out".to_owned()));
    if result.is_err() {
        let _ = child.kill().await;
    }
    result
}

#[cfg(all(test, unix))]
mod capture_tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, process::Command};

    #[tokio::test]
    async fn capture_timeout_kills_and_reaps_blocked_git_process() {
        let root = tempfile::tempdir().unwrap();
        let fifo = root.path().join("blocked");
        assert!(Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let git = root.path().join("git");
        fs::write(&git, "#!/bin/sh\nprintf '%s' \"$$\" > \"$CAPTURE_TEST_PID\"\nexec /bin/cat \"$CAPTURE_TEST_FIFO\"\n").unwrap();
        fs::set_permissions(&git, fs::Permissions::from_mode(0o700)).unwrap();
        let pid_path = root.path().join("pid");
        let environment = BTreeMap::from([
            (
                "CAPTURE_TEST_PID".to_owned(),
                pid_path.display().to_string(),
            ),
            ("CAPTURE_TEST_FIFO".to_owned(), fifo.display().to_string()),
        ]);

        let result = git_output_async(
            &git,
            root.path(),
            vec![],
            Some(&environment),
            None,
            Duration::from_millis(250),
        )
        .await;

        assert_eq!(result.unwrap_err(), "Git capture timed out");
        let pid: i32 = fs::read_to_string(pid_path).unwrap().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    }
}
