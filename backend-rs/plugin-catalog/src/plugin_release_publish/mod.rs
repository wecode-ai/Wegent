// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/internal/plugins/releases` — publish the exact artifact produced
//! by the protected plugin publication pipeline.
//!
//! Mirrors `app.api.endpoints.internal.plugin_publications.publish_plugin_release`
//! and `app.services.auth.plugin_release_key.verify_plugin_release_key`:
//! authenticate the dedicated `plugin_release` bearer key, bind the multipart
//! `metadata`/`package` parts and the `Idempotency-Key` header, validate the
//! release envelope, verify the artifact identity, then hand the envelope to
//! [`service::publish_enterprise_release`].
//!
//! FastAPI solves the authentication dependency before it parses the body, so
//! an unauthenticated request is rejected with `401` even when its content is
//! not multipart. The handler therefore reads the raw body itself and parses
//! it only after authentication succeeds.

mod artifact;
mod gitlab;
mod marketplace;
mod metadata;
mod package;
mod service;
mod settings;

use brz_http_server::{StatusCode, Upload};
use brz_mysql::MysqlTransaction;
use chrono::{NaiveDateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};

use crate::CatalogState;
use crate::http_compat::FastApiError;
use wegent_storage::s3_signing::hex_sha256;

use metadata::{MAX_PLUGIN_PACKAGE_SIZE_BYTES, PluginReleaseMetadata};

/// `PluginReleasePublishResponse` (`app.schemas.plugin_publication`), rendered
/// with the pydantic declaration order and the `catalogNamespace` default.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginReleasePublishResponse {
    pub plugin_id: i64,
    pub release_id: i64,
    pub created: bool,
    pub catalog_namespace: &'static str,
    pub slug: String,
    pub version: String,
    pub sha256: String,
}

impl PluginReleasePublishResponse {
    /// `PluginReleaseMetadata.model_validate(binding.response_json)` for a
    /// reused idempotency binding: the persisted response already carries the
    /// namespace, but a row written before the field existed leaves it out.
    pub(crate) fn from_stored(value: &Value) -> Option<Self> {
        Some(Self {
            plugin_id: value.get("pluginId")?.as_i64()?,
            release_id: value.get("releaseId")?.as_i64()?,
            created: value.get("created")?.as_bool()?,
            catalog_namespace: "enterprise",
            slug: value.get("slug")?.as_str()?.to_owned(),
            version: value.get("version")?.as_str()?.to_owned(),
            sha256: value.get("sha256")?.as_str()?.to_owned(),
        })
    }

    /// `response.model_dump(mode="json")` for the idempotency binding.
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "pluginId": self.plugin_id,
            "releaseId": self.release_id,
            "created": self.created,
            "catalogNamespace": self.catalog_namespace,
            "slug": self.slug,
            "version": self.version,
            "sha256": self.sha256,
        })
    }
}

/// `PluginReleasePrincipal`: the authenticated release key identity.
#[derive(Debug, Clone)]
struct PluginReleasePrincipal {
    key_id: i64,
}

