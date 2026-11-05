// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::task_runtime::issue_follow_events as events;
use serde_json::json;

impl TaskRuntime {
    pub(super) async fn external_event_baseline(
        &self,
        project: &LoopItem,
        provider: TaskProviderKind,
        task: &str,
    ) -> Result<Vec<events::Event>, TaskRuntimeError> {
        let source = external_source(provider)?;
        let mut baseline = Vec::new();
        for stream in events::streams(source) {
            let mut token = Value::Null;
            loop {
                let (events, next, done) = self
                    .external_event_page(project, provider, task, stream, &token)
                    .await?;
                baseline.extend(events);
                if done {
                    break;
                }
                token = next;
            }
        }
        Ok(baseline)
    }

    async fn external_event_page(
        &self,
        project: &LoopItem,
        provider: TaskProviderKind,
        task: &str,
        stream: &str,
        token: &Value,
    ) -> Result<(Vec<events::Event>, Value, bool), TaskRuntimeError> {
        if provider == TaskProviderKind::DingtalkAitable {
            self.aitable_provider
                .event_page(project, task, stream, token)
                .await
        } else {
            let page = token.as_u64().unwrap_or(1);
            let (events, done) = self
                .issue_provider
                .event_page(project, provider, task, stream, page)
                .await?;
            Ok((events, json!(page + 1), done))
        }
    }

    pub async fn poll_followed_external_issues(&self) -> Result<(), TaskRuntimeError> {
        for identity in self.local_store.followed_external_issues()? {
            if let Err(error) = self.poll_external_issue(identity.clone()).await {
                self.local_store
                    .defer_external_scan(&identity.0, &identity.1)?;
                crate::logging::write_executor_log_line(&format!(
                    "Followed Issue event scan failed: {error}"
                ));
            }
        }
        Ok(())
    }

    async fn poll_external_issue(
        &self,
        identity: (String, String, Value),
    ) -> Result<(), TaskRuntimeError> {
        let (project_id, task_id, mut cursor) = identity;
        let project = self.local_store.get_project(&project_id)?;
        let provider = task_provider(&project)?;
        let source = external_source(provider)?;
        // A provider read is required on every scan; a subscription is no access grant.
        let mut issue = self.get_task(&project_id, &task_id).await?;
        for _ in 0..8 {
            let index = cursor["stream"].as_u64().unwrap_or(0) as usize;
            let stream = events::streams(source)
                .get(index)
                .ok_or_else(|| TaskRuntimeError::Invalid("Invalid event continuation".into()))?;
            let (decoded, token, last_page) = self
                .external_event_page(&project, provider, &issue.id, stream, &cursor["token"])
                .await?;
            let next_stream = if last_page { index + 1 } else { index };
            let finished = next_stream == events::streams(source).len();
            let next = json!({"stream":if finished {0}else{next_stream},"token":if last_page {Value::Null}else{token},"next_at":chrono::Utc::now().timestamp_millis()+if finished {300_000}else{0}});
            if !self
                .local_store
                .commit_external_event_page(&project, &issue, &cursor, &decoded, &next)?
            {
                break;
            }
            cursor = next;
            issue.metadata["follow_poll"] = cursor.clone();
            if finished {
                break;
            }
        }
        Ok(())
    }
}

fn external_source(provider: TaskProviderKind) -> Result<&'static str, TaskRuntimeError> {
    match provider {
        TaskProviderKind::Github => Ok("github"),
        TaskProviderKind::Gitlab => Ok("gitlab"),
        TaskProviderKind::DingtalkAitable => Ok("dingtalk_aitable"),
        _ => Err(TaskRuntimeError::Invalid(
            "Issue has no external event source".into(),
        )),
    }
}
