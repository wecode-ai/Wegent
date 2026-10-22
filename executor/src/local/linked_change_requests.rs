// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Only operator-configured Git hosts may receive automatic linked PR queries.

use std::{
    collections::HashMap,
    sync::OnceLock,
    time::{Duration, Instant},
};

use tokio::sync::Mutex;
use url::Url;

use super::{
    command::build_env,
    git_commands::{resolve_cli_executable, run_cli_probe},
};

type HostCache = Mutex<HashMap<String, (Instant, Vec<String>)>>;
static HOSTS: OnceLock<HostCache> = OnceLock::new();
const HOST_CACHE_TTL: Duration = Duration::from_secs(60);

fn configured_origin(value: &str) -> Option<String> {
    let value = value.trim();
    let address = if value.contains("://") {
        value.to_owned()
    } else {
        format!("https://{value}")
    };
    let url = Url::parse(&address).ok()?;
    (matches!(url.scheme(), "https" | "http")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none())
    .then(|| url.origin().ascii_serialization())
}

fn request_origin(provider: &str, args: &[String]) -> Result<String, String> {
    let address = match (provider, args) {
        ("github", [address]) => address,
        ("gitlab", [number, flag, address]) if flag == "--repo" && valid_number(number) => address,
        _ => return Err("Invalid linked change request arguments".to_owned()),
    };
    let url = Url::parse(address).map_err(|_| "Invalid linked change request URL")?;
    let segments: Vec<_> = url.path().split('/').skip(1).collect();
    let valid_path = match provider {
        "github" => segments.len() == 4 && segments[2] == "pull" && valid_number(segments[3]),
        "gitlab" => segments.len() >= 2,
        _ => false,
    };
    if !valid_path
        || segments.iter().any(|part| part.is_empty())
        || !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid linked change request URL".to_owned());
    }
    Ok(url.origin().ascii_serialization())
}

fn valid_number(value: &str) -> bool {
    value.bytes().all(|byte| byte.is_ascii_digit())
        && value
            .parse::<u64>()
            .is_ok_and(|number| number > 0 && number < (1_u64 << 53))
}

async fn configured_origins(provider: &str, env: &HashMap<String, String>) -> Vec<String> {
    let tool = if provider == "github" { "gh" } else { "glab" };
    let Some(executable) = resolve_cli_executable(tool, env) else {
        return vec![];
    };
    let key = format!(
        "{provider}:{}:{:?}",
        executable.display(),
        [
            "HOME",
            "USERPROFILE",
            "XDG_CONFIG_HOME",
            "GH_CONFIG_DIR",
            "GLAB_CONFIG_DIR",
            "GH_HOST",
            "GITLAB_HOST"
        ]
        .map(|name| env.get(name))
    );
    let mut cache = HOSTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .await;
    if let Some((at, origins)) = cache.get(&key) {
        if at.elapsed() < HOST_CACHE_TTL {
            return origins.clone();
        }
    }
    // These probes read only configured host names, never tokens or credential files.
    let probe_args: &[&str] = if provider == "github" {
        &["auth", "status", "--json", "hosts", "--jq", ".hosts | keys"]
    } else {
        &["config", "get", "host", "--global"]
    };
    let mut origins = vec![];
    if let Ok(output) = run_cli_probe(&executable, env, probe_args, Duration::from_secs(10)).await {
        if output.status.success() {
            let values = if provider == "github" {
                serde_json::from_slice::<Vec<String>>(&output.stdout).unwrap_or_default()
            } else {
                vec![String::from_utf8_lossy(&output.stdout).trim().to_owned()]
            };
            origins = values
                .iter()
                .filter_map(|value| configured_origin(value))
                .collect();
        }
    }
    cache.insert(key, (Instant::now(), origins.clone()));
    origins
}

