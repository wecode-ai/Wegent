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

/// `knowledge_engine.excel.MAX_EXCEL_CONTEXT_NAME`.
const MAX_EXCEL_CONTEXT_NAME: usize = 48;

/// A populated row at its 1-based physical source row.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ExcelRow {
    pub source_row: u64,
    pub cells: Vec<ExcelCell>,
}

/// A populated cell at its 1-based physical source column.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ExcelCell {
    pub source_column: u64,
    pub value: ExcelValue,
}

/// A worksheet and its populated physical rows.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ExcelSheet {
    pub name: String,
    pub rows: Vec<ExcelRow>,
}

/// `normalize_excel_value`: the deterministic JSON data of one cell.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ExcelValue {
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
    pub(crate) fn to_json(&self) -> String {
        match self {
            Self::Text(value) => quote_json(value),
            Self::Integer(value) => value.clone(),
            Self::Float(value) => python_float_repr(*value),
            Self::Bool(value) => value.to_string(),
            Self::Object(fields) => {
                let body = fields
                    .iter()
                    .map(|(key, value)| format!("{}:{}", quote_json(key), value.to_json()))
                    .collect::<Vec<_>>()
                    .join(",");
                format!("{{{body}}}")
            }
        }
    }

    /// The compact projection's spelling: strings stay JSON-quoted.
    fn compact(&self) -> String {
        self.to_json()
    }
}

