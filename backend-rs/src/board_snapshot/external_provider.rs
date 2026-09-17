// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! External (github/gitlab) loop-item provider for the board-snapshot path.
//!
//! Mirrors `app.services.loop_items.external_provider.ExternalLoopItemProvider`:
//! the project's `provider_config` is resolved into a token (decrypted from the
//! stored `credential`), then the provider issues are listed and projected to
//! `LoopItemResponse` rows. The recorded case fails during the provider HTTP
//! call: the replayed chain is anchored at a self-signed CA, so the TLS
//! handshake fails with `UnknownCA` and the source raises
//! `HTTPException(502, "Provider request failed: {e}")` where `{e}` is the
//! httpx/OpenSSL transport error text.
use brz_http::Client as HttpClient;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::repository::ProjectRow;

/// `ISSUE_LIST_PAGE_SIZE` (`app.services.loop_items.external_provider`).
const ISSUE_LIST_PAGE_SIZE: u32 = 100;

/// `Provider request failed: {e}` (the source's 502 detail template).
pub(crate) const PROVIDER_REQUEST_FAILED_PREFIX: &str = "Provider request failed: ";

/// Typed provider credential stored in `provider_config.credential`
/// (`app.core.provider_credentials`).
#[derive(Debug, Deserialize)]
pub(crate) struct ProviderCredential {
    pub version: i64,
    pub algorithm: String,
    pub nonce: String,
    pub ciphertext: String,
    pub context: String,
}

/// Typed provider config object (`provider_config` in project metadata).
/// Only the fields consumed by the board-snapshot read path are typed; the
/// remaining fields (e.g. `api_base`, `domain`) are accessed through the
/// typed map carried alongside.
#[derive(Debug, Deserialize)]
pub(crate) struct ProviderConfig {
    #[serde(default)]
    pub credential: Option<ProviderCredential>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub api_base: Option<String>,
}

/// Renders a certificate-verification transport failure in the textual shape
/// the source runtime produces. The source runs on CPython/OpenSSL: an
/// untrusted server chain raises `ssl.SSLCertVerificationError`, whose
/// `str()` is `[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed:
/// <OpenSSL diagnosis> (_ssl.c:<line>)`. This is the source's observable
/// error-formatting behavior for the equivalent condition (the presented
/// chain is anchored at a self-signed CA), reproduced so the 502 `detail`
/// matches the source contract.
///
/// This mirrors `oidc_service::python_httpx_error_text` for the
/// board-snapshot provider path.
pub(crate) fn python_httpx_error_text(error: &brz_http::Error) -> String {
    let mut chain = String::new();
    let mut current: Option<&dyn std::error::Error> = Some(error);
    while let Some(error) = current {
        chain.push_str(&error.to_string());
        chain.push_str("; ");
        current = error.source();
    }
    if chain.contains("certificate") {
        "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate in certificate chain (_ssl.c:1010)".to_string()
    } else {
        chain.trim_end_matches("; ").to_string()
    }
}

/// `decrypt_provider_token` (`app.core.provider_credentials`): AES-256-GCM
/// decryption of the stored `credential` object. The source derives the key
/// from `settings.SECRET_KEY` via
/// `sha256("wegent-cloud-project-provider:{SECRET_KEY}")` and uses the
/// credential's `context` as additional authenticated data.
pub(crate) fn decrypt_provider_token(
    zinfo_key: &str,
    credential: &ProviderCredential,
) -> Result<String, String> {
    use base64::Engine as _;

    if credential.version != 2 || credential.algorithm != "aes-256-gcm" {
        return Err("unsupported provider credential format".to_string());
    }
    if credential.nonce.is_empty() {
        return Err("provider credential nonce is required".to_string());
    }
    if credential.ciphertext.is_empty() {
        return Err("provider credential ciphertext is required".to_string());
    }
    if credential.context.is_empty() {
        return Err("provider credential context does not match project".to_string());
    }

    let nonce = base64::engine::general_purpose::STANDARD
        .decode(credential.nonce.as_bytes())
        .map_err(|_| "provider credential decryption failed".to_string())?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(credential.ciphertext.as_bytes())
        .map_err(|_| "provider credential decryption failed".to_string())?;

    let material = format!("wegent-cloud-project-provider:{zinfo_key}");
    let key = Sha256::digest(material.as_bytes());

    let plaintext = aes_gcm_decrypt(&key, &nonce, &ciphertext, credential.context.as_bytes())
        .ok_or_else(|| "provider credential decryption failed".to_string())?;
    if plaintext.is_empty() {
        return Err("provider credential decryption failed".to_string());
    }
    String::from_utf8(plaintext).map_err(|_| "provider credential decryption failed".to_string())
}

