// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Prepare the desktop-managed interpreter before Python plugin execution.

use std::{env, net::Ipv4Addr, net::Ipv6Addr, time::Duration};

use reqwest::{redirect::Policy, Url};
use serde::Deserialize;
use serde_json::Value;
use tokio::process::Command;

const RUNTIME_URL_ENV: &str = "WEWORK_PYTHON_RUNTIME_URL";
const RUNTIME_TOKEN_ENV: &str = "WEWORK_PYTHON_RUNTIME_TOKEN";
const ENSURE_PATH: &str = "/runtime/python/ensure";
pub(crate) const PYTHON_RUNTIME_ENSURE_TIMEOUT_SECONDS: u64 = 13 * 60;

pub(crate) fn managed_python_bridge_configured() -> bool {
    env::var_os(RUNTIME_URL_ENV).is_some() || env::var_os(RUNTIME_TOKEN_ENV).is_some()
}

#[derive(Deserialize)]
struct PreparationResponse {
    ok: bool,
    data: Option<Value>,
}

pub(crate) async fn ensure_managed_python() -> Result<(), String> {
    let url = configured_value(RUNTIME_URL_ENV)?;
    let token = configured_value(RUNTIME_TOKEN_ENV)?;
    ensure_configured_python(url.as_deref(), token.as_deref()).await
}

pub(crate) fn is_python_program(program: &str) -> bool {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let name = name.to_ascii_lowercase();
    if name.ends_with(".py") {
        return true;
    }
    let name = name.strip_suffix(".exe").unwrap_or(&name);
    if matches!(name, "python" | "pythonw") {
        return true;
    }
    let Some(version) = name.strip_prefix("python") else {
        return false;
    };
    let version = version.strip_prefix('w').unwrap_or(version);
    let mut parts = version.split('.');
    parts.next() == Some("3")
        && parts.all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

pub(crate) fn isolate_python_environment(command: &mut Command) {
    let inherited = env::vars_os().map(|(name, _)| name);
    let configured = command.as_std().get_envs().map(|(name, _)| name.to_owned());
    let names: Vec<_> = inherited
        .chain(configured)
        .filter(|name| {
            name.to_str().is_some_and(|name| {
                [
                    "PYTHONHOME",
                    "PYTHONPATH",
                    "PYTHONUSERBASE",
                    "PYTHONNOUSERSITE",
                ]
                .iter()
                .any(|blocked| name.eq_ignore_ascii_case(blocked))
            })
        })
        .collect();
    for name in names {
        command.env_remove(name);
    }
    command.env("PYTHONNOUSERSITE", "1");
}

fn configured_value(name: &str) -> Result<Option<String>, String> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => {
            Err("Managed Python runtime bridge configuration is invalid".to_owned())
        }
    }
}

fn bridge_configuration(url: Option<&str>, token: Option<&str>) -> Result<Option<Url>, String> {
    let invalid = || "Managed Python runtime bridge configuration is invalid".to_owned();
    let (url, token) = match (url, token) {
        (None, None) => return Ok(None),
        (Some(url), Some(token)) if !url.is_empty() && !token.trim().is_empty() => (url, token),
        _ => return Err(invalid()),
    };
    let parsed = Url::parse(url).map_err(|_| invalid())?;
    let loopback = match parsed.host() {
        Some(url::Host::Ipv4(address)) => address == Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(address)) => address == Ipv6Addr::LOCALHOST,
        _ => false,
    };
    if parsed.scheme() != "http"
        || !loopback
        || parsed.path() != ENSURE_PATH
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || token.contains(['\r', '\n'])
    {
        return Err(invalid());
    }
    Ok(Some(parsed))
}

