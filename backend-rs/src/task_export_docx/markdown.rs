// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Markdown parsing and rendering into WordprocessingML paragraph forms,
//! mirroring `app.services.export.docx_generator`'s line parser, inline
//! formatter, and code/table/list rendering.

use super::xml::{escape_text, text_element};

const PRIMARY_COLOR: &str = "14B8A6";
const TEXT_COLOR: &str = "24292E";
const LATIN_FONT: &str = "Arial";
const EAST_ASIA_FONT: &str = "Microsoft YaHei";
const MONOSPACE_FONT: &str = "Courier New";

/// An `xml:space="preserve"` `<w:t>` for labels that keep edge whitespace.
fn text_preserve(text: &str) -> String {
    format!("<w:t xml:space=\"preserve\">{}</w:t>", escape_text(text))
}

/// `_set_rpr_fonts`' `w:rFonts` element.
fn r_fonts(latin: &str, east_asia: &str) -> String {
    format!(
        "<w:rFonts w:ascii=\"{latin}\" w:hAnsi=\"{latin}\" w:eastAsia=\"{east_asia}\" w:cs=\"{latin}\"/>"
    )
}

/// `_set_rpr_language`.
fn lang() -> &'static str {
    "<w:lang w:val=\"en-US\" w:eastAsia=\"zh-CN\"/>"
}

/// One markdown segment after inline parsing (`_add_inline_formatting`).
#[derive(Debug, PartialEq)]
enum Segment {
    Text(String),
    Bold(String),
    Italic(String),
    BoldItalic(String),
    Strikethrough(String),
    Code(String),
    Link(String, String),
}

/// Find `delim + inner + delim` (non-greedy, no newline) like the source
/// regexes; returns (start, end, inner).
fn find_delimited(text: &str, delimiter: &str) -> Option<(usize, usize, String)> {
    let start = text.find(delimiter)?;
    let rest = &text[start + delimiter.len()..];
    let end_rel = rest.find(delimiter)?;
    if end_rel == 0 {
        // The source `(.+?)` requires at least one character.
        return None;
    }
    let inner = &rest[..end_rel];
    if inner.contains('\n') {
        return None;
    }
    Some((
        start,
        start + delimiter.len() + end_rel + delimiter.len(),
        inner.to_string(),
    ))
}

/// `[text](url)` link pattern (label without `]`, url without newline).
fn find_link(text: &str) -> Option<(usize, usize, String, String)> {
    let start = text.find('[')?;
    let rest = &text[start..];
    let close = rest.find("](")?;
    let label = &rest[1..close];
    if label.is_empty() || label.contains(']') || label.contains('\n') {
        return None;
    }
    let after = &rest[close + 2..];
    let url_end = after.find(')')?;
    let url = &after[..url_end];
    if url.is_empty() || url.contains('\n') {
        return None;
    }
    Some((
        start,
        start + close + 2 + url_end + 1,
        label.to_string(),
        url.to_string(),
    ))
}

/// `_add_inline_formatting`'s segmenter: the earliest match among the
/// patterns wins, scanning left to right.
fn inline_segments(text: &str) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut remaining = text;
    loop {
        let mut best: Option<(usize, usize, Segment)> = None;
        let candidates: [Option<(usize, usize, Segment)>; 6] = [
            find_delimited(remaining, "***").map(|(s, e, i)| (s, e, Segment::BoldItalic(i))),
            find_delimited(remaining, "**").map(|(s, e, i)| (s, e, Segment::Bold(i))),
            find_delimited(remaining, "*").map(|(s, e, i)| (s, e, Segment::Italic(i))),
            find_delimited(remaining, "`").map(|(s, e, i)| (s, e, Segment::Code(i))),
            find_delimited(remaining, "~~").map(|(s, e, i)| (s, e, Segment::Strikethrough(i))),
            find_link(remaining).map(|(s, e, l, u)| (s, e, Segment::Link(l, u))),
        ];
        for candidate in candidates.into_iter().flatten() {
            match &best {
                Some((start, _, _)) if candidate.0 >= *start => {}
                _ => best = Some(candidate),
            }
        }
        match best {
            Some((start, end, segment)) => {
                if start > 0 {
                    segments.push(Segment::Text(remaining[..start].to_string()));
                }
                segments.push(segment);
                remaining = &remaining[end..];
            }
            None => {
                if !remaining.is_empty() {
                    segments.push(Segment::Text(remaining.to_string()));
                }
                break;
            }
        }
    }
    segments
}

