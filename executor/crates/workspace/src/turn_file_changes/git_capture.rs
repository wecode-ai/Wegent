// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};

use crate::native_git::LOCAL_GIT_ENV_KEYS;

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
    wait_for_capture(run)
}

fn wait_for_capture(
    run: impl std::future::Future<Output = Result<Vec<u8>, String>>,
) -> Result<Vec<u8>, String> {
    // This synchronous API runs outside async workers. A borrowed Handle cannot
    // drive a current-thread caller's I/O, so keep the capture driver independent.
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?
        .block_on(run)
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
    use std::{
        fs, future::Future, io::Write, os::unix::fs::OpenOptionsExt, process::Command, sync::mpsc,
    };

    fn gated_git(
        root: &Path,
        startup_delay: &str,
    ) -> (std::path::PathBuf, BTreeMap<String, String>) {
        let fifo = root.join("blocked");
        assert!(Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        // Parallel forks can retain a newly written executable's writer until exec.
        let git =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/git-capture-blocked.sh");
        let environment = BTreeMap::from([
            (
                "CAPTURE_TEST_PID".to_owned(),
                root.join("pid").display().to_string(),
            ),
            ("CAPTURE_TEST_FIFO".to_owned(), fifo.display().to_string()),
            (
                "CAPTURE_TEST_STARTUP_DELAY".to_owned(),
                startup_delay.to_owned(),
            ),
        ]);
        (git, environment)
    }

    #[test]
    fn synchronous_capture_drives_io_without_polling_the_callers_runtime() {
        assert_synchronous_capture_is_independent("0");
    }

    #[test]
    fn synchronous_capture_separates_slow_startup_from_io_independence() {
        assert_synchronous_capture_is_independent("2.1");
    }

    fn assert_synchronous_capture_is_independent(startup_delay: &str) {
        let root = tempfile::tempdir().unwrap();
        let (git, environment) = gated_git(root.path(), startup_delay);
        let workspace = root.path().to_owned();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (sender, receiver) = mpsc::channel();
        let (pending_sender, pending_receiver) = mpsc::channel();
        let completed_without_driver = runtime.block_on(async {
            let worker = tokio::task::spawn_blocking(move || {
                let run = git_output_async(
                    &git,
                    &workspace,
                    vec![],
                    Some(&environment),
                    None,
                    Duration::from_secs(10),
                );
                let mut run = std::pin::pin!(run);
                let mut pending_sender = Some(pending_sender);
                let observed = std::future::poll_fn(|cx| {
                    let result = run.as_mut().poll(cx);
                    if result.is_pending() {
                        if let Some(sender) = pending_sender.take() {
                            let _ = sender.send(());
                        }
                    }
                    result
                });
                let result = wait_for_capture(observed);
                // The observer may have timed out; preserve its failure diagnostic.
                let _ = sender.send(result);
            });
            let result = observe_independent_capture(
                &root.path().join("blocked"),
                pending_receiver,
                receiver,
            );
            // Resume the caller before asserting, so even the broken implementation
            // can clean up its OS child and blocking worker without hanging teardown.
            worker.await.unwrap();
            result
        });
        assert_eq!(
            completed_without_driver
                .expect("Synchronous capture must drive I/O without its caller")
                .unwrap(),
            b"captured"
        );
    }

    fn observe_independent_capture(
        fifo: &Path,
        pending: mpsc::Receiver<()>,
        result: mpsc::Receiver<Result<Vec<u8>, String>>,
    ) -> Result<Result<Vec<u8>, String>, String> {
        pending
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| format!("Capture did not reach I/O wait: {error}"))?;
        let started = std::time::Instant::now();
        let mut writer = loop {
            match fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(fifo)
            {
                Ok(writer) => break writer,
                Err(error) if error.raw_os_error() == Some(libc::ENXIO) => {
                    if started.elapsed() >= Duration::from_secs(5) {
                        return Err("Git child did not become ready".to_owned());
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(format!("Git child readiness failed: {error}")),
            }
        };
        // Both the real child and the capture's pending I/O are ready. Keep the
        // parent reactor unpolled while releasing output, without charging OS
        // process startup to the original two-second independence assertion.
        writer
            .write_all(b"captured")
            .map_err(|error| error.to_string())?;
        drop(writer);
        result
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| format!("Ready capture depended on its caller's driver: {error}"))
    }

    async fn wait_for_child_pid(path: &Path) -> i32 {
        let started = std::time::Instant::now();
        loop {
            match fs::read_to_string(path) {
                Ok(contents) => {
                    if let Some(pid) = contents.strip_suffix('\n') {
                        return pid.parse().expect("valid child PID");
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("failed to read child PID: {error}"),
            }
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "Git test process did not report its PID"
            );
            // Keep work runnable so paused time cannot advance before the OS child is ready.
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn capture_timeout_kills_and_reaps_blocked_git_process() {
        let root = tempfile::tempdir().unwrap();
        let (git, environment) = gated_git(root.path(), "0");
        let pid_path = root.path().join("pid");

        let deadline = Duration::from_millis(250);
        let capture = git_output_async(
            &git,
            root.path(),
            vec![],
            Some(&environment),
            None,
            deadline,
        );
        tokio::pin!(capture);
        let pid = tokio::select! {
            pid = wait_for_child_pid(&pid_path) => pid,
            result = &mut capture => panic!("capture ended before the child was ready: {result:?}"),
        };

        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        tokio::time::advance(deadline).await;
        assert_eq!(capture.await.unwrap_err(), "Git capture timed out");
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
}
