// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Public kind resource reader.
//!
//! The open-source reader is backed by the `kinds` table. Internal deployments
//! may wrap the public repository at their application boundary, but this
//! module does not know about deployment-specific cache keys or table layouts.

use brz_mysql::{FromMysqlRow, Mysql};
use serde_json::Value;

use super::error::ApiError;

/// One active `kinds` row.
#[derive(Debug, Clone, FromMysqlRow)]
pub(crate) struct KindRecord {
    #[mysql(rename = "kinds_id")]
    pub(crate) id: i64,
    #[mysql(rename = "kinds_user_id")]
    pub(crate) user_id: i64,
    #[mysql(rename = "kinds_kind")]
    pub(crate) kind: String,
    #[mysql(rename = "kinds_name")]
    pub(crate) name: String,
    #[mysql(rename = "kinds_namespace")]
    pub(crate) namespace: String,
    #[mysql(rename = "kinds_json")]
    pub(crate) json: brz_mysql::Json<Value>,
    #[mysql(rename = "kinds_is_active")]
    pub(crate) is_active: i8,
    #[mysql(rename = "kinds_created_at")]
    pub(crate) created_at: chrono::NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    pub(crate) updated_at: chrono::NaiveDateTime,
}

/// Kinds access through the public SQL reader. The second type parameter is
/// retained for source compatibility with callers that also own a Redis
/// client; it is deliberately not read by the public implementation.
pub(crate) struct KindStore<'a, M: Mysql, R = ()> {
    pub(crate) mysql: &'a M,
    // Migrated from the Python source; not yet wired into the gateway.
    #[allow(dead_code)]
    pub(crate) redis: Option<&'a R>,
}

fn public_fallback_kind(kind: &str) -> bool {
    matches!(
        kind,
        "Model" | "Shell" | "Skill" | "Ghost" | "Retriever" | "Bot"
    )
}

impl<'a, M: Mysql, R> KindStore<'a, M, R> {
    /// Read a public resource (`user_id = 0`) in the requested namespace.
    pub(crate) async fn get_public(
        &self,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRecord>, ApiError> {
        self.fetch_where(
            "kinds.user_id = ? AND kinds.kind = ? AND kinds.namespace = ? \
             AND kinds.name = ? AND kinds.is_active = true",
            (0_i64, kind, namespace, name),
        )
        .await
    }

    /// Read a user-owned resource in the requested namespace.
    #[allow(dead_code)]
    pub(crate) async fn get_personal(
        &self,
        user_id: i64,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRecord>, ApiError> {
        self.fetch_where(
            "kinds.user_id = ? AND kinds.kind = ? AND kinds.namespace = ? \
             AND kinds.name = ? AND kinds.is_active = true",
            (user_id, kind, namespace, name),
        )
        .await
    }

    /// Read a namespace-scoped resource. The public reader has no special
    /// cache or physical shard branch for group namespaces.
    pub(crate) async fn get_group(
        &self,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRecord>, ApiError> {
        self.fetch_where(
            "kinds.kind = ? AND kinds.namespace = ? AND kinds.name = ? \
             AND kinds.is_active = true",
            (kind, namespace, name),
        )
        .await
    }

    /// Apply the public reader's personal-then-public fallback policy.
    pub(crate) async fn get_by_name_and_namespace(
        &self,
        user_id: i64,
        kind: &str,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRecord>, ApiError> {
        if namespace != "default" {
            return self.get_group(kind, namespace, name).await;
        }
        if user_id != 0
            && let Some(personal) = self.get_personal(user_id, kind, namespace, name).await?
        {
            return Ok(Some(personal));
        }
        if public_fallback_kind(kind) {
            return self.get_public(kind, namespace, name).await;
        }
        Ok(None)
    }

    /// Resolve a Team directly by owner, used when a CRD carries an owner id.
    pub(crate) async fn get_team_by_owner(
        &self,
        owner_user_id: i64,
        namespace: &str,
        name: &str,
    ) -> Result<Option<KindRecord>, ApiError> {
        self.fetch_where(
            "kinds.user_id = ? AND kinds.kind = 'Team' AND kinds.namespace = ? \
             AND kinds.name = ? AND kinds.is_active = true",
            (owner_user_id, namespace, name),
        )
        .await
    }

    /// Read active resources by id. The database determines the returned order
    /// just as the public Python reader does.
    pub(crate) async fn get_by_ids(
        &self,
        kind: &str,
        resource_ids: &[i64],
    ) -> Result<Vec<KindRecord>, ApiError> {
        if resource_ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; resource_ids.len()].join(", ");
        let rows: Vec<KindRecord> = self
            .mysql
            .fetch_all(
                &format!(
                    "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
                     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
                     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
                     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
                     kinds.updated_at AS kinds_updated_at \
                     FROM kinds WHERE kinds.id IN ({placeholders}) \
                     AND kinds.kind = '{escaped_kind}' AND kinds.is_active = true",
                    escaped_kind = escape_sql_string(kind)
                ),
                resource_ids.to_vec(),
            )
            .await
            .map_err(|error| {
                tracing::warn!(%error, "public kinds by-id query failed");
                ApiError::internal("kind query failed")
            })?;
        Ok(rows)
    }

    /// Read one active resource by id. This convenience method keeps the
    /// public reader compatible with call sites that previously used the
    /// cache-backed repository's single-id lookup.
    pub(crate) async fn get_by_id(
        &self,
        kind: &str,
        resource_id: i64,
    ) -> Result<Option<KindRecord>, ApiError> {
        Ok(self
            .get_by_ids(kind, &[resource_id])
            .await?
            .into_iter()
            .next())
    }

    async fn fetch_where(
        &self,
        predicate: &str,
        arguments: impl brz_mysql::MysqlArgs,
    ) -> Result<Option<KindRecord>, ApiError> {
        self.mysql
            .fetch_optional(
                &format!(
                    "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
                     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
                     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
                     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
                     kinds.updated_at AS kinds_updated_at \
                     FROM kinds WHERE {predicate} LIMIT 1"
                ),
                arguments,
            )
            .await
            .map_err(|error| {
                tracing::warn!(%error, "public kinds query failed");
                ApiError::internal("kind query failed")
            })
    }
}

fn escape_sql_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

/// Render a JSON string with Python's `json.dumps(ensure_ascii=True)` escape
/// behavior. Shared response serializers use this helper for opaque values.
// Migrated from the Python source; not yet wired into the gateway.
#[allow(dead_code)]
pub(crate) fn python_json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            other if (other as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", other as u32));
            }
            other if (other as u32) < 0x7f => out.push(other),
            other => {
                let code = other as u32;
                if code <= 0xffff {
                    out.push_str(&format!("\\u{code:04x}"));
                } else {
                    let code = code - 0x1_0000;
                    out.push_str(&format!(
                        "\\u{:04x}\\u{:04x}",
                        0xd800 + (code >> 10),
                        0xdc00 + (code & 0x3ff)
                    ));
                }
            }
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_json_string_escapes_non_ascii() {
        assert_eq!(python_json_string("张三"), "\"\\u5f20\\u4e09\"");
        assert_eq!(python_json_string("a\"b\\c\n"), "\"a\\\"b\\\\c\\n\"");
        assert_eq!(python_json_string("\u{1f600}"), "\"\\ud83d\\ude00\"");
    }
}