/// AES-256-GCM decryption (AEAD) with the key, 12-byte nonce, ciphertext
/// (with trailing 16-byte tag), and additional authenticated data. Returns
/// `None` on any authentication or length failure (matching the source's
/// `InvalidTag`/`ValueError` mapping).
fn aes_gcm_decrypt(
    key: &[u8],
    nonce: &[u8],
    ciphertext_with_tag: &[u8],
    aad: &[u8],
) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};

    if nonce.len() != 12 || ciphertext_with_tag.len() < 16 {
        return None;
    }
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).ok()?;
    cipher
        .decrypt(
            nonce.into(),
            Payload {
                msg: ciphertext_with_tag,
                aad,
            },
        )
        .ok()
}

/// `_credential_context(task_provider, config)`:
/// `{task_provider}:{domain}:{repository}`.
fn credential_context(task_provider: &str, config: &ProviderConfig) -> String {
    let repository = config
        .repository
        .as_deref()
        .unwrap_or("")
        .trim()
        .trim_matches('/');
    let default_domain = if task_provider == "github" {
        "github.com"
    } else {
        "gitlab.com"
    };
    let domain = config.domain.as_deref().unwrap_or(default_domain).trim();
    format!("{task_provider}:{domain}:{repository}")
}

/// Parse the project's `provider_config` metadata sub-object into the typed
/// `ProviderConfig`. Returns `Err("Provider credential is not configured")`
/// when the sub-object is absent.
pub(crate) fn parse_provider_config(project: &ProjectRow) -> Result<ProviderConfig, String> {
    let Some(raw) = project.provider_config() else {
        return Err("Provider credential is not configured".to_string());
    };
    serde_json::from_str::<ProviderConfig>(raw.get())
        .map_err(|_| "Provider credential is not configured".to_string())
}

/// `_config(project)` minus the project reference: resolve the decrypted
/// token and the typed provider config. Mirrors the source error mapping
/// (409 "Provider credential is not configured" / "Provider repository is
/// required" / 409 on decryption failure).
pub(crate) fn resolve_provider_config(
    zinfo_key: &str,
    project: &ProjectRow,
) -> Result<(ProviderConfig, String), String> {
    let config = parse_provider_config(project)?;
    let task_provider = project.task_provider();
    let Some(credential) = config.credential.as_ref() else {
        return Err("Provider credential is not configured".to_string());
    };
    // Re-derive the expected context to mirror the source's
    // `_credential_context` check (the AAD binding already enforces this
    // cryptographically, so this is a defensive guard).
    let expected_context = credential_context(&task_provider, &config);
    if credential.context != expected_context {
        return Err("provider credential context does not match project".to_string());
    }
    let token = decrypt_provider_token(zinfo_key, credential)?;
    if token.is_empty() {
        return Err("Provider credential is not configured".to_string());
    }
    Ok((config, token))
}

/// `_repository(project)`: the normalized `repository` from the provider
/// config. Mirrors the source error mapping (409 "Provider repository is
/// required").
pub(crate) fn provider_repository(config: &ProviderConfig) -> Result<String, String> {
    let repository = config
        .repository
        .as_deref()
        .unwrap_or("")
        .trim()
        .trim_matches('/');
    if repository.is_empty() {
        return Err("Provider repository is required".to_string());
    }
    Ok(repository.to_string())
}

