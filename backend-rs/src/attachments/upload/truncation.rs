// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The smart-truncation strategies the attachment endpoint applies
//! (`app/services/attachment/truncation_strategies/`).
//!
//! Only the two formats this endpoint parses structurally are here: Word
//! (`word.py`, head + tail paragraphs) and Excel (`excel.py`, complete rows
//! under a character budget, with an omission marker). Both keep a contiguous
//! head and tail when the middle is dropped — `MIDDLE_RATIO` is 0 — and the
//! length arithmetic matches the source exactly, because the rendered text is
//! what the attachment stores.
use crate::attachments::upload::office::excel::{
    ExcelSheet, compact_row_line, serialize_sheet_compact, sheet_header,
};

/// Head and tail shares of the kept items (`BaseTruncationStrategy`).
const HEAD_RATIO: f64 = 0.5;
const TAIL_RATIO: f64 = 0.5;
/// `overhead` reserved for section markers and omission messages.
const OVERHEAD: usize = 200;

/// The truncation outcome the endpoint needs: the text plus the three lengths
/// `TruncationInfo` carries.
#[derive(Debug, PartialEq)]
pub(crate) struct Truncated {
    pub text: String,
    pub is_truncated: bool,
    pub original_length: usize,
    pub truncated_length: usize,
}

impl Truncated {
    fn untruncated(text: String) -> Self {
        let length = text.chars().count();
        Self {
            text,
            is_truncated: false,
            original_length: length,
            truncated_length: length,
        }
    }
}

/// `WordTruncationStrategy.truncate`.
pub(crate) fn word_paragraphs(paragraphs: &[String], max_length: usize) -> Truncated {
    let original_text = paragraphs.join("\n\n");
    let original_length = original_text.chars().count();
    if original_length <= max_length {
        return Truncated::untruncated(original_text);
    }

    let total_paragraphs = paragraphs.len();
    let average = original_length as f64 / total_paragraphs.max(1) as f64;
    let available = max_length.saturating_sub(OVERHEAD);
    let max_paragraphs = ratio_floor(available, average).max(3);

    if max_paragraphs >= total_paragraphs {
        let truncated = truncate_chars(&original_text, max_length);
        return Truncated {
            truncated_length: truncated.chars().count(),
            text: truncated,
            is_truncated: true,
            original_length,
        };
    }

    let head_count = (max_paragraphs as f64 * HEAD_RATIO).floor().max(1.0) as usize;
    let tail_count = (max_paragraphs as f64 * TAIL_RATIO).floor().max(1.0) as usize;
    let remainder = max_paragraphs.saturating_sub(head_count + tail_count);
    // `MIDDLE_RATIO <= 0` folds the remainder into the head.
    let mut head_count = head_count + remainder;
    let mut tail_count = tail_count;
    if head_count + tail_count >= total_paragraphs {
        head_count = max_paragraphs / 2;
        tail_count = max_paragraphs - head_count;
    }
    let tail_start = total_paragraphs - tail_count;

    let mut parts: Vec<String> = Vec::new();
    if head_count > 0 {
        parts.push(format!("# Head Section (paragraphs 1-{head_count})"));
        for (index, paragraph) in paragraphs[..head_count].iter().enumerate() {
            parts.push(format!("[Paragraph {}]\n{paragraph}", index + 1));
        }
    }
    if head_count > 0 && tail_count > 0 {
        let gap = total_paragraphs - tail_count - head_count;
        if gap > 0 {
            parts.push(format!("\n... [{gap} paragraphs omitted] ..."));
        }
    }
    if tail_count > 0 {
        parts.push(format!(
            "\n# Tail Section (paragraphs {}-{total_paragraphs})",
            total_paragraphs - tail_count + 1
        ));
        for (offset, paragraph) in paragraphs[tail_start..].iter().enumerate() {
            parts.push(format!(
                "[Paragraph {}]\n{paragraph}",
                tail_start + offset + 1
            ));
        }
    }

    let mut text = parts.join("\n\n");
    if text.chars().count() > max_length {
        text = truncate_chars(&text, max_length);
    }
    Truncated {
        truncated_length: text.chars().count(),
        text,
        is_truncated: true,
        original_length,
    }
}

