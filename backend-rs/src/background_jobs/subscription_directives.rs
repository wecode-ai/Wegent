//! Per-message group notification controls shared by completion and delivery.
use std::sync::LazyLock;

static SILENT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)\s*(?:\[\s*(?:静默|silent)\s*\]|【\s*(?:静默|silent)\s*】)\s*$")
        .expect("static silent directive")
});
static MENTION: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)\s*(?:\[\s*(?:@\s*列表\s*[:：]\s*|mention\s*[:：]?\s*|@\s*)([^\]\n]*?)\s*\]|【\s*(?:@\s*列表\s*[:：]\s*|mention\s*[:：]?\s*|@\s*)([^】\n]*?)\s*】)\s*$",
    )
    .expect("static mention directive")
});
static SEPARATOR: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"[,，;；\s]+").expect("static ID separator"));

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Directives {
    pub(crate) content: String,
    pub(crate) silent: bool,
    pub(crate) mentions: Vec<String>,
}

fn mention_ids(raw: &str) -> Vec<String> {
    SEPARATOR
        .split(raw)
        .filter_map(|part| {
            let id = part
                .trim_matches(|c: char| {
                    matches!(
                        c,
                        ' ' | '\t'
                            | '\r'
                            | '\n'
                            | '@'
                            | ':'
                            | '：'
                            | ','
                            | '，'
                            | ';'
                            | '；'
                            | '.'
                            | '。'
                            | '!'
                            | '！'
                            | '?'
                            | '？'
                    )
                })
                .split([':', '：'])
                .next()
                .unwrap_or("");
            (!id.is_empty() && id.chars().all(|c| c.is_ascii_digit())).then(|| id.to_string())
        })
        .collect()
}

pub(crate) const GROUP_NOTIFICATION_CONTROL_INSTRUCTION: &str = concat!(
    "群通知控制（仅影响已绑定的群聊，不影响私聊）：",
    "控制说明必须放在【】中，并作为回答最后一行单独输出。",
    "如果本次不需要发送群聊通知，请输出“【静默】”；",
    "如果需要在群聊中 @指定用户，请输出",
    "“【@列表:1234,1235】”或“【mention:1234,1235】”，",
    "将 staffId 替换为实际工号。",
    "这些控制标记只用于通知路由，不要写进正文或其他位置。"
);

pub(crate) fn append_group_notification_instruction(
    prompt: &str,
    subscription: &serde_json::Value,
) -> String {
    let has_bound_group = subscription["_internal"]["notification_channel_bindings"]
        .as_object()
        .is_some_and(|bindings| {
            bindings.values().any(|config| {
                config["bind_group"] == true
                    && config["group_conversation_id"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty())
            })
        });
    if has_bound_group {
        format!(
            "{}\n\n---\n\n{GROUP_NOTIFICATION_CONTROL_INSTRUCTION}",
            prompt.trim_end()
        )
    } else {
        prompt.to_string()
    }
}

pub(crate) fn parse(message: &str) -> Directives {
    let mut content = message.trim_end().to_string();
    let mut result = Directives::default();
    loop {
        let mut matched = false;
        if let Some(captures) = SILENT.captures(&content) {
            let start = captures.get(0).expect("silent match").start();
            content.truncate(start);
            content = content.trim_end().to_string();
            result.silent = true;
            matched = true;
        }
        if let Some(captures) = MENTION.captures(&content) {
            let start = captures.get(0).expect("mention match").start();
            let raw = captures
                .get(1)
                .or_else(|| captures.get(2))
                .map_or("", |value| value.as_str());
            result.mentions.extend(mention_ids(raw));
            content.truncate(start);
            content = content.trim_end().to_string();
            matched = true;
        }
        if !matched {
            break;
        }
    }
    let mut seen = std::collections::HashSet::new();
    result.mentions.retain(|id| seen.insert(id.clone()));
    result.content = content.trim().to_string();
    result
}

pub(crate) fn strip(message: Option<String>) -> Option<String> {
    message.map(|value| parse(&value).content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_trailing_controls_and_preserves_body() {
        let parsed = parse("Build finished\n\n【静默】【@列表：900101，900102】");
        assert_eq!(parsed.content, "Build finished");
        assert!(parsed.silent);
        assert_eq!(parsed.mentions, ["900101", "900102"]);
        assert_eq!(
            parse("Discuss 【静默】 in the body").content,
            "Discuss 【静默】 in the body"
        );
    }

    #[test]
    fn accepts_bracket_colon_and_comma_variants() {
        for message in [
            "Report [mention:1234,1235]",
            "Report 【@列表:1234，1235】",
            "Report 【@列表：1234,1235】",
        ] {
            let parsed = parse(message);
            assert_eq!(parsed.content, "Report");
            assert_eq!(parsed.mentions, ["1234", "1235"]);
        }
    }

    #[test]
    fn invalid_targets_do_not_create_mentions() {
        for message in ["Report\n\n【@列表：】", "Report\n\n【@列表：张三】"] {
            let parsed = parse(message);
            assert_eq!(parsed.content, "Report");
            assert!(parsed.mentions.is_empty());
        }
    }

    #[test]
    fn scans_across_empty_and_invalid_controls() {
        for (message, silent, mentions) in [
            ("Report\n【静默】\n\n【@列表：】", true, vec![]),
            ("Report\n【静默】\n\n【@列表：张三】", true, vec![]),
            (
                "Report\n【@列表:900101】\n\n【@列表：】",
                false,
                vec!["900101"],
            ),
            (
                "Report\n\n【静默】\n\n【@列表:900101】",
                true,
                vec!["900101"],
            ),
        ] {
            let parsed = parse(message);
            assert_eq!(parsed.content, "Report");
            assert_eq!(parsed.silent, silent);
            assert_eq!(parsed.mentions, mentions);
            assert_eq!(strip(Some(parsed.content)).as_deref(), Some("Report"));
        }
    }

    #[test]
    fn appends_instruction_only_for_a_bound_group() {
        let bound = serde_json::json!({
            "_internal": {"notification_channel_bindings": {
                "9": {"bind_group": true, "group_conversation_id": "conversation-1"}
            }}
        });
        let prompt = append_group_notification_instruction("Check the service.\n", &bound);
        assert!(prompt.starts_with("Check the service.\n\n---\n\n"));
        assert!(prompt.contains("【静默】"));
        assert!(prompt.contains("【@列表:1234,1235】"));

        for subscription in [
            serde_json::json!({}),
            serde_json::json!({"_internal": {"notification_channel_bindings": {
                "9": {"bind_group": false, "group_conversation_id": "conversation-1"}
            }}}),
            serde_json::json!({"_internal": {"notification_channel_bindings": {
                "9": {"bind_group": true, "group_conversation_id": ""}
            }}}),
        ] {
            assert_eq!(
                append_group_notification_instruction("Check the service.", &subscription),
                "Check the service."
            );
        }
    }
}
