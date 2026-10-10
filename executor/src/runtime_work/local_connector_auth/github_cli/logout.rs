//! Disconnect only the active local CLI profile, without exposing credentials.
use super::*;

fn profile(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<Option<String>, &'static str> {
    if !success {
        return if String::from_utf8_lossy(stderr).contains("could not find key \"user\"") {
            Ok(None)
        } else {
            Err("gh_logout_failed")
        };
    }
    let login = String::from_utf8_lossy(stdout).trim().to_owned();
    // GitHub login names cannot contain CLI switches or shell syntax.
    if login.is_empty()
        || login.len() > 39
        || !login
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || login.starts_with('-')
    {
        return Err("gh_logout_failed");
    }
    Ok(Some(login))
}

async fn active_profile(command: &mut Command) -> Result<Option<String>, &'static str> {
    // Config lookup is offline and does not read authentication tokens.
    let output = command
        .stdout(Stdio::piped())
        .output()
        .await
        .map_err(|cause| {
            if cause.kind() == std::io::ErrorKind::NotFound {
                "gh_missing"
            } else {
                "gh_logout_failed"
            }
        })?;
    profile(output.status.success(), &output.stdout, &output.stderr)
}

pub(super) async fn run(
    mut make_command: impl FnMut(&[&str]) -> Command,
    environment_auth: bool,
) -> Value {
    if environment_auth {
        return error("gh_logout_env_token");
    }
    let disconnect = async {
        let args = ["config", "get", "user", "--host", "github.com"];
        let Some(login) = active_profile(&mut make_command(&args)).await? else {
            return Ok(json!({"status": "ok", "connected": false}));
        };
        // Explicit user/host avoids interactive selection or removing another account.
        let result = make_command(&[
            "auth",
            "logout",
            "--hostname",
            "github.com",
            "--user",
            &login,
        ])
        .output()
        .await
        .map_err(|_| "gh_logout_failed")?;
        if !result.status.success() {
            return Err("gh_logout_failed");
        }
        let remaining = active_profile(&mut make_command(&args)).await?;
        if remaining.as_deref() == Some(login.as_str()) {
            return Err("gh_logout_failed");
        }
        Ok::<_, &'static str>(json!({"status": "ok", "connected": remaining.is_some()}))
    };
    match tokio::time::timeout(Duration::from_secs(20), disconnect).await {
        Ok(Ok(result)) => result,
        Ok(Err(code)) => error(code),
        Err(_) => error("gh_logout_timeout"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_missing_profile_from_config_failure() {
        assert_eq!(
            profile(true, b"test-user\n", b""),
            Ok(Some("test-user".into()))
        );
        assert_eq!(
            profile(false, b"", b"could not find key \"user\""),
            Ok(None)
        );
        assert!(profile(false, b"", b"permission denied").is_err());
        for invalid in ["--user", "foo;bar", "", "name\nother"] {
            assert!(profile(true, invalid.as_bytes(), b"").is_err());
        }
    }

    #[tokio::test]
    async fn refuses_environment_credentials_without_running_commands() {
        let result = run(|_| panic!("must not run gh"), true).await;
        assert_eq!(result["errorCode"], "gh_logout_env_token");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn removes_only_the_active_profile_and_reports_remaining_accounts() {
        for remaining in [false, true] {
            let mut calls = 0;
            let result = run(
                |args| {
                    calls += 1;
                    let script = match calls {
                        1 => "printf 'test-user'",
                        2 => {
                            assert_eq!(
                                args,
                                [
                                    "auth",
                                    "logout",
                                    "--hostname",
                                    "github.com",
                                    "--user",
                                    "test-user"
                                ]
                            );
                            "exit 0"
                        }
                        3 if remaining => "printf 'other-user'",
                        3 => "printf 'could not find key \"user\"' >&2; exit 1",
                        _ => panic!("unexpected command"),
                    };
                    let mut child = Command::new("sh");
                    child
                        .args(["-c", script])
                        .kill_on_drop(true)
                        .stderr(Stdio::piped());
                    child
                },
                false,
            )
            .await;
            assert_eq!(calls, 3);
            assert_eq!(result["status"], "ok");
            assert_eq!(result["connected"], remaining);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn keeps_failed_logout_retryable_and_empty_logout_idempotent() {
        for empty in [false, true] {
            let mut calls = 0;
            let result = run(
                |_| {
                    calls += 1;
                    let script = if empty {
                        "printf 'could not find key \"user\"' >&2; exit 1"
                    } else if calls == 1 {
                        "printf 'test-user'"
                    } else {
                        "exit 1"
                    };
                    let mut child = Command::new("sh");
                    child
                        .args(["-c", script])
                        .kill_on_drop(true)
                        .stderr(Stdio::piped());
                    child
                },
                false,
            )
            .await;
            assert_eq!(result["status"], if empty { "ok" } else { "error" });
            assert_eq!(calls, if empty { 1 } else { 2 });
        }
    }
}