/// `PowerPointTruncationStrategy.truncate`: slides joined with `\n\n`, then
/// a contiguous head + tail of slides under section markers. Identical shape
/// to the Word strategy with `slides` as the unit; `MIDDLE_RATIO = 0` folds
/// the middle into the head.
pub(crate) fn powerpoint_slides(slides: &[String], max_length: usize) -> Truncated {
    let original_text = slides.join("\n\n");
    let original_length = original_text.chars().count();
    if original_length <= max_length {
        return Truncated::untruncated(original_text);
    }

    let total_slides = slides.len();
    let average = original_length as f64 / total_slides.max(1) as f64;
    let available = max_length.saturating_sub(OVERHEAD);
    let max_slides = ratio_floor(available, average).max(3);

    if max_slides >= total_slides {
        let truncated = truncate_chars(&original_text, max_length);
        return Truncated {
            truncated_length: truncated.chars().count(),
            text: truncated,
            is_truncated: true,
            original_length,
        };
    }

    let head_count = (max_slides as f64 * HEAD_RATIO).floor().max(1.0) as usize;
    let tail_count = (max_slides as f64 * TAIL_RATIO).floor().max(1.0) as usize;
    let remainder = max_slides.saturating_sub(head_count + tail_count);
    // `MIDDLE_RATIO <= 0` folds the remainder into the head.
    let mut head_count = head_count + remainder;
    let mut tail_count = tail_count;
    if head_count + tail_count >= total_slides {
        head_count = max_slides / 2;
        tail_count = max_slides - head_count;
    }
    let tail_start = total_slides - tail_count;

    let mut parts: Vec<String> = Vec::new();
    if head_count > 0 {
        parts.push(format!("# Head Section (slides 1-{head_count})"));
        // Slides already carry their own `--- Slide N ---` headers.
        parts.extend(slides[..head_count].iter().cloned());
    }
    if head_count > 0 && tail_count > 0 {
        let gap = total_slides - tail_count - head_count;
        if gap > 0 {
            parts.push(format!("\n... [{gap} slides omitted] ..."));
        }
    }
    if tail_count > 0 {
        parts.push(format!(
            "\n# Tail Section (slides {}-{total_slides})",
            total_slides - tail_count + 1
        ));
        parts.extend(slides[tail_start..].iter().cloned());
    }

    let mut text = parts.join("\n\n");
    if text.chars().count() > max_length {
        text = truncate_chars(&text, max_length);
    }
    Truncated {
        truncated_length: text.chars().count(),
        text,
        is_truncated: true,
        original_length,
    }
}

/// `ExcelTruncationStrategy.truncate`: keep complete rows within the budget.
pub(crate) fn excel_sheets(sheets: &[ExcelSheet], max_length: usize) -> Truncated {
    let populated: Vec<&ExcelSheet> = sheets
        .iter()
        .filter(|sheet| !sheet.rows.is_empty())
        .collect();
    let total_rows: usize = populated.iter().map(|sheet| sheet.rows.len()).sum();
    debug_assert!(total_rows == 0 || !populated.is_empty());
    let full_text = populated
        .iter()
        .map(|sheet| serialize_sheet_compact(sheet))
        .collect::<Vec<_>>()
        .join("\n\n");
    let original_length = full_text.chars().count();
    if original_length <= max_length {
        return Truncated {
            text: full_text,
            is_truncated: false,
            original_length,
            truncated_length: original_length,
        };
    }

    let separator_length = populated.len().saturating_sub(1) * 2;
    let mut remaining_budget = max_length.saturating_sub(separator_length);
    let mut parts: Vec<String> = Vec::new();
    for (index, sheet) in populated.iter().enumerate() {
        let budget = remaining_budget / (populated.len() - index);
        let result = truncate_sheet(sheet, budget);
        if !result.text.is_empty() {
            remaining_budget = remaining_budget.saturating_sub(result.text.chars().count());
            debug_assert!(result.kept_rows <= sheet.rows.len());
            parts.push(result.text);
        }
    }
    let text = parts.join("\n\n");
    Truncated {
        truncated_length: text.chars().count(),
        text,
        is_truncated: true,
        original_length,
    }
}

