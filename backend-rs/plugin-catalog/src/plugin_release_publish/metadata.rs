// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PluginReleaseMetadata` validation (`app.schemas.plugin_publication`).
//!
//! The release endpoint receives its metadata as a multipart `metadata` text
//! part, not as a pydantic body model, so `_parse_metadata` converts every
//! schema failure into one `422 {"detail": "Invalid release metadata"}`. The
//! validators therefore only need to answer valid or invalid; they do not
//! render pydantic error arrays.

use serde_json::{Map, Value, json};

/// `MAX_PLUGIN_PACKAGE_SIZE_BYTES` (`app.services.plugin_package_parser`).
pub const MAX_PLUGIN_PACKAGE_SIZE_BYTES: i64 = 50 * 1024 * 1024;
/// `PluginReleaseIdentity.version` upper bound.
const MAX_VERSION_LENGTH: usize = 50;

/// `PluginReleaseIdentity`: the manifest identity the artifact must match.
#[derive(Debug, Clone)]
pub struct PluginReleaseIdentity {
    pub slug: String,
    pub version: String,
    pub listing_type: String,
}

/// `PluginReleaseArtifact`: the exact uploaded artifact identity.
#[derive(Debug, Clone)]
pub struct PluginReleaseArtifact {
    pub file: String,
    pub sha256: String,
    pub size_bytes: i64,
}

/// `PluginReleaseSourceMetadata`: `extra="forbid"`, one project path.
#[derive(Debug, Clone)]
pub struct PluginReleaseSourceMetadata {
    pub project_path: String,
}

/// `PluginReleaseProvenance`: the protected pipeline that produced the artifact.
#[derive(Debug, Clone)]
pub struct PluginReleaseProvenance {
    pub project_id: String,
    pub git_ref: String,
    pub source_commit_sha: String,
    pub pipeline_id: i64,
    pub pipeline_url: String,
    pub metadata: PluginReleaseSourceMetadata,
}

/// `PluginReleaseMetadata`: the complete release envelope.
#[derive(Debug, Clone)]
pub struct PluginReleaseMetadata {
    pub schema_version: i64,
    pub changed: bool,
    pub plugin: PluginReleaseIdentity,
    pub artifact: PluginReleaseArtifact,
    pub source: PluginReleaseProvenance,
    pub request_id: Option<i64>,
    pub revision: Option<i64>,
}

impl PluginReleaseMetadata {
    /// `metadata.model_dump(mode="json")`: every field, defaults included, in
    /// the pydantic declaration order. The canonical envelope hashes sort keys,
    /// so the order only keeps the stored `envelope_json` readable.
    pub fn to_json(&self) -> Value {
        let mut root = Map::new();
        root.insert("schemaVersion".into(), json!(self.schema_version));
        root.insert("changed".into(), json!(self.changed));
        root.insert(
            "plugin".into(),
            json!({
                "slug": self.plugin.slug,
                "version": self.plugin.version,
                "listingType": self.plugin.listing_type,
            }),
        );
        root.insert(
            "artifact".into(),
            json!({
                "file": self.artifact.file,
                "sha256": self.artifact.sha256,
                "sizeBytes": self.artifact.size_bytes,
            }),
        );
        root.insert(
            "source".into(),
            json!({
                "projectId": self.source.project_id,
                "ref": self.source.git_ref,
                "sourceCommitSha": self.source.source_commit_sha,
                "pipelineId": self.source.pipeline_id,
                "pipelineUrl": self.source.pipeline_url,
                "metadata": {
                    "projectPath": self.source.metadata.project_path,
                },
            }),
        );
        root.insert("requestId".into(), json!(self.request_id));
        root.insert("revision".into(), json!(self.revision));
        Value::Object(root)
    }
}

/// `PluginReleaseMetadata.model_validate(raw)`. A failure is reported as the
/// endpoint's single `Invalid release metadata` rejection.
pub fn parse(value: &Value) -> Option<PluginReleaseMetadata> {
    let root = value.as_object()?;
    forbid_extra(
        root,
        &[
            "schemaVersion",
            "changed",
            "plugin",
            "artifact",
            "source",
            "requestId",
            "revision",
        ],
    )?;
    // `schemaVersion: Literal[1]`
    if root.get("schemaVersion").and_then(Value::as_i64) != Some(1) {
        return None;
    }
    // `changed: Literal[True]`
    if root.get("changed").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let plugin = parse_identity(root.get("plugin")?)?;
    let artifact = parse_artifact(root.get("artifact")?)?;
    let source = parse_provenance(root.get("source")?)?;
    let request_id = optional_positive_int(root.get("requestId"))?;
    let revision = optional_positive_int(root.get("revision"))?;
    // `require_complete_publication_identity`
    if request_id.is_some() != revision.is_some() {
        return None;
    }
    Some(PluginReleaseMetadata {
        schema_version: 1,
        changed: true,
        plugin,
        artifact,
        source,
        request_id,
        revision,
    })
}

fn parse_identity(value: &Value) -> Option<PluginReleaseIdentity> {
    let object = value.as_object()?;
    forbid_extra(object, &["slug", "version", "listingType"])?;
    let slug = bounded_string(object.get("slug")?, 1, 100)?;
    let version = bounded_string(object.get("version")?, 1, MAX_VERSION_LENGTH)?;
    let listing_type = match object.get("listingType") {
        None => "plugin".to_owned(),
        Some(value) => {
            let value = value.as_str()?;
            if !matches!(value, "plugin" | "skill") {
                return None;
            }
            value.to_owned()
        }
    };
    Some(PluginReleaseIdentity {
        slug,
        version,
        listing_type,
    })
}

