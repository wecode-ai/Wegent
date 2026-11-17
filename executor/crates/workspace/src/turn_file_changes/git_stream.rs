// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, future::Future, path::Path, process::Stdio, time::Duration};

use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, ChildStdout, Command},
    task::JoinHandle,
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
pub(super) const BUFFER_BYTES: usize = 64 * 1024;

/// Only control replies and individual path tokens have an in-memory ceiling.
/// Patch and file-list contents never pass through this API.
pub(super) fn output(
    workspace: &Path,
    args: &[&str],
    env: Option<&BTreeMap<String, String>>,
) -> Result<Vec<u8>, String> {
    block_on(async {
        let mut process = GitStream::spawn(workspace, args, env)?;
        let mut output = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = process.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            if output.len() + count > BUFFER_BYTES {
                return Err("Git control reply exceeds 64 KiB".to_owned());
            }
            output.extend_from_slice(&buffer[..count]);
        }
        process.finish().await?;
        Ok(output)
    })
}

pub(super) fn block_on<T>(future: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(error)?
        .block_on(future)
}

pub(super) struct GitStream {
    child: Child,
    stdout: BufReader<ChildStdout>,
    stderr: Option<JoinHandle<Result<Vec<u8>, String>>>,
    guard: crate::process::ProcessTreeGuard,
    armed: bool,
}

impl GitStream {
    pub(super) fn diff(
        workspace: &Path,
        options: &[&str],
        before: &str,
        after: &str,
    ) -> Result<Self, String> {
        let mut args = vec!["diff"];
        args.extend_from_slice(options);
        args.extend([before, after]);
        Self::spawn_with_attributes(workspace, &args, None, Some(after))
    }

    pub(super) fn spawn(
        workspace: &Path,
        args: &[&str],
        env: Option<&BTreeMap<String, String>>,
    ) -> Result<Self, String> {
        Self::spawn_with_input(workspace, args, env, None, Stdio::null())
    }

    pub(super) fn with_input(
        workspace: &Path,
        args: &[&str],
        env: &BTreeMap<String, String>,
        input: std::fs::File,
    ) -> Result<Self, String> {
        Self::spawn_with_input(workspace, args, Some(env), None, Stdio::from(input))
    }

    fn spawn_with_attributes(
        workspace: &Path,
        args: &[&str],
        env: Option<&BTreeMap<String, String>>,
        attribute_tree: Option<&str>,
    ) -> Result<Self, String> {
        Self::spawn_with_input(workspace, args, env, attribute_tree, Stdio::null())
    }

    fn spawn_with_input(
        workspace: &Path,
        args: &[&str],
        env: Option<&BTreeMap<String, String>>,
        attribute_tree: Option<&str>,
        input: Stdio,
    ) -> Result<Self, String> {
        let mut command = Command::new("git");
        crate::process::hide_windows_console(&mut command);
        for key in crate::native_git::LOCAL_GIT_ENV_KEYS {
            command.env_remove(key);
        }
        command
            .args(["-c", "core.quotePath=false", "-C"])
            .arg(workspace);
        if let Some(index_directory) = env
            .and_then(|env| env.get("GIT_INDEX_FILE"))
            .and_then(|index| Path::new(index).parent())
        {
            // Internal index writes must not run the user's index hooks or
            // introduce unrelated edits into the captured working tree.
            command.args([
                "-c",
                &format!("core.hooksPath={}", index_directory.display()),
            ]);
        }
        if let Some(tree) = attribute_tree {
            // Git 2.41+ freezes repository attributes alongside the file trees.
            // Unsupported versions fail explicitly instead of reading live files.
            command.arg(format!("--attr-source={tree}"));
        }
        if args.first() == Some(&"diff") {
            command
                .args([
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    "--no-relative",
                    "--src-prefix=a/",
                    "--dst-prefix=b/",
                ])
                .args(&args[1..]);
        } else {
            command.args(args);
        }
        if let Some(env) = env {
            command.envs(env);
        }
        command
            .stdin(input)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            command.as_std_mut().process_group(0);
        }
        let mut child = command.spawn().map_err(error)?;
        let stdout = BufReader::with_capacity(
            BUFFER_BYTES,
            child.stdout.take().ok_or("missing Git stdout")?,
        );
        let mut stderr = child.stderr.take().ok_or("missing Git stderr")?;
        let drain = tokio::spawn(async move {
            let mut preview = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = stderr.read(&mut buffer).await.map_err(error)?;
                if count == 0 {
                    break;
                }
                let keep = count.min(4096 - preview.len());
                preview.extend_from_slice(&buffer[..keep]);
            }
            Ok(preview)
        });
        let guard = crate::process::ProcessTreeGuard::new(child.id());
        Ok(Self {
            child,
            stdout,
            stderr: Some(drain),
            guard,
            armed: true,
        })
    }

    pub(super) async fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        tokio::time::timeout(IDLE_TIMEOUT, self.stdout.read(buffer))
            .await
            .map_err(|_| "Git output stalled for 300s".to_owned())?
            .map_err(error)
    }

    pub(super) async fn token(&mut self) -> Result<Option<Vec<u8>>, String> {
        let mut token = Vec::new();
        loop {
            let available = tokio::time::timeout(IDLE_TIMEOUT, self.stdout.fill_buf())
                .await
                .map_err(|_| "Git metadata stalled for 300s".to_owned())?
                .map_err(error)?;
            if available.is_empty() {
                return if token.is_empty() {
                    Ok(None)
                } else {
                    Err("Incomplete Git metadata token".to_owned())
                };
            }
            let end = available.iter().position(|byte| *byte == 0);
            let count = end.unwrap_or(available.len());
            if token.len() + count > BUFFER_BYTES {
                return Err("Git metadata token exceeds 64 KiB".to_owned());
            }
            token.extend_from_slice(&available[..count]);
            self.stdout.consume(count + usize::from(end.is_some()));
            if end.is_some() {
                return Ok(Some(token));
            }
        }
    }

    pub(super) async fn finish(mut self) -> Result<(), String> {
        let status = tokio::time::timeout(IDLE_TIMEOUT, self.child.wait())
            .await
            .map_err(|_| "Git process stalled for 300s".to_owned())?
            .map_err(error)?;
        let stderr = tokio::time::timeout(
            IDLE_TIMEOUT,
            self.stderr.take().ok_or("missing Git stderr task")?,
        )
        .await
        .map_err(|_| "Git stderr did not close".to_owned())?
        .map_err(error)??;
        self.guard.disarm().map_err(error)?;
        self.armed = false;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "Git failed ({status}): {}",
                String::from_utf8_lossy(&stderr)
            ))
        }
    }
}

impl Drop for GitStream {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        self.guard.terminate();
        if let Some(task) = self.stderr.take() {
            task.abort();
        }
    }
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
