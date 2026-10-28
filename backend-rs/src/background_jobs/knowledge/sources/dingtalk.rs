// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! DingTalk snapshots are read through each owner's configured MCP sessions.

use super::{Content, Identity, error, string};
use crate::AppState;
use anyhow::{Context, Result, bail};
use base64::Engine;
use brz_mysql::FromMysqlRow;
use serde_json::{Value, json};
use std::time::Duration;

pub async fn inspect(state: &AppState, identity: &Identity) -> Result<Value> {
    let url = service_url(state, identity.user_id, "docs").await?;
    let mut session = Session::open(&url).await?;
    let result = session
        .call(
            "get_document_info",
            json!({"nodeId":identity.external_resource_id}),
        )
        .await;
    session.close().await;
    result.map(|info| metadata(identity, &info))
}

pub async fn fetch(state: &AppState, identity: &Identity) -> Result<Content> {
    #[derive(FromMysqlRow)]
    struct Node {
        node_type: String,
        content_type: String,
        extension: String,
    }
    let node:Node=state.mysql.fetch_optional("SELECT node_type,content_type,extension FROM dingtalk_synced_nodes WHERE user_id=? AND dingtalk_node_id=? AND is_active=true",(identity.user_id,identity.external_resource_id.as_str())).await?.context("DingTalk document not found in the owner's synced nodes")?;
    if import_extension(&json!({"nodeType":node.node_type,"contentType":node.content_type,"extension":node.extension})).is_none(){bail!("This DingTalk file type cannot be imported")}
    let url = service_url(state, identity.user_id, "docs").await?;
    let mut session = Session::open(&url).await?;
    let result = tokio::time::timeout(
        Duration::from_secs(180),
        fetch_in_session(state, identity, &mut session),
    )
    .await;
    session.close().await;
    result.map_err(|_| error("external_import_failed", "DingTalk import timed out", true))?
}

async fn fetch_in_session(
    state: &AppState,
    identity: &Identity,
    session: &mut Session,
) -> Result<Content> {
    let info = session
        .call(
            "get_document_info",
            json!({"nodeId":identity.external_resource_id}),
        )
        .await?;
    let extension =
        import_extension(&info).context("This DingTalk file type cannot be imported")?;
    let original = string(&info, "extension").trim().to_ascii_lowercase();
    let alidoc = string(&info, "contentType")
        .trim()
        .eq_ignore_ascii_case("ALIDOC");
    let bytes = if alidoc && original == "adoc" {
        let body = session
            .call(
                "get_document_content",
                json!({"nodeId":identity.external_resource_id,"format":"markdown"}),
            )
            .await?;
        string(&body, "markdown").into_bytes()
    } else if alidoc && (original == "axls" || original == "able") {
        let service = if original == "axls" {
            "table"
        } else {
            "ai_table"
        };
        let url = service_url(state, identity.user_id, service).await?;
        let mut export = Session::open(&url).await?;
        let result = export_sheet(
            &mut export,
            &identity.external_resource_id,
            original == "able",
        )
        .await;
        export.close().await;
        result?
    } else {
        let download = session
            .call(
                "download_file",
                json!({"nodeId":identity.external_resource_id}),
            )
            .await?;
        let url = download
            .get("resourceUrl")
            .and_then(|url| url.as_array().and_then(|urls| urls.first()).or(Some(url)))
            .and_then(Value::as_str)
            .context("DingTalk returned no download URL")?;
        download_content(url, download.get("headers")).await?
    };
    if bytes.is_empty() {
        return Err(error(
            "external_import_failed",
            "DingTalk document content is empty or unreadable",
            true,
        ));
    }
    let metadata = metadata(identity, &info);
    let name = metadata["title"]
        .as_str()
        .unwrap_or(&identity.external_resource_id)
        .to_owned();
    Ok(Content {
        name,
        extension,
        bytes,
        metadata: metadata.as_object().cloned().unwrap_or_default(),
    })
}

