//! DingTalk protocol double backed by the isolated desktop scenario's mailbox.
use std::{
    env, fs,
    io::Write,
    path::Path,
    process,
    time::{SystemTime, UNIX_EPOCH},
};

const PROFILE: &str = "dots-org:dots-owner";
const GROUP: &str = "dots-group";
const OTHER_GROUP: &str = "dots-other-group";
const PEER: &str = "dots-peer";
const OTHER_PEER: &str = "dots-other-peer";
const DIRECT: &str = "dots-direct";
const OTHER_DIRECT: &str = "dots-other-direct";

fn quote(value: &str) -> String {
    let mut escaped = String::from("\"");
    for char in value.chars() {
        match char {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\u{0}'..='\u{1f}' => escaped.push_str(&format!("\\u{:04x}", char as u32)),
            _ => escaped.push(char),
        }
    }
    escaped.push('"');
    escaped
}

fn flag<'a>(args: &[&'a str], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1])
}

fn required<'a>(args: &[&'a str], name: &str) -> &'a str {
    flag(args, name).unwrap_or_else(|| panic!("Expected DingTalk flag {name}"))
}

fn read(root: &Path, name: &str) -> String {
    fs::read_to_string(root.join(name)).unwrap_or_else(|error| panic!("Read {name}: {error}"))
}

fn append(root: &Path, name: &str, mut value: String) {
    value.push('\n');
    fs::OpenOptions::new()
        .append(true)
        .open(root.join(name))
        .expect("open isolated DingTalk audit")
        .write_all(value.as_bytes())
        .expect("write isolated DingTalk audit");
}

fn disconnected() -> ! {
    println!(
        r#"{{"success":false,"error":{{"code":"NETWORK_ERROR","message":"isolated DingTalk connection unavailable"}}}}"#
    );
    process::exit(6);
}

fn timestamp(value: &str) -> String {
    let utc = value
        .strip_suffix('Z')
        .or_else(|| value.strip_suffix("+00:00"))
        .expect("DingTalk fixture timestamps are UTC");
    let (seconds, fraction) = utc.split_once('.').unwrap_or((utc, ""));
    assert_eq!(seconds.len(), 19, "DingTalk fixture timestamps use RFC3339");
    assert!(fraction.len() <= 9 && fraction.bytes().all(|byte| byte.is_ascii_digit()));
    format!("{seconds}.{fraction:0<9}")
}

struct Message<'a> {
    at: &'a str,
    time: String,
    conversation: &'a str,
    kind: &'a str,
    sender: &'a str,
    mentioned: bool,
    search_json: &'a str,
    native_json: &'a str,
}

fn mailbox(data: &str) -> Vec<Message<'_>> {
    let mut messages: Vec<_> = data
        .lines()
        .map(|line| {
            let parts: Vec<_> = line.split('\t').collect();
            let [at, conversation, kind, sender, mentioned, search_json, native_json] = parts[..]
            else {
                panic!("Expected seven fields in the isolated DingTalk mailbox");
            };
            Message {
                at,
                time: timestamp(at),
                conversation,
                kind,
                sender,
                mentioned: mentioned == "1",
                search_json,
                native_json,
            }
        })
        .collect();
    messages.sort_by(|left, right| right.time.cmp(&left.time));
    messages
}

fn audit_read(root: &Path, operation: &str, conversation: &str, args: &[&str]) {
    let quoted_flag = |name| quote(flag(args, name).unwrap_or(""));
    let offline = read(root, "offline") == "true";
    append(
        root,
        "reads.jsonl",
        format!(
            "{{\"operation\":{},\"conversationId\":{},\"start\":{},\"end\":{},\"senderIds\":{},\"cursor\":{},\"offline\":{offline}}}",
            quote(operation),
            quote(conversation),
            quoted_flag("--start"),
            quote(flag(args, "--end").or_else(|| flag(args, "--time")).unwrap_or("")),
            quoted_flag("--sender-ids"),
            quoted_flag("--cursor")
        ),
    );
    if offline {
        disconnected();
    }
}

fn direct_conversation(args: &[&str]) -> &'static str {
    match required(args, "--open-dingtalk-id") {
        PEER => DIRECT,
        OTHER_PEER => OTHER_DIRECT,
        peer => panic!("Unknown DingTalk test peer {peer}"),
    }
}

fn native_direct(root: &Path, args: &[&str]) -> String {
    let conversation = direct_conversation(args);
    audit_read(root, "list-direct", conversation, args);
    let until = timestamp(required(args, "--time"));
    let limit = required(args, "--limit").parse::<usize>().expect("limit");
    assert!(limit > 0);
    let data = read(root, "messages.tsv");
    let messages = mailbox(&data);
    let matching: Vec<_> = messages
        .iter()
        .filter(|message| {
            message.kind == "direct"
                && message.conversation == conversation
                && message.time <= until
        })
        .collect();
    let has_more = matching.len() > limit;
    let result = matching
        .iter()
        .take(limit)
        .map(|value| value.native_json)
        .collect::<Vec<_>>()
        .join(",");
    let next = if has_more {
        format!(
            ",\"nextPage\":{{\"time\":{}}}",
            quote(matching[limit - 1].at)
        )
    } else {
        String::new()
    };
    format!("{{\"contractVersion\":\"im.message-list.v1\",\"paginationKnown\":true,\"hasMore\":{has_more},\"complete\":true,\"failedCount\":0,\"messages\":[{result}]{next}}}")
}

