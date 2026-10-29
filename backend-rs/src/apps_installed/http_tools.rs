// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! HTTP-transport connector tools (`transport = "http"` plus `httpTools`).
//!
//! Ports `ConnectorRuntimeService._http_tool_definitions`,
//! `_http_request_parts`, and `_call_http_tool`: a configured operation is
//! exposed as one `<slug>__<name>` tool and executed as a plain HTTP request
//! with the caller's stored credentials, instead of an MCP session.

use std::collections::BTreeMap;
use std::time::Duration;

use brz_http::{Client as HttpClient, Method};
use brz_json::OpaqueJson;
use serde::Deserialize;
use serde_json::{Value, json};

use super::mcp::ToolCall;
use super::service::ConnectorApp;

/// `MAX_HTTP_RESPONSE_BYTES`.
const MAX_RESPONSE_BYTES: usize = 1_000_000;
/// `ConnectorHttpToolDefinition.timeout_seconds` default and bounds.
const DEFAULT_TIMEOUT_SECONDS: u64 = 30;
const MAX_TIMEOUT_SECONDS: u64 = 120;

/// One configured operation (`ConnectorHttpToolDefinition`).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct HttpTool {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_method")]
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub input_schema: Option<OpaqueJson>,
    #[serde(default)]
    pub argument_locations: BTreeMap<String, String>,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}

fn default_method() -> String {
    "POST".to_string()
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECONDS
}

/// Why one configured HTTP tool could not run.
#[derive(Debug)]
pub(crate) enum HttpToolError {
    /// The stored configuration does not decode.
    InvalidConfiguration,
    /// The configured `input_schema` is not a usable JSON Schema.
    InvalidSchema,
    /// The caller's arguments violate the tool's contract.
    InvalidArguments(String),
    /// The upstream call failed or exceeded the response budget.
    Upstream(String),
}

impl std::fmt::Display for HttpToolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfiguration => {
                formatter.write_str("Connector HTTP tool configuration is invalid")
            }
            Self::InvalidSchema => formatter.write_str("Connector HTTP tool schema is invalid"),
            Self::InvalidArguments(message) => write!(formatter, "{message}"),
            Self::Upstream(message) => write!(formatter, "{message}"),
        }
    }
}

/// `_http_tool_definitions`: decode every configured operation.
pub(crate) fn definitions(app: &ConnectorApp) -> Result<Vec<HttpTool>, HttpToolError> {
    app.http_tools
        .iter()
        .map(|entry| {
            serde_json::from_value::<HttpTool>(entry.to_value())
                .map_err(|_| HttpToolError::InvalidConfiguration)
        })
        .collect()
}

/// The tool-listing entry for one configured operation.
pub(crate) fn listing_entry(app: &ConnectorApp, tool: &HttpTool) -> Value {
    let mut entry = json!({
        "name": format!("{}__{}", app.slug, tool.name),
        "description": tool.description,
        "rawToolName": tool.name,
        "inputSchema": tool
            .input_schema
            .as_ref()
            .map(|schema| schema.to_value())
            .unwrap_or_else(super::connection::default_input_schema),
    });
    if tool.name.is_empty() {
        entry["name"] = Value::String(app.slug.clone());
    }
    entry
}

/// `_call_http_tool`: run one configured operation and shape its result like
/// the MCP client's `CallToolResult`.
pub(crate) async fn call(
    app: &ConnectorApp,
    tool: &HttpTool,
    arguments: &Value,
    headers: &[(String, String)],
) -> Result<ToolCall, HttpToolError> {
    validate_arguments(tool, arguments)?;
    let (url, query, body) = request_parts(&app.mcp_url, tool, arguments)?;
    let method = Method::from_bytes(tool.method.to_ascii_uppercase().as_bytes())
        .map_err(|_| HttpToolError::InvalidConfiguration)?;
    let timeout = Duration::from_secs(tool.timeout_seconds.clamp(1, MAX_TIMEOUT_SECONDS));
    let client = HttpClient::builder()
        .connect_timeout(timeout)
        .read_timeout(timeout)
        .build()
        .map_err(|error| HttpToolError::Upstream(error.to_string()))?;
    let endpoint = client
        .endpoint(&url)
        .map_err(|error| HttpToolError::Upstream(error.to_string()))?;
    let mut request = endpoint.request(method);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if !query.is_empty() {
        request = request.query(&query);
    }
    if !body.is_empty() {
        request = request.json(&Value::Object(body.into_iter().collect()));
    }
    let response = request
        .send()
        .await
        .map_err(|error| HttpToolError::Upstream(error.to_string()))?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(HttpToolError::Upstream(
            "Connector HTTP response exceeds the size limit".to_string(),
        ));
    }
    let bytes = read_bounded_body(response).await?;
    Ok(shape_result(status.as_u16(), &bytes))
}

