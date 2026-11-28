// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, ops::Range, sync::OnceLock};

use regex::Regex;

use super::transcript_search_projection::markdown_literal_ranges;

struct Directive<'a> {
    end: usize,
    name: &'a str,
    label: Option<&'a str>,
    attributes: HashMap<&'a str, String>,
}

/// The renderer excludes annotation buttons from prose, but preserves literal Markdown.
pub(super) fn assistant_annotation_ranges(source: &str) -> Vec<Range<usize>> {
    static CANDIDATE: OnceLock<Regex> = OnceLock::new();
    let candidates = CANDIDATE.get_or_init(|| {
        Regex::new(r":+[a-zA-Z][a-zA-Z0-9_-]*(?:\{|\[)|【[^\n†】]+†L|\x{E200}(?:cite|filecite|filenav)(?:\x{E202}|$)")
            .expect("valid assistant annotation candidates")
    });
    let mut candidates = candidates.find_iter(source).peekable();
    if candidates.peek().is_none() {
        return Vec::new();
    }
    let protected = markdown_literal_ranges(source);
    let mut removed = Vec::new();
    let mut consumed = 0;
    let mut line_end = 0;
    let mut budgets = [0, 0];
    for found in candidates {
        let start = found.start();
        if start < consumed
            || protected.iter().any(|range| range.contains(&start))
            || source[..start]
                .bytes()
                .rev()
                .take_while(|byte| *byte == b'\\')
                .count()
                % 2
                == 1
        {
            continue;
        }
        if source[start..].starts_with('\u{e200}') {
            consumed = source[start..]
                .find('\u{e201}')
                .map_or(source.len(), |end| start + end + '\u{e201}'.len_utf8());
            removed.push(start..consumed);
        } else if source[start..].starts_with('【') {
            if let Some(end) = legacy_citation_end(&source[start..]) {
                consumed = start + end;
                removed.push(start..consumed);
            }
        } else {
            if start >= line_end {
                line_end = source[start..]
                    .find('\n')
                    .map_or(source.len(), |end| start + end);
                budgets.fill((line_end - start).saturating_mul(4));
            }
            let prefer_escapes = !found
                .as_str()
                .trim_start_matches(':')
                .starts_with("codex-file-citation{");
            if let Some(directive) = parse_directive(source, start, prefer_escapes, &mut budgets[0])
                .or_else(|| parse_directive(source, start, !prefer_escapes, &mut budgets[1]))
            {
                // Even unknown directives own their contents, including nested markers.
                consumed = directive.end;
                if is_prose_annotation(&directive) {
                    removed.push(start..consumed);
                }
            }
        }
    }
    removed
}

fn step(budget: &mut usize) -> Option<()> {
    *budget = budget.checked_sub(1)?;
    Some(())
}

fn word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

fn spaces(bytes: &[u8], cursor: &mut usize, budget: &mut usize) -> Option<()> {
    while bytes
        .get(*cursor)
        .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
    {
        step(budget)?;
        *cursor += 1;
    }
    Some(())
}

fn parse_directive<'a>(
    source: &'a str,
    start: usize,
    escaped_quotes: bool,
    budget: &mut usize,
) -> Option<Directive<'a>> {
    let bytes = source.as_bytes();
    let mut cursor = start;
    while bytes.get(cursor) == Some(&b':') {
        step(budget)?;
        cursor += 1;
    }
    if cursor - start > 3 {
        return None;
    }
    let name_start = cursor;
    while bytes.get(cursor).is_some_and(|byte| word(*byte)) {
        step(budget)?;
        cursor += 1;
    }
    let name = &source[name_start..cursor];
    let label = if bytes.get(cursor) == Some(&b'[') {
        if name != "codex-followup" {
            return None;
        }
        Some(parse_label(source, &mut cursor, budget)?)
    } else {
        None
    };
    if bytes.get(cursor) != Some(&b'{') {
        return None;
    }
    cursor += 1;
    let mut attributes = HashMap::new();
    while cursor < source.len() {
        step(budget)?;
        spaces(bytes, &mut cursor, budget)?;
        if bytes.get(cursor) == Some(&b'}') {
            return Some(Directive {
                end: cursor + 1,
                name,
                label,
                attributes,
            });
        }
        let key_start = cursor;
        while bytes.get(cursor).is_some_and(|byte| word(*byte)) {
            step(budget)?;
            cursor += 1;
        }
        let key = &source[key_start..cursor];
        if key.is_empty() || attributes.contains_key(key) {
            return None;
        }
        spaces(bytes, &mut cursor, budget)?;
        if bytes.get(cursor) != Some(&b'=') {
            return None;
        }
        cursor += 1;
        spaces(bytes, &mut cursor, budget)?;
        let value = parse_value(source, &mut cursor, escaped_quotes, budget)?;
        attributes.insert(key, value);
    }
    None
}