struct SheetTruncation {
    text: String,
    kept_rows: usize,
}

/// `ExcelTruncationStrategy._truncate_sheet`.
fn truncate_sheet(sheet: &ExcelSheet, max_length: usize) -> SheetTruncation {
    let header = sheet_header(&sheet.name);
    let rows: Vec<String> = sheet.rows.iter().map(compact_row_line).collect();
    let total_rows = rows.len();
    if header.chars().count() > max_length {
        return SheetTruncation {
            text: String::new(),
            kept_rows: 0,
        };
    }

    let mut prefix_lengths = vec![0usize];
    for row in &rows {
        let previous = prefix_lengths.last().copied().unwrap_or(0);
        prefix_lengths.push(previous + row.chars().count());
    }

    if selection_length(&header, &prefix_lengths, 0, 0) > max_length {
        return SheetTruncation {
            text: header,
            kept_rows: 0,
        };
    }

    let mut head_count = 0;
    let mut tail_count = 0;
    let mut prefer_head = true;
    while head_count + tail_count < total_rows {
        let directions = if prefer_head {
            ["head", "tail"]
        } else {
            ["tail", "head"]
        };
        let mut accepted = false;
        for direction in directions {
            let next_head = head_count + usize::from(direction == "head");
            let next_tail = tail_count + usize::from(direction == "tail");
            if selection_length(&header, &prefix_lengths, next_head, next_tail) <= max_length {
                head_count = next_head;
                tail_count = next_tail;
                prefer_head = direction != "head";
                accepted = true;
                break;
            }
        }
        if !accepted {
            break;
        }
    }

    let omitted = total_rows - head_count - tail_count;
    let mut lines = vec![header];
    lines.extend(rows[..head_count].iter().cloned());
    if omitted > 0 {
        lines.push(format!("... [{omitted} rows omitted] ..."));
    }
    if tail_count > 0 {
        lines.extend(rows[total_rows - tail_count..].iter().cloned());
    }
    SheetTruncation {
        text: lines.join("\n"),
        kept_rows: head_count + tail_count,
    }
}

/// `TextTruncationStrategy.truncate`: plain text and markdown keep a
/// contiguous head and tail, dropping the middle behind one omission marker.
/// Markdown with at least three headings instead keeps whole heading sections.
pub(crate) fn text_lines(text: &str, max_length: usize) -> Truncated {
    let lines: Vec<&str> = text.split('\n').collect();
    let original_length = text.chars().count();
    if original_length <= max_length {
        return Truncated::untruncated(text.to_owned());
    }
    let headings: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| markdown_heading(line))
        .map(|(index, _)| index)
        .collect();
    if headings.len() >= 3 {
        truncate_markdown(text, &lines, &headings, max_length, original_length)
    } else {
        truncate_plain_text(text, &lines, max_length, original_length)
    }
}

/// `TextTruncationStrategy.MARKDOWN_HEADING_PATTERN` (`^#{1,6}\s+`).
fn markdown_heading(line: &str) -> bool {
    let mut characters = line.chars();
    let mut level = 0;
    for character in characters.by_ref() {
        if character == '#' {
            level += 1;
        } else {
            return (1..=6).contains(&level) && character.is_whitespace();
        }
    }
    false
}

/// `_truncate_plain_text`.
fn truncate_plain_text(
    text: &str,
    lines: &[&str],
    max_length: usize,
    original_length: usize,
) -> Truncated {
    let total_lines = lines.len();
    let average = original_length as f64 / total_lines.max(1) as f64;
    let available = max_length.saturating_sub(OVERHEAD);
    let max_lines = ratio_floor(available, average).max(3);
    if max_lines >= total_lines {
        let truncated = truncate_chars(text, max_length);
        return Truncated {
            truncated_length: truncated.chars().count(),
            text: truncated,
            is_truncated: true,
            original_length,
        };
    }
    let (head_count, tail_count) = head_tail(total_lines, max_lines);
    let mut parts: Vec<String> = Vec::new();
    if head_count > 0 {
        parts.push(format!("# Head Section (lines 1-{head_count})"));
        parts.extend(lines[..head_count].iter().map(|line| (*line).to_owned()));
    }
    if head_count > 0 && tail_count > 0 {
        let gap = total_lines - tail_count - head_count;
        if gap > 0 {
            parts.push(format!("\n... [{gap} lines omitted] ..."));
        }
    }
    if tail_count > 0 {
        parts.push(format!(
            "\n# Tail Section (lines {}-{total_lines})",
            total_lines - tail_count + 1
        ));
        parts.extend(
            lines[total_lines - tail_count..]
                .iter()
                .map(|line| (*line).to_owned()),
        );
    }
    let mut rendered = parts.join("\n");
    if rendered.chars().count() > max_length {
        rendered = truncate_chars(&rendered, max_length);
    }
    Truncated {
        truncated_length: rendered.chars().count(),
        text: rendered,
        is_truncated: true,
        original_length,
    }
}

