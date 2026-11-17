//! Merge candidates are built in a disposable checkout; publishing is an explicit action.
use super::*;

impl WorktreeManager {
    pub fn prepare_request_merge(
        &self,
        path: &Path,
        owner: &RequestWorktreeOwner,
        target_ref: Option<&str>,
    ) -> Result<ManagedWorktree, String> {
        let worktree_lock = self.worktree_lock(path)?;
        let _worktree_guard = worktree_lock
            .lock()
            .map_err(|_| "Worktree lock is unavailable")?;
        let mut record = self.request_worktree(path, owner)?;
        let _registry = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree registry is unavailable")?;
        let source = Path::new(
            record
                .source_path
                .as_deref()
                .ok_or("Missing base repository")?,
        );
        let target_ref = match target_ref {
            Some(reference) => reference.to_owned(),
            None => git_output(source, &["symbolic-ref", "HEAD"], None)?,
        };
        validate_target_ref(path, &target_ref)?;
        let target = resolve_revision(path, Some(&target_ref))?;
        let request_revision = self.snapshot_request(path, &mut record)?;
        let request_tree = revision_tree(path, &request_revision)?;
        if record.merge.as_ref().is_some_and(|evidence| {
            evidence.state != "escalated"
                && evidence.target_ref == target_ref
                && (evidence.target_revision == target
                    || evidence.merged_revision.as_deref() == Some(target.as_str()))
                && revision_tree(path, &evidence.request_revision)
                    .is_ok_and(|tree| tree == request_tree)
        }) {
            return self.save_request_record(record);
        }
        let evidence = build_candidate(
            &self.state_path,
            path,
            &target_ref,
            &target,
            &request_revision,
        )?;
        record.merge = Some(evidence);
        self.save_request_record(record)
    }

    pub fn publish_request_merge(
        &self,
        path: &Path,
        owner: &RequestWorktreeOwner,
        expected_target_revision: &str,
        expected_candidate_revision: &str,
        confirmed: bool,
    ) -> Result<ManagedWorktree, String> {
        if !confirmed {
            return Err(
                "worktree_merge_confirmation_required: Confirm this merge before publishing"
                    .to_owned(),
            );
        }
        let worktree_lock = self.worktree_lock(path)?;
        let _worktree_guard = worktree_lock
            .lock()
            .map_err(|_| "Worktree lock is unavailable")?;
        let mut record = self.request_worktree(path, owner)?;
        let _registry = self
            .mutation_lock
            .lock()
            .map_err(|_| "Worktree registry is unavailable")?;
        let mut evidence = record
            .merge
            .clone()
            .ok_or("worktree_merge_candidate_missing")?;
        if evidence.state == "merged"
            && evidence.candidate_revision.as_deref() == Some(expected_candidate_revision)
        {
            return Ok(record);
        }
        if evidence.state != "awaiting_confirmation"
            || evidence.target_revision != expected_target_revision
            || evidence.candidate_revision.as_deref() != Some(expected_candidate_revision)
        {
            return Err(
                "worktree_merge_candidate_changed: Review a fresh merge candidate".to_owned(),
            );
        }
        let source = PathBuf::from(
            record
                .source_path
                .as_deref()
                .ok_or("Missing base repository")?,
        );
        validate_record_worktree_identity(&record, path)?;
        if git_common_dir(&source)? != git_common_dir(path)?
            || git_output(&source, &["symbolic-ref", "HEAD"], None)? != evidence.target_ref
        {
            return Err("worktree_merge_target_changed: The base checkout changed".to_owned());
        }
        let current_target = resolve_revision(&source, None)?;
        if current_target != expected_target_revision
            && current_target != expected_candidate_revision
        {
            return Err(
                "worktree_merge_target_changed: Refresh and validate the target baseline"
                    .to_owned(),
            );
        }
        if !git_output(
            &source,
            &["status", "--porcelain", "--untracked-files=all"],
            None,
        )?
        .is_empty()
        {
            return Err(
                "worktree_merge_target_dirty: Preserve the unfinished base checkout changes"
                    .to_owned(),
            );
        }
        let current = self.snapshot_request(path, &mut record)?;
        if revision_tree(path, &current)? != revision_tree(path, &evidence.request_revision)? {
            return Err(
                "worktree_merge_request_changed: Request changes need a fresh candidate".to_owned(),
            );
        }
        // The caller has authenticated the owner and obtained approval. Git still
        // refuses non-fast-forward publication and never resets the base checkout.
        if current_target != expected_candidate_revision {
            if let Err(error) = super::publish::guarded_fast_forward(
                &source,
                &self.state_path,
                &evidence,
                expected_candidate_revision,
            ) {
                let observed = resolve_revision(&source, None)?;
                evidence.observed_target_revision = Some(observed.clone());
                evidence.target_worktree_dirty = Some(
                    !git_output(
                        &source,
                        &["status", "--porcelain", "--untracked-files=all"],
                        None,
                    )?
                    .is_empty(),
                );
                evidence.state = if observed == expected_candidate_revision {
                    "merged"
                } else {
                    "escalated"
                }
                .to_owned();
                evidence.merged_revision =
                    (observed == expected_candidate_revision).then_some(observed);
                evidence.reason_code = Some("publish_failed".to_owned());
                log_executor_event("request merge publication failed", &[("error", error)]);
                record.merge = Some(evidence);
                return self.save_request_record(record);
            }
        }
        let merged = resolve_revision(&source, None)?;
        if merged != expected_candidate_revision {
            return Err(
                "worktree_merge_target_changed: Git did not publish the validated candidate"
                    .to_owned(),
            );
        }
        evidence.state = "merged".to_owned();
        evidence.merged_revision = Some(merged);
        record.merge = Some(evidence);
        self.save_request_record(record)
    }