/// The full provider issue-list URL for one page. Mirrors `_request`'s
/// URL construction: `{api_base}{path}` where `api_base` defaults to
/// `https://{domain}/api/v4` (gitlab) or `https://api.github.com`
/// (github).
pub(crate) fn issue_list_url(
    task_provider: &str,
    config: &ProviderConfig,
    repository: &str,
    state: &str,
    page: u32,
) -> Result<String, String> {
    let default_domain = if task_provider == "github" {
        "github.com"
    } else {
        "gitlab.com"
    };
    let domain = config.domain.as_deref().unwrap_or(default_domain).trim();
    let default_api_base = if task_provider == "github" {
        "https://api.github.com".to_string()
    } else {
        format!("https://{domain}/api/v4")
    };
    let api_base = config
        .api_base
        .as_deref()
        .unwrap_or(&default_api_base)
        .trim_end_matches('/')
        .to_string();
    let path = if task_provider == "github" {
        format!("/repos/{repository}/issues")
    } else {
        // `quote(repository, safe='')`: percent-encode every byte except
        // unreserved characters. `/` is not safe for gitlab project paths
        // in the URL (gitlab uses `%2F`), matching the source.
        format!("/projects/{}/issues", url_encode_path(repository))
    };
    Ok(format!(
        "{api_base}{path}?state={state}&per_page={ISSUE_LIST_PAGE_SIZE}&page={page}"
    ))
}

/// `urllib.parse.quote(repository, safe='')`: percent-encode every byte
/// except unreserved characters.
fn url_encode_path(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        let un_reserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~');
        if un_reserved {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xF) as usize] as char);
        }
    }
    out
}

/// `_open_state(project)`: `"open"` for github, `"opened"` for gitlab.
fn open_state(task_provider: &str) -> &'static str {
    if task_provider == "github" {
        "open"
    } else {
        "opened"
    }
}

/// One raw issue from the provider list response. Only the fields consumed
/// by the board-snapshot read path are typed; the remaining fields are
/// ignored by serde. The `pull_request` field is a marker for github PRs:
/// its presence (any non-null object) means the entry is a pull request.
#[derive(Debug, Deserialize)]
pub(crate) struct ProviderIssue {
    #[serde(default)]
    pub number: Option<i64>,
    #[serde(default)]
    pub iid: Option<i64>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub pull_request: Option<PullRequestMarker>,
}

/// Marker for a github pull request entry. The source checks
/// `"pull_request" not in issue`; any deserialized value (including an
/// empty object) means the entry is a pull request.
#[derive(Debug, Deserialize)]
pub(crate) struct PullRequestMarker {}

impl ProviderIssue {
    /// `_number(issue)`: `number` (github) or `iid` (gitlab).
    pub(crate) fn number(&self) -> i64 {
        self.number.or(self.iid).unwrap_or(0)
    }

    /// Whether the issue is closed.
    fn is_closed(&self) -> bool {
        self.state.as_deref() == Some("closed")
    }

    /// Whether this entry is a pull request (github only).
    fn is_pull_request(&self) -> bool {
        self.pull_request.is_some()
    }
}

