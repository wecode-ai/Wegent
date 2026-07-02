// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, fs, path::PathBuf, process::Stdio};

use aes::Aes256;
use base64::{engine::general_purpose, Engine as _};
use cbc::{
    cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit},
    Decryptor,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{io::AsyncWriteExt, process::Command};

use crate::{
    logging::{log_executor_event, task_fields},
    protocol::ExecutionRequest,
};

type Aes256CbcDecryptor = Decryptor<Aes256>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCredentials {
    pub username: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitTokenDiagnostics {
    source: &'static str,
    encrypted: bool,
    decrypt_success: Option<bool>,
    raw_len: usize,
    token_len: usize,
    token_fingerprint: String,
}

pub async fn setup_git_authentication(request: &ExecutionRequest) {
    set_git_environment(request);
    let fields = task_fields(request.task_id, request.subtask_id);
    let Some(git_domain) = request_git_domain(request) else {
        log_executor_event(
            "git cli authentication skipped",
            &[("reason", "missing_domain".to_owned())],
        );
        return;
    };
    let Some((credentials, diagnostics)) = git_credentials_with_diagnostics(&git_domain, request)
    else {
        let mut skipped_fields = fields;
        skipped_fields.push(("reason", "missing_token".to_owned()));
        skipped_fields.push(("git_domain", git_domain));
        log_executor_event("git cli authentication skipped", &skipped_fields);
        return;
    };

    let mut start_fields = fields.clone();
    start_fields.push(("git_domain", git_domain.clone()));
    push_token_diagnostic_fields(&mut start_fields, &diagnostics);
    log_executor_event("git cli authentication started", &start_fields);

    let success = authenticate_cli(&git_domain, &credentials).await;
    let mut auth_fields = fields;
    auth_fields.push(("git_domain", git_domain));
    push_token_diagnostic_fields(&mut auth_fields, &diagnostics);
    auth_fields.push(("success", success.to_string()));
    log_executor_event("git cli authentication finished", &auth_fields);
}

pub fn decrypt_git_token(token: &str) -> Option<String> {
    decrypt_sensitive_data(token)
}

pub fn is_token_encrypted(token: &str) -> bool {
    let Ok(decoded) = general_purpose::STANDARD.decode(token.as_bytes()) else {
        return false;
    };
    !decoded.is_empty() && decoded.len() % 16 == 0
}

pub fn request_git_domain(request: &ExecutionRequest) -> Option<String> {
    extra_string(request, "git_domain")
        .or_else(|| user_git_domain(request))
        .or_else(|| request.git_url().and_then(|url| domain_from_url(&url)))
}

pub fn git_credentials(request: &ExecutionRequest) -> Option<GitCredentials> {
    let git_domain = request_git_domain(request)?;
    git_credentials_for_domain(&git_domain, request)
}

fn set_git_environment(request: &ExecutionRequest) {
    for (source_key, env_key) in [
        ("git_domain", "GIT_DOMAIN"),
        ("git_repo", "GIT_REPO"),
        ("git_repo_id", "GIT_REPO_ID"),
        ("branch_name", "BRANCH_NAME"),
    ] {
        if let Some(value) = extra_string(request, source_key) {
            env::set_var(env_key, value);
        }
    }
    if let Some(git_url) = request.git_url() {
        env::set_var("GIT_URL", git_url);
    }
}

fn git_credentials_for_domain(
    git_domain: &str,
    request: &ExecutionRequest,
) -> Option<GitCredentials> {
    let Some((credentials, diagnostics)) = git_credentials_with_diagnostics(git_domain, request)
    else {
        let mut fields = task_fields(request.task_id, request.subtask_id);
        fields.push(("git_domain", git_domain.to_owned()));
        fields.push(("reason", "missing_token".to_owned()));
        log_executor_event("git token diagnostics unavailable", &fields);
        return None;
    };
    let mut fields = task_fields(request.task_id, request.subtask_id);
    fields.push(("git_domain", git_domain.to_owned()));
    push_token_diagnostic_fields(&mut fields, &diagnostics);
    log_executor_event("git token diagnostics", &fields);
    Some(credentials)
}

fn git_credentials_with_diagnostics(
    git_domain: &str,
    request: &ExecutionRequest,
) -> Option<(GitCredentials, GitTokenDiagnostics)> {
    let (raw_token, token_source) = raw_git_token_for_domain(git_domain, request)?;
    let raw_token = raw_token.trim();
    let token_encrypted = is_token_encrypted(raw_token);
    let token = normalize_git_token(raw_token)?;
    let diagnostics = GitTokenDiagnostics {
        source: token_source,
        encrypted: token_encrypted,
        decrypt_success: token_encrypted.then_some(token != raw_token),
        raw_len: raw_token.len(),
        token_len: token.len(),
        token_fingerprint: token_fingerprint(&token),
    };
    Some((
        GitCredentials {
            username: user_git_login(request).unwrap_or_else(|| "token".to_owned()),
            token,
        },
        diagnostics,
    ))
}

fn push_token_diagnostic_fields(
    fields: &mut Vec<(&'static str, String)>,
    diagnostics: &GitTokenDiagnostics,
) {
    fields.push(("token_source", diagnostics.source.to_owned()));
    fields.push(("token_encrypted", diagnostics.encrypted.to_string()));
    if let Some(decrypt_success) = diagnostics.decrypt_success {
        fields.push(("token_decrypt_success", decrypt_success.to_string()));
    }
    fields.push(("raw_token_len", diagnostics.raw_len.to_string()));
    fields.push(("token_len", diagnostics.token_len.to_string()));
    fields.push(("token_fingerprint", diagnostics.token_fingerprint.clone()));
}

fn raw_git_token_for_domain(
    git_domain: &str,
    request: &ExecutionRequest,
) -> Option<(String, &'static str)> {
    if let Some(token) = user_git_token(request) {
        if is_masked_or_empty_token(&token) {
            log_token_source_probe(
                request,
                git_domain,
                "request_user",
                Some(token.trim().len()),
                Some("masked_or_empty"),
            );
        } else {
            log_token_source_probe(request, git_domain, "request_user", Some(token.len()), None);
            return Some((token, "request_user"));
        }
    }
    token_file(git_domain, request).map(|token| (token, "home_ssh_domain_file"))
}

fn user_git_token(request: &ExecutionRequest) -> Option<String> {
    request
        .extra
        .get("user")
        .and_then(Value::as_object)
        .and_then(|user| user.get("git_token").or_else(|| user.get("gitToken")))
        .and_then(value_string)
}

fn user_git_domain(request: &ExecutionRequest) -> Option<String> {
    request
        .extra
        .get("user")
        .and_then(Value::as_object)
        .and_then(|user| user.get("git_domain").or_else(|| user.get("gitDomain")))
        .and_then(value_string)
}

pub fn user_git_login(request: &ExecutionRequest) -> Option<String> {
    request
        .extra
        .get("user")
        .and_then(Value::as_object)
        .and_then(|user| user.get("git_login").or_else(|| user.get("gitLogin")))
        .and_then(value_string)
}

pub fn user_git_email(request: &ExecutionRequest) -> Option<String> {
    let user = request.extra.get("user")?.as_object()?;
    let git_email = user
        .get("git_email")
        .or_else(|| user.get("gitEmail"))
        .and_then(value_string);
    if git_email.is_some() {
        return git_email;
    }
    let git_id = user
        .get("git_id")
        .or_else(|| user.get("gitId"))
        .and_then(value_string)?;
    let git_login = user
        .get("git_login")
        .or_else(|| user.get("gitLogin"))
        .and_then(value_string)?;
    Some(format!("{git_id}+{git_login}@users.noreply.github.com"))
}

fn token_file(git_domain: &str, request: &ExecutionRequest) -> Option<String> {
    let Some(home) = home_dir() else {
        log_token_source_probe(
            request,
            git_domain,
            "home_ssh_domain_file",
            None,
            Some("missing_home"),
        );
        return None;
    };
    let path = home.join(".ssh").join(git_domain);
    match fs::read_to_string(&path) {
        Ok(token) => {
            log_token_source_probe(
                request,
                git_domain,
                "home_ssh_domain_file",
                Some(token.trim().len()),
                None,
            );
            Some(token)
        }
        Err(error) => {
            let mut fields = task_fields(request.task_id, request.subtask_id);
            fields.push(("git_domain", git_domain.to_owned()));
            fields.push(("token_source", "home_ssh_domain_file".to_owned()));
            fields.push(("token_file", path.display().to_string()));
            fields.push(("error_kind", format!("{:?}", error.kind())));
            fields.push(("error", error.to_string()));
            log_executor_event("git token source probe failed", &fields);
            None
        }
    }
}

fn log_token_source_probe(
    request: &ExecutionRequest,
    git_domain: &str,
    token_source: &'static str,
    token_len: Option<usize>,
    reason: Option<&'static str>,
) {
    let mut fields = task_fields(request.task_id, request.subtask_id);
    fields.push(("git_domain", git_domain.to_owned()));
    fields.push(("token_source", token_source.to_owned()));
    if let Some(token_len) = token_len {
        fields.push(("raw_token_len", token_len.to_string()));
    }
    if let Some(reason) = reason {
        fields.push(("reason", reason.to_owned()));
    }
    log_executor_event("git token source probe", &fields);
}

fn normalize_git_token(token: &str) -> Option<String> {
    let token = token.trim();
    if is_masked_or_empty_token(token) {
        return None;
    }
    if is_token_encrypted(token) {
        return decrypt_git_token(token).and_then(|value| {
            let value = value.trim().to_owned();
            (!value.is_empty() && value != "***").then_some(value)
        });
    }
    Some(token.to_owned())
}

fn is_masked_or_empty_token(token: &str) -> bool {
    let token = token.trim();
    token.is_empty() || token == "***"
}

fn token_fingerprint(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
        .chars()
        .take(12)
        .collect()
}

async fn authenticate_cli(git_domain: &str, credentials: &GitCredentials) -> bool {
    configure_repo_proxy(git_domain).await;
    if git_domain.to_ascii_lowercase().contains("github") {
        return authenticate_github(git_domain, credentials).await;
    }
    authenticate_gitlab(git_domain, &credentials.token).await
}

async fn authenticate_github(git_domain: &str, credentials: &GitCredentials) -> bool {
    log_executor_event(
        "git cli authentication command starting",
        &[
            ("provider", "github".to_owned()),
            ("git_domain", git_domain.to_owned()),
        ],
    );
    let mut command = Command::new("gh");
    command
        .arg("auth")
        .arg("login")
        .arg("--hostname")
        .arg(git_domain)
        .arg("--with-token")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let Ok(mut child) = command.spawn() else {
        log_executor_event(
            "git cli authentication command spawn failed",
            &[
                ("provider", "github".to_owned()),
                ("git_domain", git_domain.to_owned()),
            ],
        );
        return false;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(credentials.token.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
    }
    child
        .wait_with_output()
        .await
        .map(|output| {
            let success = output.status.success();
            let stderr = String::from_utf8_lossy(&output.stderr);
            log_executor_event(
                "git cli authentication command finished",
                &[
                    ("provider", "github".to_owned()),
                    ("git_domain", git_domain.to_owned()),
                    ("success", success.to_string()),
                    (
                        "exit_code",
                        output
                            .status
                            .code()
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "signal".to_owned()),
                    ),
                    ("stderr", stderr_summary(&stderr)),
                ],
            );
            if success {
                return true;
            }
            if stderr.contains("missing required scope 'read:org'") {
                return configure_github_cli_host(git_domain, credentials);
            }
            false
        })
        .unwrap_or(false)
}

fn configure_github_cli_host(git_domain: &str, credentials: &GitCredentials) -> bool {
    let Some(home) = home_dir() else {
        log_executor_event(
            "git cli authentication fallback failed",
            &[
                ("provider", "github".to_owned()),
                ("git_domain", git_domain.to_owned()),
                ("reason", "missing_home".to_owned()),
            ],
        );
        return false;
    };
    let config_dir = home.join(".config").join("gh");
    if fs::create_dir_all(&config_dir).is_err() {
        log_executor_event(
            "git cli authentication fallback failed",
            &[
                ("provider", "github".to_owned()),
                ("git_domain", git_domain.to_owned()),
                ("reason", "create_config_dir_failed".to_owned()),
            ],
        );
        return false;
    }

    let user_line = if credentials.username.trim().is_empty() || credentials.username == "token" {
        String::new()
    } else {
        format!("    user: {}\n", yaml_scalar(&credentials.username))
    };
    let content = format!(
        "{}:\n    oauth_token: {}\n{}    git_protocol: https\n",
        yaml_scalar(git_domain),
        yaml_scalar(&credentials.token),
        user_line
    );
    let path = config_dir.join("hosts.yml");
    let success = fs::write(&path, content).is_ok();
    log_executor_event(
        if success {
            "git cli authentication fallback configured"
        } else {
            "git cli authentication fallback failed"
        },
        &[
            ("provider", "github".to_owned()),
            ("git_domain", git_domain.to_owned()),
            ("reason", "missing_read_org_scope".to_owned()),
            ("path", path.display().to_string()),
            ("success", success.to_string()),
        ],
    );
    success
}

async fn authenticate_gitlab(git_domain: &str, git_token: &str) -> bool {
    log_executor_event(
        "git cli authentication command starting",
        &[
            ("provider", "gitlab".to_owned()),
            ("git_domain", git_domain.to_owned()),
        ],
    );
    Command::new("glab")
        .arg("auth")
        .arg("login")
        .arg("--hostname")
        .arg(git_domain)
        .arg("--token")
        .arg(git_token)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .map(|output| {
            let success = output.status.success();
            log_executor_event(
                "git cli authentication command finished",
                &[
                    ("provider", "gitlab".to_owned()),
                    ("git_domain", git_domain.to_owned()),
                    ("success", success.to_string()),
                    (
                        "exit_code",
                        output
                            .status
                            .code()
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "signal".to_owned()),
                    ),
                    (
                        "stderr",
                        stderr_summary(&String::from_utf8_lossy(&output.stderr)),
                    ),
                ],
            );
            success
        })
        .unwrap_or(false)
}

async fn configure_repo_proxy(git_domain: &str) {
    let Some(proxy_values) = repo_proxy_values(git_domain) else {
        return;
    };
    for (key, value) in proxy_values {
        let _ = Command::new("git")
            .arg("config")
            .arg("--global")
            .arg(key)
            .arg(value)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
}

fn repo_proxy_values(git_domain: &str) -> Option<Vec<(String, String)>> {
    let raw = env::var("REPO_PROXY_CONFIG").ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    let object = value.as_object()?;
    let domain_config = object
        .get(git_domain)
        .or_else(|| object.get(&git_domain.to_ascii_lowercase()))
        .or_else(|| object.get("*"))?
        .as_object()?;
    let values = domain_config
        .iter()
        .filter_map(|(key, value)| {
            let key = key.to_ascii_lowercase();
            if key != "http.proxy" && key != "https.proxy" {
                return None;
            }
            value_string(value).map(|value| (key, value))
        })
        .collect::<Vec<_>>();
    (!values.is_empty()).then_some(values)
}

fn decrypt_sensitive_data(token: &str) -> Option<String> {
    if token.is_empty() || token == "***" {
        return Some(token.to_owned());
    }
    let key = env::var("GIT_TOKEN_AES_KEY")
        .unwrap_or_else(|_| "12345678901234567890123456789012".to_owned());
    let iv = env::var("GIT_TOKEN_AES_IV").unwrap_or_else(|_| "1234567890123456".to_owned());
    let Ok(encrypted) = general_purpose::STANDARD.decode(token.as_bytes()) else {
        return Some(token.to_owned());
    };
    let mut buffer = encrypted;
    let Ok(decryptor) = Aes256CbcDecryptor::new_from_slices(key.as_bytes(), iv.as_bytes()) else {
        return Some(token.to_owned());
    };
    let Ok(decrypted) = decryptor.decrypt_padded_mut::<Pkcs7>(&mut buffer) else {
        return Some(token.to_owned());
    };
    String::from_utf8(decrypted.to_vec())
        .ok()
        .or_else(|| Some(token.to_owned()))
}

fn extra_string(request: &ExecutionRequest, key: &str) -> Option<String> {
    request.extra.get(key).and_then(value_string)
}

fn domain_from_url(url: &str) -> Option<String> {
    let url = url
        .split("/-/")
        .next()
        .unwrap_or(url)
        .trim()
        .trim_start_matches("ssh://");

    if let Some((_, after_at)) = url.split_once('@') {
        let host = if after_at.contains('/') {
            after_at.split('/').next().unwrap_or(after_at)
        } else {
            after_at.split(':').next().unwrap_or(after_at)
        };
        return non_empty(host).map(ToOwned::to_owned);
    }

    let without_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let domain = without_scheme.split('/').next()?.split(':').next()?;
    non_empty(domain).map(ToOwned::to_owned)
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => non_empty(value).map(ToOwned::to_owned),
        Value::Number(_) | Value::Bool(_) => Some(value.to_string()),
        _ => None,
    }
}

fn stderr_summary(stderr: &str) -> String {
    let sanitized = stderr
        .split_whitespace()
        .map(redact_auth_fragment)
        .collect::<Vec<_>>()
        .join(" ");
    if sanitized.len() > 240 {
        format!("{}...", &sanitized[..240])
    } else {
        sanitized
    }
}

fn redact_auth_fragment(fragment: &str) -> String {
    if fragment.starts_with("ghp_")
        || fragment.starts_with("github_pat_")
        || fragment.starts_with("glpat-")
        || fragment.starts_with("gloas-")
    {
        return "***".to_owned();
    }
    fragment.to_owned()
}

fn yaml_scalar(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':'))
    {
        return value.to_owned();
    }
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    const TEST_GIT_DOMAIN: &str = "github.com";

    #[test]
    fn decrypt_git_token_matches_legacy_aes_cbc_fixture() {
        let _env = EnvGuard::set_many(&[
            ("GIT_TOKEN_AES_KEY", "12345678901234567890123456789012"),
            ("GIT_TOKEN_AES_IV", "1234567890123456"),
        ]);

        assert_eq!(
            decrypt_git_token("iOuoSwc/HrF6ZhttvtSNeQ==").as_deref(),
            Some("ghp_test_token")
        );
        assert!(is_token_encrypted("iOuoSwc/HrF6ZhttvtSNeQ=="));
        assert!(!is_token_encrypted("ghp_test_token"));
    }

    #[test]
    fn git_credentials_reports_safe_token_diagnostics() {
        let request = ExecutionRequest {
            extra: serde_json::Map::from_iter([(
                "user".to_owned(),
                json!({
                    "git_token": "glpat-secret",
                    "git_login": "oauth2"
                }),
            )]),
            ..ExecutionRequest::default()
        };

        let (credentials, diagnostics) =
            git_credentials_with_diagnostics("gitlab.com", &request).unwrap();

        assert_eq!(credentials.username, "oauth2");
        assert_eq!(credentials.token, "glpat-secret");
        assert_eq!(diagnostics.source, "request_user");
        assert!(!diagnostics.encrypted);
        assert_eq!(diagnostics.decrypt_success, None);
        assert_eq!(diagnostics.raw_len, "glpat-secret".len());
        assert_eq!(diagnostics.token_len, "glpat-secret".len());
        assert_eq!(diagnostics.token_fingerprint.len(), 12);
        assert_ne!(diagnostics.token_fingerprint, "glpat-secret");
    }

    #[test]
    fn git_credentials_reports_encrypted_token_decrypt_success() {
        let _env = EnvGuard::set_many(&[
            ("GIT_TOKEN_AES_KEY", "12345678901234567890123456789012"),
            ("GIT_TOKEN_AES_IV", "1234567890123456"),
        ]);
        let request = ExecutionRequest {
            extra: serde_json::Map::from_iter([(
                "user".to_owned(),
                json!({
                    "git_token": "iOuoSwc/HrF6ZhttvtSNeQ=="
                }),
            )]),
            ..ExecutionRequest::default()
        };

        let (credentials, diagnostics) =
            git_credentials_with_diagnostics("github.com", &request).unwrap();

        assert_eq!(credentials.token, "ghp_test_token");
        assert!(diagnostics.encrypted);
        assert_eq!(diagnostics.decrypt_success, Some(true));
        assert_eq!(diagnostics.token_len, "ghp_test_token".len());
    }

    #[test]
    fn git_credentials_reads_domain_token_file_from_home_ssh() {
        let temp_home =
            env::temp_dir().join(format!("wegent-git-auth-test-{}", std::process::id()));
        let ssh_dir = temp_home.join(".ssh");
        fs::create_dir_all(&ssh_dir).unwrap();
        fs::write(ssh_dir.join(TEST_GIT_DOMAIN), "file-token\n").unwrap();
        let _home = EnvGuard::set("HOME", temp_home.to_str().unwrap());

        let request = ExecutionRequest::default();
        let (credentials, diagnostics) =
            git_credentials_with_diagnostics(TEST_GIT_DOMAIN, &request).unwrap();

        assert_eq!(credentials.token, "file-token");
        assert_eq!(diagnostics.source, "home_ssh_domain_file");
        assert_eq!(diagnostics.raw_len, "file-token".len());
        let _ = fs::remove_dir_all(temp_home);
    }

    #[test]
    fn git_credentials_falls_back_to_token_file_when_request_token_is_masked() {
        let temp_home = env::temp_dir().join(format!(
            "wegent-git-auth-masked-test-{}",
            std::process::id()
        ));
        let ssh_dir = temp_home.join(".ssh");
        fs::create_dir_all(&ssh_dir).unwrap();
        fs::write(ssh_dir.join(TEST_GIT_DOMAIN), "file-token\n").unwrap();
        let _home = EnvGuard::set("HOME", temp_home.to_str().unwrap());
        let request = ExecutionRequest {
            extra: serde_json::Map::from_iter([(
                "user".to_owned(),
                json!({
                    "git_token": "***",
                    "git_login": "oauth2"
                }),
            )]),
            ..ExecutionRequest::default()
        };

        let (credentials, diagnostics) =
            git_credentials_with_diagnostics(TEST_GIT_DOMAIN, &request).unwrap();

        assert_eq!(credentials.token, "file-token");
        assert_eq!(credentials.username, "oauth2");
        assert_eq!(diagnostics.source, "home_ssh_domain_file");
        let _ = fs::remove_dir_all(temp_home);
    }

    struct EnvGuard {
        previous: Vec<(&'static str, Option<String>)>,
        _guard: MutexGuard<'static, ()>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            Self::set_many(&[(key, value)])
        }

        fn set_many(values: &[(&'static str, &str)]) -> Self {
            let guard = env_lock().lock().unwrap();
            let previous = values
                .iter()
                .map(|(key, value)| {
                    let previous = env::var(key).ok();
                    env::set_var(key, value);
                    (*key, previous)
                })
                .collect();
            Self {
                previous,
                _guard: guard,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, previous) in self.previous.iter().rev() {
                if let Some(previous) = previous {
                    env::set_var(key, previous);
                } else {
                    env::remove_var(key);
                }
            }
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }
}