pub async fn validate_linked_request(
    provider: &str,
    args: &[String],
    environment: &HashMap<String, String>,
) -> Result<(), String> {
    let origin = request_origin(provider, args)?;
    let public_origin = if provider == "github" {
        "https://github.com"
    } else {
        "https://gitlab.com"
    };
    if origin == public_origin {
        return Ok(());
    }
    let env = build_env(environment);
    let host_variable = if provider == "github" {
        "GH_HOST"
    } else {
        "GITLAB_HOST"
    };
    if env
        .get(host_variable)
        .and_then(|value| configured_origin(value))
        .as_deref()
        == Some(&origin)
    {
        return Ok(());
    }
    if configured_origins(provider, &env).await.contains(&origin) {
        return Ok(());
    }
    Err("Untrusted change request host".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn validates_request_shape_and_rejects_argument_injection() {
        assert_eq!(
            request_origin("github", &args(&["https://github.com/org/app/pull/42"])).unwrap(),
            "https://github.com"
        );
        assert_eq!(
            request_origin(
                "gitlab",
                &args(&["7", "--repo", "https://gitlab.com/group/sub/app"])
            )
            .unwrap(),
            "https://gitlab.com"
        );
        for invalid in [
            args(&["--hostname", "evil.test"]),
            args(&["https://user:secret@github.com/org/app/pull/42"]),
            args(&["https://github.com/org/app/pull/0"]),
            args(&["https://github.com/org/app/pull/9007199254740993"]),
        ] {
            assert!(request_origin("github", &invalid).is_err());
        }
    }

    #[tokio::test]
    async fn accepts_public_https_and_explicit_operator_host_origins() {
        assert!(validate_linked_request(
            "github",
            &args(&["https://github.com/org/app/pull/42"]),
            &HashMap::new()
        )
        .await
        .is_ok());
        let env = HashMap::from([(
            "GH_HOST".to_owned(),
            "http://ghe.company.test:8080".to_owned(),
        )]);
        assert!(validate_linked_request(
            "github",
            &args(&["http://ghe.company.test:8080/org/app/pull/42"]),
            &env
        )
        .await
        .is_ok());
        assert_eq!(
            configured_origin("ghe.company.test"),
            Some("https://ghe.company.test".to_owned())
        );
        assert!(configured_origin("https://user:secret@ghe.company.test").is_none());
    }

    #[tokio::test]
    async fn rejects_unknown_hosts_and_public_http_before_running_any_cli() {
        let env = HashMap::from([
            ("PATH".to_owned(), String::new()),
            ("GH_HOST".to_owned(), String::new()),
            ("GITLAB_HOST".to_owned(), String::new()),
        ]);
        for address in [
            "https://github.com.attacker.test/org/app/pull/42",
            "http://github.com/org/app/pull/42",
            "https://127.0.0.1/org/app/pull/42",
        ] {
            assert_eq!(
                validate_linked_request("github", &args(&[address]), &env)
                    .await
                    .unwrap_err(),
                "Untrusted change request host"
            );
        }
        assert!(validate_linked_request(
            "gitlab",
            &args(&["7", "--repo", "https://gitlab.attacker.test/group/app"]),
            &env
        )
        .await
        .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovers_configured_hosts_once_without_exposing_credentials() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let executable = fixture.path().join("gh");
        let log = fixture.path().join("probe.log");
        std::fs::write(&executable, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FIXTURE_HOST_LOG\"\nprintf '%s\\n' '[\"ghe.company.test\"]'\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env = HashMap::from([
            ("PATH".to_owned(), fixture.path().display().to_string()),
            ("GH_HOST".to_owned(), String::new()),
            ("GITLAB_HOST".to_owned(), String::new()),
            ("FIXTURE_HOST_LOG".to_owned(), log.display().to_string()),
        ]);
        let allowed = args(&["https://ghe.company.test/org/app/pull/42"]);
        let denied = args(&["https://attacker.test/org/app/pull/42"]);
        let (first, second, third) = tokio::join!(
            validate_linked_request("github", &allowed, &env),
            validate_linked_request("github", &allowed, &env),
            validate_linked_request("github", &denied, &env),
        );
        assert!(first.is_ok() && second.is_ok() && third.is_err());
        assert_eq!(
            std::fs::read_to_string(log).unwrap(),
            "auth status --json hosts --jq .hosts | keys\n"
        );
        let glab = fixture.path().join("glab");
        std::fs::write(&glab, "#!/bin/sh\n[ \"$*\" = 'config get host --global' ] || exit 1\nprintf '%s\\n' 'http://gitlab.company.test:8080'\n").unwrap();
        std::fs::set_permissions(&glab, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(validate_linked_request(
            "gitlab",
            &args(&[
                "7",
                "--repo",
                "http://gitlab.company.test:8080/group/sub/app"
            ]),
            &env
        )
        .await
        .is_ok());
        assert!(validate_linked_request(
            "gitlab",
            &args(&[
                "7",
                "--repo",
                "http://gitlab.company.test:9090/group/sub/app"
            ]),
            &env
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn ipc_rejects_untrusted_links_before_command_execution() {
        use super::super::{
            app_ipc::AppIpcServer,
            command::{CommandRequest, CommandResult, DeviceCommandHandler},
        };
        struct MustNotExecute;
        impl DeviceCommandHandler for MustNotExecute {
            fn handle_execute_command<'a>(
                &'a self,
                _: CommandRequest,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = CommandResult> + Send + 'a>>
            {
                Box::pin(async { panic!("untrusted link reached command execution") })
            }
        }
        let server = AppIpcServer::new().with_command_handler(MustNotExecute);
        let response = server.handle_line(&serde_json::json!({
            "type": "request", "id": "unsafe-link", "method": "device.execute_command",
            "params": { "command_key": "git_github_pull_request_view", "args": ["https://attacker.test/org/app/pull/42"], "env": { "PATH": "", "GH_HOST": "" } }
        }).to_string()).await.unwrap();
        assert_eq!(response["result"]["success"], false);
        assert_eq!(response["result"]["error"], "Untrusted change request host");
    }
}