/// `_truncate_markdown`: keep every heading plus whole head and tail sections.
fn truncate_markdown(
    text: &str,
    lines: &[&str],
    headings: &[usize],
    max_length: usize,
    original_length: usize,
) -> Truncated {
    let total_lines = lines.len();
    let mut sections: Vec<(usize, usize)> = Vec::with_capacity(headings.len());
    for (index, heading) in headings.iter().enumerate() {
        let next = headings.get(index + 1).copied().unwrap_or(total_lines);
        sections.push((*heading, next));
    }
    let preamble = &lines[..headings[0]];
    let headings_text: usize = headings
        .iter()
        .map(|index| lines[*index].chars().count())
        .sum::<usize>()
        + headings.len().saturating_sub(1);
    let preamble_text: usize = preamble
        .iter()
        .map(|line| line.chars().count())
        .sum::<usize>()
        + preamble.len().saturating_sub(1);
    let overhead = headings_text + preamble_text + 300;
    let Some(available) = max_length.checked_sub(overhead) else {
        return truncate_plain_text(text, lines, max_length, original_length);
    };
    if available == 0 {
        return truncate_plain_text(text, lines, max_length, original_length);
    }
    let total_sections = sections.len();
    let total_content: usize = sections
        .iter()
        .map(|(start, end)| {
            let content: Vec<&str> = lines[start + 1..*end].to_vec();
            content.join("\n").chars().count()
        })
        .sum();
    let average = total_content as f64 / total_sections.max(1) as f64;
    let max_sections = ratio_floor(available, average).max(3);
    let (mut head_count, mut tail_count) = head_tail(total_sections, max_sections);
    if head_count + tail_count >= total_sections {
        head_count = max_sections / 2;
        tail_count = max_sections - head_count;
    }
    let mut parts: Vec<String> = Vec::new();
    if !preamble.is_empty() {
        parts.push("# Document Preamble".to_owned());
        parts.extend(preamble.iter().map(|line| (*line).to_owned()));
    }
    if head_count > 0 {
        parts.push(format!("\n# Head Sections (sections 1-{head_count})"));
        for (start, end) in &sections[..head_count] {
            parts.extend(lines[*start..*end].iter().map(|line| (*line).to_owned()));
        }
    }
    if head_count > 0 && tail_count > 0 {
        let gap = total_sections - tail_count - head_count;
        if gap > 0 {
            parts.push(format!("\n... [{gap} sections omitted] ..."));
        }
    }
    if tail_count > 0 {
        parts.push(format!(
            "\n# Tail Sections (sections {}-{total_sections})",
            total_sections - tail_count + 1
        ));
        for (start, end) in &sections[total_sections - tail_count..] {
            parts.extend(lines[*start..*end].iter().map(|line| (*line).to_owned()));
        }
    }
    let mut rendered = parts.join("\n");
    if rendered.chars().count() > max_length {
        rendered = truncate_chars(&rendered, max_length);
    }
    Truncated {
        truncated_length: rendered.chars().count(),
        text: rendered,
        is_truncated: true,
        original_length,
    }
}

