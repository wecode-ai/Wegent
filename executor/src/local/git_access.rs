// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, path::Path};

use serde::{Deserialize, Serialize};

use super::command::{build_env, CommandResult};

pub const ERROR_PREFIX: &str = "git-access:";

/// Safe repository access diagnostics; never include Git output or credentials.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitAccessFailure {
    pub code: String,
    pub domain: String,
    pub message: String,
}

impl GitAccessFailure {
    pub fn new(code: &str, domain: &str, message: &str) -> Self {
        Self {
            code: code.to_owned(),
            domain: domain.to_owned(),
            message: message.to_owned(),
        }
    }

    pub fn wire_error(&self) -> String {
        format!("{ERROR_PREFIX}{}", serde_json::to_string(self).unwrap())
    }
}

fn repository_domain(url: &str) -> Result<String, GitAccessFailure> {
    let invalid = || {
        GitAccessFailure::new(
            "invalid-url",
            "",
            "Repository URL must not contain credentials, a query, or command options",
        )
    };
    if url.trim().is_empty() || url.starts_with('-') || url.contains("::") && !url.contains("://") {
        return Err(invalid());
    }
    if url.contains("://") {
        let parsed = url::Url::parse(url).map_err(|_| invalid())?;
        if !matches!(parsed.scheme(), "http" | "https" | "ssh" | "git" | "file") {
            return Err(invalid());
        }
        let authority = url
            .split("://")
            .nth(1)
            .unwrap_or_default()
            .split('/')
            .next()
            .unwrap_or_default();
        let embeds_http_identity =
            matches!(parsed.scheme(), "http" | "https") && authority.contains('@');
        let embeds_credential = authority
            .rsplit_once('@')
            .is_some_and(|(identity, _)| identity.contains(':'));
        if parsed.query().is_some()
            || parsed.fragment().is_some()
            || embeds_credential
            || embeds_http_identity
        {
            return Err(invalid());
        }
        let port = parsed
            .port()
            .or_else(|| authority.rsplit_once(':')?.1.parse::<u16>().ok());
        return Ok(parsed
            .host_str()
            .map(|host| match port {
                Some(port) => format!("{host}:{port}"),
                None => host.to_owned(),
            })
            .unwrap_or_default());
    }
    // SCP-style SSH URLs. Filesystem paths (including Windows drives) need no account.
    if let Some((authority, _)) = url.split_once(':') {
        if !authority.contains(['/', '\\']) && authority.len() > 1 {
            return Ok(authority
                .rsplit('@')
                .next()
                .unwrap_or_default()
                .to_lowercase());
        }
    }
    Ok(String::new())
}

pub fn noninteractive_environment(env: &HashMap<String, String>) -> HashMap<String, String> {
    let mut env = env.clone();
    env.insert("GIT_TERMINAL_PROMPT".into(), "0".into());
    env.insert("GCM_INTERACTIVE".into(), "Never".into());
    env.insert("LC_ALL".into(), "C".into());
    // Git owns SSH transport precedence, including core.sshCommand. Do not
    // inject an environment override; native process deadlines bound SSH waits.
    env
}

pub fn classify_failure(domain: &str, result: &CommandResult) -> GitAccessFailure {
    let detail = format!(
        "{} {}",
        result.stderr,
        result.error.as_deref().unwrap_or_default()
    )
    .to_lowercase();
    let (code, message) = if result.timed_out
        || [
            "could not resolve",
            "failed to connect",
            "connection refused",
            "connection timed out",
            "connection reset",
            "connection closed",
            "operation timed out",
            "network is unreachable",
            "error: 500",
            "error: 502",
            "error: 503",
            "error: 504",
            "ssl certificate problem",
            "host key verification failed",
        ]
        .iter()
        .any(|text| detail.contains(text))
    {
        (
            "network-error",
            "Check the device network, proxy, TLS certificate and SSH host trust",
        )
    } else if detail.contains("could not read username")
        || detail.contains("terminal prompts disabled")
    {
        (
            "credentials-required",
            "This repository requires Git credentials on the selected device",
        )
    } else if detail.contains("permission denied (publickey") {
        (
            "ssh-authentication-failed",
            "SSH authentication was rejected; configure the SSH key on the selected device",
        )
    } else if detail.contains("authentication failed")
        || detail.contains("http basic: access denied")
        || detail.contains("error: 401")
    {
        (
            "authentication-failed",
            "Git authentication was rejected; check the account or SSH key",
        )
    } else if result.exit_code.is_none() && result.error.is_some() {
        (
            "git-unavailable",
            "Git could not start on the selected device; install or repair Git",
        )
    } else {
        // A 403/404 may hide private repositories or indicate missing permission.
        // They are not evidence of missing or expired authentication.
        (
            "repository-inaccessible",
            "Check the repository URL and the account's repository access",
        )
    };
    GitAccessFailure::new(code, domain, message)
}