async fn export_sheet(session: &mut Session, node: &str, ai_table: bool) -> Result<Vec<u8>> {
    if ai_table {
        let mut arguments = json!({"baseId":node,"scope":"all","format":"excel","timeoutMs":30000});
        for _ in 0..6 {
            let result = session.call("export_data", arguments.clone()).await?;
            let data = result
                .get("data")
                .filter(|data| data.is_object())
                .context("DingTalk export returned invalid data")?;
            if let Some(id) = arguments.get("taskId")
                && data.get("taskId") != Some(id)
            {
                bail!("DingTalk export task identity changed")
            }
            if data["status"] == "success" {
                if !string(data, "fileName").to_lowercase().ends_with(".xlsx") {
                    bail!("DingTalk export did not return an XLSX workbook")
                }
                if let Some(url) = data["downloadUrl"].as_str().filter(|url| !url.is_empty()) {
                    return download_content(url, None).await;
                }
            }
            let task = string(data, "taskId");
            if !["pending", "success"].contains(&data["status"].as_str().unwrap_or(""))
                || task.trim().is_empty()
            {
                bail!("DingTalk AI Table export failed")
            }
            arguments = json!({"baseId":node,"taskId":task,"timeoutMs":30000});
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        bail!("DingTalk AI Table export timed out")
    }
    let submitted = session
        .call(
            "submit_export_job",
            json!({"nodeId":node,"exportFormat":"xlsx"}),
        )
        .await?;
    let job = string(&submitted, "jobId");
    if job.trim().is_empty() {
        bail!("DingTalk sheet export returned no job ID")
    }
    loop {
        let result = session
            .call("query_export_job", json!({"jobId":job}))
            .await?;
        if result["jobId"] != job {
            bail!("DingTalk sheet export job identity changed")
        }
        if ["failed", "error"].contains(&result["status"].as_str().unwrap_or("")) {
            bail!("DingTalk sheet export failed")
        }
        if result["status"] == "success"
            && let Some(url) = result["downloadUrl"].as_str().filter(|url| !url.is_empty())
        {
            return download_content(url, None).await;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn metadata(identity: &Identity, info: &Value) -> Value {
    let update = info
        .get("updateTime")
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str()?.trim().parse().ok())
        })
        .filter(|value| *value > 0);
    let title = info
        .get("name")
        .or_else(|| info.get("title"))
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or(&identity.external_resource_id);
    json!({"provider":"dingtalk","resource_id":identity.external_resource_id,"title":title,"source_update_time":update})
}

fn import_extension(info: &Value) -> Option<String> {
    let kind = string(info, "nodeType").trim().to_ascii_lowercase();
    let content = string(info, "contentType").trim().to_ascii_uppercase();
    let extension = string(info, "extension").trim().to_ascii_lowercase();
    if kind == "folder" {
        return None;
    }
    if content == "ALIDOC" {
        return match extension.as_str() {
            "adoc" => Some("md".into()),
            "able" | "axls" => Some("xlsx".into()),
            _ => None,
        };
    }
    (kind == "file"
        && !content.is_empty()
        && ["pdf", "docx", "pptx", "xlsx", "csv", "txt", "md"].contains(&extension.as_str()))
    .then_some(extension)
}

async fn service_url(state: &AppState, user_id: i64, service: &str) -> Result<String> {
    #[derive(FromMysqlRow)]
    struct User {
        preferences: String,
    }
    let user: User = state
        .mysql
        .fetch_one(
            "SELECT preferences FROM users WHERE id=? AND is_active=true",
            (user_id,),
        )
        .await?;
    let prefs: Value = serde_json::from_str(&user.preferences)?;
    let config = &prefs["mcps"]["dingtalk"]["services"][service];
    if config["enabled"] != true {
        bail!("DingTalk MCP service is not enabled")
    }
    let url = string(&config["credentials"], "url");
    let encrypted = base64::engine::general_purpose::STANDARD
        .decode(&url)
        .is_ok_and(|bytes| !bytes.is_empty() && bytes.len() % 16 == 0);
    let url = if encrypted {
        crate::mcp_providers::security::decrypt_provider_key(&url).map_err(|_| {
            error(
                "external_import_failed",
                "DingTalk MCP credential could not be decrypted",
                true,
            )
        })?
    } else {
        url
    };
    if url.trim().is_empty() {
        bail!("DingTalk MCP URL is not configured")
    }
    Ok(url)
}

pub async fn download_content(url: &str, headers: Option<&Value>) -> Result<Vec<u8>> {
    crate::background_jobs::download::get_with_headers(url, super::max_bytes(), 0, headers)
        .await
        .map_err(|_| {
            error(
                "external_import_failed",
                "DingTalk file download failed or exceeded the upload size limit",
                true,
            )
        })
}

struct Session {
    http: brz_http::Client,
    url: String,
    session: Option<String>,
    protocol: String,
    next: i64,
}
impl Session {
    async fn open(url: &str) -> Result<Self> {
        let mut session = Self {
            http: super::http()?,
            url: url.into(),
            session: None,
            protocol: "2025-11-25".into(),
            next: 0,
        };
        let result=session.rpc("initialize",json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"mcp","version":"0.1.0"}})).await?;
        if let Some(protocol) = result["protocolVersion"].as_str() {
            session.protocol = protocol.into();
        }
        session
            .post(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .await?
            .bytes()
            .await?;
        Ok(session)
    }
    async fn post(&self, payload: Value) -> Result<brz_http::reqwest::Response> {
        let mut request = self
            .http
            .as_reqwest()
            .post(&self.url)
            .header("Accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", &self.protocol)
            .json(&payload);
        if let Some(session) = &self.session {
            request = request.header("mcp-session-id", session);
        }
        request.send().await.map_err(|_| {
            error(
                "external_import_failed",
                "DingTalk MCP transport failed",
                true,
            )
        })
    }
    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next;
        self.next += 1;
        let mut response = self
            .post(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        if !response.status().is_success() {
            bail!("DingTalk MCP request was rejected")
        }
        if let Some(session) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
        {
            self.session = Some(session.into());
        }
        let mut bytes = vec![];
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > super::max_bytes() {
                bail!("DingTalk MCP response exceeds document limit")
            }
            bytes.extend_from_slice(&chunk);
            if let Some(value) = rpc_result(&bytes, id) {
                return value;
            }
        }
        rpc_result(&bytes, id).context("DingTalk MCP response is incomplete")?
    }
    async fn call(&mut self, name: &str, arguments: Value) -> Result<Value> {
        let result = self
            .rpc("tools/call", json!({"name":name,"arguments":arguments}))
            .await?;
        if result["isError"] == true {
            bail!("DingTalk MCP tool returned an error")
        }
        let text = result["content"]
            .as_array()
            .context("DingTalk MCP tool response has no content")?
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let payload: Value =
            serde_json::from_str(&text).context("DingTalk MCP tool returned invalid JSON")?;
        if name == "get_document_info"
            && payload["success"] == false
            && [
                "invalidParameter.item.notFound",
                "invalidRequest.resource.notFound",
            ]
            .contains(&payload["errorCode"].as_str().unwrap_or(""))
        {
            return Err(error(
                "external_source_missing",
                "DingTalk source document no longer exists",
                true,
            ));
        }
        let success = if name == "export_data" {
            payload["status"] == "success"
        } else {
            payload["success"] == true
        };
        if !success {
            bail!("DingTalk MCP returned an unsuccessful response for {name}")
        }
        Ok(payload)
    }
    async fn close(self) {
        if let Some(session) = self.session {
            let _ = self
                .http
                .as_reqwest()
                .delete(&self.url)
                .header("mcp-session-id", session)
                .header("mcp-protocol-version", self.protocol)
                .send()
                .await;
        }
    }
}