/// `_bounded_response_body`: stop as soon as the budget is exceeded, so a
/// chunked or unterminated response cannot be buffered past the limit.
async fn read_bounded_body(mut response: brz_http::Response) -> Result<Vec<u8>, HttpToolError> {
    let mut collected: Vec<u8> = Vec::new();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|error| HttpToolError::Upstream(error.to_string()))?;
        let Some(chunk) = chunk else {
            return Ok(collected);
        };
        if collected.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(HttpToolError::Upstream(
                "Connector HTTP response exceeds the size limit".to_string(),
            ));
        }
        collected.extend_from_slice(&chunk);
    }
}

/// `_http_response`: JSON payloads stay structured, everything else becomes
/// text, and non-2xx answers are tool errors rather than protocol errors.
fn shape_result(status_code: u16, body: &[u8]) -> ToolCall {
    let payload: Value = match serde_json::from_slice::<Value>(body) {
        Ok(value) => value,
        Err(_) => Value::String(String::from_utf8_lossy(body).into_owned()),
    };
    let text = match &payload {
        Value::String(value) => value.clone(),
        other => other.to_string(),
    };
    ToolCall {
        content: json!([{"type": "text", "text": text}]),
        structured_content: payload
            .is_object()
            .then(|| json!({"status_code": status_code, "data": payload}))
            .or_else(|| {
                payload
                    .is_array()
                    .then(|| json!({"status_code": status_code, "data": payload}))
            }),
        is_error: !(200..300).contains(&status_code),
    }
}

/// The resolved request target of one configured operation.
type RequestParts = (String, Vec<(String, String)>, BTreeMap<String, Value>);

/// `_http_request_parts`: split the arguments into path, query, and body.
fn request_parts(
    base_url: &str,
    tool: &HttpTool,
    arguments: &Value,
) -> Result<RequestParts, HttpToolError> {
    let mut path = tool.path.clone();
    let mut query: Vec<(String, String)> = Vec::new();
    let mut body: BTreeMap<String, Value> = BTreeMap::new();
    let method = tool.method.to_ascii_uppercase();
    if let Some(entries) = arguments.as_object() {
        for (name, value) in entries {
            let placeholder = format!("{{{name}}}");
            let location = tool.argument_locations.get(name);
            if location.is_some_and(|location| location == "path") || path.contains(&placeholder) {
                let scalar = path_text(value).ok_or_else(|| {
                    HttpToolError::InvalidArguments(format!(
                        "HTTP path argument '{name}' must be scalar"
                    ))
                })?;
                path = path.replace(&placeholder, &quote_path(&scalar));
            } else if location.is_some_and(|location| location == "query")
                || (location.is_none() && matches!(method.as_str(), "GET" | "DELETE"))
            {
                for encoded in query_values(value) {
                    query.push((name.clone(), encoded));
                }
            } else {
                body.insert(name.clone(), value.clone());
            }
        }
    }
    if path.contains('{') || path.contains('}') {
        return Err(HttpToolError::InvalidArguments(
            "A required HTTP path argument is missing".to_string(),
        ));
    }
    Ok((
        format!("{}{path}", base_url.trim_end_matches('/')),
        query,
        body,
    ))
}

/// `str(value)` for a path segment; containers are not addressable.
fn path_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(boolean) => Some(if *boolean { "True" } else { "False" }.to_string()),
        Value::Null => Some("None".to_string()),
        Value::Array(_) | Value::Object(_) => None,
    }
}

/// httpx query rendering: arrays repeat the parameter, scalars follow Python's
/// `str()` forms (`true`/`false`, empty string for `null`).
fn query_values(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().map(query_scalar).collect(),
        other => vec![query_scalar(other)],
    }
}

