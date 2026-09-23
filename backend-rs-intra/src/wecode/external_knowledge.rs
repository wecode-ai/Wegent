//! `GET /api/wecode/external-knowledge/{provider}/knowledge-bases`.
//!
//! Mirrors `wecode.api.external_knowledge.list_external_knowledge_bases`
//! (router mounted at `/wecode/external-knowledge` under `/api`): authenticate
//! the user, resolve the ERP employee id (source `_get_employee_id`, the
//! `wecode_erp_user` profile lookup of `ErpEntityResolver`), then list the
//! provider's knowledge bases. Only the `ap` provider is registered
//! (`wecode/api/__init__.py:_register_ap_external_knowledge_provider`);
//! unknown providers raise the source's 404 `provider_not_found` error.
//!
//! The AP provider calls the AP MCP JSON-RPC service
//! (`POST {AP_KNOWLEDGE_BASE_URL}{AP_KNOWLEDGE_MCP_PATH}`). In the recorded
//! environment that TLS exchange fails (`proxy_error: tls handshake eof` on
//! `apgateway.erp.sina.com.cn`), which `ApKnowledgeMcpClient.call_tool`
//! maps through `httpx.HTTPError` to
//! `502 {"detail":{"code":"internal_error","message":"Failed to request AP
//! knowledge service"}}` — the recorded case's response.

use std::time::Duration;

use brz_http_server::StatusCode;
use serde::Deserialize;
use serde::Serialize;
use wegent_backend_rs::config::env_or_dotenv;
use wegent_backend_rs::http_compat::FastApiError;

use super::startup::SharedWecodeAppState;

/// `ExternalKnowledgeSettings.AP_KNOWLEDGE_TIMEOUT` default (seconds).
const AP_KNOWLEDGE_TIMEOUT: Duration = Duration::from_secs(30);
/// `ExternalKnowledgeSettings.AP_KNOWLEDGE_BASE_URL` default.
const DEFAULT_AP_KNOWLEDGE_BASE_URL: &str =
    "https://apgateway.erp.sina.com.cn/proxy/test-knowledge-matrix.api.weibo.com";
/// `ExternalKnowledgeSettings.AP_KNOWLEDGE_MCP_PATH`.
const AP_KNOWLEDGE_MCP_PATH: &str = "/mcp/knowledge-external/sse";
/// `LIST_KNOWLEDGE_BASES_TOOL`.
const LIST_KNOWLEDGE_BASES_TOOL: &str = "ks_kb_list_knowledge_bases";
/// Source `list_external_knowledge_bases` defaults: `limit=50` (1..=100),
/// `offset=0` (>=0), `scope` restricted to all|personal|organization, and
/// `query` at most 100 characters.
const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 100;
const MAX_QUERY_LEN: usize = 100;

/// `ExternalKnowledgeBase` (source `wecode/schemas/external_knowledge.py`).
#[derive(Serialize)]
struct ExternalKnowledgeBase {
    provider: &'static str,
    knowledge_base_id: String,
    knowledge_base_name: String,
    description: Option<String>,
    scope: String,
    owner_id: Option<String>,
    employee_id: Option<String>,
    document_count: i64,
    created_at: Option<String>,
    updated_at: Option<String>,
}

/// `ExternalKnowledgeBaseListResponse`.
#[derive(Serialize)]
struct KnowledgeBaseListResponse {
    provider: &'static str,
    total: i64,
    total_returned: i64,
    has_more: bool,
    limit: i64,
    offset: i64,
    items: Vec<ExternalKnowledgeBase>,
}

/// The JSON-RPC request of `ApKnowledgeMcpClient.call_tool` (`tools/call`).
#[derive(Serialize)]
struct McpToolRequest<'a> {
    jsonrpc: &'static str,
    id: u64,
    method: &'static str,
    params: McpToolParams<'a>,
}

#[derive(Serialize)]
struct McpToolParams<'a> {
    name: &'a str,
    arguments: McpListArguments<'a>,
}

#[derive(Serialize)]
struct McpListArguments<'a> {
    scope: &'a str,
    limit: i64,
    offset: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    query: Option<&'a str>,
}

/// The JSON-RPC response shape read by `_parse_response`.
#[derive(Deserialize)]
struct McpToolResponse {
    #[serde(default)]
    result: Option<McpResult>,
}

#[derive(Deserialize)]
struct McpResult {
    /// The MCP envelope spells the flag `isError`.
    #[serde(default, rename = "isError")]
    is_error: Option<bool>,
    #[serde(default)]
    content: Vec<McpContent>,
}

