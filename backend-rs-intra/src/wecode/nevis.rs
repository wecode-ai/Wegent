// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Nevis Sandbox API settings and client.
//!
//! Mirrors `wecode/config/nevis_config.py` (`NevisSettings`) and
//! `wecode/service/nevis_client.py` (`NevisClient`). Only the sandbox read
//! used by `GET /api/cloud-devices/{device_id}/status` is ported here; create,
//! restart, delete, and metrics belong to the endpoints that call them.
//!
//! The source builds one `NevisClient` at import time and snapshots the four
//! settings then; the target builds one client during startup from the same
//! environment/dotenv lookup and keeps it for the process lifetime. Each
//! request's `httpx.AsyncClient(timeout=30.0)` is per call in the source, but
//! the request carries no connection-local state, so the target reuses one
//! pooled client with the same 30-second connect/read budget (httpx applies
//! its timeout to every phase).
use std::time::Duration;

use brz_http::Client as HttpClient;
use wegent_backend_rs::config::env_or_dotenv;

/// `nevis_client.NEVIS_TIMEOUT = 30.0` (seconds).
const NEVIS_TIMEOUT: Duration = Duration::from_secs(30);

/// Stable metric profile for the per-sandbox route. The sandbox id is a
/// high-cardinality path component, so the profile name is the route template
/// rather than the resolved URL (`Client::endpoint_named`).
const SANDBOX_PROFILE: &str =
    "http://nevis/apis/sandboxes/v1/managers/:manager_id/sandboxes/:sandbox_id";

/// The four required settings (`NevisSettings`); every field is read from the
/// environment or the mounted dotenv exactly like pydantic-settings does.
pub(crate) struct NevisSettings {
    base_url: String,
    manager_id: String,
    image_id: String,
    signature: String,
}

impl NevisSettings {
    /// `NevisClient.__init__`: `NEVIS_BASE_URL.rstrip("/")` and the three
    /// other settings, each defaulting to the pydantic empty string.
    pub(crate) fn from_env() -> Self {
        Self::from_values(
            env_or_dotenv("NEVIS_BASE_URL"),
            env_or_dotenv("NEVIS_MANAGER_ID"),
            env_or_dotenv("NEVIS_IMAGE_ID"),
            env_or_dotenv("NEVIS_SIGNATURE"),
        )
    }

    /// The four settings after the source's `rstrip("/")` on the base URL and
    /// the pydantic empty-string defaults.
    fn from_values(
        base_url: Option<String>,
        manager_id: Option<String>,
        image_id: Option<String>,
        signature: Option<String>,
    ) -> Self {
        Self {
            base_url: base_url
                .unwrap_or_default()
                .trim_end_matches('/')
                .to_string(),
            manager_id: manager_id.unwrap_or_default(),
            image_id: image_id.unwrap_or_default(),
            signature: signature.unwrap_or_default(),
        }
    }

    /// `NevisClient.is_configured`: every setting must be non-empty.
    pub(crate) fn is_configured(&self) -> bool {
        !self.base_url.is_empty()
            && !self.manager_id.is_empty()
            && !self.image_id.is_empty()
            && !self.signature.is_empty()
    }

    /// `NevisClient._get_sandboxes_url(sandbox_id)`.
    pub(crate) fn sandbox_url(&self, sandbox_id: &str) -> String {
        format!(
            "{}/apis/sandboxes/v1/managers/{}/sandboxes/{}",
            self.base_url, self.manager_id, sandbox_id
        )
    }
}

/// One `SandboxService.GetSandbox` document, projected to the members
/// `CloudDeviceProvider.get_vm_status` reads. Unknown members are ignored,
/// like the source's dict lookups. A member whose JSON type does not fit the
/// projection fails the decode, which the endpoint renders as its generic
/// 500 — the same outcome as the source's pydantic validation of the mapped
/// fields.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct SandboxDocument {
    /// `result.get("id", device_id)`.
    pub(crate) id: Option<String>,
    /// `result.get("status", "unknown")`.
    pub(crate) status: Option<String>,
    /// `result.get("createdAt")`: the sandbox creation timestamp as Nevis
    /// reports it (RFC 3339 with a `Z` offset).
    #[serde(rename = "createdAt")]
    pub(crate) created_at: Option<String>,
    /// `result.get("details") or {}`.
    pub(crate) details: SandboxDetails,
}

/// The `details` object of a sandbox document.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct SandboxDetails {
    /// `details.get("urls")`: the VM address as Nevis reports it. It is not
    /// necessarily a normalized IP; `normalize_nevis_ip` decides that for the
    /// IP index while the response echoes this raw value.
    pub(crate) urls: Option<String>,
    /// `details.get("vnc_url")`: the VNC viewer URL when the sandbox exposes
    /// one.
    pub(crate) vnc_url: Option<String>,
}

