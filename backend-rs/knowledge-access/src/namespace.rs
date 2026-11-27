// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Active namespace classification for knowledge access and download policies.

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use wegent_access::namespace_projection::NAMESPACE_COLUMNS;

/// `load_active_namespace_map` for one name (`namespace.in_(names)` with
/// `is_active IS true`), then `classify_namespace_level`.
async fn active_namespace_by_name<M>(mysql: &M, name: &str) -> MysqlResult<Option<NamespaceRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(&namespace_names_sql(&[name.to_string()]), ())
        .await
}

fn namespace_names_sql(names: &[String]) -> String {
    let quoted = names
        .iter()
        .map(|name| quote_literal(name))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT {NAMESPACE_COLUMNS} \nFROM namespace \n\
         WHERE namespace.name IN ({quoted}) AND namespace.is_active IS true"
    )
}

/// MySQL default string-literal escaping (mirrors the source's rendered
/// COM_QUERY text).
pub fn quote_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for byte in value.bytes() {
        match byte {
            b'\'' => out.push_str("\\'"),
            b'\\' => out.push_str("\\\\"),
            b'\0' => out.push_str("\\0"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            0x1a => out.push_str("\\Z"),
            other => out.push(other as char),
        }
    }
    out.push('\'');
    out
}

#[derive(Debug, FromMysqlRow)]
pub struct NamespaceRow {
    pub namespace_id: i64,
    pub namespace_level: String,
}

/// `is_organization_namespace`: the active namespace's level is
/// `organization`. The personal namespace (`default`) never queries: the
/// source's `load_active_namespace_map` filters it out and
/// `classify_namespace_level` returns `personal`.
///
/// Re-exported at the crate root: the deployment document-download policy
/// (the source document-protection policy) makes the same
/// decision through the shared `load_active_namespace_map` lookup.
pub async fn is_organization_namespace<M>(mysql: &M, name: &str) -> MysqlResult<bool>
where
    M: Mysql,
{
    if name == "default" {
        return Ok(false);
    }
    Ok(active_namespace_by_name(mysql, name)
        .await?
        .is_some_and(|row| row.namespace_level == "organization"))
}
