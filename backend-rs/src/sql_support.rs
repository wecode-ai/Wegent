// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared statement-argument and SQL-literal helpers for the task store.
//!
//! Extracted from `task_store` to keep that file within the repository's
//! module-size bound while the search read surface was added.

use brz_mysql::{MysqlResult, MysqlValue, MysqlValueWriter};

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

    fn encoded_size_hint(&self) -> usize {
        match self {
            Self::Int(value) => value.encoded_size_hint(),
            Self::Str(value) => value.encoded_size_hint(),
            Self::DateTime(value) => value.encoded_size_hint(),
        }
    }
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
