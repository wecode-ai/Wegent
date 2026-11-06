// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared SQL helpers: statement arguments, single-quoted literals, and the
//! text-to-count conversion for `sum()` DECIMAL columns.
//!
//! Extracted from `task_store` to keep that file within the repository's
//! module-size bound while the search read surface was added.

use brz_mysql::{
    FromMysqlCol, MysqlError, MysqlResult, MysqlRouteValue, MysqlRow, MysqlValue, MysqlValueWriter,
};

/// One owned statement parameter for the statements whose argument list is
/// built at run time: integer ids, text references, and keyset datetimes.
#[derive(Debug, Clone)]
pub enum StatementArg {
    Int(i64),
    Str(String),
    DateTime(chrono::NaiveDateTime),
}

impl MysqlValue for StatementArg {
    fn write(self, writer: &mut MysqlValueWriter) -> MysqlResult<()> {
        match self {
            Self::Int(value) => value.write(writer),
            Self::Str(value) => value.write(writer),
            Self::DateTime(value) => value.write(writer),
        }
    }

    /// Preserve the wrapped value's implicit routing key so a pooled handle
    /// routes a `StatementArg`-bound statement exactly like the native value
    /// list it replaced.
    fn route_value(&self) -> MysqlRouteValue<'_> {
        match self {
            Self::Int(value) => value.route_value(),
            Self::Str(value) => value.route_value(),
            Self::DateTime(value) => value.route_value(),
        }
    }

    fn encoded_size_hint(&self) -> usize {
        match self {
            Self::Int(value) => value.encoded_size_hint(),
            Self::Str(value) => value.encoded_size_hint(),
            Self::DateTime(value) => value.encoded_size_hint(),
        }
    }
}

/// One SQL `sum()` DECIMAL aggregate converted like the source's
/// `int(Decimal)`.
///
/// The source reads the aggregate as `Decimal`; this driver renders the
/// `DECIMAL`/`NEWDECIMAL` column as text, and a strict integer decode of that
/// column is a type mismatch (`DECIMAL` is not compatible with `BIGINT`).
/// A fractional form such as `7.0` truncates toward zero, and malformed text
/// stays a decode error instead of a fabricated count.
///
/// Decode such a field as `Option<DecimalCount>`: the derive then reads it
/// with `MysqlRow::get`, so SQL NULL yields `None` (a `sum()` over no rows)
/// and only non-NULL values reach this adapter. [`DecimalCount::or_zero`]
/// applies the source's `or 0` to that `None`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct DecimalCount(pub(crate) i64);

impl DecimalCount {
    /// `int(value or 0)`: a NULL aggregate (`None`) counts as zero.
    pub(crate) fn or_zero(value: Option<Self>) -> i64 {
        value.map_or(0, |count| count.0)
    }
}

impl FromMysqlCol for DecimalCount {
    fn from_mysql_col(row: &MysqlRow, index: usize) -> MysqlResult<Self> {
        let text = <String as FromMysqlCol>::from_mysql_col(row, index)?;
        let column = row.columns().nth(index).unwrap_or_default().to_string();
        parse_decimal_count(&text)
            .map(Self)
            .ok_or(MysqlError::Decode {
                column,
                expected: "a decimal count",
            })
    }
}

/// Python `int(Decimal(text))`: an integral text parses directly, otherwise
/// the fraction must be all digits, is dropped, and the integral part is
/// parsed (truncation toward zero). `None` means the text is not a decimal
/// count; a malformed fraction such as `7.abc` must not become 7.
fn parse_decimal_count(text: &str) -> Option<i64> {
    let text = text.trim();
    if let Ok(value) = text.parse::<i64>() {
        return Some(value);
    }
    let (integral, fraction) = text.split_once('.')?;
    if fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    integral.parse::<i64>().ok()
}

/// Escape one value into a single-quoted SQL literal, the way the source's
/// driver renders the values it inlines rather than binds.
pub(crate) fn quote_sql_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for character in value.chars() {
        match character {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\0' => out.push_str("\\0"),
            // ASCII control characters use the driver's escaped form; every
            // UTF-8 name stays byte-identical.
            other => out.push(other),
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::{DecimalCount, parse_decimal_count};

    #[test]
    fn decimal_count_truncates_a_replayed_fraction() {
        // A live DECIMAL `sum()` renders `1`, but a replayed response can carry
        // the fractional form `1.0`; `int(Decimal)` truncates both to 1.
        assert_eq!(parse_decimal_count("1"), Some(1));
        assert_eq!(parse_decimal_count("1.0"), Some(1));
        assert_eq!(parse_decimal_count("0.0"), Some(0));
        assert_eq!(parse_decimal_count(" 2 "), Some(2));
        assert_eq!(parse_decimal_count("-3.9"), Some(-3));
        // The recorded prompt-stat columns (`searchable_count` /
        // `spreadsheet_count`) carry exactly these DECIMAL texts.
        assert_eq!(parse_decimal_count("7.0"), Some(7));
        assert_eq!(parse_decimal_count("3.0"), Some(3));
        // Malformed text is a decode failure, not a fabricated zero.
        assert_eq!(parse_decimal_count(""), None);
        assert_eq!(parse_decimal_count("abc"), None);
        assert_eq!(parse_decimal_count("7.abc"), None);
    }

    /// A `sum()` over no rows is SQL NULL: the derive reads an
    /// `Option<DecimalCount>` field with `row.get`, which yields `None`, and
    /// the source's `or 0` turns that into zero. A non-NULL DECIMAL keeps the
    /// exact integer from the adapter.
    #[test]
    fn a_null_aggregate_counts_as_zero() {
        assert_eq!(DecimalCount::or_zero(None), 0);
        assert_eq!(DecimalCount::or_zero(Some(DecimalCount(7))), 7);
    }
}