async fn ensure_configured_python(url: Option<&str>, token: Option<&str>) -> Result<(), String> {
    let Some(url) = bridge_configuration(url, token)? else {
        return Ok(());
    };
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(PYTHON_RUNTIME_ENSURE_TIMEOUT_SECONDS))
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| "Managed Python runtime bridge is unavailable".to_owned())?;
    let response = client
        .post(url)
        .bearer_auth(token.expect("validated bridge token"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|_| "Managed Python runtime preparation could not be reached".to_owned())?;
    if !response.status().is_success() {
        return Err("Managed Python runtime preparation request failed".to_owned());
    }
    let response: PreparationResponse = response.json().await.map_err(|_| {
        "Managed Python runtime preparation returned an invalid response".to_owned()
    })?;
    if response.ok
        && response
            .data
            .as_ref()
            .is_some_and(|status| status["id"] == "python" && status["state"] == "installed")
    {
        return Ok(());
    }
    Err("Managed Python runtime could not be prepared".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::{header, HeaderMap, StatusCode},
        response::IntoResponse,
        routing::post,
        Router,
    };

    struct TestBridge {
        url: String,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TestBridge {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn test_bridge(
        status: StatusCode,
        body: &'static str,
        location: Option<String>,
    ) -> TestBridge {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route(
            ENSURE_PATH,
            post(move |headers: HeaderMap| {
                let location = location.clone();
                async move {
                    assert_eq!(headers[header::AUTHORIZATION], "Bearer test-runtime-token");
                    let mut response = (status, body).into_response();
                    if let Some(location) = location {
                        response
                            .headers_mut()
                            .insert(header::LOCATION, location.parse().unwrap());
                    }
                    response
                }
            }),
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        TestBridge {
            url: format!("http://{address}{ENSURE_PATH}"),
            task,
        }
    }

    #[tokio::test]
    async fn standalone_executor_does_not_require_a_desktop_bridge() {
        ensure_configured_python(None, None).await.unwrap();
    }

    #[test]
    fn recognizes_python_interpreters_and_scripts_without_guessing_shell_contents() {
        for program in [
            "python",
            "python3",
            "python3.12",
            "/managed/bin/python3.12",
            "scripts/auth.py",
            "C:\\managed\\Python3.EXE",
            "C:\\plugins\\AUTH.PY",
            "pythonw.exe",
        ] {
            assert!(is_python_program(program), "{program}");
        }
        for program in [
            "sh",
            "pwsh",
            "scripts/auth.sh",
            "scripts/auth.ps1",
            "python3evil",
            "python2",
            "python3.",
            "python3.12-extra",
            "auth.py.exe",
            "dws",
            "glab",
        ] {
            assert!(!is_python_program(program), "{program}");
        }
    }

    #[test]
    fn isolates_python_import_configuration_case_insensitively() {
        let mut command = Command::new("python3");
        command
            .env("PythonHome", "foreign-runtime")
            .env("pythonpath", "foreign-packages")
            .env("PYTHONUSERBASE", "foreign-user-base")
            .env("PythonNoUserSite", "0")
            .env("PLUGIN_SETTING", "keep");

        isolate_python_environment(&mut command);

        let environment: std::collections::HashMap<_, _> = command.as_std().get_envs().collect();
        for name in ["PYTHONHOME", "PYTHONPATH", "PYTHONUSERBASE"] {
            assert!(!environment.iter().any(|(key, value)| {
                key.to_str()
                    .is_some_and(|key| key.eq_ignore_ascii_case(name))
                    && value.is_some()
            }));
        }
        assert!(environment.iter().any(|(key, value)| {
            key.to_str()
                .is_some_and(|key| key.eq_ignore_ascii_case("PYTHONNOUSERSITE"))
                && *value == Some(std::ffi::OsStr::new("1"))
        }));
        assert_eq!(
            environment.get(std::ffi::OsStr::new("PLUGIN_SETTING")),
            Some(&Some(std::ffi::OsStr::new("keep")))
        );
    }

    #[test]
    fn accepts_only_the_authenticated_loopback_preparation_endpoint() {
        for endpoint in [
            "http://127.0.0.1:9231/runtime/python/ensure",
            "http://[::1]:9231/runtime/python/ensure",
        ] {
            assert!(bridge_configuration(Some(endpoint), Some("test-token")).is_ok());
        }
        for endpoint in [
            "https://127.0.0.1:9231/runtime/python/ensure",
            "http://localhost:9231/runtime/python/ensure",
            "http://127.0.0.2:9231/runtime/python/ensure",
            "http://192.168.1.1:9231/runtime/python/ensure",
            "http://127.0.0.1:9231/other",
            "http://user@127.0.0.1:9231/runtime/python/ensure",
            "http://127.0.0.1:9231/runtime/python/ensure?token=private",
            "http://127.0.0.1:9231/runtime/python/ensure#fragment",
        ] {
            assert!(bridge_configuration(Some(endpoint), Some("test-token")).is_err());
        }
        assert!(bridge_configuration(Some(""), Some("test-token")).is_err());
        assert!(bridge_configuration(None, Some("test-token")).is_err());
        assert!(bridge_configuration(Some("http://127.0.0.1"), None).is_err());
        assert!(bridge_configuration(Some("http://127.0.0.1"), Some(" ")).is_err());
    }

    #[tokio::test]
    async fn waits_for_the_host_to_report_an_installed_python_runtime() {
        let bridge = test_bridge(
            StatusCode::OK,
            r#"{"ok":true,"data":{"id":"python","state":"installed","version":"3.12.12"}}"#,
            None,
        )
        .await;

        ensure_configured_python(Some(&bridge.url), Some("test-runtime-token"))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn rejects_failed_pending_or_malformed_preparation_responses() {
        for body in [
            r#"{"ok":false,"error":"download failed"}"#,
            r#"{"ok":true,"data":{"id":"python","state":"downloading"}}"#,
            r#"{"ok":true,"data":{"id":"node","state":"installed"}}"#,
            r#"{"ok":true}"#,
            "not JSON",
        ] {
            let bridge = test_bridge(StatusCode::OK, body, None).await;
            assert!(
                ensure_configured_python(Some(&bridge.url), Some("test-runtime-token"))
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn rejects_redirects_without_following_them() {
        let bridge = test_bridge(
            StatusCode::TEMPORARY_REDIRECT,
            "",
            Some("http://127.0.0.1:1/unexpected".to_owned()),
        )
        .await;

        let error = ensure_configured_python(Some(&bridge.url), Some("test-runtime-token"))
            .await
            .unwrap_err();

        assert_eq!(error, "Managed Python runtime preparation request failed");
        assert!(!error.contains("test-runtime-token"));
    }
}