/// Per-run property additions applied to every inline run (heading and
/// blockquote styling is applied to all runs after inline formatting).
#[derive(Clone, Default)]
pub(crate) struct RunExtras {
    bold: bool,
    italic: bool,
    color: Option<&'static str>,
    size: Option<u32>,
}

/// Render the inline segments of one paragraph, applying `extras` to each
/// text-like run like the source's `for run in p.runs` styling loops.
fn add_inline_formatting(
    out: &mut String,
    text: &str,
    extras: &RunExtras,
    links: &mut Vec<String>,
) {
    for segment in inline_segments(text) {
        match segment {
            Segment::Text(t) => out.push_str(&styled_run(&t, extras)),
            Segment::Bold(t) => out.push_str(&styled_run(
                &t,
                &RunExtras {
                    bold: true,
                    ..extras.clone()
                },
            )),
            Segment::Italic(t) => out.push_str(&styled_run(
                &t,
                &RunExtras {
                    italic: true,
                    ..extras.clone()
                },
            )),
            Segment::BoldItalic(t) => out.push_str(&styled_run(
                &t,
                &RunExtras {
                    bold: true,
                    italic: true,
                    ..extras.clone()
                },
            )),
            Segment::Strikethrough(t) => out.push_str(&styled_run(
                &t,
                &RunExtras {
                    bold: extras.bold,
                    italic: extras.italic,
                    color: extras.color,
                    size: extras.size,
                },
            )),
            // Strike is not combined with bold/italic by the source's emoji
            // helper; re-render here for that exact shape.
            Segment::Code(t) => {
                out.push_str(&format!(
                    "<w:r><w:rPr>{}{}{}<w:sz w:val=\"20\"/>{}{}</w:rPr>{}</w:r>",
                    r_fonts(MONOSPACE_FONT, EAST_ASIA_FONT),
                    bool_el(extras.bold, "<w:b/>"),
                    color_el(extras.color),
                    size_el(extras.size),
                    lang(),
                    text_element(&t)
                ));
            }
            Segment::Link(label, url) => {
                links.push(url.clone());
                let id = 9 + links.len();
                out.push_str(&format!(
                    "<w:hyperlink r:id=\"rId{id}\"><w:r><w:rPr>{}{}{}{}{}<w:color w:val=\"55B9F7\"/><w:u w:val=\"single\"/></w:rPr>{}</w:r></w:hyperlink>",
                    r_fonts(LATIN_FONT, EAST_ASIA_FONT),
                    bool_el(extras.bold, "<w:b/>"),
                    bool_el(extras.italic, "<w:i/>"),
                    size_el(extras.size),
                    lang(),
                    text_element(&label)
                ));
            }
        }
    }
}

fn bool_el(on: bool, el: &'static str) -> &'static str {
    if on { el } else { "" }
}

fn color_el(color: Option<&str>) -> String {
    color
        .map(|c| format!("<w:color w:val=\"{c}\"/>"))
        .unwrap_or_default()
}

fn size_el(size: Option<u32>) -> String {
    size.map(|s| format!("<w:sz w:val=\"{s}\"/>"))
        .unwrap_or_default()
}

/// `_add_text_with_emoji_support` run shape: standard fonts, the requested
/// character formatting, then language.
fn styled_run(text: &str, extras: &RunExtras) -> String {
    format!(
        "<w:r><w:rPr>{}{}{}{}{}{}</w:rPr>{}</w:r>",
        r_fonts(LATIN_FONT, EAST_ASIA_FONT),
        bool_el(extras.bold, "<w:b/>"),
        bool_el(extras.italic, "<w:i/>"),
        color_el(extras.color),
        size_el(extras.size),
        lang(),
        text_element(text)
    )
}

/// `_add_horizontal_rule`.
fn horizontal_rule(color: &str) -> String {
    format!(
        "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"{color}\"/></w:pBdr></w:pPr></w:p>"
    )
}

/// Run text where every `\n` becomes `<w:br/>` (python-docx `Run.text`).
fn run_text_with_breaks(text: &str) -> String {
    let mut out = String::new();
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push_str("<w:br/>");
        }
        if !line.is_empty() {
            out.push_str(&text_element(line));
        }
    }
    out
}

