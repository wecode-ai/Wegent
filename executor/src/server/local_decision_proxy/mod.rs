// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Executor-owned configuration for the Wework decision router.
//!
//! The decision upstream, the model catalogue, and the upstream credential are
//! trusted Executor configuration. A Smart App may read the catalogue from
//! `GET .../status` and name one of the allowlisted models in a request, but it
//! can never move the upstream, widen the allowlist, or see the credential.

// The routing work that consumes these types lands in follow-up changes; until
// then the module is intentionally unreferenced.
#![allow(dead_code, unused_imports)]

mod protocol;
mod registry;

pub(crate) use protocol::{
    DecisionModel, DecisionProxyErrorBody, DecisionProxyErrorPayload, DecisionRequest,
    DecisionStatusResponse, DECISION_PROXY_PROTOCOL_VERSION,
};

use std::{collections::HashSet, env, fmt};

use url::Url;

use crate::logging::log_executor_event;

/// Local placeholder marker used by every Wework built-in local proxy route.
///
/// It travels as `Authorization: Bearer <value>` and is a protocol marker, not
/// a security boundary: the opaque route token in the URL is the capability.
pub(crate) const LOCAL_AUTHORIZATION_VALUE: &str = "wework-local-router";

/// Upstream path that decision requests are always forwarded to.
pub(crate) const UPSTREAM_PATH: &str = "/v1/decisions";

/// Hosts allowed for the decision upstream.
///
/// The upstream is fixed by trusted configuration; this list is defense in
/// depth against a mis-edited deployment value.
const ALLOWED_UPSTREAM_HOSTS: &[&str] = &["copilot.weibo.com"];

const ENV_ENABLED: &str = "WEWORK_DECISION_PROXY_ENABLED";
const ENV_UPSTREAM_URL: &str = "WEWORK_DECISION_PROXY_UPSTREAM_URL";
const ENV_DEFAULT_MODEL: &str = "WEWORK_DECISION_PROXY_DEFAULT_MODEL";
const ENV_ALLOWED_MODELS_JSON: &str = "WEWORK_DECISION_PROXY_ALLOWED_MODELS_JSON";
const ENV_CREDENTIAL: &str = "WEWORK_DECISION_PROXY_CREDENTIAL";
const ENV_STATIC_CREDENTIAL: &str = "WEWORK_DECISION_PROXY_API_KEY";

/// Where the upstream credential comes from.
///
/// [REV-D3] The first version defaults to [`Self::Static`]: the platform
/// decision credential belongs to `copilot.weibo.com` and is unrelated to the
/// Wework user session token used for the Wegent backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DecisionCredentialMode {
    /// Executor-controlled platform credential, read per request.
    Static,
    /// Current Wework login snapshot (`ConnectionConfig.auth_token`).
    Login,
}

/// Parsed, validated decision proxy configuration.
///
/// Disabled and enabled configurations are different shapes rather than one
/// struct with an optional upstream, so handlers cannot fall back to a
/// half-configured upstream.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum DecisionProxyConfig {
    Disabled,
    Enabled(DecisionProxySettings),
}

/// Trusted settings used once the decision proxy is enabled.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DecisionProxySettings {
    pub upstream_url: Url,
    pub default_model: String,
    pub models: Vec<DecisionModel>,
    pub credential: DecisionCredentialMode,
}

/// Static, client-safe reason for a rejected configuration.
///
/// The reason never echoes an environment value, so log lines and error
/// messages cannot leak the upstream URL or a credential embedded in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DecisionProxyConfigError {
    reason: &'static str,
}

impl DecisionProxyConfigError {
    const fn new(reason: &'static str) -> Self {
        Self { reason }
    }

    pub(crate) const fn reason(self) -> &'static str {
        self.reason
    }
}

impl fmt::Display for DecisionProxyConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid decision proxy configuration: {}",
            self.reason
        )
    }
}

impl std::error::Error for DecisionProxyConfigError {}

impl DecisionProxyConfig {
    /// Reads the configuration from the Executor process environment.
    pub(crate) fn from_env() -> Result<Self, DecisionProxyConfigError> {
        Self::from_lookup(|name| env::var(name).ok())
    }

    /// Whether route registration and HTTP handling are open.
    pub(crate) const fn enabled(&self) -> bool {
        matches!(self, Self::Enabled(_))
    }

    /// Registered settings, or `None` while the proxy is disabled.
    pub(crate) fn settings(&self) -> Option<&DecisionProxySettings> {
        match self {
            Self::Disabled => None,
            Self::Enabled(settings) => Some(settings),
        }
    }