fn parse_artifact(value: &Value) -> Option<PluginReleaseArtifact> {
    let object = value.as_object()?;
    forbid_extra(object, &["file", "sha256", "sizeBytes"])?;
    let file = bounded_string(object.get("file")?, 1, 255)?;
    let sha256 = hex64(object.get("sha256")?)?;
    let size_bytes = positive_int_le(object.get("sizeBytes")?, MAX_PLUGIN_PACKAGE_SIZE_BYTES)?;
    Some(PluginReleaseArtifact {
        file,
        sha256,
        size_bytes,
    })
}

fn parse_provenance(value: &Value) -> Option<PluginReleaseProvenance> {
    let object = value.as_object()?;
    forbid_extra(
        object,
        &[
            "projectId",
            "ref",
            "sourceCommitSha",
            "pipelineId",
            "pipelineUrl",
            "metadata",
        ],
    )?;
    let project_id = bounded_string(object.get("projectId")?, 1, 100)?;
    let git_ref = bounded_string(object.get("ref")?, 1, 255)?;
    let source_commit_sha = commit_sha(object.get("sourceCommitSha")?)?;
    let pipeline_id = positive_int(object.get("pipelineId")?)?;
    let pipeline_url = bounded_string(object.get("pipelineUrl")?, 1, 500)?;
    let metadata = parse_source_metadata(object.get("metadata")?)?;
    Some(PluginReleaseProvenance {
        project_id,
        git_ref,
        source_commit_sha,
        pipeline_id,
        pipeline_url,
        metadata,
    })
}

fn parse_source_metadata(value: &Value) -> Option<PluginReleaseSourceMetadata> {
    let object = value.as_object()?;
    forbid_extra(object, &["projectPath"])?;
    Some(PluginReleaseSourceMetadata {
        project_path: bounded_string(object.get("projectPath")?, 1, 500)?,
    })
}

/// `ConfigDict(extra="forbid")`: an unknown key rejects the whole model.
fn forbid_extra(object: &Map<String, Value>, allowed: &[&str]) -> Option<()> {
    object
        .keys()
        .all(|key| allowed.contains(&key.as_str()))
        .then_some(())
}

fn bounded_string(value: &Value, min: usize, max: usize) -> Option<String> {
    let text = value.as_str()?;
    let length = text.chars().count();
    (length >= min && length <= max).then(|| text.to_owned())
}

/// `@field_validator("sha256")`: lowercase and require hexadecimal.
fn hex64(value: &Value) -> Option<String> {
    let text = value.as_str()?.to_lowercase();
    (text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(text)
}

/// `@field_validator("sourceCommitSha")`: lowercase, 40..=64 hexadecimal.
fn commit_sha(value: &Value) -> Option<String> {
    let text = value.as_str()?.to_lowercase();
    ((40..=64).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(text)
}

/// `pipelineId: int = Field(gt=0)`; pydantic also accepts a numeric string.
fn positive_int(value: &Value) -> Option<i64> {
    let number = int_value(value)?;
    (number > 0).then_some(number)
}

/// `requestId`/`revision`: `int | None = Field(default=None, gt=0)`.
fn optional_positive_int(value: Option<&Value>) -> Option<Option<i64>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(value) => positive_int(value).map(Some),
    }
}

/// `sizeBytes: int = Field(gt=0, le=50 MiB)`.
fn positive_int_le(value: &Value, max: i64) -> Option<i64> {
    let number = int_value(value)?;
    (number > 0 && number <= max).then_some(number)
}

/// Pydantic v2 lax integer coercion: integers, integral floats, and numeric
/// strings; booleans are not integers.
fn int_value(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.fract() == 0.0 && value.is_finite())
                .map(|value| value as i64)
        }),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> Value {
        json!({
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
        })
    }

    #[test]
    fn accepts_the_exact_multipart_envelope_with_defaults() {
        let metadata = parse(&valid()).expect("valid metadata");
        assert_eq!(metadata.plugin.listing_type, "plugin");
        assert_eq!(metadata.request_id, None);
        assert_eq!(metadata.revision, None);
        let dumped = metadata.to_json();
        assert_eq!(dumped["plugin"]["listingType"], "plugin");
        assert!(dumped["requestId"].is_null());
    }

    #[test]
    fn request_identity_must_be_paired() {
        let mut value = valid();
        value["requestId"] = json!(12);
        assert!(parse(&value).is_none());
        value["revision"] = json!(3);
        assert!(parse(&value).is_some());
    }

    #[test]
    fn unknown_keys_and_bad_digests_are_rejected() {
        let mut value = valid();
        value["extra"] = json!(1);
        assert!(parse(&value).is_none());

        let mut value = valid();
        value["artifact"]["sha256"] = json!("g".repeat(64));
        assert!(parse(&value).is_none());

        let mut value = valid();
        value["artifact"]["sizeBytes"] = json!(50 * 1024 * 1024 + 1);
        assert!(parse(&value).is_none());
    }

    #[test]
    fn sha_and_commit_digests_normalize_to_lowercase() {
        let mut value = valid();
        value["artifact"]["sha256"] = json!("A".repeat(64));
        value["source"]["sourceCommitSha"] = json!("B".repeat(40));
        let metadata = parse(&value).expect("valid metadata");
        assert_eq!(metadata.artifact.sha256, "a".repeat(64));
        assert_eq!(metadata.source.source_commit_sha, "b".repeat(40));
    }
}
