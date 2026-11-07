use super::RuntimeTaskLink;
use crate::runtime_work::util::{
    infer_workspace_kind, infer_worktree_id, normalize_workspace_path, workspace_task_path,
};

impl RuntimeTaskLink {
    fn has_explicit_local_workspace(&self) -> bool {
        self.runtime_handle
            .pointer("/executionRequest/workspace_source")
            .and_then(serde_json::Value::as_str)
            == Some("local_path")
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
