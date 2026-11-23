// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use tokio::io::AsyncReadExt;

const MARKETPLACE_COMMAND_TIMEOUT: Duration = Duration::from_secs(45);

impl CodexAppServerClient {
    /// Read the resolved Git catalog with the bundled CLI and an empty profile.
    /// The native marketplace upgrade RPC also rewrites installed plugin caches.
    pub(crate) async fn read_git_marketplace_versions(
        &self,
        name: &str,
        source: &str,
        git_ref: Option<&str>,
        sparse_paths: &[String],
    ) -> Result<Vec<Value>, String> {
        let preview = tempfile::tempdir().map_err(|error| error.to_string())?;
        let proxy = self.state.lock().await.runtime_proxy_env.clone();
        let mut add = self.marketplace_preview_command(preview.path(), &proxy);
        add.args(["plugin", "marketplace", "add", "--json"]);
        if let Some(reference) = git_ref {
            add.args(["--ref", reference]);
        }
        for sparse_path in sparse_paths {
            add.args(["--sparse", sparse_path]);
        }
        add.args(["--", source]);
        let added = run_catalog_command(add, "fetch", MARKETPLACE_COMMAND_TIMEOUT).await?;
        if added["marketplaceName"].as_str() != Some(name) {
            return Err("The configured Git source returned a different marketplace name".into());
        }

        let mut list = self.marketplace_preview_command(preview.path(), &proxy);
        list.args([
            "plugin",
            "list",
            "--available",
            "--json",
            "--marketplace",
            name,
        ]);
        let catalog = run_catalog_command(list, "list", MARKETPLACE_COMMAND_TIMEOUT).await?;
        let versions = catalog["available"]
            .as_array()
            .ok_or_else(|| "Codex returned an invalid marketplace catalog".to_owned())?
            .iter()
            .filter(|plugin| {
                plugin["marketplaceName"].as_str() == Some(name)
                    && plugin["marketplaceSource"]["sourceType"] == "git"
            })
            .filter_map(|plugin| {
                Some(json!({
                    "pluginName": plugin["name"].as_str()?,
                    "version": plugin["version"].as_str(),
                }))
            })
            .collect();
        Ok(versions)
    }

    fn marketplace_preview_command(
        &self,
        preview: &Path,
        proxy: &BTreeMap<String, String>,
    ) -> Command {
        let mut command = Command::new(&self.binary);
        for key in EXECUTOR_INTERNAL_ENV_KEYS
            .iter()
            .chain(TASK_SCOPED_ENV_KEYS)
        {
            command.env_remove(key);
        }
        crate::process::hide_windows_console(&mut command);
        command
            .current_dir(preview)
            .envs(proxy)
            .envs(
                process_environment::process_env(&[])
                    .into_iter()
                    .filter(|(key, _)| {
                        matches!(
                            key.as_str(),
                            "GH_CONFIG_DIR" | "GLAB_CONFIG_DIR" | "GIT_CONFIG_GLOBAL"
                        )
                    }),
            )
            .env(CODEX_HOME_ENV, preview)
            .env("CODEX_SQLITE_HOME", preview)
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY")
            .env_remove("WEGENT_CONNECTION_SERVICE_TOKEN")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env(
                "PATH",
                process_environment::normalized_process_path(
                    env::var("PATH").ok().as_deref().unwrap_or_default(),
                ),
            )
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        command
    }
}

async fn run_catalog_command(
    mut command: Command,
    operation: &str,
    budget: Duration,
) -> Result<Value, String> {
    let start_error = |error| format!("Could not start Codex marketplace {operation}: {error}");
    command.stdout(Stdio::piped()).kill_on_drop(true);
    configure_codex_app_server_process_group(&mut command);
    #[cfg(windows)]
    let (mut child, mut tree) = {
        let mut tree = wegent_subprocess::ProcessTreeGuard::prepare_child(&mut command)
            .map_err(start_error)?;
        let mut child = command.spawn().map_err(start_error)?;
        if let Err(error) = tree.attach_child(&child) {
            tree.terminate();
            let _ = child.kill().await;
            return Err(start_error(error));
        }
        (child, tree)
    };
    #[cfg(not(windows))]
    let mut child = CodexAppServerChild::new(command.spawn().map_err(start_error)?, None);
    let mut stdout = child.stdout.take().expect("piped Codex marketplace output");
    let mut output = Vec::new();
    let result = timeout(budget, async {
        tokio::try_join!(child.wait(), stdout.read_to_end(&mut output))
    })
    .await;
    let status = match result {
        Ok(Ok((status, _))) => status,
        failure => {
            #[cfg(windows)]
            tree.terminate();
            let _ = timeout(Duration::from_secs(1), child.kill()).await;
            return Err(match failure {
                Ok(Err(error)) => format!("Could not read Codex marketplace {operation}: {error}"),
                _ => format!("Codex marketplace {operation} timed out"),
            });
        }
    };
    if !status.success() {
        // Git errors can include credentials embedded in the configured URL.
        return Err(format!("Codex marketplace {operation} failed ({status})"));
    }
    serde_json::from_slice(&output)
        .map_err(|_| format!("Codex marketplace {operation} returned invalid JSON"))
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::*;
    use std::{os::fd::OwnedFd, os::unix::net::UnixStream};

    #[tokio::test]
    async fn marketplace_command_timeout_stops_git_descendants() {
        let preview = tempfile::tempdir().unwrap();
        let (reader, writer) = UnixStream::pair().unwrap();
        reader.set_nonblocking(true).unwrap();
        let mut reader = tokio::net::UnixStream::from_std(reader).unwrap();
        let mut command = Command::new("/bin/sh");
        command
            .current_dir(preview.path())
            .stderr(OwnedFd::from(writer))
            .args(["-c", "sleep 60 & printf '%s' \"$!\" > child-pid; wait"]);

        let error = run_catalog_command(command, "fetch", Duration::from_secs(2))
            .await
            .unwrap_err();

        assert_eq!(error, "Codex marketplace fetch timed out");
        let child_pid = fs::read_to_string(preview.path().join("child-pid"))
            .unwrap()
            .parse::<libc::pid_t>()
            .unwrap();
        let closed = timeout(Duration::from_secs(1), reader.read(&mut [0])).await;
        if closed.is_err() {
            // SAFETY: this PID belongs to the test's sleep, which still holds the writer.
            unsafe { libc::kill(child_pid, libc::SIGKILL) };
        }
        assert_eq!(closed.unwrap().unwrap(), 0, "descendant retained the pipe");
    }
}
