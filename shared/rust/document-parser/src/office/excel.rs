// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `openpyxl`-equivalent `.xlsx` reading plus `knowledge_engine.excel`'s
//! compact projection (`DocumentParser._parse_excel_smart`).
//!
//! The source loads the workbook twice — once for formulas
//! (`data_only=False`) and, only when formula cells exist, once for cached
//! results (`data_only=True`) — and merges the cached value into the formula
//! cell as `{"formula": ..., "value": ...}`. Cell coordinates come from the
//! `r` attributes with a running counter fallback, populated cells keep the
//! physical row/column they were written at, and each value is normalized the
//! way `normalize_excel_value` normalizes it (dates through
//! [`super::excel_serial::from_excel`], integral floats to integers, strings
//! unchanged).
use std::collections::{HashMap, HashSet};

use super::OfficeError;
use super::excel_serial::{
    MAC_EPOCH, WINDOWS_EPOCH, from_excel, from_iso8601, is_date_format, is_timedelta_format,
    python_float_repr,
};
use super::xml::{Element, Tree};
use super::zip::ZipArchive;

#[path = "excel_text.rs"]
mod text;
pub use text::read_text_with_limits;

/// `knowledge_engine.excel.MAX_EXCEL_CONTEXT_NAME`.
const MAX_EXCEL_CONTEXT_NAME: usize = 48;

/// A populated row at its 1-based physical source row.
#[derive(Debug, Clone, PartialEq)]
pub struct ExcelRow {
    pub source_row: u64,
    pub cells: Vec<ExcelCell>,
}

/// A populated cell at its 1-based physical source column.
#[derive(Debug, Clone, PartialEq)]
pub struct ExcelCell {
    pub source_column: u64,
    pub value: ExcelValue,
}

/// A worksheet and its populated physical rows.
#[derive(Debug, Clone, PartialEq)]
pub struct ExcelSheet {
    pub name: String,
    pub rows: Vec<ExcelRow>,
}

/// `normalize_excel_value`: the deterministic JSON data of one cell.
#[derive(Debug, Clone, PartialEq)]
pub enum ExcelValue {
    /// A string value (including error codes and non-finite floats).
    Text(String),
    /// An integer, kept as its canonical decimal spelling.
    Integer(String),
    /// A finite, non-integral number.
    Float(f64),
    /// A boolean.
    Bool(bool),
    /// A formula wrapper: an object with keys in the source's order.
    Object(Vec<(String, ExcelValue)>),
}

impl ExcelValue {
    /// The canonical single-line JSON encoding the compact projection uses.
    pub fn to_json(&self) -> String {
        let mut output = String::new();
        text::write_value(&mut output, self).expect("writing to String is infallible");
        output
    }
}

