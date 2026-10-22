use super::*;
use crate::runtime_work::codex_global_state::CodexGlobalProjectIndex;

pub(super) fn validate_stand_in_workspace(config: &Value) -> Result<(), AppIpcError> {
    let Some(workspace) = config.get("workspace").filter(|value| !value.is_null()) else {
        return Ok(());
    };
    let index = CodexGlobalProjectIndex::load();
    let key = workspace["projectKey"].as_str().unwrap_or_default();
    let path = workspace["workspacePath"].as_str().unwrap_or_default();
    let project = index.project_for_key(key).ok_or_else(|| {
        AppIpcError::new(
            "workspace_unavailable",
            "The selected local project is unavailable on this Executor",
        )
    })?;
    if project.remote_host_id.is_some()
        || !project
            .roots
            .iter()
            .chain(std::iter::once(&project.workspace_path))
            .any(|root| normalize_workspace_path(root) == normalize_workspace_path(path))
        || !Path::new(path).is_dir()
    {
        return Err(AppIpcError::new(
            "workspace_unavailable",
            "Choose an available directory in the selected local project",
        ));
    }
    match workspace["executionMode"].as_str() {
        Some("current_workspace") => Ok(()),
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
            Ok(())
        }
        _ => Err(AppIpcError::new(
            "bad_request",
            "Invalid Stand-in execution mode",
        )),
    }
}

pub(super) fn apply_stand_in_workspace(
    payload: &mut Value,
    config: &Value,
) -> Result<(), AppIpcError> {
    validate_stand_in_workspace(config)?;
    let workspace = &config["workspace"];
    payload["workspacePath"] = workspace["workspacePath"].clone();
    payload["runtimeProjectKey"] = workspace["projectKey"].clone();
    payload["runtimeWorkspaceRoots"] = json!([workspace["workspacePath"]]);
    payload.as_object_mut().unwrap().remove("execution");
    payload["executionRequest"]
        .as_object_mut()
        .unwrap()
        .remove("workspace_source");
    if workspace["executionMode"] == "git_worktree" {
        let mut target = json!({"source":"git_worktree"});
        if let Some(branch) = workspace["branch"]
            .as_str()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
        {
            target["branch"] = json!(branch);
        }
        payload["execution"] = json!({"workspace":target});
        payload["executionRequest"]["workspace_source"] = json!("git_worktree");
    }
    Ok(())
}
