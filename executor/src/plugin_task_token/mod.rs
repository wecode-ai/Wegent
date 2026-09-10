//! Task-owned remote MCP routes. Real TaskTokens exist only in native memory.

pub(crate) mod issuer;
mod package;
mod sse;

pub(crate) use package::{materialize as materialize_native_plugin, requires_native_proxy};

use crate::{mcp_utils::replace_mcp_server_variables, protocol::ExecutionRequest};
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle};

pub(crate) struct PreparedMcps {
    pub servers: BTreeMap<String, Value>,
    workers: Vec<JoinHandle<()>>,
    files: Vec<tempfile::NamedTempFile>,
    identity: Option<Arc<Identity>>,
}

impl PreparedMcps {
    pub(crate) fn write_claude_config(
        &mut self,
        directory: &Path,
        content: &Value,
    ) -> Result<PathBuf, String> {
        use std::io::Write;
        let mut file = tempfile::Builder::new()
            .prefix("task-mcp-")
            .suffix(".json")
            .tempfile_in(directory)
            .map_err(|_| "Cannot prepare task MCP configuration")?;
        serde_json::to_writer(&mut file, content)
            .map_err(|_| "Cannot write task MCP configuration")?;
        file.flush()
            .map_err(|_| "Cannot flush task MCP configuration")?;
        let path = file.path().to_path_buf();
        self.files.push(file);
        Ok(path)
    }
}

impl Drop for PreparedMcps {
    fn drop(&mut self) {
        if let Some(identity) = &self.identity {
            identity.active.store(false, Ordering::Release);
        }
        for worker in &self.workers {
            worker.abort();
        }
    }
}

fn executor_home() -> PathBuf {
    std::env::var_os("WEGENT_EXECUTOR_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".wegent-executor")
        })
}

pub(crate) async fn prepare(
    request: &ExecutionRequest,
    home: &Path,
    claude: bool,
) -> Result<PreparedMcps, String> {
    let servers = package::load(home, claude, request)?;
    prepare_servers(request, servers, issuer::current()).await
}

async fn prepare_servers(
    request: &ExecutionRequest,
    servers: BTreeMap<String, Value>,
    issuer: Result<issuer::Issuer, String>,
) -> Result<PreparedMcps, String> {
    let mut prepared = PreparedMcps {
        servers: BTreeMap::new(),
        workers: Vec::new(),
        files: Vec::new(),
        identity: None,
    };
    if servers.is_empty() {
        return Ok(prepared);
    }
    let task_id = request
        .extra
        .get("runtimeLocalTaskId")
        .and_then(Value::as_str)
        .unwrap_or(&request.task_id)
        .trim();
    if task_id.is_empty() {
        return Err("Plugin TaskToken requires a concrete task".into());
    }
    let issuer = issuer?;
    let token = issuer.issue(task_id).await?;
    let identity = Arc::new(Identity {
        task_id: task_id.into(),
        issuer,
        token: Mutex::new(token),
        active: AtomicBool::new(true),
    });
    prepared.identity = Some(identity.clone());
    for (name, server) in servers {
        // Resolve other existing variables without ever substituting auth_token
        // (which can be a desktop login credential) for task_token.
        let mut context = request.clone();
        context.auth_token = Some("${{task_token}}".into());
        let server = replace_mcp_server_variables(&server, Some(&context));
        let server_type = if server["type"] == "sse" {
            "sse"
        } else {
            "http"
        };
        let (url, worker) = start_proxy(server, identity.clone()).await?;
        prepared.workers.push(worker);
        prepared
            .servers
            .insert(name, json!({"type": server_type, "url": url}));
    }
    Ok(prepared)
}

struct Identity {
    task_id: String,
    issuer: issuer::Issuer,
    token: Mutex<issuer::Token>,
    active: AtomicBool,
}

impl Identity {
    async fn token(&self) -> Result<String, String> {
        if !self.active.load(Ordering::Acquire) || !self.issuer.available() {
            return Err("Plugin TaskToken connection has changed".into());
        }
        let mut token = self.token.lock().await;
        if token.expires <= tokio::time::Instant::now() {
            *token = self.issuer.issue(&self.task_id).await?;
        }
        if !self.active.load(Ordering::Acquire) || !self.issuer.available() {
            return Err("Plugin TaskToken connection has changed".into());
        }
        Ok(token.value.clone())
    }
}

#[derive(Clone)]
struct Proxy {
    url: reqwest::Url,
    headers: HeaderMap,
    identity: Arc<Identity>,
    client: reqwest::Client,
    legacy_sse: bool,
    local: String,
    endpoint: Arc<Mutex<Option<reqwest::Url>>>,
}

