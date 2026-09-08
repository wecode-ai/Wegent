// SPDX-License-Identifier: Apache-2.0
//! Native credential adapter execution. These types are not runtime RPC results.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

pub mod broker;
mod automation;
mod execution;
mod gateway;
pub use execution::{execute, ExecutionRequest};
mod migration;
pub use migration::{migrate, resolve_managed_package, PreparedPackage};
mod local_configuration;
mod process;
mod revocation;
pub use gateway::{ConnectionMetadata, NativeAuthGateway};
pub use revocation::revoke_pending;

pub const MAX_FRAME_BYTES: usize = 65_536;

#[derive(Debug, Clone, Copy, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct AuthError(pub &'static str);

/// Intentionally has no Debug or Serialize implementation.
pub struct Credential(Value);

impl Credential {
    pub fn from_json(raw: &str) -> Result<Self, AuthError> {
        if raw.is_empty() || raw.len() > MAX_FRAME_BYTES {
            return Err(AuthError("plugin_auth_invalid_credential"));
        }
        let value: Value =
            serde_json::from_str(raw).map_err(|_| AuthError("plugin_auth_invalid_credential"))?;
        if !value.is_object() {
            return Err(AuthError("plugin_auth_invalid_credential"));
        }
        Ok(Self(value))
    }

    /// Only the authenticated native backend transport may call this method.
    pub fn into_native_json(self) -> String {
        self.0.to_string()
    }
}

pub struct ExportedCredential {
    pub account_id: String,
    pub credential: Credential,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OAuthOperation {
    Authorize,
    Refresh,
    Revoke,
}

impl OAuthOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Authorize => "authorize",
            Self::Refresh => "refresh",
            Self::Revoke => "revoke",
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthDefinition {
    protocol_version: u32,
    credential_type: String,
    adapter: String,
    oauth2: Option<Vec<OAuthOperation>>,
    export_mode: Option<String>,
    local_environment: Option<std::collections::BTreeMap<String, local_configuration::Setting>>,
}

pub struct NativeAdapter {
    root: PathBuf,
    script: PathBuf,
    connector_slug: String,
    definition: AuthDefinition,
}

impl NativeAdapter {
    /// The caller must resolve this root from the authoritative installed package.
    /// Never accept a model/user-supplied arbitrary directory as a trusted plugin.
    pub fn load(root: &Path, connector_slug: &str, expected: &Value) -> Result<Self, AuthError> {
        let root = root
            .canonicalize()
            .map_err(|_| AuthError("plugin_auth_package_missing"))?;
        let manifest_path = root
            .join(".codex-plugin/plugin.json")
            .canonicalize()
            .map_err(|_| AuthError("plugin_auth_package_missing"))?;
        if !manifest_path.starts_with(&root) {
            return Err(AuthError("plugin_auth_invalid_adapter"));
        }
        let manifest: Value = serde_json::from_slice(
            &fs::read(manifest_path).map_err(|_| AuthError("plugin_auth_package_missing"))?,
        )
        .map_err(|_| AuthError("plugin_auth_invalid_adapter"))?;
        let connectors = manifest["connectors"]
            .as_array()
            .ok_or(AuthError("plugin_auth_invalid_adapter"))?;
        let matches: Vec<_> = connectors
            .iter()
            .filter(|item| item["slug"].as_str() == Some(connector_slug))
            .collect();
        if matches.len() != 1 || matches[0].get("accountAuth") != Some(expected) {
            return Err(AuthError("plugin_auth_definition_mismatch"));
        }
        let definition: AuthDefinition = serde_json::from_value(expected.clone())
            .map_err(|_| AuthError("plugin_auth_invalid_adapter"))?;
        local_configuration::validate(definition.local_environment.as_ref())?;
        if definition.protocol_version != 1
            || definition
                .export_mode
                .as_ref()
                .is_some_and(|mode| mode != "exclusive" || definition.credential_type != "oauth2")
            || !["password", "bearer", "oauth2"].contains(&definition.credential_type.as_str())
            || definition.adapter.contains(['\\', ':'])
            || definition.adapter.starts_with('~')
            || Path::new(&definition.adapter)
                .components()
                .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            return Err(AuthError("plugin_auth_invalid_adapter"));
        }
        let script = root
            .join(&definition.adapter)
            .canonicalize()
            .map_err(|_| AuthError("plugin_auth_invalid_adapter"))?;
        if !script.starts_with(&root) || !script.is_file() {
            return Err(AuthError("plugin_auth_invalid_adapter"));
        }
        Ok(Self {
            root,
            script,
            connector_slug: connector_slug.to_owned(),
            definition,
        })
    }

    pub async fn export(
        &self,
        interpreter: &Path,
        timeout: Duration,
    ) -> Result<ExportedCredential, AuthError> {
        let result =
            process::invoke(self, interpreter, &["export".into()], None, None, timeout).await?;
        self.exported_result(result)
    }

    pub fn requires_exclusive_transfer(&self) -> bool {
        self.definition.export_mode.as_deref() == Some("exclusive")
    }