/// `_add_code_block`.
fn code_block(code: &str, language: &str) -> String {
    let mut runs = String::new();
    if !language.is_empty() {
        runs.push_str(&format!(
            "<w:r><w:rPr><w:color w:val=\"969696\"/><w:sz w:val=\"16\"/></w:rPr>{}<w:br/></w:r>",
            text_element(language)
        ));
    }
    runs.push_str(&format!(
        "<w:r><w:rPr>{}<w:color w:val=\"{TEXT_COLOR}\"/><w:sz w:val=\"18\"/>{}</w:rPr>{}</w:r>",
        r_fonts(MONOSPACE_FONT, EAST_ASIA_FONT),
        lang(),
        run_text_with_breaks(code)
    ));
    format!(
        "<w:p><w:pPr><w:shd w:fill=\"F6F8FA\"/><w:pBdr><w:top w:val=\"single\" w:sz=\"4\" w:space=\"1\" w:color=\"DCDCDC\"/><w:left w:val=\"single\" w:sz=\"4\" w:space=\"1\" w:color=\"DCDCDC\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"1\" w:color=\"DCDCDC\"/><w:right w:val=\"single\" w:sz=\"4\" w:space=\"1\" w:color=\"DCDCDC\"/></w:pBdr></w:pPr>{runs}</w:p>"
    )
}

/// `_add_table`: header row bold, `Light Grid Accent 1` style, even column
/// widths over the 8640-twip text width.
fn table(headers: &[String], rows: &[Vec<String>]) -> String {
    if headers.is_empty() {
        return String::new();
    }
    let cols = headers.len();
    let col_w = 8640 / cols;
    let mut grid = String::new();
    for _ in 0..cols {
        grid.push_str(&format!("<w:gridCol w:w=\"{col_w}\"/>"));
    }
    let mut trs = String::new();
    let mut header_cells = String::new();
    for header in headers {
        header_cells.push_str(&format!(
            "<w:tc><w:tcPr><w:tcW w:type=\"dxa\" w:w=\"{col_w}\"/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr>{}</w:r></w:p></w:tc>",
            text_element(header)
        ));
    }
    trs.push_str(&format!("<w:tr>{header_cells}</w:tr>"));
    for row in rows {
        let mut cells = String::new();
        for cell in row.iter().take(cols) {
            cells.push_str(&format!(
                "<w:tc><w:tcPr><w:tcW w:type=\"dxa\" w:w=\"{col_w}\"/></w:tcPr><w:p><w:r>{}</w:r></w:p></w:tc>",
                text_element(cell)
            ));
        }
        // Cells beyond the row's values keep `add_table`'s empty paragraph.
        for _ in row.len()..cols {
            cells.push_str(&format!(
                "<w:tc><w:tcPr><w:tcW w:type=\"dxa\" w:w=\"{col_w}\"/></w:tcPr><w:p/></w:tc>"
            ));
        }
        trs.push_str(&format!("<w:tr>{cells}</w:tr>"));
    }
    format!(
        "<w:tbl><w:tblPr><w:tblStyle w:val=\"LightGrid-Accent1\"/><w:tblW w:type=\"auto\" w:w=\"0\"/><w:tblLook w:firstColumn=\"1\" w:firstRow=\"1\" w:lastColumn=\"0\" w:lastRow=\"0\" w:noHBand=\"0\" w:noVBand=\"1\" w:val=\"04A0\"/></w:tblPr><w:tblGrid>{grid}</w:tblGrid>{trs}</w:tbl>"
    )
}

/// One parsed line (`_parse_line_type`).
enum LineKind {
    Empty,
    Heading { level: usize, content: String },
    ListUnordered { content: String },
    ListOrdered { content: String },
    Blockquote { content: String },
    HorizontalRule,
    TableSeparator,
    TableRow { cells: Vec<String> },
    Paragraph { content: String },
}