fn charge_value(value: &ExcelValue, remaining: &mut usize) -> Result<(), OfficeError> {
    *remaining = remaining
        .checked_sub(std::mem::size_of::<ExcelValue>())
        .ok_or(OfficeError)?;
    match value {
        ExcelValue::Text(text) | ExcelValue::Integer(text) => {
            *remaining = remaining.checked_sub(text.len()).ok_or(OfficeError)?;
        }
        ExcelValue::Object(fields) => {
            for (key, value) in fields {
                *remaining = remaining.checked_sub(key.len()).ok_or(OfficeError)?;
                charge_value(value, remaining)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// `format_excel_row_compact`: `R<n>: v1 | v2 | [4]=v4`.
pub fn compact_row_line(row: &ExcelRow) -> String {
    let mut output = String::new();
    text::write_row(&mut output, row).expect("writing to String is infallible");
    output
}

/// `format_excel_sheet_header`, empty when the collapsed name is empty.
pub fn sheet_header(name: &str) -> String {
    let collapsed = truncate_sheet_name(name, MAX_EXCEL_CONTEXT_NAME);
    if collapsed.is_empty() {
        return String::new();
    }
    format!("--- Sheet: {collapsed} ---")
}

/// `serialize_excel_sheet_compact`.
pub fn serialize_sheet_compact(sheet: &ExcelSheet) -> String {
    let header = sheet_header(&sheet.name);
    let rows_text = sheet
        .rows
        .iter()
        .map(compact_row_line)
        .collect::<Vec<_>>()
        .join("\n");
    if header.is_empty() {
        return rows_text;
    }
    if rows_text.is_empty() {
        return header;
    }
    format!("{header}\n{rows_text}")
}

/// `_truncate_sheet_name`: collapse line breaks, strip, then cap with an
/// ellipsis.
fn truncate_sheet_name(name: &str, cap: usize) -> String {
    let collapsed = split_lines(name).join(" ");
    let collapsed = collapsed.trim_matches(python_whitespace);
    if cap < 1 || collapsed.is_empty() {
        return String::new();
    }
    let characters: Vec<char> = collapsed.chars().collect();
    if characters.len() > cap {
        let mut truncated: String = characters[..cap - 1].iter().collect();
        truncated.push('…');
        return truncated;
    }
    collapsed.to_string()
}

/// `str.splitlines()`: the Unicode line boundaries Python recognizes.
fn split_lines(value: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\n' | '\u{b}' | '\u{c}' | '\u{1c}' | '\u{1d}' | '\u{1e}' | '\u{85}' | '\u{2028}'
            | '\u{2029}' => lines.push(std::mem::take(&mut current)),
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                lines.push(std::mem::take(&mut current));
            }
            ch => current.push(ch),
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

/// `str.strip()`: Python's whitespace set.
fn python_whitespace(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '\u{b}' | '\u{c}' | '\u{1c}' | '\u{1d}' | '\u{1e}' | '\u{85}'
        )
}

/// Read every worksheet in the workbook in `openpyxl` order.
pub fn read_sheets(data: &[u8]) -> Result<Vec<ExcelSheet>, OfficeError> {
    let archive = ZipArchive::new(data).map_err(|_| OfficeError)?;
    read_sheets_from_archive(&archive)
}

/// Extract using the caller's archive and cumulative decoded-byte budget.
pub fn read_sheets_from_archive(archive: &ZipArchive<'_>) -> Result<Vec<ExcelSheet>, OfficeError> {
    read_sheets_with_value_limit(archive, usize::MAX)
}

/// Bound cumulative materialized cell values, including the cached-formula pass.
pub fn read_sheets_with_value_limit(
    archive: &ZipArchive<'_>,
    mut remaining: usize,
) -> Result<Vec<ExcelSheet>, OfficeError> {
    let workbook_xml = read_part(archive, "xl/workbook.xml")?;
    let workbook = Tree::controlled(&workbook_xml, archive.control())
        .find_element("workbook")
        .map_err(|_| OfficeError)?
        .ok_or(OfficeError)?;
    let windows_epoch = !workbook_is_1904(&workbook);
    let epoch = if windows_epoch {
        WINDOWS_EPOCH
    } else {
        MAC_EPOCH
    };
    let sheets = workbook
        .child("sheets")
        .map(|sheets| {
            sheets
                .named_children("sheet")
                .map(|sheet| {
                    (
                        sheet.attr("name").unwrap_or_default().to_string(),
                        sheet.attr("r:id").unwrap_or_default().to_string(),
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let relationships = read_relationships(archive)?;
    let shared_strings = read_shared_strings(archive)?;
    let styles = read_styles(archive)?;

    let mut loaded = Vec::with_capacity(sheets.len());
    let mut formula_cells: Vec<HashSet<(u64, u64)>> = Vec::with_capacity(sheets.len());
    for (name, relationship_id) in &sheets {
        let target = relationships.get(relationship_id).ok_or(OfficeError)?;
        let sheet_xml = read_part(archive, target)?;
        let parsed = parse_sheet(
            &sheet_xml,
            &shared_strings,
            &styles,
            epoch,
            false,
            &archive.control(),
            &mut remaining,
        )?;
        loaded.push(ExcelSheet {
            name: name.clone(),
            rows: parsed.rows,
        });
        formula_cells.push(parsed.formula_cells);
    }

    // The cached-result pass is skipped entirely when no formula cell exists.
    if formula_cells.iter().all(HashSet::is_empty) {
        return Ok(loaded);
    }

    for (index, (_, relationship_id)) in sheets.iter().enumerate() {
        if formula_cells[index].is_empty() {
            continue;
        }
        let target = relationships.get(relationship_id).ok_or(OfficeError)?;
        let sheet_xml = read_part(archive, target)?;
        let cached = parse_sheet(
            &sheet_xml,
            &shared_strings,
            &styles,
            epoch,
            true,
            &archive.control(),
            &mut remaining,
        )?;
        let cached_values: HashMap<(u64, u64), ExcelValue> = cached
            .cells
            .into_iter()
            .filter(|(row, column, _)| formula_cells[index].contains(&(*row, *column)))
            .map(|(row, column, value)| ((row, column), value))
            .collect();
        merge_cached_values(&mut loaded[index], &cached_values);
    }
    Ok(loaded)
}

/// `_merge_cached_values`: wrap each formula cell with its cached result.
fn merge_cached_values(sheet: &mut ExcelSheet, cached: &HashMap<(u64, u64), ExcelValue>) {
    for row in &mut sheet.rows {
        for cell in &mut row.cells {
            let Some(value) = cached.get(&(row.source_row, cell.source_column)) else {
                continue;
            };
            cell.value = ExcelValue::Object(vec![
                ("formula".to_string(), cell.value.clone()),
                ("value".to_string(), value.clone()),
            ]);
        }
    }
}

/// `WorkbookParser`'s `workbookPr@date1904` flag.
fn workbook_is_1904(workbook: &Element) -> bool {
    workbook
        .child("workbookPr")
        .and_then(|properties| properties.attr_local("date1904"))
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true"))
}

/// The `xl/_rels/workbook.xml.rels` id -> archive path map.
fn read_relationships(archive: &ZipArchive<'_>) -> Result<HashMap<String, String>, OfficeError> {
    let xml = archive
        .read("xl/_rels/workbook.xml.rels")
        .map_err(|_| OfficeError)?;
    let xml = String::from_utf8(xml).map_err(|_| OfficeError)?;
    let Some(root) = Tree::controlled(&xml, archive.control())
        .find_element("Relationships")
        .map_err(|_| OfficeError)?
    else {
        return Ok(HashMap::new());
    };
    let mut relationships = HashMap::new();
    for relationship in root.named_children("Relationship") {
        let (Some(id), Some(target)) = (relationship.attr("Id"), relationship.attr("Target"))
        else {
            continue;
        };
        relationships.insert(id.to_string(), sheet_part_path(target));
    }
    Ok(relationships)
}

/// Resolve a relationship target to an archive path (`xl/` relative, or
/// package-absolute after a leading `/`).
fn sheet_part_path(target: &str) -> String {
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_string();
    }
    format!("xl/{}", target.trim_start_matches("./"))
}

/// `read_string_table`: the shared string table, with the `x005F_` quirk.
fn read_shared_strings(archive: &ZipArchive<'_>) -> Result<Vec<String>, OfficeError> {
    let Ok(xml) = archive.read("xl/sharedStrings.xml") else {
        archive.check_budget().map_err(|_| OfficeError)?;
        return Ok(Vec::new());
    };
    let xml = String::from_utf8(xml).map_err(|_| OfficeError)?;
    let Some(root) = Tree::controlled(&xml, archive.control())
        .find_element("sst")
        .map_err(|_| OfficeError)?
    else {
        return Ok(Vec::new());
    };
    // `read_string_table`: `Text.from_tree(si).content`, minus the `x005F_`
    // escaping quirk.
    Ok(root
        .named_children("si")
        .map(|item| text_content(item).replace("x005F_", ""))
        .collect())
}

/// `openpyxl.cell.text.Text.content`: direct `t` text plus the runs' text.
fn text_content(element: &Element) -> String {
    let mut content = String::new();
    if let Some(plain) = element.child("t") {
        content.push_str(&plain.direct_text());
    }
    for run in element.named_children("r") {
        if let Some(text) = run.child("t") {
            content.push_str(&text.direct_text());
        }
    }
    content
}

/// The styles a numeric cell needs: which style ids are date or elapsed-time
/// formats, resolved from `xl/styles.xml`.
struct Styles {
    date_styles: HashSet<usize>,
    timedelta_styles: HashSet<usize>,
}

fn read_styles(archive: &ZipArchive<'_>) -> Result<Styles, OfficeError> {
    let mut styles = Styles {
        date_styles: HashSet::new(),
        timedelta_styles: HashSet::new(),
    };
    let Ok(xml) = archive.read("xl/styles.xml") else {
        archive.check_budget().map_err(|_| OfficeError)?;
        return Ok(styles);
    };
    let xml = String::from_utf8(xml).map_err(|_| OfficeError)?;
    let Some(root) = Tree::controlled(&xml, archive.control())
        .find_element("styleSheet")
        .map_err(|_| OfficeError)?
    else {
        return Ok(styles);
    };

    let mut custom_formats: HashMap<String, String> = HashMap::new();
    if let Some(formats) = root.child("numFmts") {
        for format in formats.named_children("numFmt") {
            if let (Some(id), Some(code)) = (
                format.attr_local("numFmtId"),
                format.attr_local("formatCode"),
            ) {
                custom_formats.insert(id.to_string(), code.to_string());
            }
        }
    }
    let Some(cell_xfs) = root.child("cellXfs") else {
        return Ok(styles);
    };
    for (index, format) in cell_xfs.named_children("xf").enumerate() {
        let num_fmt_id = format.attr_local("numFmtId").unwrap_or("0");
        let code = custom_formats
            .get(num_fmt_id)
            .map(String::as_str)
            .or_else(|| builtin_format_code(num_fmt_id));
        if is_date_format(code) {
            styles.date_styles.insert(index);
        }
        if is_timedelta_format(code) {
            styles.timedelta_styles.insert(index);
        }
    }
    Ok(styles)
}

/// `openpyxl.styles.numbers.BUILTIN_FORMATS`: the standard number formats.
fn builtin_format_code(id: &str) -> Option<&'static str> {
    let index: usize = id.parse().ok()?;
    BUILTIN_FORMATS
        .iter()
        .find(|(candidate, _)| *candidate == index)
        .map(|(_, code)| *code)
}

const BUILTIN_FORMATS: &[(usize, &str)] = &[
    (0, "General"),
    (1, "0"),
    (2, "0.00"),
    (3, "#,##0"),
    (4, "#,##0.00"),
    (5, "\"$\"#,##0_);(\"$\"#,##0)"),
    (6, "\"$\"#,##0_);[Red](\"$\"#,##0)"),
    (7, "\"$\"#,##0.00_);(\"$\"#,##0.00)"),
    (8, "\"$\"#,##0.00_);[Red](\"$\"#,##0.00)"),
    (9, "0%"),
    (10, "0.00%"),
    (11, "0.00E+00"),
    (12, "# ?/?"),
    (13, "# ??/??"),
    (14, "mm-dd-yy"),
    (15, "d-mmm-yy"),
    (16, "d-mmm"),
    (17, "mmm-yy"),
    (18, "h:mm AM/PM"),
    (19, "h:mm:ss AM/PM"),
    (20, "h:mm"),
    (21, "h:mm:ss"),
    (22, "m/d/yy h:mm"),
    (37, "#,##0_);(#,##0)"),
    (38, "#,##0_);[Red](#,##0)"),
    (39, "#,##0.00_);(#,##0.00)"),
    (40, "#,##0.00_);[Red](#,##0.00)"),
    (41, "_(* #,##0_);_(* \\(#,##0\\);_(* \"-\"_);_(@_)"),
    (
        42,
        "_(\"$\"* #,##0_);_(\"$\"* \\(#,##0\\);_(\"$\"* \"-\"_);_(@_)",
    ),
    (43, "_(* #,##0.00_);_(* \\(#,##0.00\\);_(* \"-\"??_);_(@_)"),
    (
        44,
        "_(\"$\"* #,##0.00_)_(\"$\"* \\(#,##0.00\\)_(\"$\"* \"-\"??_)_(@_)",
    ),
    (45, "mm:ss"),
    (46, "[h]:mm:ss"),
    (47, "mmss.0"),
    (48, "##0.0E+0"),
    (49, "@"),
];

/// One worksheet read, plus the coordinates of its formula cells.
struct ParsedSheet {
    rows: Vec<ExcelRow>,
    /// Every populated cell at its own coordinate, the form
    /// `_read_cached_values` keys its results by.
    cells: Vec<(u64, u64, ExcelValue)>,
    formula_cells: HashSet<(u64, u64)>,
}

/// `_read_sheet`: populated cells only, keeping physical coordinates.
fn parse_sheet(
    xml: &str,
    shared_strings: &[String],
    styles: &Styles,
    epoch: (i32, u32, u32),
    data_only: bool,
    control: &crate::ParseControl,
    remaining: &mut usize,
) -> Result<ParsedSheet, OfficeError> {
    let mut tree = Tree::controlled(xml, control.clone());
    if !tree.enter("sheetData").map_err(|_| OfficeError)? {
        return Ok(ParsedSheet {
            rows: Vec::new(),
            cells: Vec::new(),
            formula_cells: HashSet::new(),
        });
    }

    let mut rows: Vec<ExcelRow> = Vec::new();
    let mut cells: Vec<(u64, u64, ExcelValue)> = Vec::new();
    let mut formula_cells: HashSet<(u64, u64)> = HashSet::new();
    let mut shared_formulas = super::excel_formula::SharedFormulas::new(xml.len());
    let mut row_counter: u64 = 0;
    while let Some(row_element) = tree.next_element().map_err(|_| OfficeError)? {
        if row_element.local() != "row" {
            continue;
        }
        row_counter = match row_element.attr("r").and_then(|value| value.parse().ok()) {
            Some(row) => row,
            None => row_counter.checked_add(1).ok_or(OfficeError)?,
        };
        let mut column_counter: u64 = 0;
        let row_start = cells.len();
        for cell_element in row_element.named_children("c") {
            control.check().map_err(|_| OfficeError)?;
            let (row, column) = match cell_element.attr("r") {
                Some(coordinate) => {
                    let (row, column) = coordinate_to_tuple(coordinate)?;
                    column_counter = column;
                    (row, column)
                }
                None => {
                    column_counter = column_counter.checked_add(1).ok_or(OfficeError)?;
                    (row_counter, column_counter)
                }
            };
            let style_id = cell_element
                .attr("s")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            let Some(mut value) = cell_value(
                cell_element,
                shared_strings,
                styles,
                style_id,
                epoch,
                data_only,
            )?
            else {
                continue;
            };
            if !data_only
                && let Some(formula) = cell_element.child("f")
                && formula.attr("t") == Some("shared")
            {
                value = ExcelValue::Text(shared_formulas.resolve(formula, row, column)?);
            }
            if cell_element.child("f").is_some() {
                formula_cells.insert((row, column));
            }
            charge_value(&value, remaining)?;
            cells.push((row, column, value));
        }
        if data_only {
            continue;
        }
        // `_read_sheet`: a row is populated when it has a valued cell, and its
        // `source_row` comes from the first of those cells.
        let Some((source_row, _, _)) = cells.get(row_start) else {
            continue;
        };
        rows.push(ExcelRow {
            source_row: *source_row,
            cells: cells
                .drain(row_start..)
                .map(|(_, column, value)| ExcelCell {
                    source_column: column,
                    value,
                })
                .collect(),
        });
    }
    Ok(ParsedSheet {
        rows,
        cells,
        formula_cells,
    })
}

/// `WorkSheetParser.parse_cell`: the normalized value of one `<c>` element.
fn cell_value(
    cell: &Element,
    shared_strings: &[String],
    styles: &Styles,
    style_id: usize,
    epoch: (i32, u32, u32),
    data_only: bool,
) -> Result<Option<ExcelValue>, OfficeError> {
    let data_type = cell.attr("t").unwrap_or("n");
    let text = cell.child("v").map(|value| value.direct_text());
    let text = text.filter(|value| !value.is_empty());

    if !data_only && let Some(formula) = cell.child("f") {
        return Ok(Some(formula_value(formula)));
    }
    let Some(text) = text else {
        if data_type == "inlineStr" {
            return Ok(cell
                .child("is")
                .map(|inline| ExcelValue::Text(text_content(inline))));
        }
        return Ok(None);
    };
    let value = match data_type {
        "s" => {
            let index: usize = text.trim().parse().map_err(|_| OfficeError)?;
            ExcelValue::Text(shared_strings.get(index).cloned().ok_or(OfficeError)?)
        }
        "b" => ExcelValue::Bool(text.trim() != "0"),
        "str" | "e" => ExcelValue::Text(text),
        "d" => match from_iso8601(&text) {
            Some(date) => ExcelValue::Text(date.render()),
            None => return Err(OfficeError),
        },
        _ => {
            let number = cast_number(&text)?;
            if styles.date_styles.contains(&style_id) {
                let as_timedelta = styles.timedelta_styles.contains(&style_id);
                let serial = match &number {
                    Number::Integer(value) => value.parse::<f64>().unwrap_or_default(),
                    Number::Float(value) => *value,
                };
                match from_excel(serial, epoch == WINDOWS_EPOCH, as_timedelta) {
                    Some(date) => ExcelValue::Text(date.render()),
                    // `openpyxl` warns and stores `#VALUE!` when the serial is
                    // outside the date limits.
                    None => ExcelValue::Text("#VALUE!".to_string()),
                }
            } else {
                normalize_number(number)
            }
        }
    };
    Ok(Some(value))
}

/// `parse_formula`: `=text`, an array formula or a data-table formula.
fn formula_value(formula: &Element) -> ExcelValue {
    match formula.attr("t") {
        Some("array") => ExcelValue::Object(vec![
            (
                "formula_type".to_string(),
                ExcelValue::Text("array".to_string()),
            ),
            (
                "ref".to_string(),
                ExcelValue::Text(formula.attr("ref").unwrap_or_default().to_string()),
            ),
            (
                "text".to_string(),
                ExcelValue::Text(format!("={}", formula.direct_text())),
            ),
        ]),
        Some("dataTable") => {
            let flag = |name: &str| ExcelValue::Bool(formula_flag(formula.attr_local(name)));
            let attribute = |name: &str| {
                formula
                    .attr_local(name)
                    .map(|value| ExcelValue::Text(value.to_string()))
            };
            ExcelValue::Object(vec![
                (
                    "formula_type".to_string(),
                    ExcelValue::Text("dataTable".to_string()),
                ),
                (
                    "ref".to_string(),
                    ExcelValue::Text(formula.attr_local("ref").unwrap_or_default().to_string()),
                ),
                ("ca".to_string(), flag("ca")),
                ("dt2D".to_string(), flag("dt2D")),
                ("dtr".to_string(), flag("dtr")),
                (
                    "r1".to_string(),
                    attribute("r1").unwrap_or(ExcelValue::Text(String::new())),
                ),
                (
                    "r2".to_string(),
                    attribute("r2").unwrap_or(ExcelValue::Text(String::new())),
                ),
                ("del1".to_string(), flag("del1")),
                ("del2".to_string(), flag("del2")),
            ])
        }
        _ => ExcelValue::Text(format!("={}", formula.direct_text())),
    }
}

/// `_normalize_formula_flag`: an OOXML boolean attribute.
fn formula_flag(value: Option<&str>) -> bool {
    match value {
        Some(value) => matches!(value.to_ascii_lowercase().as_str(), "1" | "true"),
        None => false,
    }
}

/// `_cast_number`: `int` unless the text carries a point or an exponent.
enum Number {
    Integer(String),
    Float(f64),
}

fn cast_number(text: &str) -> Result<Number, OfficeError> {
    let trimmed = text.trim();
    if trimmed.contains('.') || trimmed.contains('E') || trimmed.contains('e') {
        let value: f64 = trimmed.parse().map_err(|_| OfficeError)?;
        return Ok(Number::Float(value));
    }
    Ok(Number::Integer(canonical_integer(trimmed)?))
}

/// `int(text)` with Python's spelling-preserving canonical digits.
fn canonical_integer(text: &str) -> Result<String, OfficeError> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(OfficeError);
    }
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return Ok("0".to_string());
    }
    Ok(if negative {
        format!("-{digits}")
    } else {
        digits.to_string()
    })
}

/// `normalize_excel_value` for a numeric cell.
fn normalize_number(number: Number) -> ExcelValue {
    match number {
        Number::Integer(value) => ExcelValue::Integer(value),
        Number::Float(value) => {
            if !value.is_finite() {
                // `str(float)` for the non-finite values JSON cannot carry.
                return ExcelValue::Text(python_float_repr(value));
            }
            if value.fract() == 0.0 {
                return if value == 0.0 {
                    ExcelValue::Integer("0".to_string())
                } else {
                    ExcelValue::Integer(format!("{value:.0}"))
                };
            }
            ExcelValue::Float(value)
        }
    }
}

/// `openpyxl.utils.cell.coordinate_to_tuple`.
fn coordinate_to_tuple(coordinate: &str) -> Result<(u64, u64), OfficeError> {
    let mut letters = String::new();
    let mut digits = String::new();
    for ch in coordinate.chars() {
        if ch.is_ascii_alphabetic() {
            if !digits.is_empty() {
                return Err(OfficeError);
            }
            letters.push(ch);
        } else if ch.is_ascii_digit() {
            digits.push(ch);
        } else {
            return Err(OfficeError);
        }
    }
    if letters.is_empty() || digits.is_empty() {
        return Err(OfficeError);
    }
    let mut column: u64 = 0;
    for ch in letters.chars() {
        let index = (ch.to_ascii_uppercase() as u8 - b'A' + 1) as u64;
        column = column
            .checked_mul(26)
            .and_then(|column| column.checked_add(index))
            .ok_or(OfficeError)?;
    }
    let row: u64 = digits.parse().map_err(|_| OfficeError)?;
    Ok((row, column))
}

/// Read one package part as text.
fn read_part(archive: &ZipArchive<'_>, name: &str) -> Result<String, OfficeError> {
    let bytes = archive.read(name).map_err(|_| OfficeError)?;
    String::from_utf8(bytes).map_err(|_| OfficeError)
}

#[cfg(test)]
#[path = "excel_tests.rs"]
mod tests;