pub async fn preflight(
    url: &str,
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout_seconds: f64,
) -> Result<(), GitAccessFailure> {
    let domain = repository_domain(url)?;
    let result = run(
        &["ls-remote".into(), "--".into(), url.into(), "HEAD".into()],
        cwd,
        env,
        timeout_seconds.clamp(0.001, 30.0),
        16 * 1024,
    )
    .await;
    if result.success && result.exit_code == Some(0) {
        Ok(())
    } else {
        Err(classify_failure(&domain, &result))
    }
}

/// Native dispatch shared by local IPC and the Backend device command channel.
pub async fn execute_clone(
    args: &[String],
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout_seconds: f64,
    max_output_bytes: usize,
) -> CommandResult {
    let started = std::time::Instant::now();
    // The public command accepts only a repository, destination and optional branch.
    let (url, target) = match args {
        [url, target] => (url, target),
        [flag, branch, single, url, target]
            if flag == "--branch" && !branch.is_empty() && single == "--single-branch" =>
        {
            (url, target)
        }
        _ => return CommandResult::error("Invalid Git clone arguments".into(), 0.0, false),
    };
    if target.is_empty() {
        return CommandResult::error("Git target path is required".into(), 0.0, false);
    }
    if let Err(error) = preflight(url, cwd, env, timeout_seconds).await {
        return CommandResult::error(error.wire_error(), 0.0, false);
    }
    let mut argv = vec!["clone".into()];
    argv.extend_from_slice(&args[..args.len() - 2]);
    argv.extend(["--".into(), url.clone(), target.clone()]);
    let mut result = run(
        &argv,
        cwd,
        env,
        (timeout_seconds - started.elapsed().as_secs_f64()).max(0.001),
        max_output_bytes,
    )
    .await;
    if !result.success {
        let domain = repository_domain(url).unwrap_or_default();
        let mut failure = classify_failure(&domain, &result);
        if failure.code == "repository-inaccessible" {
            failure = GitAccessFailure::new(
                "clone-failed", &domain,
                "Repository access passed, but cloning failed; check the branch, destination, disk space and device permissions",
            );
        }
        result.error = Some(failure.wire_error());
        result.stderr.clear();
        result.stdout = serde_json::Value::String(String::new());
    }
    result
}