    fn from_lookup<F>(lookup: F) -> Result<Self, DecisionProxyConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let enabled = lookup(ENV_ENABLED).is_some_and(|value| is_truthy_flag(&value));
        if !enabled {
            return Ok(Self::Disabled);
        }

        let upstream = lookup(ENV_UPSTREAM_URL)
            .ok_or_else(|| DecisionProxyConfigError::new("missing_upstream_url"))?;
        let upstream_url = parse_upstream_url(&upstream)?;

        let default_model = lookup(ENV_DEFAULT_MODEL)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| DecisionProxyConfigError::new("missing_default_model"))?;

        let models = parse_allowed_models(lookup(ENV_ALLOWED_MODELS_JSON).as_deref())?;
        if !models.iter().any(|model| model.id == default_model) {
            return Err(DecisionProxyConfigError::new("default_model_not_allowed"));
        }

        let credential = parse_credential_mode(lookup(ENV_CREDENTIAL).as_deref())?;

        Ok(Self::Enabled(DecisionProxySettings {
            upstream_url,
            default_model,
            models,
            credential,
        }))
    }
}

/// Reads the platform decision credential used by [`DecisionCredentialMode::Static`].
///
/// Returns `None` when the deployment has not provided one, so callers answer
/// `credential_unavailable` instead of calling the upstream unauthenticated.
pub(crate) fn static_credential_from_env() -> Option<String> {
    env::var(ENV_STATIC_CREDENTIAL)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Logs the startup summary. Tokens, the upstream URL, and the model catalogue
/// contents stay out of the log.
pub(crate) fn log_config_summary(config: &DecisionProxyConfig) {
    match config {
        DecisionProxyConfig::Disabled => {
            log_executor_event("decision_proxy.config", &[("enabled", "false".to_owned())])
        }
        DecisionProxyConfig::Enabled(settings) => log_executor_event(
            "decision_proxy.config",
            &[
                ("enabled", "true".to_owned()),
                ("model_count", settings.models.len().to_string()),
                ("upstream_host", safe_url(&settings.upstream_url)),
            ],
        ),
    }
}

fn is_truthy_flag(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn parse_credential_mode(
    raw: Option<&str>,
) -> Result<DecisionCredentialMode, DecisionProxyConfigError> {
    match raw.map(str::trim) {
        None | Some("") => Ok(DecisionCredentialMode::Static),
        Some(value) => match value.to_ascii_lowercase().as_str() {
            "static" => Ok(DecisionCredentialMode::Static),
            "login" => Ok(DecisionCredentialMode::Login),
            _ => Err(DecisionProxyConfigError::new("invalid_credential_mode")),
        },
    }
}

fn parse_upstream_url(raw: &str) -> Result<Url, DecisionProxyConfigError> {
    let invalid = || DecisionProxyConfigError::new("invalid_upstream_url");
    let url = Url::parse(raw.trim()).map_err(|_| invalid())?;
    let host_allowed = url
        .host_str()
        .is_some_and(|host| ALLOWED_UPSTREAM_HOSTS.contains(&host));
    if url.scheme() != "https"
        || !host_allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != UPSTREAM_PATH
    {
        return Err(invalid());
    }
    Ok(url)
}

fn parse_allowed_models(raw: Option<&str>) -> Result<Vec<DecisionModel>, DecisionProxyConfigError> {
    let invalid = || DecisionProxyConfigError::new("invalid_allowed_models");
    let ids: Vec<String> = serde_json::from_str(raw.ok_or_else(invalid)?).map_err(|_| invalid())?;
    if ids.is_empty() {
        return Err(invalid());
    }

    let mut seen = HashSet::with_capacity(ids.len());
    let mut models = Vec::with_capacity(ids.len());
    for id in ids {
        let id = id.trim().to_owned();
        if id.is_empty() || !seen.insert(id.clone()) {
            return Err(invalid());
        }
        models.push(DecisionModel {
            display_name: id.clone(),
            id,
        });
    }
    Ok(models)
}

/// Renders `scheme://host[:port]/path` so log lines never carry credentials,
/// query parameters, or fragments.
fn safe_url(url: &Url) -> String {
    let host = url.host_str().unwrap_or("<invalid-host>");
    match url.port() {
        Some(port) => format!("{}://{}:{}{}", url.scheme(), host, port, url.path()),
        None => format!("{}://{}{}", url.scheme(), host, url.path()),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const VALID_UPSTREAM: &str = "https://copilot.weibo.com/v1/decisions";

    fn config_from(
        entries: &[(&str, &str)],
    ) -> Result<DecisionProxyConfig, DecisionProxyConfigError> {
        let map: HashMap<String, String> = entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        DecisionProxyConfig::from_lookup(|name| map.get(name).cloned())
    }

    fn enabled_settings(entries: &[(&str, &str)]) -> DecisionProxySettings {
        match config_from(entries).expect("config must be valid") {
            DecisionProxyConfig::Enabled(settings) => settings,
            DecisionProxyConfig::Disabled => panic!("expected an enabled config"),
        }
    }

    fn upstream_entries(upstream: &str) -> [(&str, &str); 4] {
        [
            (ENV_ENABLED, "true"),
            (ENV_UPSTREAM_URL, upstream),
            (ENV_DEFAULT_MODEL, "model-a"),
            (ENV_ALLOWED_MODELS_JSON, r#"["model-a"]"#),
        ]
    }

    fn model_entries<'a>(allowed: &'a str, default: &'a str) -> [(&'a str, &'a str); 4] {
        [
            (ENV_ENABLED, "true"),
            (ENV_UPSTREAM_URL, VALID_UPSTREAM),
            (ENV_DEFAULT_MODEL, default),
            (ENV_ALLOWED_MODELS_JSON, allowed),
        ]
    }

    #[test]
    fn flag_absent_or_false_disables_the_proxy() {
        assert_eq!(
            config_from(&[]).expect("empty environment is valid"),
            DecisionProxyConfig::Disabled
        );
        for value in ["false", "0", "no", "off", "  FALSE "] {
            assert_eq!(
                config_from(&[(ENV_ENABLED, value)]).expect("false flag is valid"),
                DecisionProxyConfig::Disabled,
                "value={value}"
            );
        }
    }

    #[test]
    fn enabled_without_upstream_is_invalid() {
        let error = config_from(&[
            (ENV_ENABLED, "true"),
            (ENV_DEFAULT_MODEL, "model-a"),
            (ENV_ALLOWED_MODELS_JSON, r#"["model-a"]"#),
        ])
        .expect_err("upstream is required when enabled");
        assert_eq!(error.reason(), "missing_upstream_url");
    }

    #[test]
    fn upstream_must_be_a_plain_https_decisions_url() {
        for upstream in [
            "http://copilot.weibo.com/v1/decisions",
            "ftp://copilot.weibo.com/v1/decisions",
            "https://user:secret@copilot.weibo.com/v1/decisions",
            "https://copilot.weibo.com/v1/decisions?x=1",
            "https://copilot.weibo.com/v1/decisions#fragment",
            "https://copilot.weibo.com/v1/decisions/",
            "https://copilot.weibo.com/v1/other",
            "https://copilot.weibo.com/",
            "https://evil.example.com/v1/decisions",
            "not-a-url",
        ] {
            let error = config_from(&upstream_entries(upstream)).expect_err(upstream);
            assert_eq!(
                error.reason(),
                "invalid_upstream_url",
                "upstream={upstream}"
            );
        }
    }

    #[test]
    fn default_model_must_be_present_and_non_blank() {
        for default in ["", "   "] {
            let error = config_from(&model_entries(r#"["model-a"]"#, default))
                .expect_err("blank default model");
            assert_eq!(
                error.reason(),
                "missing_default_model",
                "default={default:?}"
            );
        }
        let error = config_from(&[
            (ENV_ENABLED, "true"),
            (ENV_UPSTREAM_URL, VALID_UPSTREAM),
            (ENV_ALLOWED_MODELS_JSON, r#"["model-a"]"#),
        ])
        .expect_err("missing default model");
        assert_eq!(error.reason(), "missing_default_model");
    }

    #[test]
    fn allowed_models_must_be_a_json_string_array() {
        for allowed in [
            r#""model-a""#,
            r#"{"model-a": true}"#,
            r#"["model-a", 1]"#,
            r#"[["model-a"]]"#,
            "not json",
        ] {
            let error = config_from(&model_entries(allowed, "model-a")).expect_err(allowed);
            assert_eq!(
                error.reason(),
                "invalid_allowed_models",
                "allowed={allowed}"
            );
        }
        let error = config_from(&[
            (ENV_ENABLED, "true"),
            (ENV_UPSTREAM_URL, VALID_UPSTREAM),
            (ENV_DEFAULT_MODEL, "model-a"),
        ])
        .expect_err("missing allowed models");
        assert_eq!(error.reason(), "invalid_allowed_models");
    }

    #[test]
    fn allowed_models_must_be_non_empty_unique_and_non_blank() {
        for allowed in [
            r#"[]"#,
            r#"[""]"#,
            r#"["   "]"#,
            r#"["model-a", "model-a"]"#,
            r#"["model-a", " model-a "]"#,
        ] {
            let error = config_from(&model_entries(allowed, "model-a")).expect_err(allowed);
            assert_eq!(
                error.reason(),
                "invalid_allowed_models",
                "allowed={allowed}"
            );
        }
    }

    #[test]
    fn default_model_must_be_allowed() {
        let error = config_from(&model_entries(r#"["model-a", "model-b"]"#, "model-z"))
            .expect_err("default model must be allowlisted");
        assert_eq!(error.reason(), "default_model_not_allowed");
    }

    #[test]
    fn valid_config_parses_into_stable_settings() {
        let entries = model_entries(r#"["model-a", "model-b"]"#, "model-a");
        let first = enabled_settings(&entries);
        let second = enabled_settings(&entries);
        assert_eq!(first, second);
        assert_eq!(first.upstream_url.as_str(), VALID_UPSTREAM);
        assert_eq!(first.default_model, "model-a");
        assert_eq!(first.credential, DecisionCredentialMode::Static);
        assert_eq!(
            first.models,
            vec![
                DecisionModel {
                    id: "model-a".to_owned(),
                    display_name: "model-a".to_owned(),
                },
                DecisionModel {
                    id: "model-b".to_owned(),
                    display_name: "model-b".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn credential_mode_defaults_to_static_and_accepts_login() {
        let default = enabled_settings(&model_entries(r#"["model-a"]"#, "model-a"));
        assert_eq!(default.credential, DecisionCredentialMode::Static);

        for (value, expected) in [
            ("static", DecisionCredentialMode::Static),
            ("STATIC", DecisionCredentialMode::Static),
            ("login", DecisionCredentialMode::Login),
            (" Login ", DecisionCredentialMode::Login),
        ] {
            let entries = [
                (ENV_ENABLED, "true"),
                (ENV_UPSTREAM_URL, VALID_UPSTREAM),
                (ENV_DEFAULT_MODEL, "model-a"),
                (ENV_ALLOWED_MODELS_JSON, r#"["model-a"]"#),
                (ENV_CREDENTIAL, value),
            ];
            assert_eq!(
                enabled_settings(&entries).credential,
                expected,
                "value={value}"
            );
        }
    }

    #[test]
    fn unknown_credential_mode_is_invalid() {
        let entries = [
            (ENV_ENABLED, "true"),
            (ENV_UPSTREAM_URL, VALID_UPSTREAM),
            (ENV_DEFAULT_MODEL, "model-a"),
            (ENV_ALLOWED_MODELS_JSON, r#"["model-a"]"#),
            (ENV_CREDENTIAL, "keychain"),
        ];
        assert_eq!(
            config_from(&entries)
                .expect_err("unknown credential mode")
                .reason(),
            "invalid_credential_mode"
        );
    }

    #[test]
    fn enabled_flag_accepts_documented_truthy_values() {
        for value in ["true", "TRUE", "1", "yes", "on", "  On  "] {
            let entries = [
                (ENV_ENABLED, value),
                (ENV_UPSTREAM_URL, VALID_UPSTREAM),
                (ENV_DEFAULT_MODEL, "model-a"),
                (ENV_ALLOWED_MODELS_JSON, r#"["model-a"]"#),
            ];
            let settings = enabled_settings(&entries);
            assert_eq!(settings.default_model, "model-a", "value={value}");
        }
    }

    #[test]
    fn config_error_display_never_leaks_the_upstream_value() {
        let error = config_from(&upstream_entries(
            "https://user:secret@copilot.weibo.com/v1/decisions",
        ))
        .expect_err("invalid upstream");
        let text = error.to_string();
        assert!(!text.contains("secret"), "error leaked a value: {text}");
        assert!(
            !text.contains("copilot.weibo.com"),
            "error leaked a value: {text}"
        );
    }

    #[test]
    fn safe_url_strips_credentials_query_and_fragment() {
        let url = url::Url::parse("https://user:secret@example.com:8443/v1/decisions?x=1#frag")
            .expect("parse url");
        let safe = safe_url(&url);
        assert_eq!(safe, "https://example.com:8443/v1/decisions");
        assert!(!safe.contains("secret"));
        assert!(!safe.contains("x=1"));
    }
}