fn parse_line(line: &str) -> LineKind {
    let stripped = line.trim();
    if stripped.is_empty() {
        return LineKind::Empty;
    }
    // Heading: `^(#{1,6})\s+(.*)$`
    let hashes = stripped.len() - stripped.trim_start_matches('#').len();
    if (1..=6).contains(&hashes) {
        let after = &stripped[hashes..];
        if after.starts_with(char::is_whitespace) {
            return LineKind::Heading {
                level: hashes,
                content: after.trim_start().to_string(),
            };
        }
    }
    // Unordered list: `^[-*+]\s+`
    for marker in ['-', '*', '+'] {
        if let Some(after) = stripped
            .strip_prefix(marker)
            .filter(|after| after.starts_with(char::is_whitespace) && !after.trim().is_empty())
        {
            return LineKind::ListUnordered {
                content: after.trim_start().to_string(),
            };
        }
    }
    // Ordered list: `^(\d+)\.\s+`
    let digits_end = stripped
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(stripped.len());
    if digits_end > 0
        && let Some(after) = stripped[digits_end..]
            .strip_prefix('.')
            .filter(|after| after.starts_with(char::is_whitespace) && !after.trim().is_empty())
    {
        return LineKind::ListOrdered {
            content: after.trim_start().to_string(),
        };
    }
    // Blockquote: `^>` with `^>\s*` stripped from the content.
    if let Some(after) = stripped.strip_prefix('>') {
        return LineKind::Blockquote {
            content: after.trim_start().to_string(),
        };
    }
    // Horizontal rule: `^(-{3,}|\*{3,}|_{3,})$`
    let is_hr = stripped.len() >= 3
        && (stripped.chars().all(|c| c == '-')
            || stripped.chars().all(|c| c == '*')
            || stripped.chars().all(|c| c == '_'));
    if is_hr {
        return LineKind::HorizontalRule;
    }
    if is_table_separator(stripped) {
        return LineKind::TableSeparator;
    }
    if stripped.contains('|') {
        let cells = stripped
            .trim_matches('|')
            .split('|')
            .map(|cell| cell.trim().to_string())
            .collect::<Vec<_>>();
        if !cells.is_empty() {
            return LineKind::TableRow { cells };
        }
    }
    LineKind::Paragraph {
        content: stripped.to_string(),
    }
}

fn is_table_separator(stripped: &str) -> bool {
    let body = stripped.strip_prefix('|').unwrap_or(stripped);
    let body = body.strip_suffix('|').unwrap_or(body);
    let columns = body.split('|').collect::<Vec<_>>();
    columns.len() >= 2 && columns.iter().all(|c| is_separator_column(c.trim()))
}

fn is_separator_column(column: &str) -> bool {
    let c = column.strip_prefix(':').unwrap_or(column);
    let c = c.strip_suffix(':').unwrap_or(c);
    !c.is_empty() && c.chars().all(|ch| ch == '-')
}

/// `_render_markdown_content`: line loop with code-block and table state.
/// Returns the hyperlink URLs in first-use order for relationship creation.
pub(crate) fn render_markdown(content: &str, links: &mut Vec<String>) -> String {
    let mut out = String::new();
    if content.is_empty() {
        return out;
    }
    let lines = content.split('\n').collect::<Vec<_>>();
    let mut in_code_block = false;
    let mut code_lines: Vec<&str> = Vec::new();
    let mut code_language = String::new();
    let mut in_table = false;
    let mut table_headers: Vec<String> = Vec::new();
    let mut table_rows: Vec<Vec<String>> = Vec::new();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            if !in_code_block {
                in_code_block = true;
                code_language = trimmed
                    .strip_prefix("```")
                    .unwrap_or(trimmed)
                    .trim()
                    .to_string();
                code_lines.clear();
            } else {
                in_code_block = false;
                out.push_str(&code_block(&code_lines.join("\n"), &code_language));
                code_lines.clear();
                code_language.clear();
            }
            i += 1;
            continue;
        }
        if in_code_block {
            code_lines.push(line);
            i += 1;
            continue;
        }
        match parse_line(line) {
            LineKind::TableSeparator => {
                in_table = true;
                if i > 0
                    && let LineKind::TableRow { cells } = parse_line(lines[i - 1])
                {
                    table_headers = cells;
                }
                i += 1;
                continue;
            }
            LineKind::TableRow { cells } if in_table => {
                table_rows.push(cells);
                i += 1;
                continue;
            }
            kind => {
                if in_table {
                    out.push_str(&table(&table_headers, &table_rows));
                    in_table = false;
                    table_headers.clear();
                    table_rows.clear();
                }
                render_line(&mut out, kind, links);
            }
        }
        i += 1;
    }
    if in_table && !table_headers.is_empty() {
        out.push_str(&table(&table_headers, &table_rows));
    }
    out
}