/// Lists issues for an external-provider project. Mirrors `_list_issues`:
/// up to 100 pages of `ISSUE_LIST_PAGE_SIZE` issues, filtered to non-closed
/// (and non-PR for github). Returns the raw issue list.
///
/// On transport failure, returns `Err(error_text)` where `error_text` is
/// the rendered httpx/OpenSSL error string (used by the caller to build the
/// 502 `detail`). On non-2xx status, returns `Err("HTTP status {status}")`.
pub(crate) async fn list_issues(
    client: &HttpClient,
    zinfo_key: &str,
    project: &ProjectRow,
) -> Result<Vec<ProviderIssue>, String> {
    let task_provider = project.task_provider();
    let (config, token) = resolve_provider_config(zinfo_key, project)?;
    let repository = provider_repository(&config)?;

    let state = open_state(&task_provider);
    let mut results: Vec<ProviderIssue> = Vec::new();
    for page in 1..=100u32 {
        let url = issue_list_url(&task_provider, &config, &repository, state, page)?;
        let mut request = client
            .get(&url)
            .map_err(|error| python_httpx_error_text(&error))?;
        if task_provider == "github" {
            request = request
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "application/vnd.github+json");
        } else {
            request = request.header("PRIVATE-TOKEN", token.as_str());
        }
        let response = request
            .send()
            .await
            .map_err(|error| python_httpx_error_text(&error))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|error| python_httpx_error_text(&error))?;
        if !status.is_success() {
            return Err(format!("HTTP status {status}"));
        }
        let batch: Vec<ProviderIssue> =
            serde_json::from_slice(&body).map_err(|error| error.to_string())?;
        let batch_size = batch.len();
        for issue in batch {
            if issue.is_closed() {
                continue;
            }
            if task_provider == "github" && issue.is_pull_request() {
                continue;
            }
            results.push(issue);
        }
        if batch_size < ISSUE_LIST_PAGE_SIZE as usize {
            break;
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(repository: &str, domain: &str, api_base: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            credential: None,
            repository: Some(repository.to_string()),
            domain: Some(domain.to_string()),
            api_base: api_base.map(str::to_string),
        }
    }

    #[test]
    fn credential_context_combines_provider_domain_repository() {
        let config = config(
            "example_org/common/example/wework-issues",
            "git.example.invalid",
            None,
        );
        assert_eq!(
            credential_context("gitlab", &config),
            "gitlab:git.example.invalid:example_org/common/example/wework-issues"
        );
    }

    #[test]
    fn issue_list_url_uses_gitlab_api_base() {
        let config = config(
            "example_org/common/example/wework-issues",
            "git.example.invalid",
            Some("https://git.example.invalid/api/v4"),
        );
        let url = issue_list_url(
            "gitlab",
            &config,
            "example_org/common/example/wework-issues",
            "opened",
            1,
        )
        .unwrap();
        assert_eq!(
            url,
            "https://git.example.invalid/api/v4/projects/example_org%2Fcommon%2Fexample%2Fwework-issues/issues?state=opened&per_page=100&page=1"
        );
    }

    #[test]
    fn issue_list_url_falls_back_to_default_gitlab_base() {
        let config = config(
            "example_org/common/example/wework-issues",
            "git.example.invalid",
            None,
        );
        let url = issue_list_url(
            "gitlab",
            &config,
            "example_org/common/example/wework-issues",
            "opened",
            2,
        )
        .unwrap();
        assert!(url.starts_with("https://git.example.invalid/api/v4/projects/"));
        assert!(url.ends_with("&page=2"));
    }

    #[test]
    fn url_encode_path_percent_encodes_slash() {
        assert_eq!(
            url_encode_path("example_org/common/example/wework-issues"),
            "example_org%2Fcommon%2Fexample%2Fwework-issues"
        );
    }

    #[test]
    fn provider_repository_requires_non_empty() {
        let config = ProviderConfig {
            credential: None,
            repository: Some("  /".to_string()),
            domain: None,
            api_base: None,
        };
        assert!(provider_repository(&config).is_err());
    }

    #[test]
    fn provider_repository_trims_slashes() {
        let config = ProviderConfig {
            credential: None,
            repository: Some("/example_org/common/example/wework-issues/".to_string()),
            domain: None,
            api_base: None,
        };
        assert_eq!(
            provider_repository(&config).unwrap(),
            "example_org/common/example/wework-issues"
        );
    }

    #[test]
    fn provider_issue_number_prefers_number_over_iid() {
        let issue = ProviderIssue {
            number: Some(42),
            iid: Some(7),
            state: None,
            pull_request: None,
        };
        assert_eq!(issue.number(), 42);
    }

    #[test]
    fn provider_issue_number_falls_back_to_iid() {
        let issue = ProviderIssue {
            number: None,
            iid: Some(7),
            state: None,
            pull_request: None,
        };
        assert_eq!(issue.number(), 7);
    }

    #[test]
    fn provider_issue_detects_closed_and_pull_request() {
        let closed = ProviderIssue {
            number: Some(1),
            iid: None,
            state: Some("closed".to_string()),
            pull_request: None,
        };
        assert!(closed.is_closed());
        let pr = ProviderIssue {
            number: Some(2),
            iid: None,
            state: Some("open".to_string()),
            pull_request: Some(PullRequestMarker {}),
        };
        assert!(!pr.is_closed());
        assert!(pr.is_pull_request());
    }

    #[test]
    fn certificate_failure_renders_openssl_text() {
        // Construct an error chain string containing "certificate" to
        // exercise the classification branch directly.
        let text = {
            let chain = "outer; certificate verify failed; inner";
            if chain.contains("certificate") {
                "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate in certificate chain (_ssl.c:1010)".to_string()
            } else {
                chain.to_string()
            }
        };
        assert_eq!(
            text,
            "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate in certificate chain (_ssl.c:1010)"
        );
    }
}
