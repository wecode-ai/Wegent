// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Stdio,
};

use serde_json::Value;
use tokio::process::Command;

use crate::{
    agents::git_auth::{
        git_credentials, request_git_domain, user_git_email, user_git_login, GitCredentials,
    },
    logging::{log_executor_event, task_fields},
    protocol::ExecutionRequest,
};

pub async fn prepare_git_workspace(
    mut request: ExecutionRequest,
) -> Result<ExecutionRequest, String> {
    let Some(git_url) = request.git_url() else {
        log_executor_event(
            "git workspace skipped",
            &[("reason", "missing_git_url".to_owned())],
        );
        return Ok(request);
    };

    let repo_name = repo_name_from_url(&git_url);
    let project_path = resolve_git_project_path(&request, &repo_name);
    request.project_workspace_path = Some(project_path.display().to_string());

    let mut fields = task_fields(&request.task_id, &request.subtask_id);
    fields.push(("path", project_path.display().to_string()));
    fields.push(("repo", repo_name));

    if request.skip_git_clone {
        fields.push(("reason", "skip_git_clone".to_owned()));
        log_executor_event("git workspace clone skipped", &fields);
        return Ok(request);
    }

    match classify_project_path(&project_path) {
        ProjectPathState::GitRepository => {
            fields.push(("reason", "existing_git_repository".to_owned()));
            log_executor_event("git workspace clone skipped", &fields);
            setup_git_config(&request, &project_path).await;
            Ok(request)
        }
        ProjectPathState::EmptyDirectory | ProjectPathState::Missing => {
            clone_repo(&request, &git_url, &project_path).await?;
            setup_git_config(&request, &project_path).await;
            fields.push(("status", "cloned".to_owned()));
            log_executor_event("git workspace prepared", &fields);
            Ok(request)
        }
        ProjectPathState::NonEmptyDirectory => Err(format!(
            "git workspace path is not empty and is not a git repository: {}",
            project_path.display()
        )),
        ProjectPathState::File => Err(format!(
            "git workspace path exists but is not a directory: {}",
            project_path.display()
        )),
    }
}

fn resolve_git_project_path(request: &ExecutionRequest, repo_name: &str) -> PathBuf {
    if let Some(path) = request
        .project_workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return resolve_workspace_path(path);
    }

    let project_id = crate::local::capabilities::get_project_id(request);
    if !project_id.is_empty() {
        return workspace_root()
            .join("projects")
            .join(project_id)
            .join(safe_repo_name(repo_name));
    }

    workspace_root()
        .join(request.task_id.to_string())
        .join(repo_name)
}

fn resolve_workspace_path(path: &str) -> PathBuf {
    let expanded = expand_tilde(path);
    if expanded.is_absolute() {
        expanded
    } else {
        workspace_root().join(expanded)
    }
}

fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn repo_name_from_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let without_fragment = trimmed.split('#').next().unwrap_or(trimmed);
    let path = without_fragment
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(without_fragment)
        .split_once(':')
        .map(|(_, rest)| rest)
        .unwrap_or(without_fragment);
    let repo = path
        .rsplit('/')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("repository");
    repo.strip_suffix(".git").unwrap_or(repo).to_owned()
}

