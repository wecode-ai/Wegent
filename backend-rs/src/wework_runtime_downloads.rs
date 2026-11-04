// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authenticated artifact resolution for the desktop's pinned Python bootstrap.
use brz_http_server::{HttpResponse, StatusCode};
use serde::{Deserialize, Serialize};

use crate::{auth::SessionUser, http_compat::FastApiError};

const UV_VERSION: &str = "0.9.5";
const PYTHON_VERSION: &str = "3.12.12";
const PYTHON_BUILD: &str = "20251014";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DownloadRequest {
    platform: String,
    arch: String,
    uv_version: String,
    python_version: String,
}

#[derive(Debug, Serialize)]
struct Artifact {
    version: &'static str,
    url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDownloads {
    uv: Artifact,
    python: Artifact,
    expires_at: Option<String>,
}

#[brz_http_server::post("/api/wework/runtime-downloads")]
async fn runtime_downloads(
    #[auth] _user: SessionUser,
    body: DownloadRequest,
) -> Result<HttpResponse<RuntimeDownloads>, FastApiError> {
    let descriptor = download_descriptor(&body, |key| std::env::var(key).ok())?;
    HttpResponse::new(descriptor)
        .header("cache-control", "no-store")
        .map_err(|_| FastApiError::internal())
}

fn download_descriptor(
    request: &DownloadRequest,
    read: impl Fn(&str) -> Option<String>,
) -> Result<RuntimeDownloads, FastApiError> {
    if request.uv_version != UV_VERSION || request.python_version != PYTHON_VERSION {
        return Err(invalid_request("Unsupported runtime version"));
    }
    let arch = match request.arch.as_str() {
        "arm64" => "aarch64",
        "x64" => "x86_64",
        _ => return Err(invalid_request("Unsupported runtime architecture")),
    };
    let (target, extension) = match request.platform.as_str() {
        "darwin" => (format!("{arch}-apple-darwin"), "tar.gz"),
        "linux" => (format!("{arch}-unknown-linux-gnu"), "tar.gz"),
        "win32" => (format!("{arch}-pc-windows-msvc"), "zip"),
        _ => return Err(invalid_request("Unsupported runtime platform")),
    };
    Ok(RuntimeDownloads {
        uv: Artifact {
            version: UV_VERSION,
            url: artifact_url(
                read("WEWORK_UV_DOWNLOAD_BASE_URL"),
                "https://github.com/astral-sh/uv/releases/download/0.9.5/",
                &format!("uv-{target}.{extension}"),
            )?,
        },
        python: Artifact {
            version: PYTHON_VERSION,
            url: artifact_url(
                read("WEWORK_PYTHON_INSTALL_MIRROR"),
                "https://github.com/astral-sh/python-build-standalone/releases/download/",
                &format!(
                    "{PYTHON_BUILD}/cpython-{PYTHON_VERSION}%2B{PYTHON_BUILD}-{target}-install_only_stripped.tar.gz"
                ),
            )?,
        },
        // Public GitHub artifacts do not require expiring download grants.
        expires_at: None,
    })
}

fn artifact_url(
    value: Option<String>,
    default: &str,
    artifact: &str,
) -> Result<String, FastApiError> {
    let value = value.as_deref().unwrap_or_default().trim();
    let value = if value.is_empty() { default } else { value };
    let mut url = url::Url::parse(value).map_err(|_| unavailable())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(unavailable());
    }
    url.set_path(&format!("{}/", url.path().trim_end_matches('/')));
    url.join(artifact)
        .map(|url| url.to_string())
        .map_err(|_| unavailable())
}

fn invalid_request(message: &str) -> FastApiError {
    FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, message)
}

fn unavailable() -> FastApiError {
    FastApiError::detail(
        StatusCode::SERVICE_UNAVAILABLE,
        "Runtime download configuration unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(platform: &str, arch: &str) -> DownloadRequest {
        DownloadRequest {
            platform: platform.into(),
            arch: arch.into(),
            uv_version: UV_VERSION.into(),
            python_version: PYTHON_VERSION.into(),
        }
    }

    #[test]
    fn returns_pinned_public_artifacts_for_all_six_targets() {
        for platform in ["darwin", "linux", "win32"] {
            for arch in ["arm64", "x64"] {
                let result = download_descriptor(&request(platform, arch), |_| None).unwrap();
                let payload = serde_json::to_value(result).unwrap();
                assert!(
                    payload["uv"]["url"]
                        .as_str()
                        .unwrap()
                        .starts_with("https://github.com/astral-sh/uv/releases/download/0.9.5/uv-")
                );
                assert!(payload["python"]["url"].as_str().unwrap().starts_with("https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.12.12%2B20251014-"));
                assert!(
                    payload["python"]["url"]
                        .as_str()
                        .unwrap()
                        .ends_with("-install_only_stripped.tar.gz")
                );
                assert_eq!(payload["uv"]["version"], UV_VERSION);
                assert_eq!(payload["python"]["version"], PYTHON_VERSION);
                assert!(payload["expiresAt"].is_null());
            }
        }
    }

    #[test]
    fn configured_directories_produce_complete_artifact_urls() {
        let result = download_descriptor(&request("win32", "x64"), |_| {
            Some(" http://mirror.example.invalid/bucket/// ".into())
        })
        .unwrap();
        assert_eq!(
            result.uv.url,
            "http://mirror.example.invalid/bucket/uv-x86_64-pc-windows-msvc.zip"
        );
        assert_eq!(
            result.python.url,
            "http://mirror.example.invalid/bucket/20251014/cpython-3.12.12%2B20251014-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
        );
        let blank =
            download_descriptor(&request("darwin", "arm64"), |_| Some("  ".into())).unwrap();
        assert!(blank.uv.url.starts_with("https://github.com/astral-sh/uv/"));
    }

    #[test]
    fn rejects_unsupported_targets_and_versions_before_reading_storage_config() {
        let mut invalid = vec![request("../bucket", "x64"), request("darwin", "../../key")];
        let mut version = request("darwin", "arm64");
        version.python_version = "3.13.0".into();
        invalid.push(version);
        for input in invalid {
            assert!(
                download_descriptor(&input, |_| panic!("Invalid target reached config")).is_err()
            );
        }
        assert!(serde_json::from_value::<DownloadRequest>(serde_json::json!({"platform":"darwin","arch":"arm64","uvVersion":"0.9.5","pythonVersion":"3.12.12","storageKey":"private"})).is_err());
    }

    #[test]
    fn rejects_credentials_and_query_parameters_in_storage_configuration() {
        for value in [
            "bad-url",
            "file:///tmp/uv",
            "https://user:secret@example.invalid/",
            "https://example.invalid/?token=secret",
            "https://example.invalid/#fragment",
        ] {
            assert!(
                download_descriptor(&request("darwin", "arm64"), |_| Some(value.into())).is_err()
            );
        }
    }

    #[test]
    fn protected_route_is_registered_and_selected_by_the_gateway() {
        use brz_http_server::__private::inventory;
        let routes: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)())
            .filter(|route| route.path == "/api/wework/runtime-downloads")
            .collect();
        assert_eq!(routes.len(), 1);
        let table = crate::load_routes_config(std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/config/routes.toml"
        )))
        .unwrap();
        let table = crate::RouteTable::compile(table).unwrap();
        assert!(table.matches(&http::Method::POST, "/api/wework/runtime-downloads"));
        assert!(!table.matches(&http::Method::GET, "/api/wework/runtime-downloads"));
    }
}