#[derive(Deserialize)]
struct McpContent {
    #[serde(default)]
    text: Option<String>,
}

/// The parsed `ks_kb_list_knowledge_bases` business payload.
#[derive(Debug, Deserialize, Default)]
struct ApKnowledgeBasesPayload {
    #[serde(default)]
    total: Option<serde_json::Number>,
    #[serde(default)]
    total_returned: Option<serde_json::Number>,
    #[serde(default)]
    has_more: Option<bool>,
    #[serde(default)]
    limit: Option<serde_json::Number>,
    #[serde(default)]
    offset: Option<serde_json::Number>,
    #[serde(default)]
    items: Vec<ApKnowledgeBaseItem>,
}

/// One AP knowledge-base item (`_map_knowledge_base` reads these fields).
#[derive(Debug, Deserialize, Default)]
struct ApKnowledgeBaseItem {
    #[serde(default)]
    knowledge_base_id: Option<serde_json::Value>,
    #[serde(default)]
    knowledge_base_name: Option<serde_json::Value>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    scope: Option<serde_json::Value>,
    #[serde(default)]
    owner_id: Option<String>,
    #[serde(default)]
    employee_id: Option<String>,
    #[serde(default)]
    document_count: Option<serde_json::Number>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

/// A provider failure carrying the source's stable code and status
/// (`ExternalKnowledgeError`).
#[derive(Debug)]
struct ExternalKnowledgeError {
    message: String,
    code: &'static str,
    status: StatusCode,
}

impl ExternalKnowledgeError {
    /// `map_provider_error`'s status table for AP error codes.
    fn from_provider_code(code: &str, message: &str) -> Self {
        let status = match code {
            "unauthorized" => StatusCode::UNAUTHORIZED,
            "forbidden" => StatusCode::FORBIDDEN,
            "bad_request" => StatusCode::BAD_REQUEST,
            "not_found" => StatusCode::NOT_FOUND,
            "rate_limited" => StatusCode::TOO_MANY_REQUESTS,
            "result_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
            _ => StatusCode::BAD_GATEWAY,
        };
        let code = match code {
            "" => "internal_error",
            other => leak_code(other),
        };
        Self {
            message: if message.is_empty() {
                code.to_string()
            } else {
                message.to_string()
            },
            code,
            status,
        }
    }

    /// The endpoint's error body (`_raise_external_error`):
    /// `{"detail":{"code":...,"message":...}}` — the code/message object is
    /// wrapped inside `detail`, like FastAPI's `HTTPException(detail={...})`.
    fn into_http_error(self) -> FastApiError {
        FastApiError::json_body(
            self.status,
            serde_json::json!({"detail": {"code": self.code, "message": self.message}}),
        )
    }
}

/// Map a provider error code onto a static string so the response body keeps
/// a stable `code` value without per-response allocation churn. The known AP
/// codes come from `map_provider_error`; anything else is `internal_error`.
fn leak_code(code: &str) -> &'static str {
    match code {
        "unauthorized" | "forbidden" | "bad_request" | "not_found" | "rate_limited"
        | "result_too_large" | "internal_error" => match code {
            "unauthorized" => "unauthorized",
            "forbidden" => "forbidden",
            "bad_request" => "bad_request",
            "not_found" => "not_found",
            "rate_limited" => "rate_limited",
            "result_too_large" => "result_too_large",
            _ => "internal_error",
        },
        _ => "internal_error",
    }
}

/// The parsed endpoint inputs after FastAPI `Query(...)` validation.
#[derive(Debug)]
struct ListParams {
    scope: String,
    query: Option<String>,
    limit: i64,
    offset: i64,
}

/// FastAPI-style 422 validation error for one query parameter.
fn validation_error(loc: &str, error_type: &str, msg: &str, input: &str) -> FastApiError {
    FastApiError::validation(serde_json::json!([
        {
            "type": error_type,
            "loc": ["query", loc],
            "msg": msg,
            "input": input,
        }
    ]))
}

