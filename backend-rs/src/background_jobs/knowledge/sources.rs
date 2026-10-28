// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Application adapters for persisted external document identities.

#[path = "sources/dingtalk.rs"]
pub(super) mod dingtalk;
#[path = "sources/wiki.rs"]
mod wiki;
#[path = "sources/xiaoxin.rs"]
pub(super) mod xiaoxin;

use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json};
use serde_json::{Map, Value};
use std::time::Duration;

use crate::AppState;

#[derive(Clone, Debug, FromMysqlRow)]
pub struct Identity {
    pub id: i64,
    pub kind_id: i64,
    pub user_id: i64,
    pub user_name: String,
    pub external_provider: String,
    pub external_resource_id: String,
    pub source_config: Json<Value>,
}

impl Identity {
    pub fn sync(&self) -> Value {
        self.source_config
            .0
            .pointer("/external/sync")
            .cloned()
            .unwrap_or(Value::Null)
    }
}

pub struct Content {
    pub name: String,
    pub extension: String,
    pub bytes: Vec<u8>,
    pub metadata: Map<String, Value>,
}

#[derive(Debug)]
pub struct SourceError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub unavailable: bool,
}
impl std::fmt::Display for SourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for SourceError {}
pub fn error(code: &'static str, message: &str, retryable: bool) -> anyhow::Error {
    SourceError {
        code,
        message: message.into(),
        retryable,
        unavailable: code == "external_source_missing" || code == "external_source_unavailable",
    }
    .into()
}

pub async fn identity(state: &AppState, id: i64) -> Result<Option<Identity>> {
    Ok(state.mysql.fetch_optional("SELECT d.id,d.kind_id,d.user_id,u.user_name,e.external_provider,e.external_resource_id,COALESCE(d.source_config,JSON_OBJECT()) AS source_config FROM knowledge_documents d JOIN knowledge_document_external_sources e ON e.document_id=d.id JOIN users u ON u.id=d.user_id AND u.is_active=true WHERE d.id=?",(id,)).await?)
}

pub async fn fetch(state: &AppState, identity: &Identity) -> Result<Content> {
    match identity.external_provider.as_str() {
        "wiki" => wiki::fetch(state, identity, false).await,
        "dingtalk" => dingtalk::fetch(state, identity).await,
        "xiaoxin" => xiaoxin::fetch(state, identity).await,
        _ => Err(error(
            "external_import_failed",
            "Unsupported external provider",
            true,
        )),
    }
}

pub async fn inspect(state: &AppState, identity: &Identity) -> Result<Value> {
    let content = match identity.external_provider.as_str() {
        "wiki" => wiki::fetch(state, identity, true).await?,
        "dingtalk" => return dingtalk::inspect(state, identity).await,
        _ => bail!("External provider has no scheduled synchronization adapter"),
    };
    Ok(Value::Object(content.metadata))
}

pub async fn bounded_body(
    mut response: brz_http::reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(error(
            "external_response_too_large",
            "External response exceeds the document size limit",
            false,
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("External response read failed")?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(error(
                "external_response_too_large",
                "External response exceeds the document size limit",
                false,
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub fn http() -> Result<brz_http::Client> {
    Ok(brz_http::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(180))
        .configure(|builder| {
            let builder = builder.redirect(brz_http::reqwest::redirect::Policy::none());
            match crate::http_trust::trust_anchor() {
                Some(anchor) => builder.add_root_certificate(anchor),
                None => builder,
            }
        })
        .build()?)
}

pub fn max_bytes() -> usize {
    super::state::seconds("MAX_UPLOAD_FILE_SIZE_MB", 100) as usize * 1024 * 1024
}

pub fn string(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").into()
}
