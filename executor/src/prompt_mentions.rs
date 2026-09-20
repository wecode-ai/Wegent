use std::sync::OnceLock;

use regex::Regex;

pub(crate) struct PromptMention {
    pub start: usize,
    pub end: usize,
    pub label: String,
    pub href: String,
}

impl PromptMention {
    pub fn name(&self) -> Option<&str> {
        let label = self.label.trim();
        let name = if self.href.starts_with("app://") || self.href.starts_with("plugin://") {
            label.trim_start_matches(['$', '@'])
        } else {
            label.strip_prefix('$')?
        };
        (!name.is_empty()).then_some(name)
    }
}

pub(crate) fn skill_name(name: &str) -> &str {
    name.split('?').next().unwrap_or(name).trim()
}

pub(crate) fn prompt_mentions(content: &str) -> Vec<PromptMention> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"\[((?:\\[^\r\n]|[^\]\\\r\n])+)\]\(((?:\\[^\r\n]|[^)\\\r\n])+)\)")
            .expect("valid prompt link pattern")
    });
    pattern
        .captures_iter(content)
        .map(|capture| {
            let matched = capture.get(0).expect("whole link match");
            PromptMention {
                start: matched.start(),
                end: matched.end(),
                label: unescape_markdown(&capture[1]),
                href: unescape_destination(&capture[2]),
            }
        })
        .collect()
}

fn unescape_destination(value: &str) -> String {
    let bytes = value.as_bytes();
    let windows_path = value.starts_with("\\\\")
        || value.starts_with("~\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\');
    if !windows_path {
        return unescape_markdown(value);
    }
    // Preserve separators before punctuation such as dot directories.
    let decoded = value.replace("\\\\", "\\");
    if value.starts_with("\\\\") && !decoded.starts_with("\\\\") {
        format!("\\{decoded}")
    } else {
        decoded
    }
}

fn unescape_markdown(value: &str) -> String {
    let mut result = String::new();
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\' && chars.peek().is_some_and(char::is_ascii_punctuation) {
            result.push(chars.next().expect("escaped punctuation"));
        } else {
            result.push(character);
        }
    }
    result
}

pub(crate) fn is_skill_reference(href: &str) -> bool {
    if href.is_empty()
        || [
            "app://",
            "plugin://",
            "file://",
            "folder://",
            "cloud://",
            "wework-member://",
            "wework-agent://",
            "wework-group://",
            "wework-issue://",
            "wework-conversation://",
        ]
        .iter()
        .any(|prefix| href.starts_with(prefix))
    {
        return false;
    }
    !url::Url::parse(href.trim()).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}