fn search_messages(root: &Path, args: &[&str], mentions: bool) -> String {
    let (operation, field) = if mentions {
        ("list-mentions", "--group")
    } else {
        ("search-advanced", "--conversation-ids")
    };
    let conversation = required(args, field);
    audit_read(root, operation, conversation, args);
    let single = match conversation {
        DIRECT | OTHER_DIRECT if !mentions => true,
        GROUP | OTHER_GROUP => false,
        _ => panic!("DingTalk fixture expects an exact conversation: {conversation}"),
    };
    let sender_ids = flag(args, "--sender-ids").map(|value| value.split(',').collect::<Vec<_>>());
    let start = timestamp(required(args, "--start"));
    let end = timestamp(required(args, "--end"));
    let limit = required(args, "--limit").parse::<usize>().expect("limit");
    let cursor = required(args, "--cursor").parse::<usize>().expect("cursor");
    assert!(limit > 0);
    let data = read(root, "messages.tsv");
    let messages = mailbox(&data);
    let matching: Vec<_> = messages
        .iter()
        .filter(|message| {
            message.conversation == conversation
                && (message.kind == "direct") == single
                && (!mentions || message.mentioned)
                && sender_ids
                    .as_ref()
                    .map_or(true, |ids| ids.contains(&message.sender))
                && message.time >= start
                && message.time <= end
        })
        .collect();
    let next = cursor + limit;
    let has_more = next < matching.len();
    let selected = matching
        .iter()
        .skip(cursor)
        .take(limit)
        .map(|value| value.search_json)
        .collect::<Vec<_>>()
        .join(",");
    let conversation = quote(conversation);
    let next_cursor = if has_more { next } else { 0 };
    format!("{{\"success\":true,\"result\":{{\"hasMore\":{has_more},\"nextCursor\":\"{next_cursor}\",\"conversationMessagesList\":[{{\"singleChat\":{single},\"openConversationId\":{conversation},\"title\":{conversation},\"messages\":[{selected}]}}]}}}}")
}

fn delivery_for<'a>(config: &'a str, message: &str) -> Option<(&'a str, &'a str)> {
    config.lines().find_map(|row| {
        let (id, outcome) = row.split_once('\t').expect("Configured delivery id");
        (id == message).then(|| {
            outcome
                .split_once('\t')
                .expect("Configured delivery mode and conversation")
        })
    })
}

