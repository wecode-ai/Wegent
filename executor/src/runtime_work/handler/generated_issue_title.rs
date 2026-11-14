//! Only an Issue created with a task opts into its generated title.
use super::*;

const ISSUE_TITLE_WRITE_ATTEMPTS: usize = 3;

impl RuntimeWorkRpcHandler {
    pub(super) async fn sync_generated_issue_title(
        &self,
        link: &RuntimeTaskLink,
        title: &str,
    ) -> Result<(), AppIpcError> {
        let origin = &link.runtime_handle["origin"];
        let Some(source) = origin["generatedIssueTitle"].as_str() else {
            return Ok(());
        };
        let (Some(project), Some(issue)) = (
            origin["cloudProjectId"].as_str(),
            origin["loopItemId"].as_str(),
        ) else {
            return Err(AppIpcError::new(
                "bad_request",
                "Generated Issue title has no Issue identity",
            ));
        };
        if origin["projectStore"] == "local" {
            let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(|error| {
                AppIpcError::new("issue_title_update_failed", error.to_string())
            })?;
            let current = store.get_task(project, issue).map_err(|error| {
                AppIpcError::new("issue_title_update_failed", error.to_string())
            })?;
            if current.title.as_deref() != Some(source) {
                return Ok(());
            }
            store
                .update_task(
                    project,
                    issue,
                    serde_json::from_value(json!({
                        "version":current.version,"title":title
                    }))
                    .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?,
                )
                .map_err(|error| {
                    AppIpcError::new("issue_title_update_failed", error.to_string())
                })?;
        } else {
            let path = format!(
                "/v1/loop-items/{}",
                url::form_urlencoded::byte_serialize(issue.as_bytes()).collect::<String>()
            );
            for attempt in 1..=ISSUE_TITLE_WRITE_ATTEMPTS {
                let current = self.runtime_http(reqwest::Method::GET, &path, None).await?;
                if current["cloud_project_id"].as_str() != Some(project) {
                    return Err(AppIpcError::new(
                        "permission_denied",
                        "Issue project identity changed",
                    ));
                }
                if current["title"].as_str() != Some(source) {
                    return Ok(());
                }
                let result = self
                    .runtime_http(
                        reqwest::Method::PATCH,
                        &path,
                        Some(&json!({
                            "version":current["version"],"title":title
                        })),
                    )
                    .await;
                match result {
                    Err(error)
                        if error.code == "version_conflict"
                            && attempt < ISSUE_TITLE_WRITE_ATTEMPTS =>
                    {
                        // Status and activity updates also advance the Issue version.
                        // Recheck the title before attempting the conditional write again.
                        continue;
                    }
                    result => return result.map(|_| ()),
                }
            }
        }
        Ok(())
    }
}
