//! One streaming formatter for Backend projections and complete memory evidence.
use super::{
    ExcelRow, ExcelValue, OfficeError, ZipArchive, python_float_repr, read_sheets_with_value_limit,
};
use std::fmt::{self, Write};

pub(super) fn write_value(out: &mut impl Write, value: &ExcelValue) -> fmt::Result {
    match value {
        ExcelValue::Text(value) => write_quoted(out, value),
        ExcelValue::Integer(value) => out.write_str(value),
        ExcelValue::Float(value) => out.write_str(&python_float_repr(*value)),
        ExcelValue::Bool(value) => write!(out, "{value}"),
        ExcelValue::Object(fields) => {
            out.write_char('{')?;
            for (index, (key, value)) in fields.iter().enumerate() {
                if index > 0 {
                    out.write_char(',')?;
                }
                write_quoted(out, key)?;
                out.write_char(':')?;
                write_value(out, value)?;
            }
            out.write_char('}')
        }
    }
}

fn write_quoted(out: &mut impl Write, value: &str) -> fmt::Result {
    out.write_char('"')?;
    for ch in value.chars() {
        match ch {
            '"' => out.write_str("\\\"")?,
            '\\' => out.write_str("\\\\")?,
            '\n' => out.write_str("\\n")?,
            '\r' => out.write_str("\\r")?,
            '\t' => out.write_str("\\t")?,
            '\u{8}' => out.write_str("\\b")?,
            '\u{c}' => out.write_str("\\f")?,
            ch if (ch as u32) < 0x20 => write!(out, "\\u{:04x}", ch as u32)?,
            ch => out.write_char(ch)?,
        }
    }
    out.write_char('"')
}

pub(super) fn write_row(out: &mut impl Write, row: &ExcelRow) -> fmt::Result {
    write!(out, "R{}: ", row.source_row)?;
    let mut expected = Some(1);
    for (index, cell) in row.cells.iter().enumerate() {
        if index > 0 {
            out.write_str(" | ")?;
        }
        if Some(cell.source_column) != expected {
            write!(out, "[{}]=", cell.source_column)?;
        }
        write_value(out, &cell.value)?;
        expected = cell.source_column.checked_add(1);
    }
    Ok(())
}

struct BoundedText {
    text: String,
    remaining: usize,
    control: crate::ParseControl,
}

impl Write for BoundedText {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        self.control.check().map_err(|_| fmt::Error)?;
        self.remaining = self.remaining.checked_sub(text.len()).ok_or(fmt::Error)?;
        self.text.push_str(text);
        Ok(())
    }
}

/// Complete worksheet names, row/column coordinates, formulas and cached values.
/// Any limit or cancellation error discards the output, never returns a prefix.
pub fn read_text_with_limits(
    archive: &ZipArchive<'_>,
    value_limit: usize,
    text_limit: usize,
) -> Result<String, OfficeError> {
    let sheets = read_sheets_with_value_limit(archive, value_limit)?;
    let mut out = BoundedText {
        text: String::new(),
        remaining: text_limit,
        control: archive.control(),
    };
    for (index, sheet) in sheets.iter().enumerate() {
        if index > 0 {
            out.write_char('\n').map_err(|_| OfficeError)?;
        }
        writeln!(out, "--- Sheet: {} ---", sheet.name).map_err(|_| OfficeError)?;
        for (index, row) in sheet.rows.iter().enumerate() {
            if index > 0 {
                out.write_char('\n').map_err(|_| OfficeError)?;
            }
            write_row(&mut out, row).map_err(|_| OfficeError)?;
        }
    }
    Ok(out.text)
}