fn parse_label<'a>(source: &'a str, cursor: &mut usize, budget: &mut usize) -> Option<&'a str> {
    *cursor += 1;
    let label_start = *cursor;
    let mut depth = 1;
    let mut code_ticks = 0;
    let mut code_start = None;
    loop {
        step(budget)?;
        if *cursor >= source.len() || matches!(source.as_bytes()[*cursor], b'\r' | b'\n') {
            *cursor = code_start.take()?;
            code_ticks = 0;
        }
        let character = source[*cursor..].chars().next()?;
        *cursor += character.len_utf8();
        if character == '`' {
            let mut ticks = 1;
            while source.as_bytes().get(*cursor) == Some(&b'`') {
                step(budget)?;
                ticks += 1;
                *cursor += 1;
            }
            if code_ticks == 0 {
                code_ticks = ticks;
                code_start = Some(*cursor);
            } else if code_ticks == ticks {
                code_ticks = 0;
                code_start = None;
            }
        } else if code_ticks == 0 {
            match character {
                '\\' => *cursor += source[*cursor..].chars().next()?.len_utf8(),
                '[' => depth += 1,
                ']' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&source[label_start..*cursor - 1]);
                    }
                }
                _ => {}
            }
        }
    }
}

fn parse_value(
    source: &str,
    cursor: &mut usize,
    escaped_quotes: bool,
    budget: &mut usize,
) -> Option<String> {
    let quote = source.as_bytes().get(*cursor).copied()?;
    let quoted = matches!(quote, b'"' | b'\'');
    if quoted {
        *cursor += 1;
    }
    let mut value = String::new();
    while *cursor < source.len() {
        step(budget)?;
        let mut character = source[*cursor..].chars().next()?;
        if matches!(character, '\r' | '\n') {
            return None;
        }
        if quoted && character as u32 == u32::from(quote) {
            *cursor += 1;
            return Some(value);
        }
        if !quoted && (character.is_whitespace() || character == '}') {
            return (!value.is_empty()).then_some(value);
        }
        if quoted
            && escaped_quotes
            && character == '\\'
            && source.as_bytes().get(*cursor + 1) == Some(&quote)
        {
            *cursor += 1;
            character = char::from(quote);
        }
        value.push(character);
        *cursor += character.len_utf8();
    }
    (!quoted && !value.is_empty()).then_some(value)
}

fn is_prose_annotation(directive: &Directive<'_>) -> bool {
    if directive.name == "codex-followup" {
        return directive
            .label
            .is_some_and(|label| !label.trim().is_empty());
    }
    directive.name == "codex-file-citation"
        && directive
            .attributes
            .get("path")
            .is_some_and(|path| valid_citation_path(path))
        && directive.attributes.get("purpose").is_none_or(|purpose| {
            purpose.is_empty() || matches!(purpose.as_str(), "source" | "output")
        })
}

fn valid_citation_path(value: &str) -> bool {
    if value
        .chars()
        .any(|character| character <= '\u{1f}' || character == '\u{7f}')
    {
        return false;
    }
    let mut path = value.trim();
    if path
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"))
    {
        path = &path[7..];
        if path
            .get(..10)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("localhost/"))
        {
            path = &path[9..];
        }
        if path.starts_with('/') && windows_path(&path[1..]) {
            path = &path[1..];
        }
    }
    let scheme = path.split_once(':').is_some_and(|(prefix, _)| {
        prefix
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
            && prefix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
    });
    !path.is_empty() && (!scheme || windows_path(path))
}

fn windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
}

fn legacy_citation_end(source: &str) -> Option<usize> {
    static LEGACY: OnceLock<Regex> = OnceLock::new();
    let matched = LEGACY
        .get_or_init(|| {
            Regex::new(r"^【([^†】\n]+)†L([0-9]+)(?:-L([0-9]+))?】").expect("valid legacy citation")
        })
        .captures(source)?;
    let raw = matched.get(1)?.as_str();
    let explicit = raw.starts_with("F:");
    let raw = raw.strip_prefix("F:").unwrap_or(raw).trim();
    let path = decode_uri(raw).unwrap_or_else(|| raw.to_owned());
    let absolute = path.starts_with('/')
        || windows_path(&path)
        || path
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file://"));
    ((explicit || absolute) && valid_citation_path(&path)).then(|| matched.get(0).unwrap().end())
}

/// decodeURI preserves reserved delimiters and rejects malformed UTF-8 or escapes.
fn decode_uri(source: &str) -> Option<String> {
    let bytes = source.as_bytes();
    let mut output = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] == b'%' {
            let end = cursor.checked_add(3)?;
            let escaped = source.get(cursor + 1..end)?;
            let decoded = u8::from_str_radix(escaped, 16).ok()?;
            if b";/?:@&=+$,#".contains(&decoded) {
                output.extend_from_slice(bytes.get(cursor..end)?);
            } else {
                output.push(decoded);
            }
            cursor = end;
        } else {
            output.push(bytes[cursor]);
            cursor += 1;
        }
    }
    String::from_utf8(output).ok()
}