/// POST /api/internal/plugins/releases.
#[brz_http_server::post("/api/internal/plugins/releases", access = public)]
async fn publish_plugin_release(
    #[inject(state)] state: &CatalogState,
    #[header("authorization")] authorization: Option<&str>,
    #[header("idempotency-key")] idempotency_key: Option<&str>,
    #[header("content-type")] content_type: Option<&str>,
    body: &[u8],
) -> Result<PluginReleasePublishResponse, FastApiError> {
    // FastAPI resolves `Depends(verify_plugin_release_key)` before the header
    // parameter and before the Form/File body, so authentication wins.
    let principal = authenticate(state, authorization.unwrap_or("")).await?;
    let idempotency_key = require_idempotency_key(idempotency_key)?;
    let (metadata_text, package) = bind_multipart(body, content_type).await?;
    let metadata = parse_metadata(&metadata_text)?;
    artifact::validate_idempotency_key_format(&idempotency_key)?;
    ensure_protected_master(&metadata)?;
    let filename = package.filename.clone();
    let package_bytes = bound_package(package)?;
    validate_artifact_identity(&metadata, &filename, &package_bytes)?;
    let parsed = package::parse(&package_bytes)?;
    if parsed.version.as_deref().unwrap_or("").is_empty() {
        return Err(unprocessable("Plugin version is required"));
    }
    if parsed.name != metadata.plugin.slug
        || parsed.version.as_deref() != Some(metadata.plugin.version.as_str())
    {
        return Err(unprocessable(
            "Artifact manifest does not match release metadata",
        ));
    }
    service::publish_enterprise_release(
        state,
        package_bytes,
        &metadata,
        &idempotency_key,
        principal.key_id,
    )
    .await
}

fn unprocessable(detail: impl Into<String>) -> FastApiError {
    FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, detail.into())
}

fn unauthorized_required() -> FastApiError {
    FastApiError::unauthorized("A plugin_release Bearer token is required")
}

/// `verify_plugin_release_key`'s credential shape check: a Bearer scheme and a
/// `wg-` raw key without a `#`. Anything else is rejected before database
/// access.
fn release_key_candidate(authorization: &str) -> Option<&str> {
    let (scheme, raw_key) = match authorization.split_once(' ') {
        Some((scheme, raw_key)) => (scheme, raw_key),
        None => (authorization, ""),
    };
    let raw_key = raw_key.trim();
    (scheme.eq_ignore_ascii_case("bearer") && raw_key.starts_with("wg-") && !raw_key.contains('#'))
        .then_some(raw_key)
}

/// `verify_plugin_release_key`.
async fn authenticate(
    state: &CatalogState,
    authorization: &str,
) -> Result<PluginReleasePrincipal, FastApiError> {
    let Some(raw_key) = release_key_candidate(authorization) else {
        return Err(unauthorized_required());
    };
    let key_hash = hex_sha256(raw_key.as_bytes());
    let now = Utc::now().naive_utc();
    let key_id = state
        .mysql
        .with_transaction(async |transaction| {
            let record: Option<ReleaseKeyRow> = transaction
                .fetch_optional(RELEASE_KEY_QUERY, (key_hash.as_str(),))
                .await?;
            let Some(record) = record else {
                return Ok(None);
            };
            if record.expires_at <= now {
                return Ok(None);
            }
            transaction
                .execute(
                    "UPDATE api_keys SET api_keys.last_used_at = ? WHERE api_keys.id = ?",
                    (sql_datetime(now), record.id),
                )
                .await?;
            Ok(Some(record.id))
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, "plugin release key database dependency failure");
            FastApiError::unhandled()
        })?;
    key_id
        .map(|key_id| PluginReleasePrincipal { key_id })
        .ok_or_else(|| FastApiError::unauthorized("Plugin release token is invalid or expired"))
}

/// One `api_keys` row for the dedicated release key type.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct ReleaseKeyRow {
    #[mysql(rename = "api_keys_id")]
    id: i64,
    #[mysql(rename = "api_keys_expires_at")]
    expires_at: NaiveDateTime,
}

/// `db.query(APIKey).filter(key_hash, key_type, is_active).first()`.
const RELEASE_KEY_QUERY: &str = "SELECT api_keys.id AS api_keys_id, \
     api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, \
     api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, \
     api_keys.key_type AS api_keys_key_type, api_keys.description AS api_keys_description, \
     api_keys.expires_at AS api_keys_expires_at, api_keys.last_used_at AS api_keys_last_used_at, \
     api_keys.is_active AS api_keys_is_active, api_keys.created_at AS api_keys_created_at, \
     api_keys.updated_at AS api_keys_updated_at \
     FROM api_keys \
     WHERE api_keys.key_hash = ? AND api_keys.key_type = 'plugin_release' \
     AND api_keys.is_active IS true LIMIT 1";