    pub async fn detach(
        &self,
        interpreter: &Path,
        migration_id: &str,
        credential: Credential,
        timeout: Duration,
    ) -> Result<(), AuthError> {
        if !self.requires_exclusive_transfer() {
            return Err(AuthError("plugin_auth_operation_unsupported"));
        }
        self.validate_credential(&credential.0)?;
        let frame = json!({
            "protocolVersion":1, "connectorSlug":self.connector_slug,
            "credentialType":self.definition.credential_type, "credential":credential.0,
        });
        let result = process::invoke(
            self,
            interpreter,
            &["detach".into(), migration_id.into()],
            Some(frame),
            None,
            timeout,
        )
        .await?;
        let status: Value = serde_json::from_slice(&result.stdout)
            .map_err(|_| AuthError("plugin_auth_invalid_response"))?;
        if status == json!({"status":"source_changed","protocolVersion":1}) {
            return Err(AuthError("plugin_auth_source_changed"));
        }
        if status != json!({"status":"detached","protocolVersion":1}) {
            return Err(AuthError("plugin_auth_invalid_response"));
        }
        Ok(())
    }

    fn exported_result(
        &self,
        result: process::AdapterResult,
    ) -> Result<ExportedCredential, AuthError> {
        let frame = result
            .frame
            .ok_or(AuthError("plugin_auth_invalid_credential"))?;
        let credential = self.parse_frame(frame)?;
        let metadata: Value = serde_json::from_slice(&result.stdout)
            .map_err(|_| AuthError("plugin_auth_invalid_metadata"))?;
        let account_id = metadata["accountId"]
            .as_str()
            .filter(|value| !value.trim().is_empty() && value.len() <= 256)
            .ok_or(AuthError("plugin_auth_invalid_metadata"))?;
        if metadata["status"] != "ok"
            || metadata["protocolVersion"] != 1
            || metadata["credentialType"] != self.definition.credential_type
        {
            return Err(AuthError("plugin_auth_invalid_metadata"));
        }
        Ok(ExportedCredential {
            account_id: account_id.to_owned(),
            credential,
        })
    }

    pub async fn oauth_operation(
        &self,
        interpreter: &Path,
        operation: OAuthOperation,
        credential: Option<Credential>,
        timeout: Duration,
    ) -> Result<Option<ExportedCredential>, AuthError> {
        if self.definition.credential_type != "oauth2"
            || !self
                .definition
                .oauth2
                .as_ref()
                .is_some_and(|operations| operations.contains(&operation))
        {
            return Err(AuthError("plugin_auth_operation_unsupported"));
        }
        if (operation == OAuthOperation::Authorize) != credential.is_none() {
            return Err(AuthError("plugin_auth_invalid_request"));
        }
        let frame = credential.map(|credential| {
            json!({
                "protocolVersion":1, "connectorSlug":self.connector_slug,
                "credentialType":self.definition.credential_type, "credential":credential.0,
            })
        });
        if let Some(frame) = &frame {
            self.validate_credential(&frame["credential"])?;
        }
        let result = process::invoke(
            self,
            interpreter,
            &[operation.as_str().into()],
            frame,
            None,
            timeout,
        )
        .await?;
        if operation == OAuthOperation::Revoke {
            let status: Value = serde_json::from_slice(&result.stdout)
                .map_err(|_| AuthError("plugin_auth_invalid_response"))?;
            if status != json!({"status":"ok","protocolVersion":1}) {
                return Err(AuthError("plugin_auth_invalid_response"));
            }
            Ok(None)
        } else {
            self.exported_result(result).map(Some)
        }
    }

    pub async fn run(
        &self,
        interpreter: &Path,
        credential: Credential,
        arguments: &[String],
        working_directory: Option<&Path>,
        timeout: Duration,
    ) -> Result<Vec<u8>, AuthError> {
        if arguments.is_empty() {
            return Err(AuthError("plugin_auth_invalid_command"));
        }
        let frame = json!({
            "protocolVersion": 1, "connectorSlug": self.connector_slug,
            "credentialType": self.definition.credential_type, "credential": credential.0,
        });
        self.validate_credential(&frame["credential"])?;
        let mut argv = vec!["run".to_owned()];
        argv.extend_from_slice(arguments);
        Ok(process::invoke(
            self,
            interpreter,
            &argv,
            Some(frame),
            working_directory,
            timeout,
        )
        .await?
        .stdout)
    }

    fn parse_frame(&self, frame: Value) -> Result<Credential, AuthError> {
        if frame.as_object().map(|value| value.len()) != Some(4)
            || frame["protocolVersion"].as_u64() != Some(1)
            || frame["connectorSlug"] != self.connector_slug
            || frame["credentialType"] != self.definition.credential_type
        {
            return Err(AuthError("plugin_auth_invalid_credential"));
        }
        self.validate_credential(&frame["credential"])?;
        Ok(Credential(frame["credential"].clone()))
    }

    fn validate_credential(&self, credential: &Value) -> Result<(), AuthError> {
        let fields: &[&str] = match self.definition.credential_type.as_str() {
            "password" => &["username", "password"],
            "bearer" => &["token"],
            "oauth2" => &["access_token"],
            _ => return Err(AuthError("plugin_auth_invalid_credential")),
        };
        if fields.iter().any(|field| {
            credential[*field]
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .is_none()
        }) {
            return Err(AuthError("plugin_auth_invalid_credential"));
        }
        Ok(())
    }
}
