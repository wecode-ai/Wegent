// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fs,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    task::JoinHandle,
    time::timeout,
};

use crate::{
    agents::git_auth::{
        configure_repo_proxy, request_git_domain, task_git_auth_environment, user_git_email,
        user_git_login, uses_device_local_git_credentials,
    },
    logging::{log_executor_event, task_fields},
    protocol::ExecutionRequest,
};

const DEFAULT_GIT_CLONE_TIMEOUT_SECONDS: u64 = 600;
const MAX_GIT_CLONE_TIMEOUT_SECONDS: u64 = 3_600;
const DEFAULT_GIT_HTTP_LOW_SPEED_LIMIT: u64 = 1_024;
const MAX_GIT_HTTP_LOW_SPEED_LIMIT: u64 = 10 * 1_024 * 1_024;
const DEFAULT_GIT_HTTP_LOW_SPEED_TIME_SECONDS: u64 = 60;
const MAX_GIT_HTTP_LOW_SPEED_TIME_SECONDS: u64 = 3_600;
const GIT_REPOSITORY_VALIDATION_TIMEOUT_SECONDS: u64 = 10;
const GIT_CLONE_TERMINATION_GRACE_SECONDS: u64 = 1;

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
            validate_existing_git_repository(&project_path).await?;
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

    workspace_root().join(&request.task_id).join(repo_name)
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
    if git_url_contains_credentials(git_url) {
        return Err("Git repository URL must not contain credentials or a query".to_owned());
    }
    if let Some(parent) = project_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create git workspace parent {}: {error}",
                parent.display()
            )
        })?;
    }

    if let Some(git_domain) = request_git_domain(request) {
        configure_repo_proxy(&git_domain).await;
    }

    let auth_environment = task_git_auth_environment(request)?;
    if missing_required_task_git_credentials(
        request,
        git_url,
        auth_environment.contains_key("GIT_ASKPASS"),
        &protected_git_credential_domains(),
    ) {
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

    let mut command = Command::new("git");
    crate::process::hide_windows_console(&mut command);
    command.arg("clone");
    let branch = branch_name(request);
    if let Some(branch) = branch.as_deref() {
        command.arg("--branch").arg(branch).arg("--single-branch");
    }
    command.arg(git_url).arg(project_path);
    command.envs(auth_environment);
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env(
            "GIT_HTTP_LOW_SPEED_LIMIT",
            git_http_low_speed_limit().to_string(),
        )
        .env(
            "GIT_HTTP_LOW_SPEED_TIME",
            git_http_low_speed_time_seconds().to_string(),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.as_std_mut().process_group(0);

    let mut fields = task_fields(&request.task_id, &request.subtask_id);
    fields.push(("path", project_path.display().to_string()));
    fields.push(("git_url", mask_url_credentials(git_url)));
    if let Some(branch) = branch.as_deref() {
        fields.push(("branch", branch.to_owned()));
    }
    let timeout_seconds = git_clone_timeout_seconds();
    fields.push(("timeout_seconds", timeout_seconds.to_string()));
    log_executor_event("git clone started", &fields);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start git clone: {error}"))?;
    let process_group_id = child.id();
    let stdout = spawn_output_reader(child.stdout.take());
    let stderr = spawn_output_reader(child.stderr.take());
    let status = match timeout(Duration::from_secs(timeout_seconds), child.wait()).await {
        Ok(result) => result.map_err(|error| format!("failed to wait for git clone: {error}"))?,
        Err(_) => {
            terminate_git_clone(&mut child, process_group_id).await;
            let stdout = collect_output(stdout).await;
            let stderr = collect_output(stderr).await;
            let mut timeout_fields = fields;
            push_git_clone_failure_fields(&mut timeout_fields, None, &stdout, &stderr);
            log_executor_event("git clone timed out", &timeout_fields);
            let cleanup_error = cleanup_incomplete_clone(project_path).err();
            return Err(git_clone_timeout_error(
                project_path,
                timeout_seconds,
                cleanup_error.as_deref(),
            ));
        }
    };
    let stdout = collect_output(stdout).await;
    let stderr = collect_output(stderr).await;
    if status.success() {
        log_executor_event("git clone finished", &fields);
        return Ok(());
    }

    let stderr_detail = stderr.trim();
    let stdout_detail = stdout.trim();
    let detail = if !stderr_detail.is_empty() {
        stderr_detail.to_owned()
    } else if !stdout_detail.is_empty() {
        stdout_detail.to_owned()
    } else {
        format!("git exited with status {status}")
    };
    let mut failed_fields = fields;
    push_git_clone_failure_fields(&mut failed_fields, status.code(), &stdout, &stderr);
    log_executor_event("git clone failed", &failed_fields);
    let cleanup_error = cleanup_incomplete_clone(project_path).err();
    let cleanup_detail = cleanup_error
        .as_deref()
        .map(|error| format!("; failed to clean incomplete workspace: {error}"))
        .unwrap_or_default();
    Err(format!(
        "git clone failed for {}: {}{}",
        project_path.display(),
        detail,
        cleanup_detail,
    ))
}

async fn validate_existing_git_repository(project_path: &Path) -> Result<(), String> {
    let mut command = Command::new("git");
    crate::process::hide_windows_console(&mut command);
    command
        .arg("-C")
        .arg(project_path)
        .args(["rev-parse", "--verify", "HEAD^{commit}"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.as_std_mut().process_group(0);

    let result = timeout(
        Duration::from_secs(GIT_REPOSITORY_VALIDATION_TIMEOUT_SECONDS),
        command.status(),
    )
    .await
    .map_err(|_| {
        format!(
            "timed out validating existing git repository: {}",
            project_path.display()
        )
    })?
    .map_err(|error| {
        format!(
            "failed to validate existing git repository {}: {error}",
            project_path.display()
        )
    })?;
    if result.success() {
        Ok(())
    } else {
        Err(format!(
            "git workspace contains an incomplete or invalid repository: {}",
            project_path.display()
        ))
    }
}

fn spawn_output_reader<R>(stream: Option<R>) -> Option<JoinHandle<Vec<u8>>>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    stream.map(|mut stream| {
        tokio::spawn(async move {
            let mut output = Vec::new();
            let _ = stream.read_to_end(&mut output).await;
            output
        })
    })
}

async fn collect_output(reader: Option<JoinHandle<Vec<u8>>>) -> String {
    let bytes = match reader {
        Some(reader) => reader.await.unwrap_or_default(),
        None => Vec::new(),
    };
    String::from_utf8_lossy(&bytes).into_owned()
}

async fn terminate_git_clone(child: &mut Child, process_group_id: Option<u32>) {
    #[cfg(unix)]
    {
        if let Some(process_group_id) = process_group_id {
            unsafe {
                let _ = libc::kill(-(process_group_id as libc::pid_t), libc::SIGTERM);
            }
            let wait_result = timeout(
                Duration::from_secs(GIT_CLONE_TERMINATION_GRACE_SECONDS),
                child.wait(),
            )
            .await;
            unsafe {
                // The clone owns its process group, so this also stops transports
                // and credential helpers that outlive the top-level Git process.
                let _ = libc::kill(-(process_group_id as libc::pid_t), libc::SIGKILL);
            }
            if wait_result.is_err() {
                let _ = child.wait().await;
            }
            return;
        }
    }

    let _ = child.start_kill();
    let _ = child.wait().await;
}

fn cleanup_incomplete_clone(project_path: &Path) -> Result<(), String> {
    if project_path == workspace_root()
        || project_path.parent().is_none()
        || project_path.file_name().is_none()
        || project_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(format!(
            "refusing to remove unsafe git workspace path {}",
            project_path.display()
        ));
    }
    let metadata = match fs::symlink_metadata(project_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(project_path).map_err(|error| error.to_string())
    } else {
        fs::remove_dir_all(project_path).map_err(|error| error.to_string())
    }
}

fn git_clone_timeout_error(
    project_path: &Path,
    timeout_seconds: u64,
    cleanup_error: Option<&str>,
) -> String {
    let cleanup_detail = cleanup_error
        .map(|error| format!("; failed to clean incomplete workspace: {error}"))
        .unwrap_or_default();
    format!(
        "git clone timed out after {timeout_seconds}s for {}; check repository reachability and proxy configuration{}",
        project_path.display(),
        cleanup_detail,
    )
}

fn git_clone_timeout_seconds() -> u64 {
    bounded_env_u64(
        "WEGENT_GIT_CLONE_TIMEOUT_SECONDS",
        DEFAULT_GIT_CLONE_TIMEOUT_SECONDS,
        1,
        MAX_GIT_CLONE_TIMEOUT_SECONDS,
    )
}

fn git_http_low_speed_limit() -> u64 {
    bounded_env_u64(
        "WEGENT_GIT_HTTP_LOW_SPEED_LIMIT",
        DEFAULT_GIT_HTTP_LOW_SPEED_LIMIT,
        1,
        MAX_GIT_HTTP_LOW_SPEED_LIMIT,
    )
}

fn git_http_low_speed_time_seconds() -> u64 {
    bounded_env_u64(
        "WEGENT_GIT_HTTP_LOW_SPEED_TIME_SECONDS",
        DEFAULT_GIT_HTTP_LOW_SPEED_TIME_SECONDS,
        1,
        MAX_GIT_HTTP_LOW_SPEED_TIME_SECONDS,
    )
}

fn bounded_env_u64(key: &str, default: u64, minimum: u64, maximum: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(default)
        .clamp(minimum, maximum)
}

fn missing_required_task_git_credentials(
    request: &ExecutionRequest,
    git_url: &str,
    has_task_credentials: bool,
    protected_domains: &[String],
) -> bool {
    !has_task_credentials
        && requires_credentials_for_clone_with_domains(git_url, protected_domains)
        && !uses_device_local_git_credentials(request)
}

fn git_url_contains_credentials(git_url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(git_url) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https")
        && (!parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some())
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
        let mut command = Command::new("git");
        crate::process::hide_windows_console(&mut command);
        let _ = command
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
    dirs::home_dir()
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
    fn device_local_transport_allows_configured_git_credential_helper() {
        let protected_domains = vec!["github.com".to_owned()];
        let server_request = ExecutionRequest::default();
        let device_request = ExecutionRequest {
            extra: serde_json::Map::from_iter([(
                "git_auth_transport".to_owned(),
                json!("device_local"),
            )]),
            ..ExecutionRequest::default()
        };
        let git_url = "https://github.com/wecode-ai/wegent.git";

        assert!(missing_required_task_git_credentials(
            &server_request,
            git_url,
            false,
            &protected_domains,
        ));
        assert!(!missing_required_task_git_credentials(
            &device_request,
            git_url,
            false,
            &protected_domains,
        ));
        assert!(!missing_required_task_git_credentials(
            &server_request,
            git_url,
            true,
            &protected_domains,
        ));
    }

    #[test]
    fn http_git_urls_reject_embedded_credentials_and_queries() {
        assert!(git_url_contains_credentials(
            "https://octocat:token@github.com/org/repo.git"
        ));
        assert!(git_url_contains_credentials(
            "https://github.com/org/repo.git?token=secret"
        ));
        assert!(!git_url_contains_credentials(
            "https://github.com/org/repo.git"
        ));
        assert!(!git_url_contains_credentials("git@github.com:org/repo.git"));
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
