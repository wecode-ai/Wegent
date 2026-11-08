// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Shared OOXML formulas, following openpyxl's worksheet parser and Translator.

use std::{collections::HashMap, sync::LazyLock};

use regex::Regex;

use super::{OfficeError, xml::Element};

struct FormulaOrigin {
    formula: String,
    row: i64,
    column: i64,
}

pub(super) struct SharedFormulas {
    origins: HashMap<String, FormulaOrigin>,
    max_entries: usize,
}

impl SharedFormulas {
    pub(super) fn new(worksheet_bytes: usize) -> Self {
        Self {
            origins: HashMap::new(),
            // Every distinct origin requires its own nonempty XML element.
            max_entries: worksheet_bytes,
        }
    }

    pub(super) fn resolve(
        &mut self,
        element: &Element,
        row: u64,
        column: u64,
    ) -> Result<String, OfficeError> {
        let index = element.attr("si").unwrap_or_default();
        let row = i64::try_from(row).map_err(|_| OfficeError)?;
        let column = i64::try_from(column).map_err(|_| OfficeError)?;
        if let Some(origin) = self.origins.get(index) {
            return translate(&origin.formula, row - origin.row, column - origin.column);
        }
        let formula = format!("={}", element.direct_text());
        if formula != "=" {
            if self.origins.len() >= self.max_entries {
                return Err(OfficeError);
            }
            self.origins.insert(
                index.to_owned(),
                FormulaOrigin {
                    formula: formula.clone(),
                    row,
                    column,
                },
            );
        }
        Ok(formula)
    }
}

fn delimiter(character: char) -> bool {
    character.is_whitespace() || "+-*/^&=><%,;(){}\"".contains(character)
}

/// Translate RANGE operands while preserving quoted strings and function names.
fn translate(formula: &str, row_delta: i64, column_delta: i64) -> Result<String, OfficeError> {
    let mut output = String::with_capacity(formula.len());
    let mut position = 0;
    while position < formula.len() {
        let character = formula[position..].chars().next().ok_or(OfficeError)?;
        if character == '"' {
            let start = position;
            position += 1;
            while position < formula.len() {
                let next = formula[position..].chars().next().ok_or(OfficeError)?;
                position += next.len_utf8();
                if next == '"' {
                    if formula[position..].starts_with('"') {
                        position += 1;
                    } else {
                        break;
                    }
                }
            }
            output.push_str(&formula[start..position]);
        } else if delimiter(character) {
            output.push(character);
            position += character.len_utf8();
            if matches!(character, ' ' | '\n') {
                while formula[position..].starts_with([' ', '\n']) {
                    position += 1;
                }
            }
        } else {
            let start = position;
            let mut quoted_sheet = false;
            let mut brackets = 0usize;
            while position < formula.len() {
                let next = formula[position..].chars().next().ok_or(OfficeError)?;
                if !quoted_sheet && brackets == 0 && delimiter(next) {
                    break;
                }
                match next {
                    '\'' => quoted_sheet = !quoted_sheet,
                    '[' if !quoted_sheet => brackets += 1,
                    ']' if !quoted_sheet => brackets = brackets.saturating_sub(1),
                    _ => {}
                }
                position += next.len_utf8();
            }
            let operand = &formula[start..position];
            if formula[position..].starts_with('(') {
                output.push_str(operand);
            } else {
                output.push_str(&translate_range(operand, row_delta, column_delta)?);
            }
        }
    }
    Ok(output)
}

fn translate_range(value: &str, row_delta: i64, column_delta: i64) -> Result<String, OfficeError> {
    static ROWS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(\$?[1-9][0-9]{0,6}):(\$?[1-9][0-9]{0,6})$").unwrap());
    static COLUMNS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(\$?[A-Za-z]{1,3}):(\$?[A-Za-z]{1,3})$").unwrap());
    static CELL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(\$?[A-Za-z]{1,3})(\$?[1-9][0-9]{0,6})$").unwrap());
    let (sheet, value) = value.rsplit_once('!').unwrap_or(("", value));
    let prefix = if sheet.is_empty() {
        String::new()
    } else {
        format!("{sheet}!")
    };
    if let Some(parts) = ROWS.captures(value) {
        return Ok(format!(
            "{prefix}{}:{}",
            translate_row(&parts[1], row_delta)?,
            translate_row(&parts[2], row_delta)?
        ));
    }
    if let Some(parts) = COLUMNS.captures(value) {
        return Ok(format!(
            "{prefix}{}:{}",
            translate_column(&parts[1], column_delta)?,
            translate_column(&parts[2], column_delta)?
        ));
    }
    if value.contains(':') {
        let translated = value
            .split(':')
            .map(|part| translate_range(part, row_delta, column_delta))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(format!("{prefix}{}", translated.join(":")));
    }
    if let Some(parts) = CELL.captures(value) {
        return Ok(format!(
            "{prefix}{}{}",
            translate_column(&parts[1], column_delta)?,
            translate_row(&parts[2], row_delta)?
        ));
    }
    Ok(value.to_owned())
}

fn translate_row(row: &str, delta: i64) -> Result<String, OfficeError> {
    if row.starts_with('$') {
        return Ok(row.to_owned());
    }
    let translated = row
        .parse::<i64>()
        .map_err(|_| OfficeError)?
        .checked_add(delta)
        .ok_or(OfficeError)?;
    if translated <= 0 {
        return Err(OfficeError);
    }
    Ok(translated.to_string())
}

fn translate_column(column: &str, delta: i64) -> Result<String, OfficeError> {
    if column.starts_with('$') {
        return Ok(column.to_owned());
    }
    let mut number = 0_i64;
    for character in column.bytes() {
        number = number * 26 + i64::from(character.to_ascii_uppercase() - b'A' + 1);
    }
    number = number.checked_add(delta).ok_or(OfficeError)?;
    if !(1..=18_278).contains(&number) {
        return Err(OfficeError);
    }
    let mut result = Vec::with_capacity(3);
    while number > 0 {
        number -= 1;
        result.push(b'A' + (number % 26) as u8);
        number /= 26;
    }
    result.reverse();
    String::from_utf8(result).map_err(|_| OfficeError)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_relative_references_and_preserves_literals() {
        assert_eq!(translate("=C3/3782", 1, 0).unwrap(), "=C4/3782");
        assert_eq!(
            translate("=SUM(A1:B2,$C3,D$4,$E$5,'Sheet 1'!A1,\"A1\")", 2, 1).unwrap(),
            "=SUM(B3:C4,$C5,E$4,$E$5,'Sheet 1'!B3,\"A1\")"
        );
        assert_eq!(translate("=SUM(A:C,1:3)", 1, 1).unwrap(), "=SUM(B:D,2:4)");
        assert!(translate("=A1", -1, 0).is_err());
    }
}