/// The failure modes of `NevisClient.get_sandbox`, split by how the source's
/// `try` block in the status endpoint observes them.
#[derive(Debug)]
pub(crate) enum NevisClientError {
    /// `NevisClientError(message, status_code=...)`: an HTTP error status
    /// (including the 404 the endpoint maps to its own 404), or the
    /// "not properly configured" / `httpx.RequestError` paths, which carry no
    /// status code.
    Client {
        status: Option<u16>,
        message: String,
    },
    /// The response body is not the expected sandbox document.
    ///
    /// The source reads the body with `response.json()`, so a non-JSON body
    /// raises `json.JSONDecodeError` — not an `httpx.HTTPError` — and reaches
    /// the endpoint's generic `except Exception` handler. The target decodes a
    /// typed document, so a JSON body of the wrong shape lands here too,
    /// which is where the source's pydantic validation would raise.
    /// [`Self::InvalidBody`] is kept out of the Nevis branch by the endpoint.
    InvalidBody,
}

impl NevisClientError {
    /// `NevisClientError.status_code`, absent for the transport paths.
    pub(crate) fn status_code(&self) -> Option<u16> {
        match self {
            Self::Client { status, .. } => *status,
            Self::InvalidBody => None,
        }
    }

    /// `str(error)`, embedded in the endpoint's 500 detail.
    pub(crate) fn message(&self) -> &str {
        match self {
            Self::Client { message, .. } => message,
            Self::InvalidBody => "invalid sandbox response",
        }
    }
}

/// `NevisClient`: one process-lifetime client over the shared pooled
/// connection.
pub(crate) struct NevisClient {
    settings: NevisSettings,
    http: HttpClient,
}

impl NevisClient {
    /// Build the retained client. httpx does not follow redirects, so the
    /// transport mirrors that policy instead of reqwest's default redirect
    /// limit.
    pub(crate) fn new(settings: NevisSettings) -> Result<Self, brz_http::Error> {
        let http = HttpClient::builder()
            .connect_timeout(NEVIS_TIMEOUT)
            .read_timeout(NEVIS_TIMEOUT)
            .configure(|builder| builder.redirect(brz_http::reqwest::redirect::Policy::none()))
            .build()?;
        Ok(Self { settings, http })
    }

    /// `NevisClient.is_configured`.
    pub(crate) fn is_configured(&self) -> bool {
        self.settings.is_configured()
    }

