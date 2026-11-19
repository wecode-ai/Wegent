//! Request-owned branches preserve their identity and evidence until explicit cleanup.
use super::*;
mod merge;
pub(super) mod publish;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RequestWorktreeOwner {
    pub request_id: String,
    pub owner_user_id: i64,
    pub conversation_id: String,
    pub device_id: String,
}

impl RequestWorktreeOwner {
    pub fn from_origin(
        origin: Option<&serde_json::Value>,
        task_id: &str,
        device_id: &str,
    ) -> Result<Option<Self>, String> {
        let Some(value) = origin.and_then(|origin| origin.get("assistantRequest")) else {
            return Ok(None);
        };
        let owner: Self = serde_json::from_value(value.clone())
            .map_err(|error| format!("worktree_request_invalid: {error}"))?;
        owner.validate(task_id, device_id)?;
        Ok(Some(owner))
    }

    fn validate(&self, task_id: &str, device_id: &str) -> Result<(), String> {
        if self.request_id.trim().is_empty()
            || self.request_id.chars().any(char::is_control)
            || self.owner_user_id < 0
            || self.conversation_id != task_id
            || self.device_id != normalize_device_id(device_id)
        {
            return Err(
                "worktree_request_invalid: Request ownership does not match this task and device"
                    .to_owned(),
            );
        }
        Ok(())
    }

    pub(super) fn branch(&self) -> String {
        let identity = serde_json::to_vec(self).expect("Request identity is serializable");
        format!("wegent/requests/{:x}", Sha256::digest(identity))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestMergeEvidence {
    pub state: String,
    pub target_ref: String,
    pub target_revision: String,
    pub request_revision: String,
    pub candidate_revision: Option<String>,
    pub merged_revision: Option<String>,
    pub conflict_files: Vec<String>,
    pub reason_code: Option<String>,
    #[serde(default)]
    pub observed_target_revision: Option<String>,
    #[serde(default)]
    pub target_worktree_dirty: Option<bool>,
}

pub(super) fn resolve_revision(source: &Path, reference: Option<&str>) -> Result<String, String> {
    let reference = reference.unwrap_or("HEAD");
    if reference.starts_with('-') || reference.chars().any(char::is_control) {
        return Err("worktree_ref_invalid: Invalid base reference".to_owned());
    }
    git_output(
        source,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
        None,
    )
}

pub(super) fn validate_owner(
    record: &ManagedWorktree,
    owner: Option<&RequestWorktreeOwner>,
    task_id: &str,
    device_id: &str,
    path_preexisted: bool,
) -> Result<(), String> {
    if let Some(owner) = owner {
        owner.validate(task_id, device_id)?;
        if record
            .request
            .as_ref()
            .is_some_and(|previous| previous != owner)
            || (path_preexisted && record.request.is_none())
            || (!record.device_id.is_empty() && record.device_id != device_id)
        {
            return Err(
                "worktree_request_owner_conflict: Worktree belongs to another request".to_owned(),
            );
        }
    } else if record.request.is_some() {
        return Err("worktree_request_owner_required: Request identity is required".to_owned());
    }
    Ok(())
}

pub(super) fn add_request_worktree(
    source: &Path,
    path: &Path,
    revision: &str,
    owner: &RequestWorktreeOwner,
) -> Result<(), String> {
    let branch = owner.branch();
    git_output(
        source,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            path.to_str().ok_or("Invalid worktree path")?,
            revision,
        ],
        None,
    )?;
    Ok(())
}

pub(super) fn validate_branch(path: &Path, owner: &RequestWorktreeOwner) -> Result<(), String> {
    let branch = git_output(path, &["symbolic-ref", "--short", "HEAD"], None)?;
    if branch != owner.branch() {
        return Err("worktree_request_branch_conflict: Request branch changed".to_owned());
    }
    Ok(())
}

impl WorktreeManager {
    pub(crate) fn has_request_origin(
        &self,
        origin: Option<&serde_json::Value>,
        task_id: &str,
    ) -> bool {
        RequestWorktreeOwner::from_origin(origin, task_id, &self.device_id)
            .is_ok_and(|owner| owner.is_some())
    }

    pub fn prepare_planned_request(
        &self,
        source: &Path,
        task_id: &str,
        base_revision: &str,
        path: &Path,
        repository_fingerprint: &str,
        owner: &RequestWorktreeOwner,
    ) -> Result<ManagedWorktree, String> {
        self.prepare_with_path(
            source,
            task_id,
            WorktreePreparation {
                git_ref: Some(base_revision),
                permanent: false,
                path,
                repo_root_fingerprint: Some(repository_fingerprint),
                request: Some(owner),
            },
        )
    }

    pub fn request_worktree(
        &self,
        path: &Path,
        owner: &RequestWorktreeOwner,
    ) -> Result<ManagedWorktree, String> {
        let _guard = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree registry is unavailable")?;
        let state = self.load();
        ensure_managed_path(path, &state.known_roots)?;
        let record = state
            .records
            .get(&normalized_path_key(path))
            .filter(|record| record.request.as_ref() == Some(owner))
            .ok_or("worktree_request_owner_conflict: Request worktree is unavailable")?;
        owner.validate(&record.worktree_id, &self.device_id)?;
        validate_record_worktree_identity(record, path)?;
        validate_branch(path, owner)?;
        Ok(record.clone())
    }

    pub fn preserve_request_worktree(
        &self,
        path: &Path,
        owner: &RequestWorktreeOwner,
    ) -> Result<ManagedWorktree, String> {
        // Cancellation retains both dirty files and the independent branch.
        self.request_worktree(path, owner)
    }
}
