// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `str(SQLAlchemy IntegrityError)` for a failed device write.
//!
//! Source: `_register_device` returns `str(exc)` for any registration failure,
//! and `upsert_device_crd`'s `db.commit()` raises SQLAlchemy's
//! `DBAPIError`-derived exception. SQLAlchemy renders
//! `"(%s.%s) %s" % (orig.__class__.__module__, orig.__class__.__name__, orig)`
//! followed by `[SQL: …]`, `[parameters: …]` and the `sqlalche.me` link
//! (`sqlalchemy/exc.py::DBAPIError.__init__` / `StatementError._sql_message`),
//! where `orig` is pymysql's exception whose `str()` is the `(errcode, "msg")`
//! tuple repr and whose class comes from `pymysql.err.error_map`.
//!
//! The statement text and parameter values are those of the failing operation:
//! SQLAlchemy's compiled statement uses named `%(name)s` placeholders and the
//! parameters are rendered with `repr()` (SQLAlchemy truncates a single value's
//! repr past 300 characters, `sqlalchemy/sql/util.py::_repr_base.trunc`).

/// The source deployment runs SQLAlchemy 2.0.x, whose `DBAPIError` sets
/// `exc._version_token = "".join(__version__.split(".")[0:2])` = `"20"`; each
/// exception class carries its own documentation code (`sqlalchemy/exc.py`).
///
/// The version segment is not a separate contract: `backend/pyproject.toml`
/// pins `sqlalchemy>=2.0.25` (the recording environment resolved 2.0.44), so
/// `/e/20/` is the only rendered form. No deployed SQLAlchemy 2.1 line exists,
/// and recording `20261105033227` ACKs the IntegrityError text with `/e/20/`.
/// The previous `/e/21/` default was an unverified guess.
fn documentation_link(class: &str) -> String {
    let code = match class {
        "IntegrityError" => "gkpj",
        "OperationalError" => "e3q8",
        "ProgrammingError" => "f405",
        "DataError" => "9h9h",
        "InternalError" => "2j85",
        "NotSupportedError" => "tw8g",
        _ => "gkpj",
    };
    format!("https://sqlalche.me/e/20/{code}")
}

/// One bound parameter, rendered with `repr()` by the parameters section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ParamValue {
    /// An integer, including a boolean bind processed to `1`/`0`.
    Int(i64),
    /// A text value.
    Text(String),
}

/// `str(pymysql.err.<class>)`: the `(code, "message")` tuple repr. Python
/// picks double quotes when the message contains `'` and no `"`.
fn pymysql_str(code: i64, message: &str) -> String {
    format!("({code}, {})", python_repr(message))
}

/// `repr()` for a Python `str`: single quotes unless the text contains `'`
/// and no `"`; backslashes and the chosen quote escaped.
fn python_repr(text: &str) -> String {
    let quote = if text.contains('\'') && !text.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::with_capacity(text.len() + 2);
    out.push(quote);
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 || ch as u32 == 0x7f => {
                out.push_str(&format!("\\x{:02x}", ch as u32));
            }
            ch if ch == quote => {
                out.push('\\');
                out.push(ch);
            }
            ch => out.push(ch),
        }
    }
    out.push(quote);
    out
}

/// `_repr_base.trunc`: a value's repr longer than 300 characters keeps 150
/// from each end around a truncated-length marker.
fn truncated_repr(text: &str) -> String {
    let rep = python_repr(text);
    let len = rep.chars().count();
    if len <= 300 {
        return rep;
    }
    let head: String = rep.chars().take(150).collect();
    let tail: String = rep.chars().skip(len - 150).collect();
    format!(
        "{head} ... ({}) ... {tail}",
        format_args!("{} characters truncated", len - 300)
    )
}

