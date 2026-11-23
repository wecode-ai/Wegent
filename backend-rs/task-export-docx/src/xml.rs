// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! XML text and attribute escaping plus the small XML primitives the DOCX
//! renderer needs (`lxml`-compatible serialization forms).
//!
//! python-docx builds runs through lxml, which escapes text with the
//! predefined entities only (`&amp;`, `&lt;`, `&gt;`) and leaves quotes
//! untouched in text nodes. Attribute values written by python-docx's oxml
//! helpers use double quotes.

/// Escape XML text content like lxml (`&`, `<`, `>`).
pub(crate) fn escape_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

/// A `<w:t>` element. python-docx sets `xml:space="preserve"` when the text
/// has leading or trailing whitespace.
pub(crate) fn text_element(text: &str) -> String {
    if text.starts_with(' ') || text.ends_with(' ') {
        format!("<w:t xml:space=\"preserve\">{}</w:t>", escape_text(text))
    } else {
        format!("<w:t>{}</w:t>", escape_text(text))
    }
}
