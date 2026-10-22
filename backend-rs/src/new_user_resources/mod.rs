//! `app.services.k_batch`: synchronous new-user YAML resource application.
//! Files are loaded per application, preserving source ordering and partial success.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Result, ensure};
use serde_json::Value;

use crate::state::AppState;

mod repository;
mod schema;
pub mod tasks;
#[cfg(test)]
mod tests;
mod validation;
mod yaml;

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FILES: usize = 4096;
static FILE_READS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

/// Source chooses INIT_DATA_DIR and only then its new_user child directory.
pub fn resource_directory() -> PathBuf {
    let configured = PathBuf::from(
        crate::config::env_or_dotenv("INIT_DATA_DIR").unwrap_or_else(|| "/app/init_data".into()),
    );
    let local = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or(Path::new("."))
        .join("backend/init_data");
    let root = if !configured.exists() && configured.is_absolute() && local.exists() {
        local
    } else {
        configured
    };
    root.join("new_user")
}

/// Apply defaults with the same best-effort per-resource failure boundary.
pub async fn apply(state: &AppState, tasks: &dyn tasks::TaskResources, user_id: i64) {
    let permit = match FILE_READS.acquire().await {
        Ok(p) => p,
        Err(_) => return,
    };
    let resources = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        load_resources(&resource_directory())
    })
    .await;
    let resources = match resources {
        Ok(Ok(resources)) => resources,
        _ => {
            tracing::warn!("new-user resource loading failed");
            return;
        }
    };
    for mut resource in resources {
        if apply_one(state, tasks, user_id, &mut resource)
            .await
            .is_err()
        {
            tracing::warn!("new-user resource application failed");
        }
    }
}

fn load_resources(directory: &Path) -> Result<Vec<Value>> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut yaml_files = Vec::new();
    let mut yml_files = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        match path.extension().and_then(|s| s.to_str()) {
            Some("yaml") => yaml_files.push(path),
            Some("yml") => yml_files.push(path),
            _ => (),
        }
        ensure!(
            yaml_files.len() + yml_files.len() <= MAX_FILES,
            "too many default resource files"
        );
    }
    yaml_files.sort();
    yml_files.sort();
    let mut resources = Vec::new();
    for path in yaml_files.into_iter().chain(yml_files) {
        let documents = load_file(&path);
        // Source discards every document of a file if safe_load_all fails.
        if let Ok(documents) = documents {
            for document in documents {
                if document.is_object()
                    && document.get("kind").is_some()
                    && document.get("metadata").is_some()
                {
                    resources.push(document);
                }
            }
        }
    }
    Ok(resources)
}

fn load_file(path: &Path) -> Result<Vec<Value>> {
    use std::io::Read as _;
    let mut file = std::fs::File::open(path)?.take(MAX_FILE_BYTES + 1);
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    ensure!(
        contents.len() as u64 <= MAX_FILE_BYTES,
        "default resource file too large"
    );
    yaml::documents(&contents)
}

async fn apply_one(
    state: &AppState,
    tasks: &dyn tasks::TaskResources,
    user_id: i64,
    resource: &mut Value,
) -> Result<()> {
    let kind = resource
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing resource kind"))?
        .to_owned();
    ensure!(
        matches!(
            kind.as_str(),
            "Ghost" | "Model" | "Shell" | "Bot" | "Team" | "Workspace" | "Task"
        ),
        "unsupported resource kind"
    );
    let namespace = resource
        .pointer("/metadata/namespace")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing resource namespace"))?
        .to_owned();
    let name = resource
        .pointer("/metadata/name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing resource name"))?
        .to_owned();
    let mut existing = repository::get(state, tasks, user_id, &kind, &namespace, &name).await?;
    let role = if existing.is_some() {
        "Developer"
    } else {
        "Maintainer"
    };
    ensure!(
        repository::permitted(state, user_id, &namespace, role).await?,
        "namespace permission denied"
    );
    if existing.is_none() {
        ensure!(
            repository::get(state, tasks, user_id, &kind, &namespace, &name)
                .await?
                .is_none(),
            "resource already exists"
        );
        // Creation extracts first; updating validates before extraction.
        extract(&kind, resource)?;
    } else {
        existing = Some(
            repository::get_unchecked(state, tasks, user_id, &kind, &namespace, &name)
                .await?
                .ok_or_else(|| anyhow::anyhow!("resource no longer exists"))?,
        );
    }
    validation::validate(state, tasks, user_id, &kind, &namespace, &name, resource).await?;
    if existing.is_some() {
        extract(&kind, resource)?;
    }
    let id = if matches!(kind.as_str(), "Task" | "Workspace") {
        tasks
            .save(
                user_id,
                &kind,
                &namespace,
                &name,
                existing.as_ref(),
                resource,
            )
            .await?
    } else {
        repository::save(
            &state.mysql,
            user_id,
            &kind,
            &namespace,
            &name,
            existing.as_ref(),
            resource,
        )
        .await?
    };
    if kind == "Task" {
        // TaskKindService catches AttributeError at its removed _create_subtasks
        // call. Preserve the preceding Team read and do not invent dispatch.
        let reference = validation::reference(resource, "teamRef")?;
        let _ = repository::owned_kind(&state.mysql, user_id, "Team", &reference.0, &reference.1)
            .await?;
        tracing::warn!(resource_id = id, "task resource subtask creation failed");
    }
    Ok(())
}

fn extract(kind: &str, resource: &mut Value) -> Result<()> {
    if resource.get("status").is_none_or(Value::is_null) {
        resource["status"] = serde_json::json!({"state":"Available"});
    }
    if kind == "Model"
        && let Some(key) = resource.pointer_mut("/spec/modelConfig/env/api_key")
        && let Some(text) = key.as_str()
        && !text.is_empty()
        && text != "***"
        && !crate::git_repositories::crypto::is_token_encrypted(text)
    {
        *key = Value::String(
            crate::git_repositories::crypto::encrypt_git_token(text)
                .map_err(|_| anyhow::anyhow!("model key encryption failed"))?,
        );
    }
    Ok(())
}

/// Shared owned default storage adapter; internal deployments replace this interface.
pub fn default_tasks(mysql: brz_mysql::MysqlService) -> Arc<dyn tasks::TaskResources> {
    Arc::new(tasks::BaseTaskResources { mysql })
}
