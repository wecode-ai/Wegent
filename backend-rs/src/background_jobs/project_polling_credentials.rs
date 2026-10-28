// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Explicit project, connector and machine-local polling credentials.
use super::{
    super::store::{self, Node},
    http::{PollError, Result, text},
};
use crate::{
    apps_installed::{connection::ConnectorConnection, db},
    state::AppState,
};
use serde_json::Value;
use std::{path::PathBuf, time::Duration};

pub(super) async fn resolve(state: &AppState, hook: &Node) -> Result<String> {
    let metadata = hook.meta();
    let source = if text(&metadata["source_type"]).is_empty() {
        hook.source.as_str()
    } else {
        text(&metadata["source_type"])
    };
    let reference = text(&metadata["credential_ref"]);
    match reference {
        "" => Err(PollError::disabled(
            "Polling requires a credential reference",
        )),
        "machine-cli" | "local-cli" => {
            let resource = &metadata["resource"];
            let instance = if text(&resource["instance_url"]).is_empty() {
                text(&resource["url"])
            } else {
                text(&resource["instance_url"])
            };
            machine_token(source, instance).await
        }
        "project-provider" => {
            let project = store::get(&state.mysql, "project", &hook.cloud_project_id)
                .await
                .map_err(|_| PollError::new("Project provider credential lookup failed"))?
                .ok_or_else(|| PollError::disabled("Project provider credential is unavailable"))?;
            let metadata = project.meta();
            if text(&metadata["task_provider"]) != source {
                return Err(PollError::disabled(
                    "Project provider does not match the event source",
                ));
            }
            provider_token(&state.auth.jwt_key, source, &metadata["provider_config"])
        }
        slug => {
            let row = db::find_connector_connection(&state.mysql, slug, hook.created_by_user_id)
                .await
                .map_err(|_| PollError::new("Connector credential lookup failed"))?
                .ok_or_else(|| {
                    PollError::disabled(format!("Connector credential '{slug}' is not connected"))
                })?;
            let connection = ConnectorConnection::from_row(&row);
            if connection.status != "connected" {
                return Err(PollError::disabled(format!(
                    "Connector credential '{slug}' is not connected"
                )));
            }
            if connection
                .expires_at
                .is_some_and(|at| at <= chrono::Utc::now().naive_utc())
            {
                return Err(PollError::disabled(format!(
                    "Connector credential '{slug}' has expired"
                )));
            }
            let token = connection
                .access_token()
                .map_err(|error| PollError::new(error.to_string()))?;
            if token.is_empty() {
                return Err(PollError::disabled(format!(
                    "Connector credential '{slug}' is unavailable"
                )));
            }
            Ok(token)
        }
    }
}

pub(super) fn provider_token(key: &str, source: &str, config: &Value) -> Result<String> {
    let credential = &config["credential"];
    if !credential.is_object() {
        return Err(PollError::disabled(
            "Project provider credential is not configured",
        ));
    }
    let token = if credential["version"] == 1 && credential["algorithm"] == "aes-256-cbc" {
        let ciphertext = text(&credential["ciphertext"]);
        if ciphertext.is_empty() {
            return Err(PollError::disabled(
                "provider credential ciphertext is required",
            ));
        }
        let token = crate::subscriptions_item::crypto::decrypt_sensitive_data(ciphertext).map_err(
            |_| {
                PollError::disabled(
                    "legacy provider credentials require GIT_TOKEN_AES_KEY and GIT_TOKEN_AES_IV",
                )
            },
        )?;
        if token.is_empty() || token == ciphertext {
            return Err(PollError::disabled("provider credential decryption failed"));
        }
        token
    } else {
        let credential: crate::board_snapshot::external_provider::ProviderCredential =
            serde_json::from_value(credential.clone())
                .map_err(|_| PollError::disabled("unsupported provider credential format"))?;
        let domain = text(&config["domain"]);
        let domain = if domain.is_empty() {
            if source == "github" {
                "github.com"
            } else {
                "gitlab.com"
            }
        } else {
            domain
        };
        let expected = format!("{source}:{domain}:{}", text(&config["repository"]));
        if credential.context != expected {
            return Err(PollError::disabled(
                "provider credential context does not match project",
            ));
        }
        crate::board_snapshot::external_provider::decrypt_provider_token(key, &credential)
            .map_err(PollError::disabled)?
    };
    if token.is_empty() {
        Err(PollError::disabled(
            "Project provider credential is not configured",
        ))
    } else {
        Ok(token)
    }
}