/// `_calculate_distribution` with the default `MIDDLE_RATIO = 0`: the middle
/// folds into the contiguous head.
fn head_tail(total_items: usize, items_to_keep: usize) -> (usize, usize) {
    if items_to_keep >= total_items {
        return (total_items, 0);
    }
    let mut head = 1.max((items_to_keep as f64 * HEAD_RATIO) as usize);
    let mut tail = 1.max((items_to_keep as f64 * TAIL_RATIO) as usize);
    head += items_to_keep.saturating_sub(head + tail);
    if head + tail >= total_items {
        head = items_to_keep / 2;
        tail = items_to_keep - head;
    }
    (head, tail)
}

/// `_selection_length`: the exact rendered length of a head/tail selection.
fn selection_length(
    header: &str,
    prefix_lengths: &[usize],
    head_count: usize,
    tail_count: usize,
) -> usize {
    let total_rows = prefix_lengths.len() - 1;
    let omitted_rows = total_rows - head_count - tail_count;
    let line_count = 1 + head_count + tail_count + usize::from(omitted_rows > 0);
    let mut content_length = header.chars().count() + prefix_lengths[head_count];
    if tail_count > 0 {
        content_length += prefix_lengths[total_rows] - prefix_lengths[total_rows - tail_count];
    }
    if omitted_rows > 0 {
        content_length += format!("... [{omitted_rows} rows omitted] ...")
            .chars()
            .count();
    }
    content_length + line_count - 1
}

/// `PDFTruncationStrategy.truncate`: page texts joined with `--- Page N ---`
/// headers, then a contiguous head + tail when the document exceeds the
/// budget. The source's `MIDDLE_RATIO = 0` drops the middle behind a single
/// omission marker.
pub(crate) fn pdf_pages(pages: &[String], max_length: usize) -> Truncated {
    let parts: Vec<String> = pages
        .iter()
        .enumerate()
        .map(|(index, page)| format!("--- Page {} ---\n{page}", index + 1))
        .collect();
    let original_text = parts.join("\n\n");
    let original_length = original_text.chars().count();
    if original_length <= max_length {
        return Truncated::untruncated(original_text);
    }

    let total_pages = pages.len();
    let average = original_length as f64 / total_pages.max(1) as f64;
    let available = max_length.saturating_sub(OVERHEAD);
    let max_pages = ratio_floor(available, average).max(3);
    if max_pages >= total_pages {
        let truncated = truncate_chars(&original_text, max_length);
        return Truncated {
            text: truncated,
            is_truncated: true,
            original_length,
            truncated_length: original_length.min(max_length),
        };
    }

    let (head_count, tail_count) = head_tail(total_pages, max_pages);
    let mut parts = Vec::new();
    if head_count > 0 {
        parts.push(format!("# Head Section (pages 1-{head_count})"));
        for (index, page) in pages.iter().take(head_count).enumerate() {
            parts.push(format!("--- Page {} ---\n{page}", index + 1));
        }
    }
    if head_count > 0 && tail_count > 0 {
        let omitted = total_pages.saturating_sub(head_count + tail_count);
        if omitted > 0 {
            parts.push(format!("\n... [{omitted} pages omitted] ..."));
        }
    }
    if tail_count > 0 {
        let first_tail = total_pages - tail_count + 1;
        parts.push(format!(
            "\n# Tail Section (pages {first_tail}-{total_pages})"
        ));
        for (index, page) in pages.iter().skip(total_pages - tail_count).enumerate() {
            parts.push(format!("--- Page {} ---\n{page}", first_tail + index));
        }
    }
    let mut text = parts.join("\n\n");
    if text.chars().count() > max_length {
        text = truncate_chars(&text, max_length);
    }
    Truncated {
        truncated_length: text.chars().count(),
        text,
        is_truncated: true,
        original_length,
    }
}

/// `int(available_length / avg_line_len)` with a zero average guarded.
fn ratio_floor(available: usize, average: f64) -> usize {
    if average <= 0.0 {
        return available;
    }
    (available as f64 / average).floor().max(0.0) as usize
}

