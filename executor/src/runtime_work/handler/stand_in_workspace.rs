use super::*;
use crate::runtime_work::codex_global_state::CodexGlobalProjectIndex;

pub(super) fn apply_stand_in_workspace(
    payload: &mut Value,
    config: &Value,
) -> Result<(), AppIpcError> {
    let workspace = &config["workspace"];
    let index = CodexGlobalProjectIndex::load();
    let key = workspace["projectKey"].as_str().unwrap_or_default();
    let project = index.project_for_key(key).ok_or_else(|| {
        AppIpcError::new(
            "workspace_unavailable",
            "The selected local project is unavailable on this Executor",
        )
    })?;
    let path = &project.workspace_path;
    if project.remote_host_id.is_some() || !Path::new(path).is_dir() {
        return Err(AppIpcError::new(
            "workspace_unavailable",
            "Choose an available directory in the selected local project",
        ));
    }
    let source = match workspace["executionMode"].as_str() {
        Some("current_workspace") => "local_path",
        Some("git_worktree") => {
            let output = std::process::Command::new("git")
                .args(["-C", path, "rev-parse", "--show-toplevel"])
                .output();
            if !output.is_ok_and(|output| output.status.success()) {
                return Err(AppIpcError::new(
                    "workspace_not_git",
                    "Worktrees require a Git repository",
                ));
            }
            "git_worktree"
        }
        _ => {
            return Err(AppIpcError::new(
                "bad_request",
                "Invalid Stand-in execution mode",
            ));
        }
    };
    payload["workspacePath"] = json!(path);
    payload["runtimeProjectKey"] = json!(project.key);
    payload["runtimeWorkspaceRoots"] = json!([path]);
    let mut target = json!({"source":source});
    if source == "git_worktree" {
        if let Some(branch) = workspace["branch"]
            .as_str()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
        {
            target["branch"] = json!(branch);
        }
    }
    payload["execution"] = json!({"workspace":target});
    payload["executionRequest"]["workspace_source"] = json!(source);
    Ok(())
}
