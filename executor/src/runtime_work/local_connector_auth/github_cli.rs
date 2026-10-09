//! GitHub CLI owns credentials. We retain only a bounded, cancellable login session.
use super::*;
use tokio::io::AsyncReadExt;
mod logout;

const SLUG: &str = "wework-github-cli";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

pub(super) async fn logout() -> Result<Value, AppIpcError> {
    let environment_auth = ["GH_TOKEN", "GITHUB_TOKEN"]
        .iter()
        .any(|key| env::var_os(key).is_some_and(|value| !value.is_empty()));
    Ok(logout::run(command, environment_auth).await)
}

pub(super) fn is_target(payload: &Value) -> bool {
    payload["pluginKey"] == "github" && payload["connectorSlug"] == SLUG
}

fn command(args: &[&str]) -> Command {
    let mut command = Command::new("gh");
    command.args(args).env(
        "PATH",
        crate::process_environment::normalized_process_path(&env::var("PATH").unwrap_or_default()),
    );
    command
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env("GH_PROMPT_DISABLED", "1");
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    command
}

fn error(code: &str) -> Value {
    json!({"status": "error", "errorCode": code})
}

fn classify_health(exit_code: Option<i32>, stderr: &[u8]) -> Value {
    if exit_code == Some(0) {
        return json!({"status": "ok"});
    }
    let text = String::from_utf8_lossy(stderr).to_lowercase();
    // gh uses exit code 4 for authentication required, including its distinct
    // GitHub Actions prompt. Transport failures must still remain errors.
    if exit_code == Some(4)
        || text.contains("http 401")
        || (text.contains("to get started with github cli") && text.contains("gh auth login"))
    {
        json!({"status": "need_login"})
    } else {
        error("gh_health_failed")
    }
}

pub(super) async fn health() -> Result<Value, AppIpcError> {
    let mut child = match command(&["api", "user", "--silent", "--hostname", "github.com"]).spawn()
    {
        Ok(child) => child,
        Err(cause) => {
            return Ok(error(if cause.kind() == std::io::ErrorKind::NotFound {
                "gh_missing"
            } else {
                "gh_start_failed"
            }))
        }
    };
    // Probe the active profile without reading or displaying credentials.
    // The API status distinguishes unauthorized access from transport failures.
    let check = async {
        let mut stderr = child.stderr.take().ok_or(std::io::ErrorKind::BrokenPipe)?;
        let mut tail = Vec::new();
        let mut chunk = [0_u8; 1024];
        loop {
            let count = stderr.read(&mut chunk).await?;
            if count == 0 {
                break;
            }
            tail.extend_from_slice(&chunk[..count]);
            if tail.len() > 4096 {
                tail.drain(..tail.len() - 4096);
            }
        }
        let status = child.wait().await?;
        Ok::<_, std::io::Error>(classify_health(status.code(), &tail))
    };
    match tokio::time::timeout(Duration::from_secs(20), check).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(_)) => Ok(error("gh_health_failed")),
        Err(_) => Ok(error("gh_health_timeout")),
    }
}

pub(super) async fn start() -> Result<Value, AppIpcError> {
    let current = health().await?;
    if current["status"] != "need_login" {
        return Ok(current);
    }
    let mut sessions = browser_auth_sessions().lock().await;
    for session in sessions.values() {
        if session.plugin_key == "github" && session.connector_slug == SLUG {
            let state = session.state.lock().await.clone();
            if matches!(
                state["status"].as_str(),
                Some("preparing" | "waiting_browser" | "verifying")
            ) {
                return Ok(state);
            }
        }
    }
    let id = Uuid::new_v4().to_string();
    let state = Arc::new(Mutex::new(json!({"status": "preparing", "sessionId": id})));
    let task_state = Arc::clone(&state);
    let task_id = id.clone();
    let task = tokio::spawn(async move {
        let result = match tokio::time::timeout(LOGIN_TIMEOUT, login(&task_state)).await {
            Ok(result) => result,
            Err(_) => json!({"status": "expired", "errorCode": "gh_login_timeout"}),
        };
        let mut result = result;
        result["sessionId"] = json!(task_id);
        *task_state.lock().await = result;
    });
    sessions.insert(
        id.clone(),
        BrowserAuthSession {
            plugin_key: "github".to_owned(),
            connector_slug: SLUG.to_owned(),
            state,
            task,
        },
    );
    Ok(json!({"status": "preparing", "sessionId": id}))
}