/// `_repr_params` for one single-row parameter dict.
fn params_repr(params: &[(&str, ParamValue)]) -> String {
    let items = params
        .iter()
        .map(|(name, value)| match value {
            ParamValue::Int(value) => format!("{}: {value}", python_repr(name)),
            ParamValue::Text(value) => format!("{}: {}", python_repr(name), truncated_repr(value)),
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("{{{items}}}")
}

/// The pymysql exception class for one MySQL error code (`pymysql.err.error_map`
/// with its `InternalError`/`OperationalError` fallback). The class comes from
/// the code alone: the synthesized reply's SQLSTATE is not evidence.
fn pymysql_class(code: i64) -> &'static str {
    const PROGRAMMING: [i64; 12] = [
        1007, 1064, 1102, 1103, 1110, 1111, 1112, 1113, 1146, 1149, 1166, 1179,
    ];
    const DATA: [i64; 9] = [1171, 1230, 1263, 1264, 1265, 1366, 1367, 1406, 1441];
    const INTEGRITY: [i64; 7] = [1048, 1062, 1215, 1216, 1217, 1451, 1452];
    const UNSUPPORTED: [i64; 4] = [1196, 1235, 1286, 1289];
    const OPERATIONAL: [i64; 7] = [1040, 1044, 1045, 1142, 1143, 1213, 4025];
    if PROGRAMMING.contains(&code) {
        "ProgrammingError"
    } else if DATA.contains(&code) {
        "DataError"
    } else if INTEGRITY.contains(&code) {
        "IntegrityError"
    } else if UNSUPPORTED.contains(&code) {
        "NotSupportedError"
    } else if OPERATIONAL.contains(&code) {
        "OperationalError"
    } else if code < 1000 {
        "InternalError"
    } else {
        "OperationalError"
    }
}

/// The source's `str(SQLAlchemy DBAPIError)` for one failed statement.
pub(crate) fn sqlalchemy_dbapi_error(
    code: i64,
    message: &str,
    statement: &str,
    params: &[(&str, ParamValue)],
) -> String {
    let class = pymysql_class(code);
    format!(
        "(pymysql.err.{}) {}\n[SQL: {statement}]\n[parameters: {}]\n(Background on this error at: {})",
        class,
        pymysql_str(code, message),
        params_repr(params),
        documentation_link(class),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESSAGE: &str = "Duplicate entry '3173-Device-local-device-default' for key 'kinds.uniq_user_kind_name_namespace'";
    const STATEMENT: &str = "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at) VALUES (%(user_id)s, %(kind)s, %(name)s, %(namespace)s, %(json)s, %(is_active)s, now(), now())";

    #[test]
    fn a_duplicate_entry_renders_the_sqlalchemy_shape() {
        let text = sqlalchemy_dbapi_error(
            1062,
            MESSAGE,
            STATEMENT,
            &[
                ("user_id", ParamValue::Int(3173)),
                ("kind", ParamValue::Text("Device".into())),
                ("name", ParamValue::Text("local-device".into())),
                ("namespace", ParamValue::Text("default".into())),
                ("json", ParamValue::Text("{\"a\": \"b\"}".into())),
                ("is_active", ParamValue::Int(1)),
            ],
        );
        let mut lines = text.lines();
        assert_eq!(
            lines.next(),
            Some(
                "(pymysql.err.IntegrityError) (1062, \"Duplicate entry '3173-Device-local-device-default' for key 'kinds.uniq_user_kind_name_namespace'\")"
            )
        );
        assert_eq!(lines.next(), Some(&*format!("[SQL: {STATEMENT}]")));
        assert_eq!(
            lines.next(),
            Some(
                "[parameters: {'user_id': 3173, 'kind': 'Device', 'name': 'local-device', 'namespace': 'default', 'json': '{\"a\": \"b\"}', 'is_active': 1}]"
            )
        );
        assert_eq!(
            lines.next(),
            Some("(Background on this error at: https://sqlalche.me/e/20/gkpj)")
        );
    }

    #[test]
    fn an_operational_error_uses_its_own_documentation_code() {
        // Oracle: `str(DBAPIError.instance(stmt, params, OperationalError(1205, msg)))`
        // from SQLAlchemy 2.0.44 + pymysql 1.4.6, with the `e/20` token.
        let text = sqlalchemy_dbapi_error(
            1205,
            "Lock wait timeout exceeded; try restarting transaction",
            STATEMENT,
            &[("id", ParamValue::Int(1))],
        );
        assert_eq!(
            text,
            "(pymysql.err.OperationalError) (1205, 'Lock wait timeout exceeded; try restarting transaction')\n[SQL: INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at) VALUES (%(user_id)s, %(kind)s, %(name)s, %(namespace)s, %(json)s, %(is_active)s, now(), now())]\n[parameters: {'id': 1}]\n(Background on this error at: https://sqlalche.me/e/20/e3q8)"
        );
    }

    #[test]
    fn escaping_matches_pythons_repr() {
        // Oracle: `repr("quote \" and ' and back\\\\slash and tab\there")`.
        assert_eq!(
            python_repr("quote \" and ' and back\\\\slash and tab\there"),
            r#"'quote " and \' and back\\\\slash and tab\there'"#
        );
        // NUL and other control characters use Python's `\xNN` form.
        assert_eq!(python_repr("a\0b"), "'a\\x00b'");
        // Unicode stays literal in Python 3's repr.
        assert_eq!(python_repr("重复 '值'"), "\"重复 '值'\"");
    }

    #[test]
    fn classification_uses_the_code_not_the_sqlstate() {
        assert_eq!(pymysql_class(1062), "IntegrityError");
        assert_eq!(pymysql_class(1452), "IntegrityError");
        assert_eq!(pymysql_class(1146), "ProgrammingError");
        assert_eq!(pymysql_class(1205), "OperationalError");
        assert_eq!(pymysql_class(1406), "DataError");
        assert_eq!(pymysql_class(1196), "NotSupportedError");
        assert_eq!(pymysql_class(500), "InternalError");
        assert_eq!(pymysql_class(9999), "OperationalError");
    }

    #[test]
    fn long_parameter_values_keep_the_truncation_marker() {
        let long = "x".repeat(700);
        let rendered = truncated_repr(&long);
        assert!(
            rendered.contains(" ... (402 characters truncated) ... "),
            "{rendered}"
        );
        assert!(rendered.starts_with('\''));
        assert!(rendered.ends_with('\''));
        // The marker sits between the first and last 150 characters of the
        // value's repr (the repr itself starts with the opening quote).
        assert_eq!(
            rendered.chars().take(150).collect::<String>(),
            format!("'{}", "x".repeat(149))
        );
    }

    #[test]
    fn non_database_errors_keep_their_own_text() {
        // The formatter only handles a database error with a code; anything
        // else stays the plain error string the caller already has.
        assert_eq!(python_repr("plain"), "'plain'");
        assert_eq!(python_repr("it's"), "\"it's\"");
        assert_eq!(python_repr("a\\b"), "'a\\\\b'");
    }
}