/// `json.dumps(value, ensure_ascii=False)` for a string.
fn quote_json(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ch if (ch as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// `format_excel_row_compact`: `R<n>: v1 | v2 | [4]=v4`.
pub(crate) fn compact_row_line(row: &ExcelRow) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(row.cells.len());
    let mut expected_column = 1;
    for cell in &row.cells {
        let value = cell.value.compact();
        if cell.source_column == expected_column {
            parts.push(value);
        } else {
            parts.push(format!("[{}]={value}", cell.source_column));
        }
        expected_column = cell.source_column + 1;
    }
    format!("R{}: {}", row.source_row, parts.join(" | "))
}

/// `format_excel_sheet_header`, empty when the collapsed name is empty.
pub(crate) fn sheet_header(name: &str) -> String {
    let collapsed = truncate_sheet_name(name, MAX_EXCEL_CONTEXT_NAME);
    if collapsed.is_empty() {
        return String::new();
    }
    format!("--- Sheet: {collapsed} ---")
}

/// `serialize_excel_sheet_compact`.
pub(crate) fn serialize_sheet_compact(sheet: &ExcelSheet) -> String {
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
pub(crate) fn read_sheets(data: &[u8]) -> Result<Vec<ExcelSheet>, OfficeError> {
    let archive = ZipArchive::new(data).map_err(|_| OfficeError)?;
    let workbook_xml = read_part(&archive, "xl/workbook.xml")?;
    let workbook = Tree::new(&workbook_xml)
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

    let relationships = read_relationships(&archive)?;
    let shared_strings = read_shared_strings(&archive)?;
    let styles = read_styles(&archive)?;

    let mut loaded = Vec::with_capacity(sheets.len());
    let mut formula_cells: Vec<HashSet<(u64, u64)>> = Vec::with_capacity(sheets.len());
    for (name, relationship_id) in &sheets {
        let target = relationships.get(relationship_id).ok_or(OfficeError)?;
        let sheet_xml = read_part(&archive, target)?;
        let parsed = parse_sheet(&sheet_xml, &shared_strings, &styles, epoch, false)?;
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
        let sheet_xml = read_part(&archive, target)?;
        let cached = parse_sheet(&sheet_xml, &shared_strings, &styles, epoch, true)?;
        let cached_values: HashMap<(u64, u64), ExcelValue> = cached
            .cells
            .iter()
            .filter(|(row, column, _)| formula_cells[index].contains(&(*row, *column)))
            .map(|(row, column, value)| ((*row, *column), value.clone()))
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
    let Some(root) = Tree::new(&xml)
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
        return Ok(Vec::new());
    };
    let xml = String::from_utf8(xml).map_err(|_| OfficeError)?;
    let Some(root) = Tree::new(&xml)
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
        return Ok(styles);
    };
    let xml = String::from_utf8(xml).map_err(|_| OfficeError)?;
    let Some(root) = Tree::new(&xml)
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
) -> Result<ParsedSheet, OfficeError> {
    let mut tree = Tree::new(xml);
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
        row_counter = row_element
            .attr("r")
            .and_then(|value| value.parse().ok())
            .unwrap_or(row_counter + 1);
        let mut column_counter: u64 = 0;
        let row_start = cells.len();
        for cell_element in row_element.named_children("c") {
            let (row, column) = match cell_element.attr("r") {
                Some(coordinate) => {
                    let (row, column) = coordinate_to_tuple(coordinate)?;
                    column_counter = column;
                    (row, column)
                }
                None => {
                    column_counter += 1;
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
            cells.push((row, column, value));
        }
        // `_read_sheet`: a row is populated when it has a valued cell, and its
        // `source_row` comes from the first of those cells.
        let Some((source_row, _, _)) = cells.get(row_start) else {
            continue;
        };
        rows.push(ExcelRow {
            source_row: *source_row,
            cells: cells[row_start..]
                .iter()
                .map(|(_, column, value)| ExcelCell {
                    source_column: *column,
                    value: value.clone(),
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
        column = column * 26 + index;
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
mod tests {
    use super::*;

    #[test]
    fn shared_formula_cells_expand_before_merging_cached_values() {
        let xml = "<worksheet><sheetData>\
            <row r=\"1\"><c r=\"A1\"><v>1</v></c><c r=\"B1\">\
            <f t=\"shared\" si=\"0\" ref=\"B1:B2\">A1*2</f><v>2</v></c></row>\
            <row r=\"2\"><c r=\"A2\"><v>2</v></c><c r=\"B2\">\
            <f t=\"shared\" si=\"0\"/><v>4</v></c></row>\
            </sheetData></worksheet>";
        let sheets = read_sheets(&package(xml, None, None)).unwrap();
        assert_eq!(
            sheets[0].rows[1].cells[1].value.compact(),
            r#"{"formula":"=A2*2","value":4}"#
        );
    }

    /// A minimal workbook package: the workbook, its relationships and one
    /// worksheet, with optional shared strings and styles.
    fn package(sheet_xml: &str, shared_strings: Option<&str>, styles: Option<&str>) -> Vec<u8> {
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        entries.push((
            "xl/workbook.xml".to_string(),
            concat!(
                "<?xml version=\"1.0\"?><workbook><sheets>",
                "<sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"
            )
            .as_bytes()
            .to_vec(),
        ));
        let mut relationships = String::from(
            "<?xml version=\"1.0\"?><Relationships>\
             <Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/>",
        );
        if shared_strings.is_some() {
            relationships.push_str("<Relationship Id=\"rId2\" Target=\"sharedStrings.xml\"/>");
        }
        if styles.is_some() {
            relationships.push_str("<Relationship Id=\"rId3\" Target=\"styles.xml\"/>");
        }
        relationships.push_str("</Relationships>");
        entries.push((
            "xl/_rels/workbook.xml.rels".to_string(),
            relationships.into_bytes(),
        ));
        if let Some(shared) = shared_strings {
            entries.push((
                "xl/sharedStrings.xml".to_string(),
                shared.as_bytes().to_vec(),
            ));
        }
        if let Some(styles) = styles {
            entries.push(("xl/styles.xml".to_string(), styles.as_bytes().to_vec()));
        }
        entries.push((
            "xl/worksheets/sheet1.xml".to_string(),
            sheet_xml.as_bytes().to_vec(),
        ));
        let borrowed: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(name, payload)| (name.as_str(), payload.as_slice()))
            .collect();
        super::super::zip::stored_archive(&borrowed)
    }

    fn sheet_data(rows: &str) -> String {
        format!(
            "<?xml version=\"1.0\"?><worksheet><sheetPr/><dimension/>\
             <sheetData>{rows}</sheetData></worksheet>"
        )
    }

    #[test]
    fn cells_normalize_with_their_physical_coordinates() {
        let shared = "<?xml version=\"1.0\"?><sst><si><t>uid</t></si>\
                      <si><r><t>rich</t></r><r><t> text</t></r></si></sst>";
        let data = package(
            &sheet_data(
                "<row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c>\
                 <c r=\"B1\" t=\"s\"><v>1</v></c><c r=\"C1\" t=\"b\"><v>1</v></c>\
                 <c r=\"D1\" t=\"e\"><v>#DIV/0!</v></c></row>\
                 <row r=\"2\"><c r=\"A2\"><v>42</v></c><c r=\"B2\"><v>2.5</v></c>\
                 <c r=\"C2\"><v>3.0</v></c><c r=\"D2\" t=\"inlineStr\"><is><t>inline</t></is></c>\
                 <c r=\"E2\"></c></row>\
                 <row r=\"4\"><c r=\"C4\"><v>7</v></c></row>",
            ),
            Some(shared),
            None,
        );
        let sheets = read_sheets(&data).expect("package reads");
        assert_eq!(sheets[0].name, "Sheet1");
        assert_eq!(
            serialize_sheet_compact(&sheets[0]),
            "--- Sheet: Sheet1 ---\n\
             R1: \"uid\" | \"rich text\" | true | \"#DIV/0!\"\n\
             R2: 42 | 2.5 | 3 | \"inline\"\n\
             R4: [3]=7"
        );
    }

    #[test]
    fn number_formats_turn_serials_into_dates() {
        let styles = "<?xml version=\"1.0\"?><styleSheet>\
                      <numFmts count=\"1\"><numFmt numFmtId=\"164\" formatCode=\"yyyy\\-mm\\-dd\"/>\
                      </numFmts><cellXfs count=\"3\"><xf numFmtId=\"0\"/><xf numFmtId=\"14\"/>\
                      <xf numFmtId=\"164\"/></cellXfs></styleSheet>";
        let data = package(
            &sheet_data(
                "<row r=\"1\"><c r=\"A1\" s=\"1\"><v>45000.5</v></c>\
                 <c r=\"B1\" s=\"2\"><v>45000.5</v></c><c r=\"C1\" s=\"2\"><v>0.25</v></c>\
                 <c r=\"D1\" s=\"2\"><v>58.999</v></c><c r=\"E1\" s=\"1\"><v>45000</v></c></row>",
            ),
            None,
            Some(styles),
        );
        let sheets = read_sheets(&data).expect("package reads");
        assert_eq!(
            sheets[0].rows[0]
                .cells
                .iter()
                .map(|cell| cell.value.to_json())
                .collect::<Vec<_>>(),
            vec![
                "\"2023-03-15T12:00:00\"",
                "\"2023-03-15T12:00:00\"",
                "\"06:00:00\"",
                "\"1900-02-27T23:58:33.600000\"",
                "\"2023-03-15T00:00:00\"",
            ]
        );
    }

    #[test]
    fn formula_cells_merge_their_cached_result() {
        let data = package(
            &sheet_data(
                "<row r=\"1\"><c r=\"A1\"><v>1</v></c><c r=\"B1\"><v>2</v></c></row>\
                 <row r=\"2\"><c r=\"A2\"><f>SUM(A1:B1)</f><v>3</v></c>\
                 <c r=\"B2\" t=\"str\"><f>CONCATENATE(\"a\",\"b\")</f><v>ab</v></c>\
                 <c r=\"C2\"><f>1+2</f></c></row>",
            ),
            None,
            None,
        );
        let sheets = read_sheets(&data).expect("package reads");
        assert_eq!(
            serialize_sheet_compact(&sheets[0]),
            "--- Sheet: Sheet1 ---\n\
             R1: 1 | 2\n\
             R2: {\"formula\":\"=SUM(A1:B1)\",\"value\":3} | \
             {\"formula\":\"=CONCATENATE(\\\"a\\\",\\\"b\\\")\",\"value\":\"ab\"} | \"=1+2\""
        );
    }

    #[test]
    fn a_package_without_a_worksheet_is_a_parse_failure() {
        let missing = super::super::zip::stored_archive(&[("xl/workbook.xml", b"<workbook/>")]);
        assert!(read_sheets(&missing).is_err());
    }
}
