//! Source checkout is an explicit model capability, never an automatic intake step.
use super::*;
use crate::repository_identity::RepositoryIdentity;
use crate::task_runtime::mcp::StandInMcpIdentity;

fn matches_repository(path: &Path, expected: &RepositoryIdentity) -> bool {
    std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|url| RepositoryIdentity::from_url(url.trim()).ok())
        .is_some_and(|actual| actual == *expected)
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn prepare_git_source_workspace(
        &self,
        identity: &StandInMcpIdentity,
        args: Value,
    ) -> Result<Value, AppIpcError> {
        if identity.device != self.device_id || identity.work.is_none() {
            return Err(AppIpcError::new(
                "permission_denied",
                "Source work is required",
            ));
        }
        let mut bound = self.bound_git_work_args(identity, args).await?;
        bound["operation"] = json!("repository");
        let repo = super::super::git_connections::read(bound.clone()).await?;
        let repository = repo["data"]["full_name"]
            .as_str()
            .or(repo["data"]["path_with_namespace"].as_str())
            .ok_or_else(|| {
                AppIpcError::new("git_connection_invalid", "Repository path unavailable")
            })?;
        let url = format!(
            "{}/{repository}.git",
            bound["instance"].as_str().unwrap_or_default()
        );
        let expected = RepositoryIdentity::from_url(&url)
            .map_err(|message| AppIpcError::new("git_connection_invalid", message))?;
        let task = self
            .local_task_link(&identity.task_id)
            .filter(|link| link.runtime_handle["origin"]["userId"] == identity.user)
            .ok_or_else(|| AppIpcError::new("permission_denied", "Task owner changed"))?;
        let root = fs::canonicalize(&task.workspace_path)
            .map_err(|_| AppIpcError::new("workspace_unavailable", "Task workspace unavailable"))?;
        if matches_repository(&root, &expected) {
            return Ok(json!({"workspacePath":root,"repository":repository}));
        }
        let gate = self.task_send_gate(&format!("git-source-workspace:{}", identity.task_id));
        let _guard = gate.lock().await;
        let target = root.join("git-source");
        if target.exists() || target.symlink_metadata().is_ok() {
            if !target
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink())
                && matches_repository(&target, &expected)
            {
                return Ok(json!({"workspacePath":target,"repository":repository}));
            }
            return Err(AppIpcError::new(
                "workspace_conflict",
                "Task checkout directory already contains another source",
            ));
        }
        let temporary = tempfile::Builder::new()
            .prefix(".git-source-")
            .tempdir_in(&root)
            .map_err(|_| {
                AppIpcError::new("workspace_unavailable", "Cannot prepare task checkout")
            })?;
        let clone = temporary.path().join("repository");
        let status = tokio::time::timeout(
            Duration::from_secs(50),
            tokio::process::Command::new(
                if bound["providerId"]
                    .as_str()
                    .is_some_and(|p| p.ends_with("/github"))
                {
                    "gh"
                } else {
                    "glab"
                },
            )
            .args(["repo", "clone", &url])
            .arg(&clone)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GLAB_PROMPT_DISABLED", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env(
                "PATH",
                crate::process_environment::normalized_process_path(
                    &env::var("PATH").unwrap_or_default(),
                ),
            )
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .status(),
        )
        .await
        .map_err(|_| AppIpcError::new("git_clone_timeout", "Source checkout timed out"))?
        .map_err(|_| AppIpcError::new("git_clone_failed", "Source checkout could not start"))?;
        if !status.success() || !matches_repository(&clone, &expected) {
            return Err(AppIpcError::new(
                "git_clone_failed",
                "Source checkout failed; verify CLI Git authentication",
            ));
        }
        fs::rename(&clone, &target)
            .map_err(|_| AppIpcError::new("workspace_conflict", "Cannot publish task checkout"))?;
        Ok(json!({"workspacePath":target,"repository":repository}))
    }
}