async fn run(
    args: &[String],
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout_seconds: f64,
    max_output_bytes: usize,
) -> CommandResult {
    let env = noninteractive_environment(&build_env(env));
    match super::native_git::run_git_capture(
        args,
        cwd,
        &env,
        std::time::Duration::from_secs_f64(timeout_seconds.max(0.001)),
        max_output_bytes,
    )
    .await
    {
        Ok(capture) => {
            let mut result =
                CommandResult::ok(String::from_utf8_lossy(&capture.stdout).into_owned());
            result.success = capture.success;
            result.exit_code = Some(if capture.success { 0 } else { 1 });
            result.stderr = capture.stderr;
            result.stdout_truncated = capture.truncated;
            result
        }
        Err(error) => CommandResult::error(error.message, 0.0, error.timed_out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_custom_ssh_transports() {
        for key in ["GIT_SSH", "GIT_SSH_COMMAND"] {
            let env = HashMap::from([(key.to_owned(), "custom-ssh".to_owned())]);
            let result = noninteractive_environment(&env);
            assert_eq!(result[key], "custom-ssh");
            if key == "GIT_SSH" {
                assert!(!result.contains_key("GIT_SSH_COMMAND"));
            }
            assert_eq!(result["GIT_TERMINAL_PROMPT"], "0");
        }
    }

    #[test]
    fn does_not_override_ssh_commands_from_git_configuration() {
        let result = noninteractive_environment(&HashMap::new());
        assert!(!result.contains_key("GIT_SSH_COMMAND"));
        assert!(!result.contains_key("GIT_SSH"));
        assert_eq!(result["GCM_INTERACTIVE"], "Never");
    }

    #[test]
    fn exact_domain_and_safe_urls() {
        assert_eq!(
            repository_domain("https://git.example.com:8443/a.git").unwrap(),
            "git.example.com:8443"
        );
        assert_eq!(
            repository_domain("https://git.example.com:443/a.git").unwrap(),
            "git.example.com:443"
        );
        assert_eq!(
            repository_domain("git@github.com:owner/repo.git").unwrap(),
            "github.com"
        );
        assert_eq!(repository_domain("/tmp/repo").unwrap(), "");
        assert_eq!(repository_domain("C:\\repo").unwrap(), "");
        for url in [
            "--upload-pack=evil",
            "https://u:secret@git.example/a",
            "https://git.example/a?token=secret",
        ] {
            assert_eq!(repository_domain(url).unwrap_err().code, "invalid-url");
        }
    }

    #[test]
    fn classifies_without_disclosing_output_or_misidentifying_permissions() {
        for (stderr, code) in [
            (
                "fatal: could not read Username: terminal prompts disabled",
                "credentials-required",
            ),
            (
                "fatal: Authentication failed for secret",
                "authentication-failed",
            ),
            (
                "The requested URL returned error: 403",
                "repository-inaccessible",
            ),
            ("Repository not found", "repository-inaccessible"),
            (
                "Permission denied (publickey).",
                "ssh-authentication-failed",
            ),
            (
                "fatal: Could not read from remote repository.",
                "repository-inaccessible",
            ),
            ("Could not resolve host", "network-error"),
            ("Host key verification failed", "network-error"),
        ] {
            let mut result = CommandResult::error(String::new(), 0.0, false);
            result.exit_code = Some(128);
            result.stderr = stderr.into();
            let failure = classify_failure("git.example", &result);
            assert_eq!(failure.code, code);
            assert!(!failure.wire_error().contains("secret"));
        }
    }

    #[tokio::test]
    async fn real_http_preflight_accepts_native_auth_and_clone_revalidates() {
        use axum::{
            extract::{Path, State},
            http::{HeaderMap, StatusCode},
            routing::get,
            Router,
        };
        use std::sync::Arc;

        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repository.git");
        let output = std::process::Command::new("git")
            .args(["init", "--bare"])
            .arg(&repo)
            .output()
            .unwrap();
        assert!(output.status.success());
        std::process::Command::new("git")
            .arg("--git-dir")
            .arg(&repo)
            .arg("update-server-info")
            .output()
            .unwrap();
        async fn serve(
            State(root): State<Arc<std::path::PathBuf>>,
            Path(path): Path<String>,
            headers: HeaderMap,
        ) -> axum::response::Response {
            use axum::response::IntoResponse;
            if headers
                .get("authorization")
                .and_then(|header| header.to_str().ok())
                != Some("Basic synthetic")
            {
                return (
                    StatusCode::UNAUTHORIZED,
                    [("www-authenticate", "Basic realm=\"test\"")],
                    "",
                )
                    .into_response();
            }
            match tokio::fs::read(root.join(path)).await {
                Ok(bytes) => bytes.into_response(),
                Err(_) => StatusCode::NOT_FOUND.into_response(),
            }
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/{*path}", get(serve))
            .with_state(Arc::new(root.path().to_owned()));
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let url = format!("http://{address}/repository.git");
        let config = root.path().join("native.gitconfig");
        std::fs::write(&config, "").unwrap();
        let env = HashMap::from([("GIT_CONFIG_GLOBAL".into(), config.display().to_string())]);
        let failure = preflight(&url, None, &env, 5.0).await.unwrap_err();
        assert_eq!(failure.code, "credentials-required");
        assert_eq!(failure.domain, address.to_string());
        std::fs::write(
            &config,
            "[http]\nextraHeader = Authorization: Basic synthetic\n",
        )
        .unwrap();
        assert!(preflight(&url, None, &env, 5.0).await.is_ok());
        let target = root.path().join("checkout");
        assert!(
            execute_clone(&[url, target.display().to_string()], None, &env, 5.0, 4096)
                .await
                .success
        );
        assert!(target.join(".git").exists());
        server.abort();
    }

    #[tokio::test]
    async fn public_empty_repository_and_missing_local_repository() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo.git");
        let status = std::process::Command::new("git")
            .args(["init", "--bare"])
            .arg(&repo)
            .output()
            .unwrap()
            .status;
        assert!(status.success());
        assert!(
            preflight(repo.to_str().unwrap(), None, &HashMap::new(), 5.0)
                .await
                .is_ok()
        );
        let result = execute_clone(
            &[
                root.path().join("missing").display().to_string(),
                root.path().join("checkout").display().to_string(),
            ],
            None,
            &HashMap::new(),
            5.0,
            4096,
        )
        .await;
        assert!(!result.success);
        assert!(!root.path().join("checkout").exists());
    }
}

#[cfg(all(test, unix))]
mod native_ssh_tests;