fn query_scalar(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(boolean) => (if *boolean { "true" } else { "false" }).to_string(),
        Value::Null => String::new(),
        Value::Array(_) | Value::Object(_) => python_repr(value),
    }
}

/// `str(value)` for a value httpx would serialize with Python's `repr`.
fn python_repr(value: &Value) -> String {
    match value {
        Value::Null => "None".to_string(),
        Value::Bool(boolean) => (if *boolean { "True" } else { "False" }).to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => format!("'{}'", text.replace('\\', "\\\\").replace('\'', "\\'")),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(python_repr).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(entries) => format!(
            "{{{}}}",
            entries
                .iter()
                .map(|(key, item)| format!(
                    "{}: {}",
                    python_repr(&Value::String(key.clone())),
                    python_repr(item)
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// `quote(value, safe="")`.
fn quote_path(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        let character = byte as char;
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '~') {
            encoded.push(character);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// `_validate_http_arguments`: validate the call against the configured
/// `input_schema` with the same JSON Schema engine semantics as the Python
/// runtime, so both entries accept and reject the same arguments.
fn validate_arguments(tool: &HttpTool, arguments: &Value) -> Result<(), HttpToolError> {
    let Some(schema) = tool
        .input_schema
        .as_ref()
        .map(|schema| schema.to_value())
        .filter(Value::is_object)
    else {
        return Ok(());
    };
    let validator = jsonschema::validator_for(&schema).map_err(|_| HttpToolError::InvalidSchema)?;
    let Some(error) = validator.iter_errors(arguments).next() else {
        return Ok(());
    };
    Err(HttpToolError::InvalidArguments(format!(
        "Invalid connector tool arguments: {error}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool() -> HttpTool {
        HttpTool {
            name: "lookup".to_string(),
            description: "Lookup a record".to_string(),
            method: "GET".to_string(),
            path: "/records/{id}".to_string(),
            input_schema: Some(OpaqueJson::from_serializable(json!({
                "type": "object",
                "required": ["id"],
                "properties": {"id": {"type": "string"}, "verbose": {"type": "boolean"}},
            }))),
            argument_locations: BTreeMap::new(),
            timeout_seconds: 30,
        }
    }

    /// Path placeholders are quoted and GET arguments become the query string.
    #[test]
    fn request_parts_split_path_and_query() {
        let (url, query, body) = request_parts(
            "https://api.example.test/v1/",
            &tool(),
            &json!({"id": "a/b c", "verbose": true}),
        )
        .unwrap();

        assert_eq!(url, "https://api.example.test/v1/records/a%2Fb%20c");
        assert_eq!(query, vec![("verbose".to_string(), "true".to_string())]);
        assert!(body.is_empty());
    }

    /// POST arguments without a location stay in the JSON body.
    #[test]
    fn post_arguments_go_to_the_body() {
        let mut tool = tool();
        tool.method = "POST".to_string();
        tool.path = "/records".to_string();
        let (url, query, body) =
            request_parts("https://api.example.test", &tool, &json!({"id": "1"})).unwrap();

        assert_eq!(url, "https://api.example.test/records");
        assert!(query.is_empty());
        assert_eq!(body.get("id"), Some(&json!("1")));
    }

    /// A missing placeholder argument is a caller error, not an upstream call.
    #[test]
    fn missing_path_arguments_are_rejected() {
        let error = request_parts("https://api.example.test", &tool(), &json!({})).unwrap_err();
        assert!(matches!(error, HttpToolError::InvalidArguments(_)));
    }

    /// Required members and plain types follow the tool's input schema.
    #[test]
    fn argument_validation_covers_required_and_types() {
        assert!(validate_arguments(&tool(), &json!({"id": "1"})).is_ok());
        assert!(matches!(
            validate_arguments(&tool(), &json!({})).unwrap_err(),
            HttpToolError::InvalidArguments(_)
        ));
        assert!(matches!(
            validate_arguments(&tool(), &json!({"id": 1})).unwrap_err(),
            HttpToolError::InvalidArguments(_)
        ));
    }

    /// The same schema engine as the Python runtime: patterns, enums, nested
    /// constraints, and `additionalProperties` all reject the same arguments.
    #[test]
    fn argument_validation_matches_the_python_schema_engine() {
        let mut tool = tool();
        tool.input_schema = Some(OpaqueJson::from_serializable(json!({
            "type": "object",
            "required": ["id"],
            "additionalProperties": false,
            "properties": {
                "id": {"type": "string", "pattern": "^[a-z]+$"},
                "mode": {"enum": ["fast", "slow"]},
                "nested": {
                    "type": "object",
                    "required": ["count"],
                    "properties": {"count": {"type": "integer", "minimum": 1}},
                },
            },
        })));

        assert!(validate_arguments(&tool, &json!({"id": "abc", "mode": "fast"})).is_ok());
        for rejected in [
            json!({"id": "ABC"}),
            json!({"id": "abc", "mode": "turbo"}),
            json!({"id": "abc", "nested": {"count": 0}}),
            json!({"id": "abc", "mystery": 1}),
        ] {
            let error = validate_arguments(&tool, &rejected).unwrap_err();
            assert!(
                matches!(error, HttpToolError::InvalidArguments(_)),
                "{rejected} was accepted"
            );
            assert!(
                error
                    .to_string()
                    .starts_with("Invalid connector tool arguments:"),
                "{error}"
            );
        }
    }

    /// A schema the engine cannot compile is a configuration fault, not a
    /// caller error.
    #[test]
    fn invalid_schemas_are_configuration_faults() {
        let mut tool = tool();
        tool.input_schema = Some(OpaqueJson::from_serializable(json!({"type": 5})));
        assert!(matches!(
            validate_arguments(&tool, &json!({})).unwrap_err(),
            HttpToolError::InvalidSchema
        ));
    }

    /// Non-2xx answers keep the body but report a tool error.
    #[test]
    fn responses_become_tool_results() {
        let ok = shape_result(200, br#"{"value":1}"#);
        assert!(!ok.is_error);
        assert_eq!(ok.content[0]["text"], json!("{\"value\":1}"));
        assert_eq!(
            ok.structured_content,
            Some(json!({"status_code": 200, "data": {"value": 1}}))
        );

        let failed = shape_result(500, b"boom");
        assert!(failed.is_error);
        assert_eq!(failed.content[0]["text"], json!("boom"));
        assert_eq!(failed.structured_content, None);
    }

    /// Run one configured operation against a real HTTP fixture: the request
    /// carries the quoted path/query and the stored headers, and the JSON answer
    /// is shaped into a tool result.
    #[tokio::test]
    async fn configured_operations_run_over_real_http() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (line_tx, line_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buffer = Vec::new();
            let mut chunk = [0_u8; 1024];
            let head = loop {
                let read = stream.read(&mut chunk).await.unwrap_or(0);
                if read == 0 {
                    return;
                }
                buffer.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&buffer).to_string();
                if text.contains("\r\n\r\n") {
                    break text;
                }
            };
            let _ = line_tx.send(head);
            let body = br#"{"ok":true}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.write_all(body).await;
        });

        let app = super::super::service::row_to_app(&crate::apps_installed::db::KindRow {
            kinds_id: 1,
            kinds_user_id: 0,
            kinds_kind: "ConnectorApp".to_string(),
            kinds_name: "erp".to_string(),
            kinds_namespace: "system".to_string(),
            kinds_json: brz_mysql::Json(
                json!({
                    "kind": "ConnectorApp",
                    "spec": {
                        "name": "erp",
                        "mcpUrl": format!("http://{address}/v1"),
                        "enabled": true,
                        "authType": "oauth2",
                        "transport": "http",
                        "visibility": "all",
                        "description": "d",
                        "allowedRoles": [],
                        "toolAllowlist": [],
                    }
                })
                .into(),
            ),
            kinds_is_active: true,
            kinds_created_at: chrono::NaiveDateTime::default(),
            kinds_updated_at: chrono::NaiveDateTime::default(),
        });

        let call = call(
            &app,
            &tool(),
            &json!({"id": "a/b", "verbose": true}),
            &[("authorization".to_string(), "Bearer stored".to_string())],
        )
        .await
        .expect("the fixture answers");

        let head = line_rx.await.unwrap();
        assert!(
            head.starts_with("GET /v1/records/a%2Fb?verbose=true HTTP/1.1"),
            "{head}"
        );
        assert!(
            head.to_ascii_lowercase()
                .contains("authorization: bearer stored"),
            "{head}"
        );
        assert!(!call.is_error);
        assert_eq!(
            call.structured_content,
            Some(json!({"status_code": 200, "data": {"ok": true}}))
        );
    }

    /// Arrays repeat the query parameter, and scalars follow httpx rendering.
    #[test]
    fn query_arguments_follow_httpx() {
        let (_url, query, _body) = request_parts(
            "https://api.example.test",
            &HttpTool {
                method: "GET".to_string(),
                path: "/search".to_string(),
                ..tool()
            },
            &json!({"tag": ["a", "b"], "flag": true, "off": false, "missing": null, "limit": 3}),
        )
        .unwrap();

        assert_eq!(
            query,
            vec![
                ("tag".to_string(), "a".to_string()),
                ("tag".to_string(), "b".to_string()),
                ("flag".to_string(), "true".to_string()),
                ("off".to_string(), "false".to_string()),
                ("missing".to_string(), String::new()),
                ("limit".to_string(), "3".to_string()),
            ]
        );
    }

    /// An explicit `query` location expands arrays on non-GET methods too.
    #[test]
    fn explicit_query_locations_expand_arrays() {
        let mut tool = tool();
        tool.method = "POST".to_string();
        tool.path = "/search".to_string();
        tool.argument_locations
            .insert("tag".to_string(), "query".to_string());
        let (_url, query, body) = request_parts(
            "https://api.example.test",
            &tool,
            &json!({"id": "x", "tag": ["a", "b"]}),
        )
        .unwrap();

        assert_eq!(
            query,
            vec![
                ("tag".to_string(), "a".to_string()),
                ("tag".to_string(), "b".to_string())
            ]
        );
        assert_eq!(body.get("id"), Some(&json!("x")));
    }

    /// Path segments use `str(value)` for null and booleans like the source.
    #[test]
    fn path_segments_render_python_scalars() {
        assert_eq!(path_text(&json!(null)).as_deref(), Some("None"));
        assert_eq!(path_text(&json!(true)).as_deref(), Some("True"));
        assert_eq!(path_text(&json!([1])), None);
    }

    /// A response without `Content-Length` is cut off once the budget is
    /// exceeded, without waiting for the server to finish.
    #[tokio::test]
    async fn oversized_streaming_responses_stop_at_the_budget() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buffer = [0_u8; 2048];
            let _ = stream.read(&mut buffer).await;
            let head = "HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\nconnection: close\r\n\r\n";
            let _ = stream.write_all(head.as_bytes()).await;
            // 1,010,000 bytes with no declared length, then hold the socket open.
            let payload = vec![b'x'; 1_010_000];
            let _ = stream.write_all(&payload).await;
            let _ = stream.flush().await;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        });

        let app = super::super::service::row_to_app(&crate::apps_installed::db::KindRow {
            kinds_id: 1,
            kinds_user_id: 0,
            kinds_kind: "ConnectorApp".to_string(),
            kinds_name: "erp".to_string(),
            kinds_namespace: "system".to_string(),
            kinds_json: brz_mysql::Json(
                json!({
                    "kind": "ConnectorApp",
                    "spec": {
                        "name": "erp",
                        "mcpUrl": format!("http://{address}"),
                        "enabled": true,
                        "authType": "none",
                        "transport": "http",
                        "visibility": "all",
                        "description": "d",
                        "allowedRoles": [],
                        "toolAllowlist": [],
                    }
                })
                .into(),
            ),
            kinds_is_active: true,
            kinds_created_at: chrono::NaiveDateTime::default(),
            kinds_updated_at: chrono::NaiveDateTime::default(),
        });
        let mut definition = tool();
        definition.method = "GET".to_string();
        definition.path = "/big".to_string();

        let error = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            call(&app, &definition, &json!({"id": "1"}), &[]),
        )
        .await
        .expect("the size limit must trigger before the stream ends")
        .unwrap_err();

        assert!(error.to_string().contains("size limit"), "{error}");
    }
}