async fn login(state: &Arc<Mutex<Value>>) -> Value {
    // Non-TTY gh emits a verification URL/code instead of opening a browser.
    // The UI opens only the verified GitHub URL after an explicit user click.
    let mut child = match command(&[
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--web",
        "--git-protocol",
        "https",
    ])
    .spawn()
    {
        Ok(child) => child,
        Err(_) => return error("gh_start_failed"),
    };
    let Some(mut stderr) = child.stderr.take() else {
        return error("gh_login_failed");
    };
    let mut chunk = [0_u8; 1024];
    let mut line = Vec::new();
    loop {
        let count = match stderr.read(&mut chunk).await {
            Ok(count) => count,
            Err(_) => return error("gh_login_failed"),
        };
        if count == 0 {
            break;
        }
        for byte in &chunk[..count] {
            if *byte == b'\n' {
                apply_prompt(&line, &mut *state.lock().await);
                line.clear();
            } else if line.len() < 4096 {
                line.push(*byte);
            }
        }
    }
    apply_prompt(&line, &mut *state.lock().await);
    match child.wait().await {
        Ok(status) if status.success() => {
            state.lock().await["status"] = json!("verifying");
            match health().await {
                Ok(result) if result["status"] == "ok" => result,
                _ => error("gh_login_verification_failed"),
            }
        }
        _ => error("gh_login_failed"),
    }
}

fn apply_prompt(line: &[u8], state: &mut Value) {
    let text = String::from_utf8_lossy(line);
    if let Some(code) = text
        .split("First copy your one-time code: ")
        .nth(1)
        .map(str::trim)
    {
        if code.len() == 9
            && code.as_bytes()[4] == b'-'
            && code.bytes().enumerate().all(|(index, byte)| {
                index == 4 || byte.is_ascii_uppercase() || byte.is_ascii_digit()
            })
        {
            state["userCode"] = json!(code);
        }
    }
    if let Some(address) = text
        .split("to continue in your web browser: ")
        .nth(1)
        .map(str::trim)
    {
        if url::Url::parse(address).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("github.com")
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && matches!(url.path(), "/login/device" | "/login/oauth/authorize")
        }) {
            state["verificationUrl"] = json!(address);
            state["status"] = json!("waiting_browser");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_cli_does_not_treat_network_failure_as_missing_auth() {
        assert_eq!(
            classify_health(
                Some(4),
                b"To get started with GitHub CLI, please run: gh auth login"
            )["status"],
            "need_login"
        );
        assert_eq!(
            classify_health(Some(1), b"gh: Bad credentials (HTTP 401)")["status"],
            "need_login"
        );
        assert_eq!(
            classify_health(Some(1), b"connection timeout")["status"],
            "error"
        );
        assert_eq!(
            classify_health(Some(1), b"gh: Forbidden (HTTP 403)")["errorCode"],
            "gh_health_failed"
        );
        assert_eq!(
            classify_health(Some(0), b"Token: [SECRET]"),
            json!({"status": "ok"})
        );
    }

    #[test]
    fn github_cli_recognizes_auth_required_in_actions_without_parsing_prompt_text() {
        for prompt in [
            b"gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.".as_slice(),
            b"".as_slice(),
        ] {
            assert_eq!(classify_health(Some(4), prompt), json!({"status": "need_login"}));
        }
        assert_eq!(classify_health(None, b""), error("gh_health_failed"));
    }

    #[test]
    fn github_cli_exposes_only_valid_device_prompts() {
        let mut state = json!({"status": "preparing", "sessionId": "test"});
        apply_prompt(b"! First copy your one-time code: ABCD-1234", &mut state);
        apply_prompt(
            b"Open this URL to continue in your web browser: https://github.com/login/device",
            &mut state,
        );
        assert_eq!(state["userCode"], "ABCD-1234");
        assert_eq!(state["status"], "waiting_browser");
        assert_eq!(state["sessionId"], "test");
        let expected = state.clone();
        for line in [
            "Token: SECRET",
            "! First copy your one-time code: SECRET",
            "Open this URL to continue in your web browser: https://github.com.evil/login/device",
            "Open this URL to continue in your web browser: https://user@github.com/login/device",
            "Open this URL to continue in your web browser: https://github.com/settings/tokens",
            "Open this URL to continue in your web browser: https://github.com:8443/login/device",
        ] {
            apply_prompt(line.as_bytes(), &mut state);
        }
        assert_eq!(state, expected);
    }

    #[test]
    fn github_cli_requires_exact_host_owned_identity() {
        assert!(is_target(
            &json!({"pluginKey":"github","connectorSlug":SLUG})
        ));
        assert!(!is_target(
            &json!({"pluginKey":"custom","connectorSlug":SLUG})
        ));
        assert!(!is_target(
            &json!({"pluginKey":"github","connectorSlug":"github"})
        ));
    }
}