pub(super) fn host(instance: &str, source: &str) -> String {
    let candidate = if instance.contains("://") {
        instance.into()
    } else {
        format!("https://{instance}")
    };
    url::Url::parse(&candidate)
        .ok()
        .and_then(|url| {
            url.host_str().map(|h| match url.port() {
                Some(port) => format!("{h}:{port}"),
                None => h.into(),
            })
        })
        .unwrap_or_else(|| {
            if source == "gitlab" {
                "gitlab.com".into()
            } else {
                "github.com".into()
            }
        })
        .to_lowercase()
}

async fn machine_token(source: &str, instance: &str) -> Result<String> {
    if !matches!(source, "github" | "gitlab") {
        return Err(PollError::new(format!(
            "machine credentials are unavailable for {source}"
        )));
    }
    let host = host(instance, source);
    if source == "github" {
        let mut command = tokio::process::Command::new("gh");
        command
            .args(["auth", "token", "--hostname", host.as_str()])
            .kill_on_drop(true);
        if let Ok(Ok(output)) =
            tokio::time::timeout(Duration::from_secs(20), command.output()).await
            && output.status.success()
        {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if !token.is_empty() {
                return Ok(token);
            }
        }
    }
    let paths = config_paths(source);
    let lookup_host = host.clone();
    let source = source.to_owned();
    let cli = if source == "gitlab" { "glab" } else { "gh" };
    let token = tokio::task::spawn_blocking(move || {
        paths.iter().find_map(|path| {
            let content = match std::fs::read_to_string(path) {
                Ok(content)=>content,
                Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return None,
                Err(_)=>{tracing::warn!(path=%path.display(),"Unable to read machine CLI credential file"); return None;}
            };
            yaml_token(&content,&source,&lookup_host)
        })
    }).await.map_err(|_|PollError::new("Machine credential lookup failed"))?;
    token.ok_or_else(||PollError::new(format!("Machine CLI credential unavailable: {cli} is not logged in to {host} (run '{cli} auth login' and try again)")))
}

pub(super) fn yaml_token(content: &str, source: &str, host: &str) -> Option<String> {
    let docs = yaml_rust2::YamlLoader::load_from_str(content).ok()?;
    let doc = docs.first()?;
    let value = if source == "gitlab" {
        &doc["hosts"][host]["token"]
    } else {
        &doc[host]["oauth_token"]
    };
    value.as_str().filter(|v| !v.is_empty()).map(str::to_owned)
}

fn config_paths(source: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    if source == "gitlab" {
        if let Some(path) = std::env::var_os("GLAB_CONFIG") {
            paths.push(path.into());
        }
        if cfg!(windows)
            && let Some(path) = std::env::var_os("APPDATA")
        {
            paths.push(PathBuf::from(path).join("glab-cli/config.yml"));
        }
        if let Some(home) = &home {
            paths.push(home.join("Library/Application Support/glab-cli/config.yml"));
        }
        if let Some(path) = std::env::var_os("XDG_CONFIG_HOME") {
            paths.push(PathBuf::from(path).join("glab-cli/config.yml"));
        }
        if let Some(home) = home {
            paths.push(home.join(".config/glab-cli/config.yml"));
        }
    } else {
        if cfg!(windows)
            && let Some(path) = std::env::var_os("APPDATA")
        {
            paths.push(PathBuf::from(path).join("GitHub CLI/hosts.yml"));
        }
        if let Some(home) = home {
            paths.push(home.join(".config/gh/hosts.yml"));
        }
    }
    paths
}
