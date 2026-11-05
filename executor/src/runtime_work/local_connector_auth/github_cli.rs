//! GitHub CLI owns credentials. We retain only a bounded, cancellable login session.
use super::*;
use tokio::io::AsyncReadExt;
mod logout;
mod prompts;
#[cfg(test)]
use crate::services::github_cli::classify_health;

const SLUG: &str = "wework-github-cli";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) async fn logout() -> Result<Value, AppIpcError> {
    let (environment, managed) = authentication_environment();
    if managed {
        return Ok(error("gh_auth_managed"));
    }
    let environment_auth = ["GH_TOKEN", "GITHUB_TOKEN"]
        .iter()
        .any(|key| environment.get(*key).is_some_and(|value| !value.is_empty()));
    let result = logout::run(
        |args| crate::services::github_cli::command(args, &environment),
        environment_auth,
    )
    .await;
    Ok(
        if result["status"] == "ok" && authentication_context_changed(&environment, managed) {
            error("gh_auth_managed")
        } else {
            result
        },
    )
}

pub(super) fn is_target(payload: &Value) -> bool {
    payload["pluginKey"] == "github" && payload["connectorSlug"] == SLUG
}

fn authentication_environment() -> (HashMap<String, String>, bool) {
    let managed = crate::services::git_credentials::environment();
    let config_dir = managed
        .get("GH_CONFIG_DIR")
        .cloned()
        .or_else(|| env::var("GH_CONFIG_DIR").ok());
    let mut environment = crate::process_environment::process_env(&[]);
    // Ownership and profile must come from the same snapshot, even during sync.
    environment.remove("GH_CONFIG_DIR");
    if let Some(config_dir) = config_dir {
        environment.insert("GH_CONFIG_DIR".to_owned(), config_dir);
    }
    (environment, managed.contains_key("GH_CONFIG_DIR"))
}

fn authentication_context_changed(environment: &HashMap<String, String>, managed: bool) -> bool {
    let (current, current_managed) = authentication_environment();
    current_managed != managed || current.get("GH_CONFIG_DIR") != environment.get("GH_CONFIG_DIR")
}

fn error(code: &str) -> Value {
    json!({"status": "error", "errorCode": code})
}

pub(super) async fn health() -> Result<Value, AppIpcError> {
    Ok(health_with_environment(&crate::process_environment::process_env(&[])).await)
}

async fn health_with_environment(environment: &HashMap<String, String>) -> Value {
    crate::services::github_cli::health(environment, Duration::from_secs(20), "plugin").await
}

pub(super) async fn start() -> Result<Value, AppIpcError> {
    let (environment, managed) = authentication_environment();
    let current = health_with_environment(&environment).await;
    if authentication_context_changed(&environment, managed) {
        return Ok(error("gh_auth_managed"));
    }
    if current["status"] != "need_login" {
        return Ok(current);
    }
    if managed {
        return Ok(error("gh_auth_managed"));
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
        let result =
            match tokio::time::timeout(LOGIN_TIMEOUT, login(&environment, &task_state)).await {
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

async fn login(environment: &HashMap<String, String>, state: &Arc<Mutex<Value>>) -> Value {
    // Non-TTY gh emits a verification URL/code instead of opening a browser.
    // The UI opens only the verified GitHub URL after an explicit user click.
    login_with_command(
        crate::services::github_cli::command(
            &[
                "auth",
                "login",
                "--hostname",
                "github.com",
                "--web",
                "--git-protocol",
                "https",
            ],
            environment,
        ),
        state,
        environment,
    )
    .await
}

async fn login_with_command(
    mut command: Command,
    state: &Arc<Mutex<Value>>,
    environment: &HashMap<String, String>,
) -> Value {
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return error("gh_start_failed"),
    };
    let Some(mut stderr) = child.stderr.take() else {
        return error("gh_login_failed");
    };
    let mut chunk = [0_u8; 1024];
    let mut line = Vec::new();
    let prompt_deadline = tokio::time::Instant::now() + PROMPT_TIMEOUT;
    loop {
        let read = async {
            let preparing = state.lock().await["status"] == "preparing";
            if preparing {
                tokio::time::timeout_at(prompt_deadline, stderr.read(&mut chunk))
                    .await
                    .map_err(|_| "gh_login_prompt_timeout")?
                    .map_err(|_| "gh_login_failed")
            } else {
                stderr.read(&mut chunk).await.map_err(|_| "gh_login_failed")
            }
        };
        let count = match read.await {
            Ok(count) => count,
            Err(code) => return error(code),
        };
        if count == 0 {
            break;
        }
        for byte in &chunk[..count] {
            if *byte == b'\n' {
                if let Err(code) = apply_prompt(&line, &mut *state.lock().await) {
                    return error(code);
                }
                line.clear();
            } else if line.len() < 4096 {
                line.push(*byte);
            }
        }
    }
    if let Err(code) = apply_prompt(&line, &mut *state.lock().await) {
        return error(code);
    }
    match child.wait().await {
        Ok(status) if status.success() => {
            state.lock().await["status"] = json!("verifying");
            if authentication_context_changed(environment, false) {
                return error("gh_auth_managed");
            }
            match health_with_environment(environment).await {
                result if result["status"] == "ok" => {
                    if authentication_context_changed(environment, false) {
                        error("gh_auth_managed")
                    } else {
                        result
                    }
                }
                _ => error("gh_login_verification_failed"),
            }
        }
        _ => error("gh_login_failed"),
    }
}

use prompts::apply_prompt;

#[cfg(all(test, unix))]
mod context_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn device_prompt_remains_pollable_and_cancellable_while_cli_waits() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf '! First copy your one-time code: ABCD-1234\\nOpen this URL to continue in your web browser: https://github.com/login/device\\n' >&2; read answer"])
            .stdin(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let state = Arc::new(Mutex::new(json!({"status":"preparing"})));
        let task_state = state.clone();
        let task =
            tokio::spawn(
                async move { login_with_command(command, &task_state, &HashMap::new()).await },
            );
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let current = state.lock().await.clone();
                if current["status"] == "waiting_browser" {
                    assert_eq!(current["userCode"], "ABCD-1234");
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn missing_code_stops_the_login_process_before_browser_wait() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf 'Open this URL to continue in your web browser: https://github.com/login/device\\n' >&2; read answer"])
            .stdin(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let state = Arc::new(Mutex::new(json!({"status":"preparing"})));
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            login_with_command(command, &state, &HashMap::new()),
        )
        .await
        .unwrap();
        assert_eq!(result["errorCode"], "gh_login_code_missing");
        assert!(state.lock().await["verificationUrl"].is_null());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stalled_prompt_has_a_bounded_deadline() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "read answer"])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let state = Arc::new(Mutex::new(json!({"status":"preparing"})));
        tokio::time::pause();
        let result = login_with_command(command, &state, &HashMap::new()).await;
        assert_eq!(result["errorCode"], "gh_login_prompt_timeout");
    }

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
