use super::RuntimeTaskLink;
use crate::runtime_work::util::{
    infer_workspace_kind, infer_worktree_id, normalize_workspace_path, workspace_task_path,
};
use serde_json::Value;

impl RuntimeTaskLink {
    fn has_explicit_local_workspace(&self) -> bool {
        let request = &self.runtime_handle["executionRequest"];
        match request.get("workspace_source") {
            Some(Value::String(source)) => source == "local_path",
            None | Some(Value::Null) => self.has_recorded_stand_in_workspace(request),
            _ => false,
        }
    }

    fn has_recorded_stand_in_workspace(&self, request: &Value) -> bool {
        let cwd = normalize_workspace_path(&self.workspace_path);
        let Some(project_key) = self.runtime_project_key.as_deref() else {
            return false;
        };
        let origin = &self.runtime_handle["origin"];
        let user = origin["userId"].as_i64();
        if cwd.is_empty()
            || project_key.trim().is_empty()
            || request["runtime_project_key"].as_str() != Some(project_key)
            || !matches!(
                origin["type"].as_str(),
                Some("stand_in_identity" | "stand_in_task")
            )
            || request.get("origin") != Some(origin)
            || !user.is_some_and(|id| id >= 0)
            || request["user_id"].as_i64() != user
            || !origin["deviceId"]
                .as_str()
                .is_some_and(|id| !id.trim().is_empty())
            || request
                .get("deferred_project_environment")
                .is_some_and(|value| !value.is_null())
            || !request["project_workspace_path"]
                .as_str()
                .is_some_and(|path| normalize_workspace_path(path) == cwd)
        {
            return false;
        }
        let Some(roots) = request["runtime_workspace_roots"].as_array() else {
            return false;
        };
        let Some(roots) = roots
            .iter()
            .map(|root| root.as_str().map(normalize_workspace_path))
            .collect::<Option<Vec<_>>>()
        else {
            return false;
        };
        // Historical Stand-in current_workspace preparation recorded these
        // bindings but omitted source; managed preparation always set its source.
        !roots.is_empty()
            && roots.iter().all(|root| !root.is_empty())
            && roots.contains(&cwd)
            && roots
                == self
                    .runtime_workspace_roots
                    .iter()
                    .map(|root| normalize_workspace_path(root))
                    .collect::<Vec<_>>()
    }

    pub(crate) fn workspace_kind(&self) -> &'static str {
        let inferred = infer_workspace_kind(&self.workspace_path);
        if self.has_explicit_local_workspace() && inferred != "chat" {
            "workspace"
        } else {
            inferred
        }
    }

    pub(crate) fn worktree_id(&self) -> Option<String> {
        (self.workspace_kind() == "worktree")
            .then(|| infer_worktree_id(&self.workspace_path))
            .flatten()
    }

    pub(crate) fn execution_workspace_path(&self, group_path: &str) -> String {
        if self.has_explicit_local_workspace() {
            normalize_workspace_path(&self.workspace_path)
        } else {
            workspace_task_path(&self.workspace_path, group_path)
        }
    }
}
