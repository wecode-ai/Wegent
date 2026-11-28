// Synthetic DingTalk protocol boundary; no credentials or network access.
use std::{
    env, fs,
    io::{self, Write},
    path::PathBuf,
    process,
};

const EXPIRED: &str = "expired";
const EXPIRE_ON_SEARCH: &str = "expire-on-search";
const SCOPED_PROFILE: &str = "fixture-org:fixture-user";
const OTHER_PROFILE: &str = "other-org:fixture-user";
const EMPTY_MESSAGES: &str =
    r#"{"success":true,"result":{"hasMore":false,"nextCursor":"0","conversationMessagesList":[]}}"#;
const MISSING_READ_SCOPE: &str =
    r#"{"success":false,"code":"PAT_SCOPE_AUTH_REQUIRED","data":{"errorType":"missing_scope"}}"#;

fn option<'a>(arguments: &[&'a str], name: &str) -> Option<&'a str> {
    arguments
        .windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1])
}

fn record(operation: &str) {
    if let Some(path) = env::var_os("WEWORK_E2E_DINGTALK_OPERATIONS") {
        let mut log = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .unwrap();
        log.write_all(format!("{operation}\n").as_bytes()).unwrap();
    }
}

fn read_scoped_messages(operation: &str) -> (&'static str, i32) {
    record(operation);
    if auth_state() == "scoped-read-denied" {
        (MISSING_READ_SCOPE, 1)
    } else {
        (EMPTY_MESSAGES, 0)
    }
}

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
            record("login");
            set_auth_state("ready");
            (r#"{"status":"ok"}"#, 0)
        }
        ["version", "--format", "json"] => (r#"{"version":"1.0.58"}"#, 0),
        ["auth", "status", ..] => (
            match option(&arguments, "--profile") {
                _ if auth_state() == EXPIRED => {
                    r#"{"success":true,"authenticated":false,"reason":"token_refresh_failed"}"#
                }
                Some(SCOPED_PROFILE) => {
                    r#"{"success":true,"authenticated":true,"token_valid":true,"user_id":"fixture-user","corp_id":"fixture-org"}"#
                }
                Some(OTHER_PROFILE) => {
                    r#"{"success":true,"authenticated":true,"token_valid":true,"user_id":"fixture-user","corp_id":"other-org"}"#
                }
                _ => r#"{"success":true,"authenticated":true,"token_valid":true}"#,
            },
            0,
        ),
        ["profile", "list", ..] if auth_state().starts_with("scoped-") => (
            r#"{"currentProfile":"fixture-org:fixture-user","profiles":[{"profile":"fixture-org:fixture-user","userName":"Fixture","userId":"fixture-user","corpId":"fixture-org","corpName":"Fixture Organization","isCurrent":true,"isOrgCurrent":true,"status":"active"},{"profile":"other-org:fixture-user","userName":"Fixture","userId":"fixture-user","corpId":"other-org","corpName":"Other Organization","isCurrent":false,"isOrgCurrent":false,"status":"active"}]}"#,
            0,
        ),
        ["profile", "list", ..] => (
            r#"{"currentProfile":"connection-test-account","profiles":[{"profile":"connection-test-account","userName":"Fixture","userId":"fixture-user"}]}"#,
            0,
        ),
        ["chat", "search", ..] if option(&arguments, "--query") == Some("Scoped Group") => {
            assert_eq!(option(&arguments, "--profile"), Some(SCOPED_PROFILE));
            search(
                r#"{"result":{"groups":[{"openConversationId":"scoped-group","title":"Scoped Group"},{"openConversationId":"other-group","title":"Other Group"}],"hasMore":false}}"#,
            )
        }
        ["chat", "search", ..] => search(r#"{"result":{"groups":[],"hasMore":false}}"#),
        ["contact", "user", "search", ..]
            if option(&arguments, "--query") == Some("Scoped Contact") =>
        {
            assert_eq!(option(&arguments, "--profile"), Some(SCOPED_PROFILE));
            search(
                r#"{"result":[{"userId":"contact-user","openDingTalkId":"scoped-contact","name":"Scoped Contact"},{"userId":"other-user","openDingTalkId":"other-contact","name":"Other Contact"}]}"#,
            )
        }
        ["contact", "user", "search", ..] => search(
            r#"{"result":[{"userId":"fixture-user","openDingTalkId":"fixture-user","name":"Fixture"}]}"#,
        ),
        ["chat", "conversation-info", ..] => {
            assert_eq!(option(&arguments, "--profile"), Some(SCOPED_PROFILE));
            assert_eq!(
                option(&arguments, "--open-dingtalk-id"),
                Some("scoped-contact")
            );
            (r#"{"result":{"openConversationId":"scoped-direct"}}"#, 0)
        }
        ["chat", "message", "list-mentions", ..]
            if option(&arguments, "--profile") == Some(SCOPED_PROFILE) =>
        {
            assert_eq!(option(&arguments, "--group"), Some("scoped-group"));
            read_scoped_messages("selected-group-mentions")
        }
        ["chat", "message", "search-advanced", ..]
            if option(&arguments, "--profile") == Some(SCOPED_PROFILE)
                && option(&arguments, "--conversation-ids") == Some("scoped-group") =>
        {
            record("selected-group-messages");
            if let Some(path) = env::var_os("WEWORK_E2E_DINGTALK_HANDBOOK_MESSAGES") {
                let payload = fs::read_to_string(path).unwrap();
                print!("{payload}");
                return;
            }
            (EMPTY_MESSAGES, 0)
        }
        ["chat", "message", "search-advanced", ..]
            if option(&arguments, "--profile") == Some(SCOPED_PROFILE) =>
        {
            assert_eq!(
                option(&arguments, "--conversation-ids"),
                Some("scoped-direct")
            );
            assert_eq!(option(&arguments, "--sender-ids"), Some("scoped-contact"));
            read_scoped_messages("selected-direct-messages")
        }
        ["chat", "+messages-list", ..]
            if env::var_os("WEWORK_E2E_DINGTALK_GROUP_MESSAGES").is_some() =>
        {
            assert_eq!(option(&arguments, "--group"), Some("scoped-group"));
            assert_eq!(option(&arguments, "--profile"), Some(SCOPED_PROFILE));
            assert!(option(&arguments, "--time").is_some());
            record("daily-group-read");
            let path = env::var_os("WEWORK_E2E_DINGTALK_GROUP_MESSAGES").unwrap();
            let payload = fs::read_to_string(path).unwrap();
            print!("{payload}");
            return;
        }
        ["calendar", "event", "list", ..]
            if env::var_os("WEWORK_E2E_DINGTALK_CALENDAR").is_some() =>
        {
            assert_eq!(option(&arguments, "--calendar-id"), Some("primary"));
            assert!(option(&arguments, "--start").is_some());
            assert!(option(&arguments, "--end").is_some());
            record("calendar-read");
            (
                r#"{"success":true,"result":[{"id":"event-fixture-1","summary":"DAILY_CHECK：评审会后的动作尚未指定负责人"}]}"#,
                0,
            )
        }
        ["chat", "message", "list-mentions", ..] | ["chat", "message", "search-advanced", ..] => {
            (EMPTY_MESSAGES, 0)
        }
        ["chat", "message", "reply", ..]
            if env::var_os("WEWORK_E2E_DINGTALK_HANDBOOK_REPLY").is_some() =>
        {
            record("send");
            assert_eq!(option(&arguments, "--profile"), Some(SCOPED_PROFILE));
            assert_eq!(
                option(&arguments, "--conversation-id"),
                Some("scoped-group")
            );
            assert_eq!(
                option(&arguments, "--ref-msg-id"),
                Some("welcome-launch-handbook")
            );
            assert_eq!(
                option(&arguments, "--ref-sender"),
                Some("fixture-colleague")
            );
            assert_eq!(
                option(&arguments, "--text"),
                Some("根据《产品客服手册》v3 第 2 节，本次验收窗口是 18:00。")
            );
            (
                r#"{"success":true,"result":{"openMessageId":"welcome-handbook-reply"}}"#,
                0,
            )
        }
        ["chat", "message", "reply" | "send" | "send-by-bot", ..] => {
            record("send");
            process::exit(2);
        }
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
