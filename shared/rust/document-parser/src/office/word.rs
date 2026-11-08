// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `python-docx`-equivalent `.docx` text extraction
//! (`DocumentParser._parse_word` / `_parse_word_smart`).
//!
//! The source keeps body-level paragraphs and body-level tables in two passes:
//! `doc.paragraphs` (non-blank paragraph text) followed by one
//! `" | "`-joined line per table row. The observable rules below therefore
//! mirror `python-docx` (`docx 1.2`):
//!
//! - a paragraph's text joins its direct `w:r` and `w:hyperlink` children, and
//!   a run's text joins its direct `w:t`/`w:tab`/`w:ptab`/`w:br`/`w:cr`/
//!   `w:noBreakHyphen` children (runs nested in other wrappers contribute
//!   nothing);
//! - a row repeats every cell once per spanned grid column, and a vertically
//!   continued cell repeats the cell above;
//! - a cell's text joins its paragraphs with `\n`.
use super::OfficeError;
use super::xml::{Element, Tree};
use super::zip::ZipArchive;
use std::collections::HashMap;

/// The extracted body text inputs, before the smart-truncation pass.
#[derive(Debug, Default, PartialEq)]
pub struct WordText {
    /// Body-level paragraph texts, blank paragraphs dropped, unstripped.
    pub paragraphs: Vec<String>,
    /// One `" | "`-joined line per table row with populated cells.
    pub table_rows: Vec<String>,
    /// References into the existing text vectors, without duplicating their text.
    body_order: Vec<BodyBlock>,
}

#[derive(Debug, PartialEq)]
enum BodyBlock {
    Paragraph(usize),
    TableRow(usize),
}