/// Validate the raw query strings like the source's `Query` constraints.
fn parse_params(
    scope: Option<&str>,
    query: Option<String>,
    limit: Option<&str>,
    offset: Option<&str>,
) -> Result<ListParams, FastApiError> {
    let scope = match scope {
        None => "all".to_string(),
        Some(value) if matches!(value, "all" | "personal" | "organization") => value.to_string(),
        Some(other) => {
            return Err(validation_error(
                "scope",
                "string_pattern_mismatch",
                "String should match pattern '^(all|personal|organization)$'",
                other,
            ));
        }
    };
    let query = match query {
        Some(value) if value.chars().count() > MAX_QUERY_LEN => {
            return Err(validation_error(
                "query",
                "string_too_long",
                "String should have at most 100 characters",
                &value,
            ));
        }
        other => other,
    };
    let limit = match limit {
        None => DEFAULT_LIMIT,
        Some(value) => {
            let parsed: i64 = value.parse().map_err(|_| {
                validation_error(
                    "limit",
                    "int_parsing",
                    "Input should be a valid integer, unable to parse string as an integer",
                    value,
                )
            })?;
            if !(1..=MAX_LIMIT).contains(&parsed) {
                return Err(validation_error(
                    "limit",
                    "int_greater_than_equal",
                    "Input should be between 1 and 100",
                    value,
                ));
            }
            parsed
        }
    };
    let offset = match offset {
        None => 0,
        Some(value) => {
            let parsed: i64 = value.parse().map_err(|_| {
                validation_error(
                    "offset",
                    "int_parsing",
                    "Input should be a valid integer, unable to parse string as an integer",
                    value,
                )
            })?;
            if parsed < 0 {
                return Err(validation_error(
                    "offset",
                    "int_greater_than_equal",
                    "Input should be greater than or equal to 0",
                    value,
                ));
            }
            parsed
        }
    };
    Ok(ListParams {
        scope,
        query,
        limit,
        offset,
    })
}

/// GET /api/wecode/external-knowledge/{provider}/knowledge-bases.
#[brz_http_server::get(
    "/api/wecode/external-knowledge/:provider/knowledge-bases",
    group = crate::wecode::startup::wecode_apis
)]
async fn list_external_knowledge_bases(
    #[inject(wecode)] state: &SharedWecodeAppState,
    provider: String,
    scope: Option<String>,
    query: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
    #[auth] user: wegent_backend_rs::auth::SessionUser,
) -> Result<KnowledgeBaseListResponse, ListError> {
    let params = parse_params(scope.as_deref(), query, limit.as_deref(), offset.as_deref())?;
    let response = list_knowledge_bases(
        state,
        user.id,
        &provider,
        &params.scope,
        params.query.as_deref(),
        params.limit,
        params.offset,
    )
    .await?;
    Ok(response)
}

/// One of the endpoint's failure shapes: 422 validation or a mapped
/// provider error body.
enum ListError {
    Validation(FastApiError),
    Provider(ExternalKnowledgeError),
}

impl From<FastApiError> for ListError {
    fn from(error: FastApiError) -> Self {
        Self::Validation(error)
    }
}

impl From<ExternalKnowledgeError> for ListError {
    fn from(error: ExternalKnowledgeError) -> Self {
        Self::Provider(error)
    }
}

impl brz_http_server::IntoHttpError for ListError {
    fn into_http_error(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        match self {
            Self::Validation(error) => error.into_http_error(arena),
            Self::Provider(error) => error.into_http_error().into_http_error(arena),
        }
    }
}

/// `list_external_knowledge_bases` handler body: resolve the employee id,
/// then dispatch to the provider.
async fn list_knowledge_bases(
    state: &SharedWecodeAppState,
    user_id: i32,
    provider_name: &str,
    scope: &str,
    query: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<KnowledgeBaseListResponse, ExternalKnowledgeError> {
    // `ExternalKnowledgeService._get_ready_provider`: registry.get raises
    // 404 `provider_not_found` for unknown names.
    if provider_name != "ap" {
        return Err(ExternalKnowledgeError {
            message: format!("Unknown external knowledge provider: {provider_name}"),
            code: "provider_not_found",
            status: StatusCode::NOT_FOUND,
        });
    }

    // `_get_employee_id` (`ErpEntityResolver.resolve_employee_id`): the
    // `wecode_erp_user` profile projection; a missing employee id raises
    // 403 `employee_id_required`.
    let employee_id = super::employee_sync::resolve_employee_id(
        &state.app.mysql,
        state.app.redis.as_ref(),
        state.app.erp.as_ref(),
        user_id,
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "external-knowledge employee lookup failed");
        ExternalKnowledgeError {
            message: "Internal server error".to_string(),
            code: "internal_error",
            status: StatusCode::INTERNAL_SERVER_ERROR,
        }
    })?;
    let Some(employee_id) = employee_id else {
        return Err(ExternalKnowledgeError {
            message: "employee_id is required to use external knowledge".to_string(),
            code: "employee_id_required",
            status: StatusCode::FORBIDDEN,
        });
    };

    // `_is_provider_configured("ap")`: the system token gates the service.
    let configured = env_or_dotenv("AP_KNOWLEDGE_SYSTEM_TOKEN").is_some();
    if !configured {
        return Err(ExternalKnowledgeError {
            message: "AP knowledge system token is not configured".to_string(),
            code: "not_configured",
            status: StatusCode::SERVICE_UNAVAILABLE,
        });
    }

    call_ap_list_knowledge_bases(&employee_id, scope, query, limit, offset).await
}