/// `_render_markdown_line`.
fn render_line(out: &mut String, kind: LineKind, links: &mut Vec<String>) {
    match kind {
        LineKind::Empty => out.push_str("<w:p/>"),
        LineKind::Heading { level, content } => {
            // `18 - level*2` points; the source applies size/bold/color to
            // every run after inline formatting.
            let extras = RunExtras {
                italic: false,
                bold: true,
                color: Some(TEXT_COLOR),
                size: Some((18 - level * 2) as u32 * 2),
            };
            out.push_str("<w:p>");
            if level <= 2 {
                out.push_str(
                    "<w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"DCDCDC\"/></w:pBdr></w:pPr>",
                );
            }
            add_inline_formatting(out, &content, &extras, links);
            out.push_str("</w:p>");
        }
        LineKind::ListUnordered { content } => {
            out.push_str("<w:p><w:pPr><w:pStyle w:val=\"ListBullet\"/></w:pPr>");
            add_inline_formatting(out, &content, &RunExtras::default(), links);
            out.push_str("</w:p>");
        }
        LineKind::ListOrdered { content } => {
            out.push_str("<w:p><w:pPr><w:pStyle w:val=\"ListNumber\"/></w:pPr>");
            add_inline_formatting(out, &content, &RunExtras::default(), links);
            out.push_str("</w:p>");
        }
        LineKind::Blockquote { content } => {
            let extras = RunExtras {
                bold: false,
                italic: true,
                color: Some("6A737D"),
                size: None,
            };
            out.push_str("<w:p><w:pPr><w:ind w:left=\"720\"/></w:pPr>");
            add_inline_formatting(out, &content, &extras, links);
            out.push_str("</w:p>");
        }
        LineKind::HorizontalRule => out.push_str(&horizontal_rule(PRIMARY_COLOR)),
        LineKind::Paragraph { content } => {
            out.push_str("<w:p>");
            add_inline_formatting(out, &content, &RunExtras::default(), links);
            out.push_str("</w:p>");
        }
        LineKind::TableSeparator | LineKind::TableRow { .. } => {}
    }
}

/// Message header paragraph: bold sender label plus gray timestamp.
pub(crate) fn message_header(sender_name: &str, timestamp: &str, is_user: bool) -> String {
    let color = if is_user { TEXT_COLOR } else { PRIMARY_COLOR };
    format!(
        "<w:p><w:r><w:rPr>{}<w:b/><w:color w:val=\"{color}\"/><w:sz w:val=\"22\"/>{}</w:rPr>{}</w:r><w:r><w:rPr><w:color w:val=\"A0A0A0\"/><w:sz w:val=\"18\"/></w:rPr>{}</w:r></w:p>",
        r_fonts(LATIN_FONT, EAST_ASIA_FONT),
        lang(),
        text_preserve(&format!("{sender_name}: ")),
        text_element(timestamp)
    )
}

/// Attachment info card (`_add_file_attachment`).
pub(crate) fn file_attachment(file_type: &str, name: &str, size: &str) -> String {
    format!(
        "<w:p><w:pPr><w:spacing w:after=\"120\"/><w:ind w:left=\"288\"/></w:pPr>\
         <w:r><w:rPr><w:b/><w:color w:val=\"646464\"/><w:sz w:val=\"18\"/></w:rPr>{}</w:r>\
         <w:r><w:rPr><w:sz w:val=\"20\"/></w:rPr>{}</w:r>\
         <w:r><w:rPr><w:color w:val=\"969696\"/><w:sz w:val=\"18\"/></w:rPr>{}</w:r></w:p>",
        text_preserve(&format!("{file_type} ")),
        text_element(name),
        text_preserve(&format!(" ({size})"))
    )
}

/// `_get_file_type_label`.
pub(crate) fn file_type_label(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        ".pdf" => "[PDF]",
        ".doc" | ".docx" => "[DOC]",
        ".txt" => "[TXT]",
        ".md" => "[MD]",
        ".zip" => "[ZIP]",
        ".rar" => "[RAR]",
        ".xls" => "[XLS]",
        ".xlsx" => "[XLSX]",
        ".ppt" | ".pptx" => "[PPT]",
        _ => "[FILE]",
    }
}

/// `_format_file_size`.
pub(crate) fn format_file_size(size_bytes: i64) -> String {
    let mut size = size_bytes as f64;
    for unit in ["B", "KB", "MB", "GB"] {
        if size < 1024.0 {
            return format!("{size:.1} {unit}");
        }
        size /= 1024.0;
    }
    format!("{size:.1} TB")
}