impl WordText {
    /// Memory evidence preserves the relationship between paragraphs and tables.
    pub fn document_text(&self) -> String {
        self.body_order
            .iter()
            .map(|block| match block {
                BodyBlock::Paragraph(index) => self.paragraphs[*index].as_str(),
                BodyBlock::TableRow(index) => self.table_rows[*index].as_str(),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// `ContextService._parse_and_update_context`'s paragraph list: the
    /// paragraphs followed by the table rows, each already stripped when it is
    /// a table row (`_parse_word_smart`).
    pub fn collected(&self) -> Vec<String> {
        self.paragraphs
            .iter()
            .chain(self.table_rows.iter())
            .cloned()
            .collect()
    }
}

/// Extract the document text from a `.docx` package.
pub fn extract(data: &[u8]) -> Result<WordText, OfficeError> {
    let archive = ZipArchive::new(data).map_err(|_| OfficeError)?;
    extract_from_archive(&archive)
}

/// Extract using the caller's archive and cumulative decoded-byte budget.
pub fn extract_from_archive(archive: &ZipArchive<'_>) -> Result<WordText, OfficeError> {
    extract_with_text_limit(archive, usize::MAX)
}

/// Bound rendered UTF-8 bytes before expanding merged table cells.
pub fn extract_with_text_limit(
    archive: &ZipArchive<'_>,
    mut remaining: usize,
) -> Result<WordText, OfficeError> {
    let part = archive.read("word/document.xml").map_err(|_| OfficeError)?;
    let text = std::str::from_utf8(&part).map_err(|_| OfficeError)?;
    let document = Tree::controlled(text, archive.control())
        .find_element("document")
        .map_err(|_| OfficeError)?
        .ok_or(OfficeError)?;
    let body = document.child("body").ok_or(OfficeError)?;

    let mut extracted = WordText::default();
    for child in &body.children {
        archive.check_budget().map_err(|_| OfficeError)?;
        match child.local() {
            "p" => {
                let paragraph = paragraph_text(child);
                if !paragraph.trim().is_empty() {
                    remaining = remaining.checked_sub(paragraph.len()).ok_or(OfficeError)?;
                    extracted
                        .body_order
                        .push(BodyBlock::Paragraph(extracted.paragraphs.len()));
                    extracted.paragraphs.push(paragraph);
                }
            }
            "tbl" => {
                let rows = render_rows(
                    &layout_rows(child, &archive.control())?,
                    &mut remaining,
                    &archive.control(),
                )?;
                let start = extracted.table_rows.len();
                extracted
                    .body_order
                    .extend((start..start + rows.len()).map(BodyBlock::TableRow));
                extracted.table_rows.extend(rows);
            }
            _ => {}
        }
    }
    Ok(extracted)
}

/// `CT_P.text`: join the direct `w:r` and `w:hyperlink` children.
fn paragraph_text(paragraph: &Element) -> String {
    let mut text = String::new();
    for child in &paragraph.children {
        match child.local() {
            "r" => text.push_str(&run_text(child)),
            "hyperlink" => {
                for run in child.named_children("r") {
                    text.push_str(&run_text(run));
                }
            }
            _ => {}
        }
    }
    text
}

/// `CT_R.text`: join the run's direct text-equivalent children.
fn run_text(run: &Element) -> String {
    let mut text = String::new();
    for child in &run.children {
        match child.local() {
            "t" => text.push_str(&child.direct_text()),
            "tab" | "ptab" => text.push('\t'),
            "br" => {
                // Only a text-wrapping break is a newline; page and column
                // breaks contribute nothing.
                let kind = child.attr("w:type").or_else(|| child.attr_local("type"));
                if kind.is_none() || kind == Some("textWrapping") {
                    text.push('\n');
                }
            }
            "cr" => text.push('\n'),
            "noBreakHyphen" => text.push('-'),
            _ => {}
        }
    }
    text
}

/// One `w:tc` in the layout model `python-docx` builds.
struct GridCell {
    /// The starting grid offset of the cell within its row.
    grid_offset: usize,
    span: usize,
    continued: bool,
    text: String,
}

/// `_Row.cells` for one table: every `w:tc` contributes its text once per
/// spanned grid column, and `w:vMerge="continue"` resolves to the cell above
/// at the same grid offset (which may itself continue further up).
fn render_rows(
    rows: &[Vec<GridCell>],
    remaining: &mut usize,
    control: &crate::ParseControl,
) -> Result<Vec<String>, OfficeError> {
    let mut lines = Vec::new();
    let mut previous: HashMap<usize, &str> = HashMap::new();
    for row in rows {
        let mut current = HashMap::new();
        let mut row_text = String::new();
        for cell in row {
            control.check().map_err(|_| OfficeError)?;
            let text = if cell.continued {
                *previous.get(&cell.grid_offset).ok_or(OfficeError)?
            } else {
                cell.text.as_str()
            };
            current.insert(cell.grid_offset, text);
            append_spanned(&mut row_text, text.trim(), cell.span, remaining, control)?;
        }
        if !row_text.is_empty() {
            lines.push(row_text);
        }
        previous = current;
    }
    Ok(lines)
}

fn append_spanned(
    line: &mut String,
    text: &str,
    span: usize,
    remaining: &mut usize,
    control: &crate::ParseControl,
) -> Result<(), OfficeError> {
    if text.is_empty() {
        return Ok(());
    }
    let separators = span - usize::from(line.is_empty());
    let bytes = text
        .len()
        .checked_mul(span)
        .and_then(|bytes| {
            separators
                .checked_mul(3)
                .and_then(|separator_bytes| bytes.checked_add(separator_bytes))
        })
        .ok_or(OfficeError)?;
    *remaining = remaining.checked_sub(bytes).ok_or(OfficeError)?;
    line.try_reserve(bytes).map_err(|_| OfficeError)?;
    for _ in 0..span {
        control.check().map_err(|_| OfficeError)?;
        if !line.is_empty() {
            line.push_str(" | ");
        }
        line.push_str(text);
    }
    Ok(())
}

/// The per-row grid model: grid columns in document order per row.
fn layout_rows(
    table: &Element,
    control: &crate::ParseControl,
) -> Result<Vec<Vec<GridCell>>, OfficeError> {
    let mut rows = Vec::new();
    for row in table.named_children("tr") {
        let grid_before = row
            .child("trPr")
            .and_then(|properties| properties.child("gridBefore"))
            .and_then(|before| before.attr_local("val"))
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let mut offset = grid_before;
        let mut cells = Vec::new();
        for cell in row.named_children("tc") {
            control.check().map_err(|_| OfficeError)?;
            let span = grid_span(cell);
            cells.push(GridCell {
                grid_offset: offset,
                span,
                continued: vertical_merge(cell),
                text: cell_text(cell),
            });
            offset = offset.checked_add(span).ok_or(OfficeError)?;
        }
        rows.push(cells);
    }
    Ok(rows)
}

/// `_Cell.text`: the cell's paragraphs joined with `\n`.
fn cell_text(cell: &Element) -> String {
    cell.named_children("p")
        .map(paragraph_text)
        .collect::<Vec<_>>()
        .join("\n")
}

/// `CT_TcPr/gridSpan/@val`, defaulting to one grid column.
fn grid_span(cell: &Element) -> usize {
    cell.child("tcPr")
        .and_then(|properties| properties.child("gridSpan"))
        .and_then(|span| span.attr_local("val"))
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1)
}

/// `CT_Tc.vMerge`: the attribute value, `continue` when written without one.
fn vertical_merge(cell: &Element) -> bool {
    let Some(value) = cell
        .child("tcPr")
        .and_then(|properties| properties.child("vMerge"))
        .map(|merge| merge.attr_local("val"))
    else {
        return false;
    };
    value != Some("restart")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_order_preserves_interleaving_without_changing_backend_collection() {
        let xml = document(
            r#"<w:p><w:r><w:t>Before</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>First row</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>Second row</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            <w:p><w:r><w:t>After</w:t></w:r></w:p>"#,
        );
        let result = extract(&package(&xml)).unwrap();
        assert_eq!(
            result.document_text(),
            "Before\nFirst row\nSecond row\nAfter"
        );
        assert_eq!(
            result.collected(),
            ["Before", "After", "First row", "Second row"]
        );
    }

    #[test]
    fn long_vertical_merges_do_not_recurse_on_the_worker_stack() {
        std::thread::Builder::new()
            .stack_size(128 * 1024)
            .spawn(|| {
                let mut rows: Vec<_> = (0..20_000)
                    .map(|index| {
                        vec![GridCell {
                            grid_offset: 0,
                            span: 1,
                            continued: index != 0,
                            text: "origin".into(),
                        }]
                    })
                    .collect();
                let mut remaining = usize::MAX;
                let control = crate::ParseControl::default();
                let rendered = render_rows(&rows, &mut remaining, &control).unwrap();
                assert_eq!(rendered.len(), rows.len());
                assert!(rendered.iter().all(|text| text == "origin"));
                rows[0][0].continued = true;
                assert!(render_rows(&rows, &mut remaining, &control).is_err());
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn caller_archive_budget_preserves_complete_text_or_fails() {
        let xml = document("<w:p><w:r><w:t>授权资料</w:t></w:r></w:p>");
        let bytes = package(&xml);
        let archive = ZipArchive::with_decoded_byte_limit(&bytes, xml.len()).unwrap();
        assert_eq!(
            extract_from_archive(&archive).unwrap(),
            extract(&bytes).unwrap()
        );
        let archive = ZipArchive::with_decoded_byte_limit(&bytes, xml.len() - 1).unwrap();
        assert!(extract_from_archive(&archive).is_err());
    }

    #[test]
    fn rendered_text_budget_counts_paragraphs_spans_and_separators() {
        let xml = document(
            r#"<w:p><w:r><w:t>前文</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>
            <w:p><w:r><w:t>值</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#,
        );
        let bytes = package(&xml);
        let archive = ZipArchive::new(&bytes).unwrap();
        let size = "前文".len() + "值 | 值".len();
        assert_eq!(
            extract_with_text_limit(&archive, size).unwrap(),
            extract(&bytes).unwrap()
        );
        assert!(extract_with_text_limit(&archive, size - 1).is_err());
    }

    #[test]
    fn huge_spans_fail_before_expansion_and_empty_spans_do_not_loop() {
        let mut line = String::new();
        let mut remaining = 128;
        let control = crate::ParseControl::default();
        assert!(append_spanned(&mut line, "x", usize::MAX, &mut remaining, &control).is_err());
        assert!(line.is_empty());
        assert_eq!(remaining, 128);
        append_spanned(&mut line, "", usize::MAX, &mut remaining, &control).unwrap();
        assert_eq!(remaining, 128);
        assert!(append_spanned(&mut line, "x", 1000, &mut remaining, &control).is_err());
        assert!(line.is_empty());
        let xml = document(&format!(
            r#"<w:tbl><w:tr><w:trPr><w:gridBefore w:val="{}"/>
            </w:trPr><w:tc><w:p/></w:tc></w:tr></w:tbl>"#,
            usize::MAX
        ));
        assert!(extract(&package(&xml)).is_err());
    }

    /// A `.docx` package assembled in memory: `zip` entries use the stored
    /// method, which is what these fixtures need.
    pub fn package(document_xml: &str) -> Vec<u8> {
        super::super::zip::stored_archive(&[("word/document.xml", document_xml.as_bytes())])
    }

    fn document(body: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>"#
        )
    }

    #[test]
    fn paragraphs_join_runs_tabs_and_breaks() {
        let xml = document(concat!(
            r#"<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Report</w:t></w:r>"#,
            r#"<w:r><w:t xml:space="preserve"> 2026</w:t></w:r></w:p>"#,
            r#"<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t><w:cr/><w:noBreakHyphen/></w:r></w:p>"#,
            r#"<w:p><w:r><w:br w:type="page"/><w:ptab/></w:r></w:p>"#,
            r#"<w:p><w:pPr/></w:p>"#,
            r#"<w:p><w:r><w:t>   </w:t></w:r></w:p>"#,
        ));
        let extracted = extract(&package(&xml)).expect("document parses");
        // A tab-only or space-only paragraph is blank after `str.strip()`, so
        // the source drops it.
        assert_eq!(
            extracted.paragraphs,
            vec!["Report 2026".to_string(), "a\tb\nc\n-".to_string(),]
        );
        assert!(extracted.table_rows.is_empty());
    }

    #[test]
    fn hyperlinks_and_wrapped_runs_follow_python_docx() {
        let xml = document(concat!(
            r#"<w:p><w:r><w:t>see </w:t></w:r>"#,
            r#"<w:hyperlink r:id="rId4"><w:r><w:t>the link</w:t></w:r></w:hyperlink></w:p>"#,
            r#"<w:p><w:smartTag><w:r><w:t>hidden</w:t></w:r></w:smartTag></w:p>"#,
        ));
        let extracted = extract(&package(&xml)).expect("document parses");
        assert_eq!(extracted.paragraphs, vec!["see the link".to_string()]);
    }

    #[test]
    fn table_rows_honor_spans_and_vertical_merges() {
        let xml = document(
            r#"<w:tbl>
                 <w:tr>
                   <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>wide</w:t></w:r></w:p></w:tc>
                   <w:tc><w:p><w:r><w:t>plain</w:t></w:r></w:p></w:tc>
                   <w:tc><w:p><w:r><w:t>  </w:t></w:r></w:p></w:tc>
                 </w:tr>
                 <w:tr>
                   <w:tc><w:p><w:r><w:t>left</w:t></w:r></w:p></w:tc>
                   <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
                   <w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p><w:p><w:r><w:t>y</w:t></w:r></w:p></w:tc>
                 </w:tr>
               </w:tbl>"#,
        );
        // The continuation at grid offset 1 has no cell *starting* there in
        // the first row, which is what `python-docx` requires.
        assert!(extract(&package(&xml)).is_err());

        let aligned = document(
            r#"<w:tbl>
                 <w:tr>
                   <w:tc><w:p><w:r><w:t>wide</w:t></w:r></w:p></w:tc>
                   <w:tc><w:p><w:r><w:t>plain</w:t></w:r></w:p></w:tc>
                 </w:tr>
                 <w:tr>
                   <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
                   <w:tc><w:p><w:r><w:t>next</w:t></w:r></w:p></w:tc>
                 </w:tr>
               </w:tbl>"#,
        );
        let extracted = extract(&package(&aligned)).expect("document parses");
        assert_eq!(
            extracted.table_rows,
            vec!["wide | plain".to_string(), "wide | next".to_string()]
        );
    }

    #[test]
    fn a_continuation_in_the_top_row_is_a_parse_failure() {
        let xml = document(
            r#"<w:tbl><w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>"#,
        );
        assert!(extract(&package(&xml)).is_err());
    }

    #[test]
    fn a_package_without_the_document_part_is_a_parse_failure() {
        let data = super::super::zip::stored_archive(&[("other.xml", b"<a/>")]);
        assert!(extract(&data).is_err());
    }
}