    fn snapshot_request(
        &self,
        path: &Path,
        record: &mut ManagedWorktree,
    ) -> Result<String, String> {
        if git_output(
            path,
            &["status", "--porcelain", "--untracked-files=all"],
            None,
        )?
        .is_empty()
        {
            return resolve_revision(path, None);
        }
        let snapshot_dir = self
            .state_path
            .parent()
            .ok_or("Missing worktree registry directory")?
            .join("snapshots");
        let snapshot = snapshot_worktree(path, &snapshot_dir)?;
        record.snapshot_ref = Some(snapshot.reference);
        record.snapshot_commit = Some(snapshot.commit.clone());
        record.snapshot_at = Some(now_ms());
        Ok(snapshot.commit)
    }

    fn save_request_record(&self, mut record: ManagedWorktree) -> Result<ManagedWorktree, String> {
        let mut state = self.load();
        let key = normalized_path_key(Path::new(&record.path));
        let current = state
            .records
            .get(&key)
            .ok_or("Request worktree disappeared")?;
        if current.request != record.request {
            return Err("worktree_request_owner_conflict: Request ownership changed".to_owned());
        }
        record.updated_at = now_ms();
        state.records.insert(key, record.clone());
        self.save(&state)?;
        Ok(record)
    }
}

fn validate_target_ref(path: &Path, reference: &str) -> Result<(), String> {
    if !reference.starts_with("refs/heads/") {
        return Err("worktree_merge_target_invalid: A local branch is required".to_owned());
    }
    git_output(path, &["check-ref-format", reference], None)?;
    Ok(())
}

fn revision_tree(path: &Path, revision: &str) -> Result<String, String> {
    git_output(
        path,
        &["rev-parse", "--verify", &format!("{revision}^{{tree}}")],
        None,
    )
}

fn build_candidate(
    state_path: &Path,
    request_path: &Path,
    target_ref: &str,
    target: &str,
    request: &str,
) -> Result<RequestMergeEvidence, String> {
    let mut evidence = RequestMergeEvidence {
        state: "no_changes".to_owned(),
        target_ref: target_ref.to_owned(),
        target_revision: target.to_owned(),
        request_revision: request.to_owned(),
        candidate_revision: None,
        merged_revision: None,
        conflict_files: Vec::new(),
        reason_code: None,
        observed_target_revision: None,
        target_worktree_dirty: None,
    };
    if revision_tree(request_path, target)? == revision_tree(request_path, request)? {
        return Ok(evidence);
    }
    let candidate_root = state_path
        .parent()
        .ok_or("Missing registry directory")?
        .join("merge-candidates");
    fs::create_dir_all(&candidate_root).map_err(|error| error.to_string())?;
    let temporary = tempfile::tempdir_in(&candidate_root).map_err(|error| error.to_string())?;
    let checkout = temporary.path().join("checkout");
    add_git_worktree(request_path, &checkout, Some(target))?;
    let outcome = merge_candidate(&checkout, &mut evidence);
    let cleanup = remove_git_worktree(&checkout);
    match (outcome, cleanup) {
        (Ok(()), Ok(())) => Ok(evidence),
        (Err(error), _) | (_, Err(error)) => Err(error),
    }
}

fn merge_candidate(checkout: &Path, evidence: &mut RequestMergeEvidence) -> Result<(), String> {
    let hooks = checkout
        .parent()
        .ok_or("Missing candidate directory")?
        .join("hooks");
    fs::create_dir(&hooks).map_err(|error| error.to_string())?;
    let hooks_config = format!("core.hooksPath={}", hooks.display());
    let merge = git_output(
        checkout,
        &[
            "-c",
            &hooks_config,
            "merge",
            "--no-ff",
            "--no-commit",
            "--no-edit",
            &evidence.request_revision,
        ],
        None,
    );
    if let Err(error) = merge {
        let conflicts = git_output_raw(
            checkout,
            &["diff", "--name-only", "--diff-filter=U", "-z"],
            None,
        )?;
        evidence.conflict_files = conflicts
            .split('\0')
            .filter(|file| !file.is_empty())
            .map(str::to_owned)
            .collect();
        evidence.state = if evidence.conflict_files.is_empty() {
            "escalated"
        } else {
            "conflict"
        }
        .to_owned();
        evidence.reason_code = Some(
            if evidence.conflict_files.is_empty() {
                "merge_failed"
            } else {
                "merge_conflict"
            }
            .to_owned(),
        );
        if evidence.conflict_files.is_empty() {
            log_executor_event("request merge candidate failed", &[("error", error)]);
        }
        return Ok(());
    }
    let tree = git_output(checkout, &["write-tree"], None)?;
    if tree == revision_tree(checkout, &evidence.target_revision)? {
        return Ok(());
    }
    let identity = [
        ("GIT_AUTHOR_NAME", "Wegent"),
        ("GIT_AUTHOR_EMAIL", "merge@wegent.local"),
        ("GIT_COMMITTER_NAME", "Wegent"),
        ("GIT_COMMITTER_EMAIL", "merge@wegent.local"),
    ];
    let candidate = git_output(
        checkout,
        &[
            "commit-tree",
            &tree,
            "-p",
            &evidence.target_revision,
            "-p",
            &evidence.request_revision,
            "-m",
            "Merge assistant request",
        ],
        Some(&identity),
    )?;
    let reference = format!("refs/wegent/request-merges/{candidate}");
    git_output(checkout, &["update-ref", &reference, &candidate], None)?;
    evidence.state = "awaiting_confirmation".to_owned();
    evidence.candidate_revision = Some(candidate);
    Ok(())
}
