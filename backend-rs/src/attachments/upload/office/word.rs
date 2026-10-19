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

/// The extracted body text inputs, before the smart-truncation pass.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct WordText {
    /// Body-level paragraph texts, blank paragraphs dropped, unstripped.
    pub paragraphs: Vec<String>,
    /// One `" | "`-joined line per table row with populated cells.
    pub table_rows: Vec<String>,
}

impl WordText {
    /// `ContextService._parse_and_update_context`'s paragraph list: the
    /// paragraphs followed by the table rows, each already stripped when it is
    /// a table row (`_parse_word_smart`).
    pub(crate) fn collected(&self) -> Vec<String> {
        self.paragraphs
            .iter()
            .chain(self.table_rows.iter())
            .cloned()
            .collect()
    }
}

/// Extract the document text from a `.docx` package.
pub(crate) fn extract(data: &[u8]) -> Result<WordText, OfficeError> {
    let archive = ZipArchive::new(data).map_err(|_| OfficeError)?;
    let part = archive.read("word/document.xml").map_err(|_| OfficeError)?;
    let text = std::str::from_utf8(&part).map_err(|_| OfficeError)?;
    let document = Tree::new(text)
        .find_element("document")
        .map_err(|_| OfficeError)?
        .ok_or(OfficeError)?;
    let body = document.child("body").ok_or(OfficeError)?;

    let mut extracted = WordText::default();
    for child in &body.children {
        match child.local() {
            "p" => {
                let paragraph = paragraph_text(child);
                if !paragraph.trim().is_empty() {
                    extracted.paragraphs.push(paragraph);
                }
            }
            "tbl" => extracted.table_rows.extend(table_rows(child)?),
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
fn table_rows(table: &Element) -> Result<Vec<String>, OfficeError> {
    let rows = layout_rows(table);
    let mut lines = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let mut row_text = Vec::new();
        for cell in row {
            let text = if cell.continued {
                resolve_continued(&rows, index, cell)?
            } else {
                cell.text.clone()
            };
            for _ in 0..cell.span {
                let stripped = text.trim();
                if !stripped.is_empty() {
                    row_text.push(stripped.to_string());
                }
            }
        }
        if !row_text.is_empty() {
            lines.push(row_text.join(" | "));
        }
    }
    Ok(lines)
}

/// The per-row grid model: grid columns in document order per row.
fn layout_rows(table: &Element) -> Vec<Vec<GridCell>> {
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
            let span = grid_span(cell);
            cells.push(GridCell {
                grid_offset: offset,
                span,
                continued: vertical_merge(cell),
                text: cell_text(cell),
            });
            offset += span;
        }
        rows.push(cells);
    }
    rows
}

/// `_tc_above` + `iter_tc_cells`: the continued cell repeats the cell that
/// starts at the same grid offset one row up, following further continuations.
fn resolve_continued(
    rows: &[Vec<GridCell>],
    row_index: usize,
    cell: &GridCell,
) -> Result<String, OfficeError> {
    let previous = row_index.checked_sub(1).ok_or(OfficeError)?;
    let above = tc_at_grid_offset(&rows[previous], cell.grid_offset).ok_or(OfficeError)?;
    if above.continued {
        return resolve_continued(rows, previous, above);
    }
    Ok(above.text.clone())
}

/// `tc_at_grid_offset`: the cell starting at exactly this grid offset.
fn tc_at_grid_offset(row: &[GridCell], grid_offset: usize) -> Option<&GridCell> {
    row.iter().find(|cell| cell.grid_offset == grid_offset)
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

    /// A `.docx` package assembled in memory: `zip` entries use the stored
    /// method, which is what these fixtures need.
    pub(crate) fn package(document_xml: &str) -> Vec<u8> {
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