fn safe_repo_name(repo_name: &str) -> String {
    repo_name.replace(['/', '\\'], "_")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectPathState {
    Missing,
    File,
    EmptyDirectory,
    NonEmptyDirectory,
    GitRepository,
}

fn classify_project_path(path: &Path) -> ProjectPathState {
    if !path.exists() {
        return ProjectPathState::Missing;
    }
    if !path.is_dir() {
        return ProjectPathState::File;
    }
    if path.join(".git").exists() {
        return ProjectPathState::GitRepository;
    }
    if fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
    {
        ProjectPathState::EmptyDirectory
    } else {
        ProjectPathState::NonEmptyDirectory
    }
}

async fn clone_repo(
    request: &ExecutionRequest,
    git_url: &str,
    project_path: &Path,
) -> Result<(), String> {
    if let Some(parent) = project_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create git workspace parent {}: {error}",
                parent.display()
            )
        })?;
    }

    let credentials = git_credentials(request);
    if credentials.is_none() && requires_credentials_for_clone(git_url) {
        let mut failed_fields = task_fields(&request.task_id, &request.subtask_id);
        failed_fields.push(("path", project_path.display().to_string()));
        failed_fields.push(("git_url", mask_url_credentials(git_url)));
        if let Some(git_domain) = request_git_domain(request) {
            failed_fields.push(("git_domain", git_domain));
        }
        log_executor_event("git clone credentials missing", &failed_fields);
        return Err(format!(
            "git credentials missing for protected repository: {}",
            mask_url_credentials(git_url)
        ));
    }

    let clone_url = authenticated_clone_url(git_url, credentials.as_ref());
    let mut command = Command::new("git");
    command.arg("clone");
    let branch = branch_name(request);
    if let Some(branch) = branch.as_deref() {
        command.arg("--branch").arg(branch).arg("--single-branch");
    }
    command.arg(clone_url).arg(project_path);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut fields = task_fields(&request.task_id, &request.subtask_id);
    fields.push(("path", project_path.display().to_string()));
    fields.push(("git_url", mask_url_credentials(git_url)));
    if let Some(branch) = branch.as_deref() {
        fields.push(("branch", branch.to_owned()));
    }
    log_executor_event("git clone started", &fields);

    let output = command
        .output()
        .await
        .map_err(|error| format!("failed to start git clone: {error}"))?;
    if output.status.success() {
        log_executor_event("git clone finished", &fields);
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    let mut failed_fields = fields;
    push_git_clone_failure_fields(
        &mut failed_fields,
        output.status.code(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );
    log_executor_event("git clone failed", &failed_fields);
    Err(format!(
        "git clone failed for {}: {}",
        project_path.display(),
        detail
    ))
}

fn authenticated_clone_url(git_url: &str, credentials: Option<&GitCredentials>) -> String {
    let Some(credentials) = credentials else {
        return git_url.to_owned();
    };
    let Some((protocol, rest)) = git_url.split_once("://") else {
        return git_url.to_owned();
    };
    if protocol != "https" && protocol != "http" {
        return git_url.to_owned();
    }
    let (username, token) = if git_url.to_ascii_lowercase().contains("gerrit") {
        (
            percent_encode(&credentials.username),
            percent_encode(&credentials.token),
        )
    } else {
        (credentials.username.clone(), credentials.token.clone())
    };
    format!("{protocol}://{username}:{token}@{rest}")
}

fn requires_credentials_for_clone(git_url: &str) -> bool {
    requires_credentials_for_clone_with_domains(git_url, &protected_git_credential_domains())
}

fn requires_credentials_for_clone_with_domains(git_url: &str, domains: &[String]) -> bool {
    let lower = git_url.to_ascii_lowercase();
    if !lower.starts_with("https://") && !lower.starts_with("http://") {
        return false;
    }
    let Some(domain) = http_url_domain(&lower) else {
        return false;
    };
    domains.iter().any(|protected_domain| {
        domain == protected_domain || domain.ends_with(&format!(".{protected_domain}"))
    })
}

fn protected_git_credential_domains() -> Vec<String> {
    env::var("PROTECTED_GIT_CREDENTIAL_DOMAINS")
        .unwrap_or_default()
        .split([',', ';', ' ', '\n', '\t'])
        .filter_map(|domain| non_empty(domain).map(|domain| domain.to_ascii_lowercase()))
        .collect()
}

fn http_url_domain(url: &str) -> Option<&str> {
    let rest = url.split_once("://")?.1;
    let host = rest
        .split('/')
        .next()?
        .split('@')
        .next_back()?
        .split(':')
        .next()?;
    non_empty(host)
}

fn branch_name(request: &ExecutionRequest) -> Option<String> {
    value_string(request.extra.get("branch_name"))
        .or_else(|| value_string(request.extra.get("branchName")))
        .or_else(|| value_path_string(&request.extra, &["workspace", "repository", "branchName"]))
        .or_else(|| value_path_string(&request.extra, &["repository", "branchName"]))
}

async fn setup_git_config(request: &ExecutionRequest, project_path: &Path) {
    let Some(git_login) = user_git_login(request) else {
        return;
    };
    let Some(git_email) = user_git_email(request) else {
        return;
    };
    for (key, value) in [("user.name", git_login), ("user.email", git_email)] {
        let _ = Command::new("git")
            .arg("-C")
            .arg(project_path)
            .arg("config")
            .arg(key)
            .arg(value)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
}

fn value_path_string(root: &serde_json::Map<String, Value>, path: &[&str]) -> Option<String> {
    let mut current = root.get(*path.first()?)?;
    for key in &path[1..] {
        current = current.as_object()?.get(*key)?;
    }
    value_string(Some(current))
}

fn value_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => non_empty(value).map(ToOwned::to_owned),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn mask_url_credentials(url: &str) -> String {
    let Some((protocol, rest)) = url.split_once("://") else {
        return url.to_owned();
    };
    let Some((_, after_credentials)) = rest.split_once('@') else {
        return url.to_owned();
    };
    format!("{protocol}://***@{after_credentials}")
}

fn push_git_clone_failure_fields(
    fields: &mut Vec<(&'static str, String)>,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
) {
    fields.push((
        "exit_code",
        exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_owned()),
    ));
    fields.push(("stdout_len", stdout.len().to_string()));
    fields.push(("stderr_len", stderr.len().to_string()));

    let stdout = git_output_summary(stdout);
    if !stdout.is_empty() {
        fields.push(("stdout", stdout));
    }
    let stderr = git_output_summary(stderr);
    if !stderr.is_empty() {
        fields.push(("stderr", stderr));
    }
}

fn git_output_summary(output: &str) -> String {
    let sanitized = output
        .split_whitespace()
        .map(redact_git_output_fragment)
        .collect::<Vec<_>>()
        .join(" ");
    truncate_summary(&sanitized, 240)
}

fn redact_git_output_fragment(fragment: &str) -> String {
    let masked = mask_url_credentials(fragment);
    if masked.starts_with("ghp_")
        || masked.starts_with("github_pat_")
        || masked.starts_with("glpat-")
        || masked.starts_with("gloas-")
    {
        return "***".to_owned();
    }
    masked
}

fn truncate_summary(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let summary = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{summary}...")
    } else {
        summary
    }
}

fn workspace_root() -> PathBuf {
    env::var_os("WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/workspace"))
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repo_name_supports_https_and_ssh_urls() {
        assert_eq!(
            repo_name_from_url("https://github.com/wecode-ai/wegent.git"),
            "wegent"
        );
        assert_eq!(
            repo_name_from_url("git@gitlab.com:group/project.git"),
            "project"
        );
    }

    #[test]
    fn authenticated_url_preserves_non_http_urls() {
        let credentials = crate::agents::git_auth::GitCredentials {
            username: "token".to_owned(),
            token: "secret".to_owned(),
        };

        assert_eq!(
            authenticated_clone_url("git@gitlab.com:group/project.git", Some(&credentials)),
            "git@gitlab.com:group/project.git"
        );
    }

    #[test]
    fn configured_https_repositories_require_credentials() {
        let protected_domains = vec!["github.com".to_owned()];

        assert!(requires_credentials_for_clone_with_domains(
            "https://github.com/wecode-ai/wegent.git",
            &protected_domains
        ));
        assert!(!requires_credentials_for_clone_with_domains(
            "https://gitlab.com/wecode-ai/wegent.git",
            &protected_domains
        ));
        assert!(!requires_credentials_for_clone_with_domains(
            "git@github.com:wecode-ai/wegent.git",
            &protected_domains
        ));
    }

    #[test]
    fn resolves_project_workspace_path_first() {
        let request = ExecutionRequest {
            task_id: "10".to_owned(),
            project_workspace_path: Some("projects/custom".to_owned()),
            extra: serde_json::Map::from_iter([("project_id".to_owned(), json!(99))]),
            ..ExecutionRequest::default()
        };

        assert!(resolve_git_project_path(&request, "repo").ends_with("projects/custom"));
    }

    #[test]
    fn git_clone_failure_fields_include_diagnostics_without_credentials() {
        let mut fields = vec![("task_id", "10".to_owned())];
        push_git_clone_failure_fields(
            &mut fields,
            Some(128),
            "trace token ghp_secret",
            "fatal: Authentication failed for 'https://token:glpat-secret@gitlab.com/org/repo.git'",
        );

        assert!(fields.contains(&("exit_code", "128".to_owned())));
        assert!(fields
            .iter()
            .any(|(key, value)| *key == "stderr" && value.contains("Authentication failed")));
        assert!(!fields
            .iter()
            .any(|(_, value)| value.contains("glpat-secret")));
        assert!(!fields.iter().any(|(_, value)| value.contains("ghp_secret")));
    }
}
