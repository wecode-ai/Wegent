// External DingTalk protocol double; native collection, permission and delivery stay real.
use std::{
    env, fs,
    io::Write,
    path::Path,
    process::{self, Command},
};

fn quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].as_str())
}

fn active(root: &Path, args: &[String]) -> Option<String> {
    let words = args.iter().map(String::as_str).collect::<Vec<_>>();
    match words.as_slice() {
        ["chat", "+messages-list", ..] => Some(fs::read_to_string(root.join("history.json")).expect("native image history")),
        ["chat", "message", "download-media", ..] => {
            assert_eq!(flag(args, "--resource-id"), Some("@source-story-image"));
            assert_eq!(flag(args, "--message-id"), Some("source-story-image-message"));
            assert_eq!(flag(args, "--open-conversation-id"), Some("source-story-group"));
            let output = flag(args, "--output").expect("host-owned output");
            fs::copy(root.join("image.png"), output).expect("download actual image bytes");
            fs::write(root.join("download-path.txt"), output).expect("download audit");
            Some(r#"{"success":true}"#.into())
        }
        ["chat", "search", ..] => Some(r#"{"success":true,"result":{"groups":[{"openConversationId":"source-story-group","title":"Source story group"}],"hasMore":false}}"#.into()),
        ["chat", "message", "list-mentions", ..] | ["chat", "message", "search-advanced", ..] => {
            Some(fs::read_to_string(root.join("mentions.json")).expect("published protocol data"))
        }
        ["chat", "message", "reply", ..] => {
            let group = flag(args, "--conversation-id").expect("bound conversation");
            let message = flag(args, "--ref-msg-id").expect("bound message");
            let sender = flag(args, "--ref-sender").expect("bound sender");
            let text = flag(args, "--text").expect("exact reply text");
            let uuid = flag(args, "--uuid").expect("native idempotency key");
            let mentions = flag(args, "--at-open-dingtalk-ids").unwrap_or("");
            if message == "SOURCE_REPLY_STORY-message-1" {
                assert_eq!(mentions, "source-story-colleague");
            }
            assert_eq!(group, "source-story-group");
            assert_eq!(sender, "source-story-sender");
            assert!(message.starts_with("SOURCE_REPLY_STORY-message-"));
            assert!(uuid.len() == 64 && uuid.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(args.iter().any(|arg| arg == "--ai-tag=true"));
            let record = format!("{{\"messageId\":{},\"group\":{},\"uuid\":{},\"text\":{},\"mentions\":{}}}\n", quote(message), quote(group), quote(uuid), quote(text), quote(mentions));
            fs::OpenOptions::new().create(true).append(true).open(root.join("replies.jsonl"))
                .expect("reply audit").write_all(record.as_bytes()).expect("record accepted reply");
            Some(format!("{{\"success\":true,\"result\":{{\"openMessageId\":{}}}}}", quote(&format!("accepted-{message}"))))
        }
        _ => None,
    }
}

fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let binary = env::current_exe().expect("fixture executable");
    let root = binary
        .parent()
        .expect("fixture directory")
        .join("dingtalk-story");
    if root.join("active").exists() {
        if let Some(response) = active(&root, &args) {
            println!("{response}");
            return;
        }
    }
    // Before the new phase, delegate every command unchanged to the original fixture.
    let baseline =
        fs::read_to_string(root.join("baseline-path.txt")).expect("original fixture path");
    let status = Command::new(baseline.trim())
        .args(&args)
        .status()
        .expect("original fixture process");
    process::exit(status.code().unwrap_or(1));
}