    /// `NevisClient.get_sandbox(sandbox_id)`: one `GET` carrying the two
    /// headers of `_get_headers`.
    pub(crate) async fn get_sandbox(
        &self,
        sandbox_id: &str,
    ) -> Result<SandboxDocument, NevisClientError> {
        if !self.is_configured() {
            return Err(NevisClientError::Client {
                status: None,
                message: "Nevis client is not properly configured".to_string(),
            });
        }
        let endpoint = self
            .http
            .endpoint_named(self.settings.sandbox_url(sandbox_id), SANDBOX_PROFILE)
            .map_err(|error| request_error(&error.to_string()))?;
        let request = endpoint
            .get()
            .header("X-Signature", self.settings.signature.as_str())
            .header("Content-Type", "application/json")
            .build()
            .map_err(|error| request_error(&error.to_string()))?;
        let response = self
            .http
            .execute(request)
            .await
            .map_err(|error| request_error(&error.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            if status == brz_http::StatusCode::NOT_FOUND {
                return Err(NevisClientError::Client {
                    status: Some(404),
                    message: format!("Sandbox not found: {sandbox_id}"),
                });
            }
            return Err(NevisClientError::Client {
                status: Some(status.as_u16()),
                message: format!("Failed to get sandbox: {body}"),
            });
        }
        let body = response
            .text()
            .await
            .map_err(|error| request_error(&format!("response body read failed: {error}")))?;
        serde_json::from_str::<SandboxDocument>(&body).map_err(|_| NevisClientError::InvalidBody)
    }
}

/// `httpx.RequestError` text for a transport failure. httpx reports a timeout
/// as `timed out` and every other connection failure as `All connection
/// attempts failed`; the mapping keeps the observable 500 detail shape rather
/// than the exact socket error.
fn request_error(detail: &str) -> NevisClientError {
    let reason = if detail.contains("timed out") || detail.contains("timeout") {
        "timed out"
    } else {
        "All connection attempts failed"
    };
    NevisClientError::Client {
        status: None,
        message: format!("Failed to connect to Nevis API: {reason}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(base_url: &str) -> NevisSettings {
        NevisSettings {
            base_url: base_url.to_string(),
            manager_id: "manager-1".to_string(),
            image_id: "image-1".to_string(),
            signature: "sig-1".to_string(),
        }
    }

    #[test]
    fn sandbox_url_matches_source_layout() {
        assert_eq!(
            settings("http://cloud.nevis.example").sandbox_url("sandbox-1"),
            "http://cloud.nevis.example/apis/sandboxes/v1/managers/manager-1/sandboxes/sandbox-1"
        );
    }

    #[test]
    fn base_url_strips_trailing_slashes_like_the_source_constructor() {
        let settings = NevisSettings::from_values(
            Some("http://cloud.nevis.example/".to_string()),
            Some("manager-1".to_string()),
            None,
            None,
        );
        assert_eq!(
            settings.sandbox_url("sandbox-1"),
            "http://cloud.nevis.example/apis/sandboxes/v1/managers/manager-1/sandboxes/sandbox-1"
        );
    }

    #[test]
    fn missing_settings_default_to_the_pydantic_empty_string() {
        let settings = NevisSettings::from_values(None, Some("manager-1".to_string()), None, None);
        assert!(!settings.is_configured());
        assert_eq!(settings.base_url, "");
        assert_eq!(settings.manager_id, "manager-1");
    }

    #[test]
    fn is_configured_requires_every_setting() {
        assert!(settings("http://cloud.nevis.example").is_configured());
        for field in ["base_url", "manager_id", "image_id", "signature"] {
            let mut candidate = settings("http://cloud.nevis.example");
            match field {
                "base_url" => candidate.base_url.clear(),
                "manager_id" => candidate.manager_id.clear(),
                "image_id" => candidate.image_id.clear(),
                _ => candidate.signature.clear(),
            }
            assert!(!candidate.is_configured(), "{field} must be required");
        }
    }

    #[test]
    fn sandbox_document_projects_the_fields_get_vm_status_reads() {
        let document = serde_json::from_str::<SandboxDocument>(
            r#"{
                "id": "sandbox-1",
                "managerId": "manager-1",
                "status": "RUNNING",
                "createdAt": "2026-06-11T06:47:23.404Z",
                "details": {"urls": "192.0.2.10", "vnc_enabled": true}
            }"#,
        )
        .expect("sandbox document");
        assert_eq!(document.id.as_deref(), Some("sandbox-1"));
        assert_eq!(document.status.as_deref(), Some("RUNNING"));
        assert_eq!(
            document.created_at.as_deref(),
            Some("2026-06-11T06:47:23.404Z")
        );
        assert_eq!(document.details.urls.as_deref(), Some("192.0.2.10"));
        // `details.vnc_url` is absent for a sandbox without VNC access.
        assert_eq!(document.details.vnc_url, None);
    }

    #[test]
    fn sandbox_document_defaults_are_absent_like_the_source_dict_lookups() {
        let document =
            serde_json::from_str::<SandboxDocument>("{}").expect("empty sandbox document");
        assert_eq!(document.id, None);
        assert_eq!(document.status, None);
        assert_eq!(document.created_at, None);
        assert_eq!(document.details.urls, None);
    }

    #[test]
    fn a_member_of_the_wrong_type_fails_the_projection() {
        let result =
            serde_json::from_str::<SandboxDocument>(r#"{"details": {"urls": ["192.0.2.10"]}}"#);
        assert!(result.is_err());
    }

    #[test]
    fn error_status_and_message_match_the_source_mapping() {
        let not_found = NevisClientError::Client {
            status: Some(404),
            message: "Sandbox not found: sandbox-1".to_string(),
        };
        assert_eq!(not_found.status_code(), Some(404));
        assert_eq!(not_found.message(), "Sandbox not found: sandbox-1");

        let api = NevisClientError::Client {
            status: Some(503),
            message: "Failed to get sandbox: upstream down".to_string(),
        };
        assert_eq!(api.status_code(), Some(503));
        assert_eq!(api.message(), "Failed to get sandbox: upstream down");

        let request = request_error("error sending request");
        assert_eq!(request.status_code(), None);
        assert_eq!(
            request.message(),
            "Failed to connect to Nevis API: All connection attempts failed"
        );
        assert_eq!(
            request_error("operation timed out").message(),
            "Failed to connect to Nevis API: timed out"
        );

        // The body-decode path reports no Nevis status so the endpoint's
        // generic 500 branch renders it.
        assert_eq!(NevisClientError::InvalidBody.status_code(), None);
    }
}
