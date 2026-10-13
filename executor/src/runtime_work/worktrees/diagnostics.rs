// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fmt::Display;
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