/// `ApExternalKnowledgeProvider.list_knowledge_bases`: call the MCP
/// `ks_kb_list_knowledge_bases` tool and map the payload into the response.
async fn call_ap_list_knowledge_bases(
    employee_id: &str,
    scope: &str,
    query: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<KnowledgeBaseListResponse, ExternalKnowledgeError> {
    let arguments = McpListArguments {
        scope,
        limit,
        offset,
        query: query.filter(|query| !query.is_empty()),
    };
    let payload = ap_call_tool(LIST_KNOWLEDGE_BASES_TOOL, &arguments, employee_id).await?;
    Ok(map_knowledge_bases(payload, limit, offset))
}

/// `ApKnowledgeMcpClient.call_tool`: POST the JSON-RPC body with the
/// system-token bearer header and X-User-Name employee header, then parse
/// the MCP envelope. Transport failures map to
/// `502 internal_error "Failed to request AP knowledge service"`.
async fn ap_call_tool(
    name: &str,
    arguments: &McpListArguments<'_>,
    employee_id: &str,
) -> Result<ApKnowledgeBasesPayload, ExternalKnowledgeError> {
    use brz_http::Client as HttpClient;

    let base_url = env_or_dotenv("AP_KNOWLEDGE_BASE_URL")
        .unwrap_or_else(|| DEFAULT_AP_KNOWLEDGE_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string();
    let url = format!("{base_url}{AP_KNOWLEDGE_MCP_PATH}");
    // The source builds a fresh `httpx.AsyncClient(timeout=...)` per call;
    // the target keeps the same transport policy (30s timeout on every
    // phase) in one shared process-lifetime client, per the platform
    // client-ownership contract.
    let client = HttpClient::builder()
        .connect_timeout(AP_KNOWLEDGE_TIMEOUT)
        .read_timeout(AP_KNOWLEDGE_TIMEOUT)
        .timeout(AP_KNOWLEDGE_TIMEOUT)
        .build()
        .map_err(transport_failure)?;
    let endpoint = client.endpoint(url).map_err(transport_failure)?;
    let token = env_or_dotenv("AP_KNOWLEDGE_SYSTEM_TOKEN").unwrap_or_default();
    let payload = McpToolRequest {
        jsonrpc: "2.0",
        // `itertools.count(1)`: a fresh client starts at 1; the server does
        // not correlate ids across calls.
        id: 1,
        method: "tools/call",
        params: McpToolParams {
            name,
            arguments: McpListArguments {
                scope: arguments.scope,
                limit: arguments.limit,
                offset: arguments.offset,
                query: arguments.query,
            },
        },
    };
    let request = endpoint
        .post()
        .json(&payload)
        .bearer_auth(token)
        .header("X-User-Name", employee_id)
        .build()
        .map_err(transport_failure)?;
    let response = client.execute(request).await.map_err(|error| {
        tracing::warn!(%error, "AP knowledge service request failed");
        transport_failure(error)
    })?;
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(ExternalKnowledgeError::from_provider_code(
            "unauthorized",
            "AP knowledge authorization failed",
        ));
    }
    if !status.is_success() {
        // `response.raise_for_status()` then the `HTTPStatusError` mapping.
        if status == StatusCode::FORBIDDEN {
            return Err(ExternalKnowledgeError::from_provider_code(
                "forbidden",
                "AP knowledge access denied",
            ));
        }
        if status == StatusCode::NOT_FOUND {
            return Err(ExternalKnowledgeError::from_provider_code(
                "not_found",
                "AP knowledge resource not found",
            ));
        }
        return Err(ExternalKnowledgeError {
            message: "AP knowledge service returned an error".to_string(),
            code: "internal_error",
            status: StatusCode::BAD_GATEWAY,
        });
    }
    let envelope: McpToolResponse = response.json().await.map_err(|error| {
        tracing::warn!(%error, "AP knowledge response decode failed");
        transport_failure(error)
    })?;
    parse_mcp_payload(envelope)
}

/// The transport-failure mapping of `call_tool` (`httpx.HTTPError`).
fn transport_failure(_error: brz_http::Error) -> ExternalKnowledgeError {
    ExternalKnowledgeError {
        message: "Failed to request AP knowledge service".to_string(),
        code: "internal_error",
        status: StatusCode::BAD_GATEWAY,
    }
}

/// `_parse_response`: read the first content text, parse it as JSON, and
/// surface `isError` payloads through the provider error mapping.
fn parse_mcp_payload(
    envelope: McpToolResponse,
) -> Result<ApKnowledgeBasesPayload, ExternalKnowledgeError> {
    let Some(result) = envelope.result else {
        // An absent result is not an `"error"` member; the source's `result
        // or {}` path parses the empty text and fails on invalid JSON.
        return Err(invalid_payload());
    };
    let text = result
        .content
        .first()
        .and_then(|content| content.text.as_deref())
        .unwrap_or("");
    let parsed: serde_json::Value = serde_json::from_str(text).map_err(|_| invalid_payload())?;
    if !parsed.is_object() {
        return Err(invalid_payload());
    }
    if result.is_error == Some(true) {
        let code = parsed
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("internal_error");
        let message = parsed
            .get("error")
            .and_then(serde_json::Value::as_str)
            .or_else(|| parsed.get("message").and_then(serde_json::Value::as_str))
            .unwrap_or("MCP tool failed");
        return Err(ExternalKnowledgeError::from_provider_code(code, message));
    }
    serde_json::from_value(parsed).map_err(|_| invalid_payload())
}

/// `_parse_text_payload` failures: invalid or non-object JSON.
fn invalid_payload() -> ExternalKnowledgeError {
    ExternalKnowledgeError {
        message: "AP knowledge response payload is invalid JSON".to_string(),
        code: "internal_error",
        status: StatusCode::BAD_GATEWAY,
    }
}

/// `_map_knowledge_base` plus the response construction of
/// `ApExternalKnowledgeProvider.list_knowledge_bases`. `limit`/`offset` are
/// the fallbacks when the payload omits them.
fn map_knowledge_bases(
    payload: ApKnowledgeBasesPayload,
    fallback_limit: i64,
    fallback_offset: i64,
) -> KnowledgeBaseListResponse {
    let items = payload
        .items
        .into_iter()
        .map(|item| ExternalKnowledgeBase {
            provider: "ap",
            knowledge_base_id: string_field(item.knowledge_base_id.as_ref()),
            knowledge_base_name: string_field(item.knowledge_base_name.as_ref()),
            description: item.description,
            scope: string_field(item.scope.as_ref()),
            owner_id: item.owner_id,
            employee_id: item.employee_id,
            document_count: int_field(item.document_count.as_ref()),
            created_at: item.created_at,
            updated_at: item.updated_at,
        })
        .collect();
    KnowledgeBaseListResponse {
        provider: "ap",
        total: int_field(payload.total.as_ref()),
        total_returned: int_field(payload.total_returned.as_ref()),
        has_more: payload.has_more.unwrap_or(false),
        // `int(payload.get("limit") or limit)`: a missing (or zero) payload
        // value falls back to the request parameter.
        limit: {
            let value = int_field(payload.limit.as_ref());
            if value == 0 { fallback_limit } else { value }
        },
        offset: {
            let value = int_field(payload.offset.as_ref());
            if value == 0 { fallback_offset } else { value }
        },
        items,
    }
}

/// `str(item.get(field) or "")`: a string, number, or boolean renders through
/// `str()`; an explicit JSON null is falsy and yields "".
fn string_field(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Number(number)) => number.to_string(),
        Some(serde_json::Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

/// `int(item.get(field) or 0)`: integers pass through; float values keep
/// their integral part; null/absent yields 0.
fn int_field(value: Option<&serde_json::Number>) -> i64 {
    value
        .map(|number| {
            number
                .as_i64()
                .or_else(|| number.as_f64().map(|float| float as i64))
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_rejects_unknown_values_like_the_pattern_constraint() {
        let error = parse_params(Some("team"), None, None, None).unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            error
                .validation_detail()
                .contains("string_pattern_mismatch")
        );
    }

    #[test]
    fn limit_and_offset_validate_ranges() {
        assert!(parse_params(None, None, Some("0"), None).is_err());
        assert!(parse_params(None, None, Some("101"), None).is_err());
        assert!(parse_params(None, None, Some("50"), Some("-1")).is_err());
        let params = parse_params(None, None, Some("100"), Some("7")).unwrap();
        assert_eq!(params.limit, 100);
        assert_eq!(params.offset, 7);
    }

    #[test]
    fn query_longer_than_100_characters_fails_validation() {
        let long = "a".repeat(101);
        assert!(parse_params(None, Some(long), None, None).is_err());
        let boundary = "a".repeat(100);
        assert!(parse_params(None, Some(boundary), None, None).is_ok());
    }

    #[test]
    fn defaults_match_the_source_query_contract() {
        let params = parse_params(None, None, None, None).unwrap();
        assert_eq!(params.scope, "all");
        assert_eq!(params.limit, 50);
        assert_eq!(params.offset, 0);
        assert!(params.query.is_none());
    }

    #[test]
    fn mcp_envelope_maps_business_payload_and_is_error() {
        let text = serde_json::json!({
            "total": 2, "total_returned": 1, "has_more": true, "limit": 100,
            "offset": 0,
            "items": [{
                "knowledge_base_id": "kb-1", "knowledge_base_name": "KB One",
                "scope": "all", "document_count": 3,
            }],
        })
        .to_string();
        let envelope: McpToolResponse = serde_json::from_str(
            &serde_json::json!({"result": {"content": [{"text": text}], "isError": false}})
                .to_string(),
        )
        .unwrap();
        let payload = parse_mcp_payload(envelope).unwrap();
        let response = map_knowledge_bases(payload, 100, 0);
        assert_eq!(response.total, 2);
        assert_eq!(response.total_returned, 1);
        assert!(response.has_more);
        assert_eq!(response.items.len(), 1);
        assert_eq!(response.items[0].knowledge_base_id, "kb-1");
        assert_eq!(response.items[0].document_count, 3);
        assert_eq!(response.items[0].scope, "all");

        let error_text = serde_json::json!({"code": "forbidden", "message": "no"}).to_string();
        let error_envelope: McpToolResponse = serde_json::from_str(
            &serde_json::json!({
                "result": {"content": [{"text": error_text}], "isError": true}
            })
            .to_string(),
        )
        .unwrap();
        let error = parse_mcp_payload(error_envelope).unwrap_err();
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(error.code, "forbidden");
        assert_eq!(error.message, "no");
    }

    #[test]
    fn missing_fields_default_like_the_source() {
        let envelope: McpToolResponse =
            serde_json::from_str(r#"{"result":{"content":[{"text":"{}"}]}}"#).unwrap();
        let payload = parse_mcp_payload(envelope).unwrap();
        // `limit`/`offset` fall back to the request values.
        let response = map_knowledge_bases(payload, 25, 10);
        assert_eq!(response.total, 0);
        assert!(!response.has_more);
        assert_eq!(response.limit, 25);
        assert_eq!(response.offset, 10);
        assert!(response.items.is_empty());
    }

    #[test]
    fn error_body_wraps_code_and_message_inside_detail() {
        let rendered = serde_json::to_value(
            serde_json::json!({"detail": {"code": "internal_error", "message": "Failed to request AP knowledge service"}}),
        )
        .unwrap();
        // The FastApiError body serializes the full object; the expected
        // recorded body nests code/message under `detail`.
        let expected = serde_json::to_string(&rendered).unwrap();
        assert_eq!(
            expected,
            "{\"detail\":{\"code\":\"internal_error\",\"message\":\"Failed to request AP knowledge service\"}}"
        );
        // The provider error renders through the same shape: the transport
        // mapping produces the recorded 502 body content.
        let transport = ExternalKnowledgeError {
            message: "Failed to request AP knowledge service".to_string(),
            code: "internal_error",
            status: StatusCode::BAD_GATEWAY,
        };
        assert_eq!(transport.status, StatusCode::BAD_GATEWAY);
        assert_eq!(transport.code, "internal_error");
        assert_eq!(transport.message, "Failed to request AP knowledge service");
    }

    #[test]
    fn string_fields_coerce_scalars_and_null() {
        assert_eq!(string_field(Some(&serde_json::json!("x"))), "x");
        assert_eq!(string_field(Some(&serde_json::json!(7))), "7");
        assert_eq!(string_field(Some(&serde_json::Value::Null)), "");
        assert_eq!(string_field(None), "");
    }
}