/// `text[:max_length]` over characters, the source's final safety cut.
fn truncate_chars(text: &str, max_length: usize) -> String {
    text.chars().take(max_length).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments::upload::office::excel::{ExcelCell, ExcelRow, ExcelValue};

    fn sheet(name: &str, rows: usize) -> ExcelSheet {
        ExcelSheet {
            name: name.to_string(),
            rows: (1..=rows)
                .map(|row| ExcelRow {
                    source_row: row as u64,
                    cells: vec![ExcelCell {
                        source_column: 1,
                        value: ExcelValue::Integer(row.to_string()),
                    }],
                })
                .collect(),
        }
    }

    #[test]
    fn a_long_pdf_keeps_a_contiguous_head_and_tail_with_page_headers() {
        let pages: Vec<String> = (1..=10).map(|index| format!("page {index}")).collect();
        let short = pdf_pages(&pages, 500_000);
        assert!(!short.is_truncated);
        assert!(
            short
                .text
                .starts_with("--- Page 1 ---\npage 1\n\n--- Page 2 ---")
        );
        assert_eq!(short.text.chars().count(), short.truncated_length);

        let truncated = pdf_pages(&pages, 180);
        assert!(truncated.is_truncated);
        assert_eq!(truncated.original_length, short.text.chars().count());
        assert!(truncated.text.starts_with("# Head Section (pages 1-2)"));
        assert!(truncated.text.contains("... [7 pages omitted] ..."));
        assert!(truncated.text.contains("# Tail Section (pages 10-10)"));
        assert!(truncated.text.ends_with("--- Page 10 ---\npage 10"));
    }

    #[test]
    fn a_long_powerpoint_keeps_a_contiguous_head_and_tail_of_slides() {
        let slides: Vec<String> = (1..=10)
            .map(|index| format!("--- Slide {index} ---\nslide {index} text"))
            .collect();
        let short = powerpoint_slides(&slides, 500_000);
        assert!(!short.is_truncated);
        assert!(short.text.starts_with("--- Slide 1 ---\nslide 1 text"));
        assert!(short.text.contains("\n\n--- Slide 2 ---"));

        let truncated = powerpoint_slides(&slides, 190);
        assert!(truncated.is_truncated);
        assert!(truncated.text.contains("# Head Section (slides 1-"));
        assert!(truncated.text.contains("slides omitted"));
        assert!(truncated.text.contains("# Tail Section (slides "));
        assert!(truncated.text.ends_with("slide 10 text"));
    }

    #[test]
    fn short_content_is_returned_unchanged() {
        let paragraphs = vec!["a".to_string(), "b".to_string()];
        let result = word_paragraphs(&paragraphs, 500_000);
        assert_eq!(result.text, "a\n\nb");
        assert!(!result.is_truncated);
        assert_eq!(result.truncated_length, 4);

        let result = excel_sheets(&[sheet("Sheet1", 2)], 500_000);
        assert_eq!(result.text, "--- Sheet: Sheet1 ---\nR1: 1\nR2: 2");
        assert!(!result.is_truncated);
    }

    #[test]
    fn a_long_word_document_keeps_a_contiguous_head_and_tail() {
        let paragraphs: Vec<String> = (1..=40).map(|index| format!("p{index}")).collect();
        // 189 characters of paragraphs against a 170-character budget keeps
        // the rendered markers inside the limit.
        let result = word_paragraphs(&paragraphs, 170);
        assert!(result.is_truncated);
        assert!(result.text.contains("# Head Section (paragraphs 1-"));
        assert!(result.text.contains("# Tail Section (paragraphs "));
        assert!(result.text.contains("paragraphs omitted"));
        assert!(result.text.chars().count() <= 170);
    }

    #[test]
    fn a_long_sheet_keeps_complete_rows_within_the_budget() {
        let result = excel_sheets(&[sheet("Sheet1", 200)], 400);
        assert!(result.is_truncated);
        assert!(result.text.starts_with("--- Sheet: Sheet1 ---\nR1: 1"));
        assert!(result.text.contains("rows omitted"));
        assert!(result.text.ends_with("R200: 200"));
        assert!(result.text.chars().count() <= 400);
    }

    #[test]
    fn a_budget_that_fits_only_the_header_keeps_the_header() {
        // The header is 22 characters; the omission marker no longer fits.
        let result = excel_sheets(&[sheet("Sheet1", 50)], 24);
        assert_eq!(result.text, "--- Sheet: Sheet1 ---");
        assert!(result.is_truncated);
        assert!(result.original_length > 24);
    }
}
