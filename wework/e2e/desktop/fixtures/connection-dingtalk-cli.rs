// Synthetic DingTalk protocol boundary; no credentials or network access.
use std::{env, process};

fn main() {
    let arguments: Vec<String> = env::args().skip(1).collect();
    let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
    let response = match arguments.as_slice() {
        ["health", ..] => r#"{"status":"ok"}"#,
        ["profile", "list", ..] => {
            r#"{"currentProfile":"connection-test-account","profiles":[{"profile":"connection-test-account","userName":"Fixture","userId":"fixture-user"}]}"#
        }
        ["chat", "search", ..] => r#"{"result":{"groups":[],"hasMore":false}}"#,
        ["contact", "user", "search", ..] => {
            r#"{"result":[{"userId":"fixture-user","openDingTalkId":"fixture-user","name":"Fixture"}]}"#
        }
        ["chat", "message", "list-mentions", ..] | ["chat", "message", "search-advanced", ..] => {
            r#"{"success":true,"result":{"hasMore":false,"nextCursor":"0","conversationMessagesList":[]}}"#
        }
        _ => {
            eprintln!("Only declared DingTalk fixture reads are supported");
            process::exit(2);
        }
    };
    println!("{response}");
}
