// Synthetic DingTalk protocol boundary; no credentials or network access.
use std::{
    env, fs,
    io::{self, Write},
    path::PathBuf,
    process,
};

const EXPIRED: &str = "expired";
const EXPIRE_ON_SEARCH: &str = "expire-on-search";

fn auth_state_path() -> Option<PathBuf> {
    env::var_os("WEWORK_E2E_DINGTALK_AUTH_STATE").map(PathBuf::from)
}

fn auth_state() -> String {
    auth_state_path()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "ready".to_owned())
}

fn set_auth_state(state: &str) {
    if let Some(path) = auth_state_path() {
        let _ = fs::write(path, state);
    }
}

fn auth_failure() -> (&'static str, i32) {
    (
        r#"{"error":{"category":"internal","code":5,"message":"Token refresh failed: invalidParameter.authCode.notFound"}}"#,
        5,
    )
}

fn main() {
    let arguments: Vec<String> = env::args().skip(1).collect();
    let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
    if let Some(root) = env::var_os("WEWORK_E2E_DINGTALK_TRAINING_HISTORY").map(PathBuf::from) {
        match arguments.as_slice() {
            ["chat", "message", "search-advanced", ..] => {
                let group = arguments
                    .windows(2)
                    .find(|pair| pair[0] == "--conversation-ids")
                    .unwrap()[1];
                assert!(matches!(
                    group,
                    "training-alpha" | "training-beta" | "training-gamma"
                ));
                print!(
                    "{}",
                    fs::read_to_string(root.join(format!("{group}.json"))).unwrap()
                );
                return;
            }
            ["chat", "message", "reply" | "send" | "send-by-bot", ..] => {
                fs::write(root.join("unexpected-send"), "send attempted").unwrap();
                process::exit(2);
            }
            _ => {}
        }
    }
    let search = |success: &'static str| -> (&'static str, i32) {
        match auth_state().as_str() {
            EXPIRE_ON_SEARCH => {
                set_auth_state(EXPIRED);
                auth_failure()
            }
            EXPIRED => auth_failure(),
            _ => (success, 0),
        }
    };
    let (response, exit_code) = match arguments.as_slice() {
        ["health", ..] => (
            if auth_state() == EXPIRED {
                r#"{"status":"need_login"}"#
            } else {
                r#"{"status":"ok"}"#
            },
            0,
        ),
        ["login", ..] => {
            set_auth_state("ready");
            (r#"{"status":"ok"}"#, 0)
        }
        ["auth", "status", ..] => (
            if auth_state() == EXPIRED {
                r#"{"success":true,"authenticated":false,"reason":"token_refresh_failed"}"#
            } else {
                r#"{"success":true,"authenticated":true,"token_valid":true}"#
            },
            0,
        ),
        ["profile", "list", ..] => (
            r#"{"currentProfile":"connection-test-account","profiles":[{"profile":"connection-test-account","userName":"Fixture","userId":"fixture-user"}]}"#,
            0,
        ),
        ["chat", "search", ..] => search(r#"{"result":{"groups":[],"hasMore":false}}"#),
        ["contact", "user", "search", ..] => search(
            r#"{"result":[{"userId":"fixture-user","openDingTalkId":"fixture-user","name":"Fixture"}]}"#,
        ),
        ["chat", "message", "list-mentions", ..] | ["chat", "message", "search-advanced", ..] => (
            r#"{"success":true,"result":{"hasMore":false,"nextCursor":"0","conversationMessagesList":[]}}"#,
            0,
        ),
        _ => {
            eprintln!("Only declared DingTalk fixture reads are supported");
            process::exit(2);
        }
    };
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{response}");
    let _ = stdout.flush();
    process::exit(exit_code);
}
