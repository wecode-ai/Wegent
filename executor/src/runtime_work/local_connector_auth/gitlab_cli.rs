//! Native glab device authorization; credentials remain owned by the CLI.
use super::*;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader};

fn instance(payload: &Value) -> Result<String, AppIpcError> {
    crate::runtime_work::git_connections::instance(payload, "gitlab")
}
fn slug(instance: &str) -> String {
    format!(
        "wework-gitlab-cli-{:x}",
        Sha256::digest(instance.as_bytes())
    )
}

pub(crate) fn target(payload: &Value) -> Result<Value, AppIpcError> {
    let instance = instance(payload)?;
    Ok(
        json!({"pluginKey":"gitlab","connectorSlug":slug(&instance),"instance":instance,"localAuth":{"kind":"browser_oauth","health":[],"start":[],"poll":[],"pollIntervalSeconds":1}}),
    )
}
pub(super) fn is_target(payload: &Value) -> bool {
    payload["pluginKey"] == "gitlab"
        && instance(payload).is_ok_and(|instance| payload["connectorSlug"] == slug(&instance))
}
pub(super) async fn health(payload: &Value) -> Result<Value, AppIpcError> {
    let result=crate::runtime_work::git_connections::read(json!({"providerId":"@wegent/dsh-connection-git/gitlab","operation":"identity","instance":instance(payload)?})).await;
    Ok(match result {
        Ok(_) => json!({"status":"ok"}),
        Err(e) if e.code == "connector_auth_required" => json!({"status":"need_login"}),
        Err(e) => json!({"status":"error","errorCode":e.code}),
    })
}
pub(super) async fn start(payload: &Value) -> Result<Value, AppIpcError> {
    let current = health(payload).await?;
    if current["status"] != "need_login" {
        return Ok(current);
    }
    let instance = instance(payload)?;
    let connector = slug(&instance);
    let mut sessions = browser_auth_sessions().lock().await;
    for session in sessions.values() {
        if session.plugin_key == "gitlab"
            && session.connector_slug == connector
            && !session.task.is_finished()
        {
            return Ok(session.state.lock().await.clone());
        }
    }
    sessions.retain(|_, s| !s.task.is_finished());
    if sessions.len() >= 16 {
        return Err(AppIpcError::new(
            "auth_capacity",
            "Too many authorization sessions",
        ));
    }
    let id = Uuid::new_v4().to_string();
    let state = Arc::new(Mutex::new(json!({"status":"preparing","sessionId":id})));
    let shared = state.clone();
    let request = payload.clone();
    let session_id = id.clone();
    let task = tokio::spawn(async move {
        let result =
            tokio::time::timeout(Duration::from_secs(600), login(&instance, &shared)).await;
        let mut result = match result {
            Ok(Ok(())) => health(&request).await.unwrap_or_else(
                |_| json!({"status":"error","errorCode":"gitlab_login_verification_failed"}),
            ),
            Ok(Err(_)) => json!({"status":"error","errorCode":"gitlab_login_failed"}),
            Err(_) => json!({"status":"expired","errorCode":"gitlab_login_timeout"}),
        };
        result["sessionId"] = json!(session_id);
        *shared.lock().await = result;
    });
    sessions.insert(
        id.clone(),
        BrowserAuthSession {
            plugin_key: "gitlab".into(),
            connector_slug: connector,
            state,
            task,
        },
    );
    Ok(json!({"status":"preparing","sessionId":id}))
}
async fn login(instance: &str, state: &Arc<Mutex<Value>>) -> Result<(), ()> {
    let host = instance.trim_start_matches("https://");
    let mut child = Command::new("glab")
        .args([
            "auth",
            "login",
            "--hostname",
            host,
            "--device",
            "--git-protocol",
            "https",
            "--api-host",
            host,
            "--api-protocol",
            "https",
        ])
        .env("NO_COLOR", "1")
        .env("GLAB_PROMPT_DISABLED", "1")
        .env(
            "PATH",
            crate::process_environment::normalized_process_path(
                &env::var("PATH").unwrap_or_default(),
            ),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| ())?;
    let mut lines = BufReader::new(child.stderr.take().ok_or(())?).lines();
    while let Some(line) = lines.next_line().await.map_err(|_| ())? {
        if line.len() > 4096 {
            return Err(());
        }
        apply_prompt(instance, &line, &mut *state.lock().await);
    }
    if child.wait().await.map_err(|_| ())?.success() {
        Ok(())
    } else {
        Err(())
    }
}
fn apply_prompt(instance: &str, line: &str, state: &mut Value) {
    if let Some(code) = line
        .trim()
        .strip_prefix("First copy your one-time code: ")
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        state["userCode"] = json!(code);
    }
    if let Some(address) = line
        .trim()
        .strip_prefix("Then open this URL on any device to authorize: ")
    {
        if url::Url::parse(address).is_ok_and(|u| {
            u.origin().ascii_serialization() == instance
                && u.scheme() == "https"
                && u.username().is_empty()
                && u.password().is_none()
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
    fn authorization_is_bound_to_the_selected_instance() {
        let a = target(&json!({"instance":"https://gitlab.example"})).unwrap();
        let b = target(&json!({"instance":"https://gitlab.other"})).unwrap();
        assert_ne!(a["connectorSlug"], b["connectorSlug"]);
        assert!(is_target(&a));
        let mut state = json!({});
        apply_prompt(
            "https://gitlab.example",
            "First copy your one-time code: ABCD-1234",
            &mut state,
        );
        apply_prompt(
            "https://gitlab.example",
            "Then open this URL on any device to authorize: https://evil.example/oauth/device",
            &mut state,
        );
        assert!(state["verificationUrl"].is_null());
        apply_prompt(
            "https://gitlab.example",
            "Then open this URL on any device to authorize: https://gitlab.example/oauth/device",
            &mut state,
        );
        assert_eq!(state["status"], "waiting_browser");
        assert_eq!(state["userCode"], "ABCD-1234");
    }
}