/// SQLAlchemy binds a naive datetime as `'%Y-%m-%d %H:%M:%S.%f'`.
fn sql_datetime(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

/// `idempotency_key: Header(alias="Idempotency-Key", min_length=81,
/// max_length=81)`. Header parameter validation runs after dependencies and
/// before the body.
fn require_idempotency_key(value: Option<&str>) -> Result<String, FastApiError> {
    let Some(value) = value else {
        return Err(FastApiError::validation(vec![json!({
            "type": "missing",
            "loc": ["header", "idempotency-key"],
            "msg": "Field required",
            "input": Value::Null,
        })]));
    };
    let length = value.chars().count();
    if length < 81 {
        return Err(FastApiError::validation(vec![json!({
            "type": "string_too_short",
            "loc": ["header", "idempotency-key"],
            "msg": "String should have at least 81 characters",
            "input": value,
            "ctx": {"min_length": 81},
        })]));
    }
    if length > 81 {
        return Err(FastApiError::validation(vec![json!({
            "type": "string_too_long",
            "loc": ["header", "idempotency-key"],
            "msg": "String should have at most 81 characters",
            "input": value,
            "ctx": {"max_length": 81},
        })]));
    }
    Ok(value.to_owned())
}

/// The `package` `File(...)` part.
struct PackagePart {
    filename: String,
    bytes: Vec<u8>,
}

/// FastAPI's `Form(...)`/`File(...)` binding for the two required parts.
async fn bind_multipart(
    body: &[u8],
    content_type: Option<&str>,
) -> Result<(String, PackagePart), FastApiError> {
    if !content_type.is_some_and(|value| {
        value
            .to_ascii_lowercase()
            .starts_with("multipart/form-data")
    }) {
        // Starlette's `request.form()` yields an empty form for other content
        // types, so both required parts render as missing.
        return Err(missing_parts_error());
    }
    let multipart =
        match brz_http_server::__private::multipart(body, content_type.map(str::as_bytes)).await {
            Ok(multipart) => multipart,
            Err(_) => {
                return Err(FastApiError::detail(
                    StatusCode::BAD_REQUEST,
                    "There was an error parsing the body",
                ));
            }
        };
    let metadata = multipart.get("metadata");
    let package = multipart.get("package");
    if metadata.is_none() || package.is_none() {
        return Err(missing_parts_error());
    }
    let metadata = metadata.expect("checked above");
    let package = package.expect("checked above");
    let Ok(metadata_text) = metadata.text() else {
        return Err(FastApiError::validation(vec![json!({
            "type": "string_unicode",
            "loc": ["body", "metadata"],
            "msg": "Input should be a valid string",
            "input": Value::Null,
        })]));
    };
    Ok((metadata_text.to_owned(), package_part(package)))
}

fn missing_parts_error() -> FastApiError {
    FastApiError::validation(vec![
        json!({
            "type": "missing",
            "loc": ["body", "metadata"],
            "msg": "Field required",
            "input": Value::Null,
        }),
        json!({
            "type": "missing",
            "loc": ["body", "package"],
            "msg": "Field required",
            "input": Value::Null,
        }),
    ])
}

fn package_part(package: &Upload) -> PackagePart {
    PackagePart {
        filename: package.filename.clone().unwrap_or_default(),
        bytes: package.bytes.to_vec(),
    }
}

/// `_parse_metadata`: JSON decode plus `PluginReleaseMetadata.model_validate`,
/// rendered as the endpoint's single invalid-metadata rejection.
fn parse_metadata(value: &str) -> Result<PluginReleaseMetadata, FastApiError> {
    let raw: Value =
        serde_json::from_str(value).map_err(|_| unprocessable("Invalid release metadata"))?;
    metadata::parse(&raw).ok_or_else(|| unprocessable("Invalid release metadata"))
}

/// `_ensure_protected_master`.
fn ensure_protected_master(metadata: &PluginReleaseMetadata) -> Result<(), FastApiError> {
    let project_id = settings::gitlab_project_id();
    if project_id.is_empty() {
        return Err(FastApiError::detail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Plugin publication GitLab project is not configured",
        ));
    }
    if metadata.source.project_id != project_id {
        return Err(FastApiError::forbidden("Release project is not configured"));
    }
    let target_branch = settings::gitlab_target_branch();
    let allowed = [target_branch.clone(), format!("refs/heads/{target_branch}")];
    if !allowed.contains(&metadata.source.git_ref) {
        return Err(FastApiError::forbidden(
            "Only the protected plugin publication branch may release",
        ));
    }
    Ok(())
}