/// `_clean_content`: strip runtime markers, drop XML-invalid characters, and
/// trim.
pub(crate) fn clean_content(content: &str) -> String {
    let mut content = content.replace("${$$}$", "\n");
    // `__PROGRESS_BAR__:.*?:\d+` and `__PROMPT_TRUNCATED__` markers are
    // runtime-injected metadata not present in stored export content.
    content = strip_marker(&content, "__PROGRESS_BAR__");
    content = strip_marker(&content, "__PROMPT_TRUNCATED__");
    sanitize_xml_text(&content).trim().to_string()
}

fn strip_marker(content: &str, marker: &str) -> String {
    let Some(mut start) = content.find(marker) else {
        return content.to_string();
    };
    let mut out = String::new();
    let mut rest = content;
    loop {
        let after = &rest[start..];
        // `marker:.*?:\d+` — consume to the first digit-run terminator.
        let Some(colon) = after.find(':') else {
            out.push_str(&rest[..start + marker.len()]);
            break;
        };
        let mut end = start + marker.len() + colon + 1;
        let bytes = rest.as_bytes();
        while end < bytes.len() && (bytes[end] as char).is_ascii_digit() {
            end += 1;
        }
        if end == start + marker.len() + colon + 1 {
            out.push_str(&rest[..start + marker.len()]);
            break;
        }
        out.push_str(&rest[..start]);
        rest = &rest[end..];
        start = match rest.find(marker) {
            Some(next) => next,
            None => {
                out.push_str(rest);
                break;
            }
        };
    }
    out
}

/// `_sanitize_xml_text`: remove characters forbidden by XML 1.0.
pub(crate) fn sanitize_xml_text(text: &str) -> String {
    text.chars()
        .filter(|c| {
            let u = *c as u32;
            !matches!(u,
                0x00..=0x08 | 0x0B | 0x0C | 0x0E..=0x1F
                | 0xD800..=0xDFFF | 0xFFFE | 0xFFFF)
        })
        .collect()
}

/// Document header: logo, title, divider, spacing (`_add_document_header`).
pub(crate) fn document_header(title: &str, links: &mut Vec<String>) -> String {
    let logo = format!(
        "<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr><w:r><w:rPr>{}<w:b/><w:color w:val=\"{PRIMARY_COLOR}\"/><w:sz w:val=\"48\"/>{}</w:rPr>{}</w:r></w:p>",
        r_fonts(LATIN_FONT, EAST_ASIA_FONT),
        lang(),
        text_element("Wegent AI")
    );
    let title_extras = RunExtras {
        bold: true,
        italic: false,
        color: Some(PRIMARY_COLOR),
        size: Some(32),
    };
    let mut title_runs = String::new();
    add_inline_formatting(&mut title_runs, title, &title_extras, links);
    format!(
        "{logo}<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr>{title_runs}</w:p>{}<w:p/>",
        horizontal_rule(PRIMARY_COLOR)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_size_formatting_matches_source() {
        assert_eq!(format_file_size(13736), "13.4 KB");
        assert_eq!(format_file_size(0), "0.0 B");
        assert_eq!(format_file_size(1024), "1.0 KB");
    }

    #[test]
    fn file_type_labels_match_source() {
        assert_eq!(file_type_label(".docx"), "[DOC]");
        assert_eq!(file_type_label(".PDF"), "[PDF]");
        assert_eq!(file_type_label(".xyz"), "[FILE]");
    }

    #[test]
    fn inline_segments_split_bold_and_code() {
        assert_eq!(
            inline_segments("a **b** c"),
            vec![
                Segment::Text("a ".into()),
                Segment::Bold("b".into()),
                Segment::Text(" c".into()),
            ]
        );
        assert_eq!(
            inline_segments("x `y` z"),
            vec![
                Segment::Text("x ".into()),
                Segment::Code("y".into()),
                Segment::Text(" z".into()),
            ]
        );
    }

    #[test]
    fn link_segments_parse() {
        assert_eq!(
            inline_segments("see [docs](http://x) now"),
            vec![
                Segment::Text("see ".into()),
                Segment::Link("docs".into(), "http://x".into()),
                Segment::Text(" now".into()),
            ]
        );
    }

    #[test]
    fn table_separator_detection() {
        assert!(is_table_separator("|---|---|"));
        assert!(is_table_separator("| --- | :---: |"));
        assert!(!is_table_separator("| a | b |"));
        assert!(!is_table_separator("---"));
    }

    #[test]
    fn sanitize_removes_xml_invalid_characters() {
        assert_eq!(sanitize_xml_text("a\u{0008}b\u{0009}c"), "ab\tc");
    }
}
