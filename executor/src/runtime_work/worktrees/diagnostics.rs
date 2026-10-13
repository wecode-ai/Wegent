// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fmt::Display;
use std::path::Path;
use std::time::Instant;

use crate::logging::log_executor_event;

pub(super) fn measure_stage<T, E: Display>(
    task_id: &str,
    stage: &str,
    operation: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let started = Instant::now();
    log_executor_event(
        "runtime worktree stage started",
        &[("task_id", task_id.to_owned()), ("stage", stage.to_owned())],
    );
    let result = operation();
    let mut fields = vec![
        ("task_id", task_id.to_owned()),
        ("stage", stage.to_owned()),
        ("elapsed_ms", started.elapsed().as_millis().to_string()),
        ("ok", result.is_ok().to_string()),
    ];
    if let Err(error) = &result {
        fields.push(("error_kind", safe_error_kind(&error.to_string()).to_owned()));
    }
    log_executor_event("runtime worktree stage finished", &fields);
    result
}

pub(super) fn log_git_worktree_failure(
    task_id: &str,
    source: &Path,
    target: &Path,
    common_dir: &Path,
    error: &str,
) {
    let mut fields = git_worktree_failure_fields(source, target, common_dir, error);
    fields.push(("task_id", task_id.to_owned()));
    log_executor_event("runtime worktree git discovery failed", &fields);
}

fn git_worktree_failure_fields(
    source: &Path,
    target: &Path,
    common_dir: &Path,
    error: &str,
) -> Vec<(&'static str, String)> {
    let source_gitdir = source.join(".git");
    let target_gitdir = target.join(".git");
    let form = if error.contains("not a git repository:") {
        "explicit_gitdir"
    } else if error.contains("not a git repository (or any") {
        "ancestor_discovery"
    } else {
        "other"
    };
    let failed_gitdir = error.split_once("not a git repository:").map(|(_, value)| {
        value
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches(['\'', '"'])
    });
    let normalize = |path: &str| {
        path.replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };
    let role = failed_gitdir
        .and_then(|failed| {
            [
                ("source", source),
                ("source_gitdir", source_gitdir.as_path()),
                ("target", target),
                ("target_gitdir", target_gitdir.as_path()),
                ("common_dir", common_dir),
            ]
            .into_iter()
            .find(|(_, path)| normalize(failed) == normalize(&path.to_string_lossy()))
            .map(|(role, _)| role)
        })
        .unwrap_or("unknown");
    let mut fields = vec![
        ("repository_error_form", form.to_owned()),
        ("failed_gitdir_role", role.to_owned()),
    ];
    for (length_key, exists_key, path) in [
        ("source_utf16_len", "source_exists", source),
        ("target_utf16_len", "target_exists", target),
        ("common_dir_utf16_len", "common_dir_exists", common_dir),
        (
            "source_gitdir_utf16_len",
            "source_gitdir_exists",
            source_gitdir.as_path(),
        ),
        (
            "target_gitdir_utf16_len",
            "target_gitdir_exists",
            target_gitdir.as_path(),
        ),
    ] {
        fields.push((
            length_key,
            path.to_string_lossy().encode_utf16().count().to_string(),
        ));
        fields.push((exists_key, path.exists().to_string()));
    }
    fields
}

fn safe_error_kind(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    for (kind, patterns) in [
        (
            "path_too_long",
            &["filename too long", "file name too long"][..],
        ),
        (
            "permission_denied",
            &["permission denied", "access is denied", "access denied"][..],
        ),
        ("target_exists", &["already exists"][..]),
        (
            "worktree_registered",
            &["already registered", "already checked out"][..],
        ),
        ("repository_unavailable", &["not a git repository"][..]),
        (
            "ref_unavailable",
            &["invalid reference", "not a valid object", "bad object"][..],
        ),
        ("path_invalid", &["invalid argument", "invalid path"][..]),
    ] {
        if patterns.iter().any(|pattern| error.contains(pattern)) {
            return kind;
        }
    }
    "unclassified"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_repository_failure_distinguishes_discovery_from_explicit_gitdir() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("private-source");
        let target = root.path().join("private-target");
        let common_dir = source.join(".git");
        std::fs::create_dir_all(&common_dir).unwrap();
        let discovery = git_worktree_failure_fields(
            &source,
            &target,
            &common_dir,
            "fatal: not a git repository (or any of the parent directories): .git",
        );
        assert!(discovery.contains(&("repository_error_form", "ancestor_discovery".to_owned())));
        assert!(discovery.contains(&("failed_gitdir_role", "unknown".to_owned())));
        let explicit = git_worktree_failure_fields(
            &source,
            &target,
            &common_dir,
            &format!(
                "fatal: not a git repository: '{}'",
                target.join(".git").display()
            ),
        );
        assert!(explicit.contains(&("repository_error_form", "explicit_gitdir".to_owned())));
        assert!(explicit.contains(&("failed_gitdir_role", "target_gitdir".to_owned())));
        assert!(explicit.contains(&("source_exists", "true".to_owned())));
        assert!(explicit.contains(&("target_exists", "false".to_owned())));
        assert!(explicit.contains(&("common_dir_exists", "true".to_owned())));
    }

    #[test]
    fn git_repository_failure_fields_expose_only_roles_lengths_and_existence() {
        let source = Path::new("private-source-😀");
        let target = Path::new("private-target-token");
        let common_dir = source.join(".git");
        let fields = git_worktree_failure_fields(
            source,
            target,
            &common_dir,
            "fatal: not a git repository: 'private-secret-token'\ncredential=private-password",
        );
        assert!(fields.contains(&("source_utf16_len", "17".to_owned())));
        assert!(fields.contains(&("failed_gitdir_role", "unknown".to_owned())));
        for (_, value) in fields {
            assert!(!value.contains("private"));
            assert!(!value.contains("credential"));
            assert!(!value.contains('😀'));
        }
    }

    #[test]
    fn worktree_stage_error_kind_does_not_include_paths_or_credentials() {
        for (error, expected) in [
            ("fatal: private/secret: Filename too long", "path_too_long"),
            (
                "fatal: private/secret: Permission denied",
                "permission_denied",
            ),
            ("fatal: private/secret already exists", "target_exists"),
            (
                "fatal: private/secret already registered",
                "worktree_registered",
            ),
            (
                "fatal: not a git repository: private/secret",
                "repository_unavailable",
            ),
            (
                "fatal: invalid reference: private/secret",
                "ref_unavailable",
            ),
            ("private/secret: Invalid argument", "path_invalid"),
            ("private/secret token=secret", "unclassified"),
        ] {
            assert_eq!(safe_error_kind(error), expected);
        }
    }

    #[test]
    fn worktree_stage_diagnostics_preserve_the_original_error() {
        let error = "private/secret token=secret".to_owned();
        let result: Result<(), String> =
            measure_stage("fixture-task", "git_worktree_add", || Err(error.clone()));
        assert_eq!(result.unwrap_err(), error);
    }
}
