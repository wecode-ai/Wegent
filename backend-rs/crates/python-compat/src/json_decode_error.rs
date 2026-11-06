// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Python JSONDecodeError diagnostics shared by raw-body request adapters.

pub struct JsonDecodeError {
    pub message: &'static str,
    pub line: usize,
    pub column: usize,
    pub position: usize,
}

impl std::fmt::Display for JsonDecodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}: line {} column {} (char {})",
            self.message, self.line, self.column, self.position
        )
    }
}

pub fn describe(text: &str, error: &serde_json::Error) -> JsonDecodeError {
    let message = error.to_string();
    let (line, reported_column) = (error.line(), error.column());
    // EOF positions name the character after the last token, matching
    // Python's end-of-document coordinates.
    let mut column = if message.starts_with("EOF while parsing") {
        reported_column + 1
    } else {
        reported_column
    };
    let mut offset = char_offset(text, line, column);
    // Python reports the start of an unparsable literal token (`n`/`t`/`f`).
    if message.starts_with("expected ident") {
        let line_start = offset.saturating_sub(reported_column.saturating_sub(1));
        let characters: Vec<char> = text.chars().collect();
        let mut start = offset.min(characters.len());
        while start > 0 && characters[start - 1].is_ascii_alphanumeric() {
            start -= 1;
        }
        offset = start;
        column = offset.saturating_sub(line_start) + 1;
    }
    let heading = if message.starts_with("expected value") {
        "Expecting value"
    } else if message.starts_with("key must be a string") {
        "Expecting property name enclosed in double quotes"
    } else if message.starts_with("expected `:`") {
        "Expecting ':' delimiter"
    } else if message.starts_with("expected `,` or `}`")
        || message.starts_with("expected `,` or `]`")
    {
        "Expecting ',' delimiter"
    } else if message.starts_with("trailing characters") {
        "Extra data"
    } else if message.starts_with("unterminated string") {
        "Unterminated string starting at"
    } else if message.starts_with("EOF while parsing") {
        eof_heading(&message, text)
    } else {
        "Expecting value"
    };
    JsonDecodeError {
        message: heading,
        line,
        column,
        position: offset,
    }
}

/// Python's heading for a truncated document, chosen from the parser state
/// serde reports plus the last token.
fn eof_heading(message: &str, text: &str) -> &'static str {
    let last = text.trim_end().chars().last();
    if message.contains("parsing a string") {
        return "Unterminated string starting at";
    }
    if message.contains("parsing a value") {
        return "Expecting value";
    }
    if message.contains("parsing an object") {
        return match last {
            Some('{') | Some(',') => "Expecting property name enclosed in double quotes",
            _ => "Expecting ',' delimiter",
        };
    }
    if message.contains("parsing a list") {
        return match last {
            Some('[') | Some(',') => "Expecting value",
            _ => "Expecting ',' delimiter",
        };
    }
    "Expecting value"
}

/// Zero-based character offset of a 1-based line/column position.
fn char_offset(text: &str, line: usize, column: usize) -> usize {
    let mut offset = 0;
    for (index, current) in text.split('\n').enumerate() {
        if index + 1 == line {
            return offset + column.saturating_sub(1);
        }
        offset += current.chars().count() + 1;
    }
    offset
}