async fn start_proxy(
    server: Value,
    identity: Arc<Identity>,
) -> Result<(String, JoinHandle<()>), String> {
    let url = server
        .get("url")
        .or_else(|| server.get("base_url"))
        .and_then(Value::as_str)
        .ok_or("TaskToken MCP requires an HTTP URL")?;
    let url = reqwest::Url::parse(url).map_err(|_| "Invalid TaskToken MCP URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("TaskToken MCP requires an HTTP URL without embedded credentials".into());
    }
    let mut headers = HeaderMap::new();
    for (key, value) in server["headers"]
        .as_object()
        .ok_or("TaskToken MCP requires headers")?
    {
        headers.insert(
            axum::http::HeaderName::try_from(key.as_str())
                .map_err(|_| "Invalid MCP header name")?,
            axum::http::HeaderValue::try_from(value.as_str().ok_or("Invalid MCP header value")?)
                .map_err(|_| "Invalid MCP header value")?,
        );
    }
    let mut state = Proxy {
        url,
        headers,
        identity,
        legacy_sse: server["type"] == "sse",
        local: String::new(),
        endpoint: Arc::new(Mutex::new(None)),
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "Cannot create TaskToken MCP client")?,
    };
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Cannot start TaskToken MCP route")?;
    let address = listener
        .local_addr()
        .map_err(|_| "Cannot resolve TaskToken MCP route")?;
    let path = format!("/mcp/{}", uuid::Uuid::new_v4());
    state.local = format!("http://{address}{path}");
    let router = Router::new()
        .route(&path, any(forward))
        .route(&format!("{path}/messages"), any(forward_message))
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .with_state(state);
    let worker = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((format!("http://{address}{path}"), worker))
}

async fn forward_message(
    State(mut proxy): State<Proxy>,
    method: Method,
    incoming: HeaderMap,
    body: Bytes,
) -> Response {
    let endpoint = proxy.endpoint.lock().await.clone();
    let Some(url) = endpoint else {
        return StatusCode::NOT_FOUND.into_response();
    };
    proxy.url = url;
    proxy.legacy_sse = false;
    forward(State(proxy), method, incoming, body).await
}

async fn forward(
    State(proxy): State<Proxy>,
    method: Method,
    incoming: HeaderMap,
    body: Bytes,
) -> Response {
    if incoming.contains_key("origin") {
        return (StatusCode::FORBIDDEN, "Browser requests are not allowed").into_response();
    }
    if !matches!(method, Method::GET | Method::POST | Method::DELETE) {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    match forward_inner(proxy, method, incoming, body).await {
        Ok(response) => response,
        Err(message) => (StatusCode::BAD_GATEWAY, message).into_response(),
    }
}

async fn forward_inner(
    proxy: Proxy,
    method: Method,
    incoming: HeaderMap,
    body: Bytes,
) -> Result<Response, String> {
    let token = proxy.identity.token().await?;
    let mut headers = HeaderMap::new();
    for key in [
        "accept",
        "content-type",
        "mcp-session-id",
        "mcp-protocol-version",
        "last-event-id",
    ] {
        if let Some(value) = incoming.get(key) {
            headers.insert(axum::http::HeaderName::from_static(key), value.clone());
        }
    }
    for (name, value) in &proxy.headers {
        let value = value
            .to_str()
            .map_err(|_| "Invalid MCP header")?
            .replace("${{task_token}}", &token);
        headers.insert(
            name.clone(),
            axum::http::HeaderValue::try_from(value).map_err(|_| "Invalid MCP header")?,
        );
    }
    let legacy_stream = proxy.legacy_sse && method == Method::GET;
    let response = tokio::time::timeout(
        Duration::from_secs(60),
        proxy
            .client
            .request(method, proxy.url.clone())
            .headers(headers)
            .body(body)
            .send(),
    )
    .await
    .map_err(|_| "Plugin TaskToken MCP request timed out")?
    .map_err(|_| "Plugin TaskToken MCP service is unavailable")?;
    // Never follow a redirect carrying an identity credential.
    if response.status().is_redirection() {
        return Err("Plugin TaskToken MCP redirects are not supported".into());
    }
    let mut output = Response::builder().status(response.status());
    for key in [
        "content-type",
        "mcp-session-id",
        "mcp-protocol-version",
        "cache-control",
        "retry-after",
    ] {
        if let Some(value) = response.headers().get(key) {
            output = output.header(key, value);
        }
    }
    let body = if legacy_stream {
        sse::body(response, proxy.url, proxy.local, proxy.endpoint)
    } else {
        Body::from_stream(response.bytes_stream())
    };
    output.body(body).map_err(|_| "Invalid MCP response".into())
}

#[cfg(test)]
mod tests;
