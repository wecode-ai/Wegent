// SPDX-License-Identifier: Apache-2.0
//! Execute plugin business commands without returning credentials to the caller.

use super::{
    migration::interpreter_for, resolve_managed_package, AuthError, Credential, NativeAdapter,
    NativeAuthGateway, OAuthOperation, PreparedPackage,
};
use crate::local::backend::LocalBackendTransport;
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionRequest {
    pub installed_plugin_id: u64,
    pub connector_slug: String,
    pub account_id: Option<String>,
    pub args: Vec<String>,
    pub working_directory: Option<PathBuf>,
}

pub async fn execute<T: LocalBackendTransport>(
    transport: T,
    executor_home: &Path,
    request: ExecutionRequest,
) -> Result<String, AuthError> {
    tokio::time::timeout(
        Duration::from_secs(180),
        execute_inner(transport, executor_home, request),
    )
    .await
    .map_err(|_| AuthError("plugin_auth_execution_timeout"))?
}

async fn execute_inner<T: LocalBackendTransport>(
    transport: T,
    executor_home: &Path,
    request: ExecutionRequest,
) -> Result<String, AuthError> {
    if request.installed_plugin_id == 0
        || request.connector_slug.is_empty()
        || request.connector_slug.len() > 100
        || !request
            .connector_slug
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
        || request.args.is_empty()
        || request.args.len() > 256
        || request.args.iter().map(String::len).sum::<usize>() > 65_536
        || request
            .working_directory
            .as_ref()
            .is_some_and(|path| !path.is_absolute() || !path.is_dir())
        || request
            .account_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 256)
    {
        return Err(AuthError("plugin_auth_invalid_request"));
    }
    let gateway = NativeAuthGateway::new(transport);
    let (package, credential) = execution_credential(&gateway, executor_home, &request).await?;
    if package.installed_plugin_id != request.installed_plugin_id
        || package.connector_slug != request.connector_slug
    {
        return Err(AuthError("plugin_auth_invalid_response"));
    }
    let root = resolve_managed_package(executor_home, &package)?;
    let adapter = NativeAdapter::load(&root, &package.connector_slug, &package.auth_definition)?;
    let interpreter = interpreter_for(&package.auth_definition)?;
    let output = adapter
        .run(
            &interpreter,
            credential,
            &request.args,
            request.working_directory.as_deref(),
            Duration::from_secs(60),
        )
        .await?;
    String::from_utf8(output).map_err(|_| AuthError("plugin_auth_invalid_output"))
}

async fn execution_credential<T: LocalBackendTransport>(
    gateway: &NativeAuthGateway<T>,
    home: &Path,
    request: &ExecutionRequest,
) -> Result<(PreparedPackage, Credential), AuthError> {
    match gateway.execution(request).await {
        Err(AuthError("plugin_auth_refresh_required")) => {}
        result => return result,
    }
    if let Some(lease) = gateway.begin_refresh(request).await? {
        let preparation = (|| {
            if lease.package.installed_plugin_id != request.installed_plugin_id
                || lease.package.connector_slug != request.connector_slug
            {
                return Err(AuthError("plugin_auth_invalid_response"));
            }
            let root = resolve_managed_package(home, &lease.package)?;
            let adapter = NativeAdapter::load(
                &root,
                &lease.package.connector_slug,
                &lease.package.auth_definition,
            )?;
            Ok((adapter, interpreter_for(&lease.package.auth_definition)?))
        })();
        let (adapter, interpreter) = match preparation {
            Ok(value) => value,
            Err(error) => {
                gateway
                    .finish_refresh(&lease.connection_id, &lease.operation_id, None, false)
                    .await?;
                return Err(error);
            }
        };
        let result = adapter
            .oauth_operation(
                &interpreter,
                OAuthOperation::Refresh,
                Some(lease.credential),
                Duration::from_secs(30),
            )
            .await;
        match result {
            Ok(Some(refreshed)) => {
                gateway
                    .finish_refresh(
                        &lease.connection_id,
                        &lease.operation_id,
                        Some(refreshed),
                        true,
                    )
                    .await?
            }
            _ => {
                gateway
                    .finish_refresh(&lease.connection_id, &lease.operation_id, None, true)
                    .await?;
                return Err(AuthError("plugin_auth_reconnect_required"));
            }
        }
    }
    gateway.execution(request).await
}