/// `_read_package`: a 50 MiB bound and the empty-package rejection.
fn bound_package(package: PackagePart) -> Result<Vec<u8>, FastApiError> {
    if package.bytes.len() as i64 > MAX_PLUGIN_PACKAGE_SIZE_BYTES {
        return Err(FastApiError::detail(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Plugin package is too large",
        ));
    }
    if package.bytes.is_empty() {
        return Err(unprocessable("Plugin package is empty"));
    }
    Ok(package.bytes)
}

/// The endpoint's artifact filename, digest, and size checks.
fn validate_artifact_identity(
    metadata: &PluginReleaseMetadata,
    filename: &str,
    package: &[u8],
) -> Result<(), FastApiError> {
    if metadata.artifact.file != filename {
        return Err(unprocessable("Artifact filename mismatch"));
    }
    if metadata.artifact.sha256 != hex_sha256(package) {
        return Err(unprocessable("Artifact SHA256 mismatch"));
    }
    if metadata.artifact.size_bytes != package.len() as i64 {
        return Err(unprocessable("Artifact size mismatch"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_metadata() -> PluginReleaseMetadata {
        let value = json!({
            "schemaVersion": 1,
            "changed": true,
            "plugin": {"slug": "pipeline-plugin", "version": "1.2.3"},
            "artifact": {
                "file": "plugin.zip",
                "sha256": "a".repeat(64),
                "sizeBytes": 42
            },
            "source": {
                "projectId": "42",
                "ref": "master",
                "sourceCommitSha": "b".repeat(40),
                "pipelineId": 99,
                "pipelineUrl": "https://git.invalid/pipelines/99",
                "metadata": {"projectPath": "wework-plugins"}
            }
        });
        metadata::parse(&value).unwrap()
    }

    #[test]
    fn plugin_release_auth_requires_a_bearer_wg_key() {
        // Every recorded request omits the header, so the empty value must be
        // rejected without a database lookup.
        assert_eq!(release_key_candidate(""), None);
        assert_eq!(release_key_candidate("Bearer"), None);
        assert_eq!(release_key_candidate("Bearer test"), None);
        assert_eq!(release_key_candidate("Basic wg-key"), None);
        assert_eq!(release_key_candidate("Bearer wg-a#b"), None);
        assert_eq!(release_key_candidate("bearer  wg-abc  "), Some("wg-abc"));
    }

    #[test]
    fn idempotency_header_is_exactly_81_characters() {
        assert!(require_idempotency_key(None).is_err());
        assert!(require_idempotency_key(Some(&"x".repeat(80))).is_err());
        assert!(require_idempotency_key(Some(&"x".repeat(82))).is_err());
        assert!(require_idempotency_key(Some(&"x".repeat(81))).is_ok());
    }

    #[test]
    fn protected_master_requires_the_configured_project_and_branch() {
        let metadata = valid_metadata();
        // The default settings leave the project unconfigured.
        let error = ensure_protected_master(&metadata).unwrap_err();
        assert_eq!(
            error.detail_message(),
            Some("Plugin publication GitLab project is not configured")
        );
    }
}
