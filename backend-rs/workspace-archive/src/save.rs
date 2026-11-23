//! Archive before executor deletion and persist the resulting task metadata.

use anyhow::Result;
use chrono::Utc;
use serde_json::{Value, json};
use wegent_executor_manager::executor_manager::ExecutorManager;
use wegent_python_compat::json_compat::python_truthy;
use wegent_task_store::task_store::TaskStore;

use super::storage::ArchiveStorage;

/// A failed archive must block deletion until the explicit force-idle threshold.
pub async fn archive(
    http: &brz_http::Client,
    executor_manager: &ExecutorManager,
    task_store: &dyn TaskStore,
    task_id: i64,
    owner_id: i64,
    executor: &str,
    namespace: &str,
) -> Result<()> {
    if crate::config::env_or_dotenv("WORKSPACE_ARCHIVE_ENABLED")
        .is_some_and(|value| value.eq_ignore_ascii_case("false"))
    {
        return Ok(());
    }
    let storage = ArchiveStorage::from_env()?;
    let (url, key) = storage.generate_upload_url(http, task_id).await?;
    let max_size = number("WORKSPACE_ARCHIVE_MAX_SIZE_MB", 2048)?;
    let result = match executor_manager
        .archive_workspace(task_id, &url, executor, namespace, max_size)
        .await
    {
        Ok(result) if python_truthy(&result) => result,
        _ => {
            let size = storage
                .archive_size(http, &key)
                .await?
                .ok_or_else(|| anyhow::anyhow!("workspace archive was not uploaded"))?;
            json!({"size_bytes":size})
        }
    };
    let zone = crate::config::env_or_dotenv("WORKSPACE_ARCHIVE_TIMEZONE")
        .unwrap_or_else(|| "Asia/Shanghai".to_owned())
        .parse::<chrono_tz::Tz>()
        .unwrap_or(chrono_tz::UTC);
    let now = Utc::now().with_timezone(&zone);
    let expires = now
        + chrono::Duration::days(i64::try_from(number(
            "WORKSPACE_ARCHIVE_RETENTION_DAYS",
            30,
        )?)?);
    let archive = json!({
        "storageKey":key, "archivedAt":now.to_rfc3339(), "expiresAt":expires.to_rfc3339(),
        "sizeBytes":result.get("size_bytes").cloned().unwrap_or(Value::Null),
        "sessionFileIncluded":result.get("session_file_included").cloned().unwrap_or(json!(false)),
        "gitIncluded":result.get("git_included").cloned().unwrap_or(json!(false)),
    });
    // Update only the archive field so a concurrent task status does not get overwritten.
    if !task_store
        .save_task_archive(
            task_id,
            owner_id,
            &serde_json::to_string(&archive)?,
            chrono::Local::now().naive_local(),
        )
        .await?
    {
        anyhow::bail!("task disappeared before its workspace archive was recorded");
    }
    Ok(())
}

fn number(name: &str, default: u64) -> Result<u64> {
    Ok(crate::config::env_or_dotenv(name)
        .map(|value| value.parse())
        .transpose()?
        .unwrap_or(default))
}