fn reply(root: &Path, args: &[&str]) -> String {
    let message = required(args, "--ref-msg-id");
    let profile = required(args, "--profile");
    let conversation = required(args, "--conversation-id");
    let sender = required(args, "--ref-sender");
    let text = required(args, "--text");
    let uuid = required(args, "--uuid");
    let ai_tag = args.contains(&"--ai-tag=true");
    let unknown = read(root, "unknown-receipt") == message;
    let offline = read(root, "offline") == "true";
    let attempted_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    append(
        root,
        "replies.jsonl",
        format!(
            "{{\"messageId\":{},\"conversationId\":{},\"senderId\":{},\"text\":{},\"uuid\":{},\"profile\":{},\"aiTag\":{ai_tag},\"unknown\":{unknown},\"offline\":{offline},\"attemptedAt\":{attempted_at}}}",
            quote(message), quote(conversation), quote(sender), quote(text), quote(uuid), quote(profile)
        ),
    );
    assert!(ai_tag, "DingTalk delegation must mark AI delivery");
    assert_eq!(profile, PROFILE);
    assert_eq!(required(args, "--format"), "json");
    assert!(uuid.len() == 64 && uuid.bytes().all(|byte| byte.is_ascii_hexdigit()));
    if offline {
        disconnected();
    }
    if unknown {
        return r#"{"success":true,"result":{}}"#.into();
    }
    let delivery = read(root, "delivery.tsv");
    if let Some((mode, expected_conversation)) = delivery_for(&delivery, message) {
        assert_eq!(conversation, expected_conversation);
        if mode == "rejected" {
            println!(
                r#"{{"success":false,"code":"PAT_SCOPE_AUTH_REQUIRED","data":{{"errorType":"missing_scope"}}}}"#
            );
            process::exit(6);
        }
        assert!(matches!(mode, "automatic" | "manual"));
        let task = quote(&format!("task-{message}"));
        return match (mode, conversation) {
            ("automatic", DIRECT) => format!(r#"{{"result":{{"openTaskId":{task}}}}}"#),
            ("automatic", GROUP) => format!(r#"{{"openTaskId":{task}}}"#),
            _ => format!(r#"{{"success":true,"result":{{"openTaskId":{task}}}}}"#),
        };
    }
    let receipt = quote(&format!("accepted-{message}"));
    format!("{{\"success\":true,\"result\":{{\"openMessageId\":{receipt}}}}}")
}

fn query_send_status(root: &Path, args: &[&str]) -> String {
    let task_id = required(args, "--open-task-id");
    let profile = required(args, "--profile");
    let delivery = read(root, "delivery.tsv");
    let message = task_id.strip_prefix("task-").expect("Fixture send task ID");
    let (mode, conversation) = delivery_for(&delivery, message).expect("Configured channel task");
    assert_eq!(profile, PROFILE);
    assert_eq!(required(args, "--format"), "json");
    let task = quote(task_id);
    let matching = match mode {
        "automatic" => read(root, "reads.jsonl").contains(&format!("\"taskId\":{task}")),
        "manual" => read(root, "matching-receipt") == "true",
        _ => panic!("Only a submitted channel task can be queried"),
    };
    append(
        root,
        "reads.jsonl",
        format!(
            "{{\"operation\":\"query-send-status\",\"taskId\":{task},\"profile\":{},\"matching\":{matching}}}",
            quote(profile)
        ),
    );
    if mode == "automatic" && !matching {
        return format!(
            r#"{{"contractVersion":"im.message-send-status.v1","openTaskId":{task},"readyForMessageActions":false}}"#
        );
    }
    let conversation = quote(if matching { conversation } else { OTHER_GROUP });
    let receipt = quote(&format!("accepted-{message}"));
    format!(
        r#"{{"contractVersion":"im.message-send-status.v1","openTaskId":{task},"readyForMessageActions":true,"messageRef":{{"openConversationId":{conversation},"openMessageId":{receipt}}}}}"#
    )
}

fn matching_resources(args: &[&str], rows: &[(&str, String)]) -> String {
    let query = required(args, "--query").to_lowercase();
    rows.iter()
        .filter(|(name, _)| name.to_lowercase().contains(&query))
        .map(|(_, resource)| resource.as_str())
        .collect::<Vec<_>>()
        .join(",")
}

fn main() {
    let arguments: Vec<_> = env::args().skip(1).collect();
    let args: Vec<_> = arguments.iter().map(String::as_str).collect();
    let binary = env::current_exe().expect("DingTalk fixture executable");
    let root = binary.parent().unwrap().join("delegation-dingtalk");
    let account = read(&root, "account.tsv");
    let (user, org) = account.split_once('\t').expect("DingTalk account fixture");
    let profile = quote(&format!("{org}:{user}"));
    let owner = "Dots owner";
    let response = match args.as_slice() {
        ["health" | "login", ..] => r#"{"status":"ok"}"#.into(),
        ["version", "--format", "json"] => r#"{"version":"1.0.58"}"#.into(),
        ["auth", "status", ..] => format!(
            "{{\"success\":true,\"authenticated\":true,\"token_valid\":true,\"user_id\":{},\"corp_id\":{}}}",
            quote(user), quote(org)
        ),
        ["profile", "list", ..] => format!(
            "{{\"currentProfile\":{profile},\"profiles\":[{{\"profile\":{profile},\"userName\":\"{owner}\",\"userId\":{},\"corpId\":{},\"orgName\":\"Dots test organization\",\"isCurrent\":true,\"isOrgCurrent\":true,\"status\":\"active\"}}]}}",
            quote(user), quote(org)
        ),
        ["chat", "search", ..] => {
            let groups = [
                ("Dots selected group", GROUP),
                ("Dots excluded group", OTHER_GROUP),
            ]
            .map(|(name, id)| (name, format!("{{\"openConversationId\":\"{id}\",\"title\":\"{name}\"}}")));
            let matched = matching_resources(&args, &groups);
            format!("{{\"success\":true,\"result\":{{\"groups\":[{matched}],\"hasMore\":false}}}}")
        }
        ["contact", "user", "search", ..] => {
            let people = [
                (owner, user),
                ("Dots selected peer", PEER),
                ("Dots excluded peer", OTHER_PEER),
            ]
            .map(|(name, id)| {
                let id = quote(id);
                (name, format!("{{\"userId\":{id},\"openDingTalkId\":{id},\"name\":\"{name}\"}}"))
            });
            let matched = matching_resources(&args, &people);
            format!("{{\"success\":true,\"result\":[{matched}]}}")
        }
        ["chat", "conversation-info", ..] => {
            let conversation = direct_conversation(&args);
            audit_read(&root, "conversation-info", conversation, &args);
            format!("{{\"result\":{{\"openConversationId\":\"{conversation}\"}}}}")
        }
        ["chat", "+messages-list-direct", ..] => native_direct(&root, &args),
        ["chat", "message", "list-mentions", ..] => search_messages(&root, &args, true),
        ["chat", "message", "search-advanced", ..] => search_messages(&root, &args, false),
        ["chat", "message", "reply", ..] => reply(&root, &args),
        ["chat", "+messages-query-send-status", ..] => query_send_status(&root, &args),
        _ => panic!("Unrecognized isolated DingTalk command: {:?}", args.iter().take(3).collect::<Vec<_>>()),
    };
    println!("{response}");
}
