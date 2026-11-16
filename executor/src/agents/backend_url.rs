// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::env;

use crate::protocol::ExecutionRequest;

pub(crate) fn request_backend_url(request: &ExecutionRequest) -> Option<String> {
    env_url("WEGENT_BACKEND_URL")
        .or_else(|| {
            if is_local_mode() {
                payload_backend_url(request)
            } else {
                None
            }
        })
        .or_else(|| env_url("TASK_API_DOMAIN"))
        .or_else(|| payload_backend_url(request))
}

pub(crate) fn request_backend_url_or_default(request: &ExecutionRequest) -> String {
    request_backend_url(request).unwrap_or_else(|| "http://wegent-backend:8000".to_owned())
}

/// Point the cloud model gateway at the backend this device actually reaches.
///
/// Backend-compiled cloud model configs may carry an internal or stale public
/// URL. Always use the connected backend's gateway, including its port and path
/// prefix, while preserving the model identity and execution user's token.
/// Direct provider endpoints are not backend gateways and remain unchanged.
pub(crate) fn bind_backend_model_gateway(request: &mut ExecutionRequest, backend_url: &str) {
    let backend_url = backend_url.trim();
    let Ok(backend) = reqwest::Url::parse(backend_url) else {
        return;
    };
    if !matches!(backend.scheme(), "http" | "https") || backend.host_str().is_none() {
        return;
    }
    let Some(config) = request.model_config.as_object_mut() else {
        return;
    };
    const GATEWAY_PATH: &str = "/api/runtime-work/llm-responses-proxy";
    for key in ["base_url", "baseUrl", "ANTHROPIC_BASE_URL"] {
        let Some(current) = config.get(key).and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Ok(current) = reqwest::Url::parse(current.trim()) else {
            continue;
        };
        if !current.path().trim_end_matches('/').ends_with(GATEWAY_PATH) {
            continue;
        }
        let Ok(gateway) = super::runtime_capabilities::api_url(backend_url, GATEWAY_PATH) else {
            return;
        };
        config.insert(key.to_owned(), serde_json::Value::String(gateway));
    }
}

/// HTTP client for requests to the Wegent backend.
///
/// The executor hydrates the user's login-shell environment, which may export
/// proxy variables meant for other tooling. Backend reachability must depend
/// only on the configured backend URL, so this client never uses them.
pub(crate) fn backend_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|error| format!("failed to configure the backend HTTP client: {error}"))
}

pub(crate) fn is_local_mode() -> bool {
    env::var("EXECUTOR_MODE")
        .ok()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("local"))
}

fn env_url(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn payload_backend_url(request: &ExecutionRequest) -> Option<String> {
    request
        .backend_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvGuard {
        key: &'static str,
        old_value: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let old_value = env::var(key).ok();
            env::set_var(key, value);
            Self { key, old_value }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.old_value {
                env::set_var(self.key, value);
            } else {
                env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn backend_http_client_ignores_shell_proxy_environment() {
        use std::io::Write as _;
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let _lock = crate::test_env::lock();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let server = tokio::spawn(async move {
                    for _ in 0..2 {
                        let (mut stream, _) = listener.accept().await.unwrap();
                        let mut buffer = vec![0; 1024];
                        let _ = stream.read(&mut buffer).await.unwrap();
                        let mut response = std::io::Cursor::new(Vec::<u8>::new());
                        write!(
                            response,
                            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                        )
                        .unwrap();
                        stream.write_all(&response.into_inner()).await.unwrap();
                    }
                });
                // A proxy variable inherited from the user's login shell must
                // not divert backend traffic; the listener is on loopback and
                // the configured proxy address is not listening at all.
                let _proxy = EnvGuard::set("HTTP_PROXY", "http://127.0.0.1:1");
                let _upper = EnvGuard::set("HTTPS_PROXY", "http://127.0.0.1:1");
                let _all = EnvGuard::set("ALL_PROXY", "http://127.0.0.1:1");

                let client = backend_http_client().expect("backend client");
                let response = client
                    .get(format!("http://{address}/api/health"))
                    .send()
                    .await
                    .expect("backend request must reach the configured backend URL");
                assert_eq!(response.status(), 200);

                drop(server);
            });
    }
}