fn rpc_result(bytes: &[u8], id: i64) -> Option<Result<Value>> {
    let decode = |payload: Value| {
        if payload.get("id") != Some(&json!(id)) {
            return None;
        }
        Some(
            payload
                .get("result")
                .cloned()
                .context("DingTalk MCP returned a protocol error"),
        )
    };
    if let Ok(payload) = serde_json::from_slice(bytes) {
        return decode(payload);
    }
    let text = std::str::from_utf8(bytes).ok()?;
    for line in text.lines() {
        if let Some(data) = line.strip_prefix("data:")
            && let Ok(payload) = serde_json::from_str::<Value>(data.trim())
            && let Some(result) = decode(payload)
        {
            return Some(result);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_is_required_for_format_selection() {
        assert_eq!(
            import_extension(&json!({"nodeType":"doc","contentType":"ALIDOC","extension":"axls"})),
            Some("xlsx".into())
        );
        assert_eq!(
            import_extension(
                &json!({"nodeType":"folder","contentType":"ALIDOC","extension":"adoc"})
            ),
            None
        );
    }
    #[test]
    fn stream_responses_are_bound_to_the_request_id() {
        assert!(rpc_result(b"data: {\"id\":9,\"result\":{}}\n\n", 8).is_none());
        assert!(
            rpc_result(b"data: {\"id\":8,\"result\":{\"ok\":true}}\n\n", 8)
                .unwrap()
                .unwrap()["ok"]
                == true
        );
    }
}
