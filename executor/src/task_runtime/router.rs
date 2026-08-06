// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::{
    aitable_provider::AITableProvider, credentials::mask_provider_config,
    issue_provider::IssueProvider, store::task_provider, BinaryInput, ChatAgent, ChatAgentCreate,
    ChatAgentUpdate, Delivery, DeliveryAsset, DeliveryCreate, DeliveryDetail, IssueComment,
    LocalExecution, LocalExecutionClaim, LocalTaskStore, LoopItem, ProjectCreate, ProjectDescriptor,
    ProjectFile, ProjectUpdate, RuntimeTaskAddress, TaskAttachment, TaskBinding, TaskCreate,
    TaskProviderKind, TaskReorder, TaskRuntimeError, TaskUpdate,
};

/// Routes project and task operations to the provider configured on each project.
///
/// The local store remains the project catalog for local projects. External issue
/// providers will plug in here and return runtime DTOs without persisting issues as
/// task rows.
#[derive(Clone)]
pub struct TaskRuntime {
    local_store: LocalTaskStore,
    issue_provider: IssueProvider,
    aitable_provider: AITableProvider,
}

impl TaskRuntime {
    pub fn from_env() -> Result<Self, TaskRuntimeError> {
        Self::new(LocalTaskStore::from_env()?)
    }

    pub fn new(local_store: LocalTaskStore) -> Result<Self, TaskRuntimeError> {
        let issue_provider = IssueProvider::new(local_store.path().to_owned())?;
        let aitable_provider = AITableProvider::new(local_store.path().to_owned())?;
        Ok(Self {
            local_store,
            issue_provider,
            aitable_provider,
        })
    }

    pub fn list_projects(&self) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        self.local_store
            .list_projects()
            .map(|projects| projects.into_iter().map(mask_project).collect())
    }

    pub fn create_project(&self, input: ProjectCreate) -> Result<LoopItem, TaskRuntimeError> {
        self.local_store.create_project(input).map(mask_project)
    }

    pub fn update_project(
        &self,
        project_id: &str,
        input: ProjectUpdate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        self.local_store
            .update_project(project_id, input)
            .map(mask_project)
    }

    pub fn archive_project(&self, project_id: &str, version: i64) -> Result<(), TaskRuntimeError> {
        self.local_store.archive_project(project_id, version)
    }

    pub fn configure_external_project(
        &self,
        project: ProjectDescriptor,
    ) -> Result<LoopItem, TaskRuntimeError> {
        self.local_store
            .configure_external_project(project)
            .map(mask_project)
    }

    pub fn remove_external_project(&self, project_id: &str) -> Result<(), TaskRuntimeError> {
        self.local_store.remove_external_project(project_id)
    }

    pub fn retain_external_projects(&self, project_ids: &[String]) -> Result<(), TaskRuntimeError> {
        self.local_store.retain_external_projects(project_ids)
    }

    pub async fn list_external_tasks(
        &self,
        project: ProjectDescriptor,
    ) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let provider = project.task_provider;
        let project = self.local_store.external_project(project)?;
        match provider {
            TaskProviderKind::DingtalkAitable => self.aitable_provider.list_board(&project).await,
            provider => self.issue_provider.list(&project, provider).await,
        }
    }

    pub async fn get_external_task(
        &self,
        project: ProjectDescriptor,
        task_id: &str,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let provider = project.task_provider;
        let project = self.local_store.external_project(project)?;
        self.issue_provider.get(&project, provider, task_id).await
    }

    pub async fn create_external_task(
        &self,
        project: ProjectDescriptor,
        input: TaskCreate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let provider = project.task_provider;
        let project = self.local_store.external_project(project)?;
        self.issue_provider.create(&project, provider, input).await
    }

    pub async fn update_external_task(
        &self,
        project: ProjectDescriptor,
        task_id: &str,
        input: TaskUpdate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let provider = project.task_provider;
        let project = self.local_store.external_project(project)?;
        self.issue_provider
            .update(&project, provider, task_id, input)
            .await
    }

    pub async fn list_external_task_attachments(
        &self,
        project: ProjectDescriptor,
        task_id: &str,
    ) -> Result<Vec<TaskAttachment>, TaskRuntimeError> {
        let provider = project.task_provider;
        let project = self.local_store.external_project(project)?;
        self.issue_provider
            .list_attachments(&project, provider, task_id)
            .await
    }

    pub async fn upload_external_task_attachment(
        &self,
        project: ProjectDescriptor,
        task_id: &str,
        input: BinaryInput,
    ) -> Result<TaskAttachment, TaskRuntimeError> {
        let provider = project.task_provider;
        let project = self.local_store.external_project(project)?;
        self.issue_provider
            .upload_attachment(&project, provider, task_id, input)
            .await
    }

    pub async fn download_external_task_attachment(
        &self,
        project: ProjectDescriptor,
        task_id: &str,
        attachment_id: &str,
    ) -> Result<String, TaskRuntimeError> {
        let provider = project.task_provider;
        let project = self.local_store.external_project(project)?;
        Ok(self
            .issue_provider
            .download_attachment(&project, provider, task_id, attachment_id)
            .await?
            .display()
            .to_string())
    }

    pub async fn delete_external_task_attachment(
        &self,
        project: ProjectDescriptor,
        task_id: &str,
        attachment_id: &str,
    ) -> Result<(), TaskRuntimeError> {
        let provider = project.task_provider;
        let project = self.local_store.external_project(project)?;
        self.issue_provider
            .delete_attachment(&project, provider, task_id, attachment_id)
            .await
    }

    pub async fn list_tasks(&self, project_id: &str) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            TaskProviderKind::Local => self.local_store.list_tasks(project_id),
            provider @ (TaskProviderKind::Github | TaskProviderKind::Gitlab) => {
                self.issue_provider.list(&project, provider).await
            }
            TaskProviderKind::DingtalkAitable => self.aitable_provider.list_board(&project).await,
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            ))),
        }
    }

    // Native DingTalk AI Table operations (dynamic schema, records, fields).

    pub async fn dws_auth_status(&self) -> Result<serde_json::Value, TaskRuntimeError> {
        self.aitable_provider.auth_status().await
    }

    pub async fn dws_auth_login(&self) -> Result<serde_json::Value, TaskRuntimeError> {
        self.aitable_provider.auth_login().await
    }

    pub async fn dws_auth_logout(&self) -> Result<(), TaskRuntimeError> {
        self.aitable_provider.auth_logout().await
    }

    pub async fn aitable_describe(
        &self,
        project_id: &str,
    ) -> Result<serde_json::Value, TaskRuntimeError> {
        let project = self.aitable_project(project_id)?;
        self.aitable_provider.describe(&project).await
    }

    pub async fn aitable_list_records(
        &self,
        project_id: &str,
        query: Option<&str>,
        limit: i64,
        cursor: Option<&str>,
        view_id: Option<&str>,
    ) -> Result<serde_json::Value, TaskRuntimeError> {
        let project = self.aitable_project(project_id)?;
        self.aitable_provider
            .list_records(&project, query, limit, cursor, view_id)
            .await
    }

    pub async fn aitable_get_record(
        &self,
        project_id: &str,
        record_id: &str,
    ) -> Result<serde_json::Value, TaskRuntimeError> {
        let project = self.aitable_project(project_id)?;
        self.aitable_provider.get_record(&project, record_id).await
    }

    pub async fn aitable_create_record(
        &self,
        project_id: &str,
        cells: serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value, TaskRuntimeError> {
        let project = self.aitable_project(project_id)?;
        self.aitable_provider.create_record(&project, cells).await
    }

    pub async fn aitable_update_record(
        &self,
        project_id: &str,
        record_id: &str,
        cells: serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value, TaskRuntimeError> {
        let project = self.aitable_project(project_id)?;
        self.aitable_provider
            .update_record(&project, record_id, cells)
            .await
    }

    pub async fn aitable_delete_record(
        &self,
        project_id: &str,
        record_id: &str,
    ) -> Result<(), TaskRuntimeError> {
        let project = self.aitable_project(project_id)?;
        self.aitable_provider
            .delete_record(&project, record_id)
            .await
    }

    pub async fn aitable_create_field(
        &self,
        project_id: &str,
        name: &str,
        field_type: &str,
        property: serde_json::Value,
    ) -> Result<serde_json::Value, TaskRuntimeError> {
        let project = self.aitable_project(project_id)?;
        self.aitable_provider
            .create_field(&project, name, field_type, property)
            .await
    }

    pub async fn aitable_update_field(
        &self,
        project_id: &str,
        field_id: &str,
        payload: serde_json::Map<String, serde_json::Value>,
    ) -> Result<serde_json::Value, TaskRuntimeError> {
        let project = self.aitable_project(project_id)?;
        self.aitable_provider
            .update_field(&project, field_id, payload)
            .await
    }

    pub async fn aitable_delete_field(
        &self,
        project_id: &str,
        field_id: &str,
    ) -> Result<(), TaskRuntimeError> {
        let project = self.aitable_project(project_id)?;
        self.aitable_provider.delete_field(&project, field_id).await
    }

    pub async fn aitable_create_view(
        &self,
        project_id: &str,
        name: &str,
        view_type: &str,
    ) -> Result<serde_json::Value, TaskRuntimeError> {
        let project = self.aitable_project(project_id)?;
        self.aitable_provider
            .create_view(&project, name, view_type)
            .await
    }

    fn aitable_project(&self, project_id: &str) -> Result<LoopItem, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        if task_provider(&project)? != TaskProviderKind::DingtalkAitable {
            return Err(TaskRuntimeError::UnsupportedProvider(
                "project is not a DingTalk AI Table project".to_owned(),
            ));
        }
        Ok(project)
    }

    pub async fn search_tasks(
        &self,
        input: super::TaskSearch,
    ) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let projects = if let Some(project_id) = input.project_id.as_deref() {
            vec![self.local_store.get_project(project_id)?]
        } else {
            self.local_store.list_projects()?
        };
        let query = input.query.trim().to_lowercase();
        let mut matches = Vec::new();
        for project in projects {
            let tasks = self.list_tasks(&project.id).await?;
            let child_ids = tasks
                .iter()
                .filter_map(|task| task.parent_id.clone())
                .collect::<std::collections::HashSet<_>>();
            for task in tasks {
                let tags = task
                    .metadata
                    .get("tags")
                    .or_else(|| task.metadata.get("labels"))
                    .and_then(serde_json::Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(serde_json::Value::as_str)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let text_matches = query.is_empty()
                    || task.id.to_lowercase().contains(&query)
                    || task
                        .title
                        .as_deref()
                        .unwrap_or_default()
                        .to_lowercase()
                        .contains(&query)
                    || task.description.to_lowercase().contains(&query)
                    || tags.iter().any(|tag| tag.to_lowercase().contains(&query));
                if !text_matches
                    || input
                        .status
                        .as_deref()
                        .is_some_and(|value| task.status.as_deref() != Some(value))
                    || input
                        .priority
                        .as_deref()
                        .is_some_and(|value| task.priority.as_deref() != Some(value))
                    || input
                        .tag
                        .as_deref()
                        .is_some_and(|value| !tags.contains(&value))
                    || input
                        .creator_user_id
                        .is_some_and(|value| task.created_by_user_id != value)
                    || input
                        .parent_id
                        .as_deref()
                        .is_some_and(|value| task.parent_id.as_deref() != Some(value))
                    || input
                        .has_children
                        .is_some_and(|value| child_ids.contains(&task.id) != value)
                {
                    continue;
                }
                matches.push(task);
                if matches.len() >= input.limit.clamp(1, 200) {
                    return Ok(matches);
                }
            }
        }
        Ok(matches)
    }

    pub async fn get_task(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            TaskProviderKind::Local => self.local_store.get_task(project_id, task_id),
            provider @ (TaskProviderKind::Github | TaskProviderKind::Gitlab) => {
                self.issue_provider.get(&project, provider, task_id).await
            }
            TaskProviderKind::DingtalkAitable => {
                self.aitable_provider.get_board(&project, task_id).await
            }
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            ))),
        }
    }

    pub async fn create_task(
        &self,
        project_id: &str,
        input: TaskCreate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            TaskProviderKind::Local => self.local_store.create_task(project_id, input),
            provider @ (TaskProviderKind::Github | TaskProviderKind::Gitlab) => {
                self.issue_provider.create(&project, provider, input).await
            }
            TaskProviderKind::DingtalkAitable => {
                self.aitable_provider.create_board(&project, input).await
            }
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            ))),
        }
    }

    pub async fn update_task(
        &self,
        project_id: &str,
        task_id: &str,
        input: TaskUpdate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            TaskProviderKind::Local => self.local_store.update_task(project_id, task_id, input),
            provider @ (TaskProviderKind::Github | TaskProviderKind::Gitlab) => {
                self.issue_provider
                    .update(&project, provider, task_id, input)
                    .await
            }
            TaskProviderKind::DingtalkAitable => {
                self.aitable_provider
                    .update_board(&project, task_id, input)
                    .await
            }
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            ))),
        }
    }

    pub async fn archive_task(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<(), TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            TaskProviderKind::Local => self.local_store.archive_task(project_id, task_id),
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            ))),
        }
    }

    pub async fn add_comment(
        &self,
        project_id: &str,
        task_id: &str,
        body: &str,
    ) -> Result<IssueComment, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            provider @ (TaskProviderKind::Github | TaskProviderKind::Gitlab) => {
                self.issue_provider
                    .add_comment(&project, provider, task_id, body)
                    .await
            }
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?} comments"
            ))),
        }
    }

    pub async fn reorder_tasks(
        &self,
        project_id: &str,
        input: TaskReorder,
    ) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            TaskProviderKind::Local => self.local_store.reorder_tasks(project_id, input),
            TaskProviderKind::Github
            | TaskProviderKind::Gitlab
            | TaskProviderKind::DingtalkAitable => self.list_tasks(project_id).await,
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            ))),
        }
    }

    pub async fn bind_task(
        &self,
        project_id: &str,
        item_id: Option<&str>,
        input: RuntimeTaskAddress,
    ) -> Result<TaskBinding, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match (task_provider(&project)?, item_id) {
            (TaskProviderKind::Local, item_id) => {
                self.local_store.bind_task(project_id, item_id, None, input)
            }
            (provider @ (TaskProviderKind::Github | TaskProviderKind::Gitlab), Some(item_id)) => {
                self.issue_provider.get(&project, provider, item_id).await?;
                self.local_store
                    .bind_task(project_id, None, Some(item_id), input)
            }
            (TaskProviderKind::Github | TaskProviderKind::Gitlab, None) => {
                self.local_store.bind_task(project_id, None, None, input)
            }
            (provider, _) => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?} bindings"
            ))),
        }
    }

    pub fn list_task_bindings(&self, item_id: &str) -> Result<Vec<TaskBinding>, TaskRuntimeError> {
        self.local_store.list_task_bindings(item_id)
    }

    pub fn list_chat_agents(
        &self,
        project_id: &str,
    ) -> Result<Vec<ChatAgent>, TaskRuntimeError> {
        self.local_store.list_chat_agents(project_id)
    }

    pub fn create_chat_agent(
        &self,
        project_id: &str,
        input: ChatAgentCreate,
    ) -> Result<ChatAgent, TaskRuntimeError> {
        self.local_store.create_chat_agent(project_id, input)
    }

    pub fn update_chat_agent(
        &self,
        project_id: &str,
        agent_id: &str,
        input: ChatAgentUpdate,
    ) -> Result<ChatAgent, TaskRuntimeError> {
        self.local_store.update_chat_agent(project_id, agent_id, input)
    }

    pub fn archive_chat_agent(
        &self,
        project_id: &str,
        agent_id: &str,
        version: i64,
    ) -> Result<(), TaskRuntimeError> {
        self.local_store
            .archive_chat_agent(project_id, agent_id, version)
    }

    pub fn list_executions(
        &self,
        project_id: &str,
        agent_id: Option<&str>,
        status: Option<&str>,
        include_terminal: bool,
    ) -> Result<Vec<LocalExecution>, TaskRuntimeError> {
        self.local_store
            .list_executions(project_id, agent_id, status, include_terminal)
    }

    pub fn approve_execution(
        &self,
        execution_id: i64,
    ) -> Result<LocalExecution, TaskRuntimeError> {
        self.local_store.approve_execution(execution_id)
    }

    pub fn reject_execution(
        &self,
        execution_id: i64,
        reason: Option<String>,
    ) -> Result<LocalExecution, TaskRuntimeError> {
        self.local_store.reject_execution(execution_id, reason)
    }

    pub fn claim_next_local_execution(
        &self,
        claim: LocalExecutionClaim,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        self.local_store.claim_next_local_execution(&claim)
    }

    pub fn heartbeat_execution(
        &self,
        execution_id: i64,
        runtime_device_id: Option<&str>,
        runtime_task_id: Option<&str>,
        lease_seconds: u64,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        self.local_store.heartbeat_execution(
            execution_id,
            runtime_device_id,
            runtime_task_id,
            lease_seconds,
        )
    }

    pub fn complete_execution(
        &self,
        execution_id: i64,
        note: Option<&str>,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        self.local_store.complete_execution(execution_id, note)
    }

    pub fn fail_execution(
        &self,
        execution_id: i64,
        error: &str,
        requeue: bool,
    ) -> Result<Option<LocalExecution>, TaskRuntimeError> {
        self.local_store.fail_execution(execution_id, error, requeue)
    }

    pub fn recover_stale_local_executions(&self) -> Result<(u64, u64), TaskRuntimeError> {
        self.local_store.recover_stale_local_executions()
    }

    pub fn find_task_binding(
        &self,
        device_id: &str,
        task_id: &str,
    ) -> Result<TaskBinding, TaskRuntimeError> {
        self.local_store.find_task_binding(device_id, task_id)
    }

    pub fn unbind_task(&self, device_id: &str, task_id: &str) -> Result<(), TaskRuntimeError> {
        self.local_store.unbind_task(device_id, task_id)
    }

    pub fn list_project_files(
        &self,
        project_id: &str,
    ) -> Result<Vec<ProjectFile>, TaskRuntimeError> {
        self.local_store.list_project_files(project_id)
    }

    pub fn create_project_folder(
        &self,
        project_id: &str,
        path: &str,
    ) -> Result<ProjectFile, TaskRuntimeError> {
        self.local_store.create_project_folder(project_id, path)
    }

    pub fn upload_project_file(
        &self,
        project_id: &str,
        path: Option<&str>,
        input: BinaryInput,
    ) -> Result<ProjectFile, TaskRuntimeError> {
        self.local_store
            .upload_project_file(project_id, path, input)
    }

    pub fn move_project_file(
        &self,
        file_id: &str,
        path: &str,
        version: i64,
    ) -> Result<ProjectFile, TaskRuntimeError> {
        self.local_store.move_project_file(file_id, path, version)
    }

    pub fn delete_project_file(
        &self,
        file_id: &str,
        recursive: bool,
    ) -> Result<(), TaskRuntimeError> {
        self.local_store.delete_project_file(file_id, recursive)
    }

    pub fn project_file_path(&self, file_id: &str) -> Result<String, TaskRuntimeError> {
        Ok(self
            .local_store
            .project_file_path(file_id)?
            .display()
            .to_string())
    }

    pub async fn add_task_attachment(
        &self,
        project_id: &str,
        item_id: &str,
        input: BinaryInput,
    ) -> Result<TaskAttachment, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            TaskProviderKind::Gitlab => {
                self.issue_provider
                    .upload_attachment(&project, TaskProviderKind::Gitlab, item_id, input)
                    .await
            }
            TaskProviderKind::Local | TaskProviderKind::Github => {
                let persisted = self.content_target(project_id, item_id).await?;
                self.local_store
                    .add_task_attachment(project_id, item_id, persisted, input)
            }
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?} attachments"
            ))),
        }
    }

    pub async fn list_task_attachments(
        &self,
        project_id: &str,
        item_id: &str,
    ) -> Result<Vec<TaskAttachment>, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            TaskProviderKind::Gitlab => {
                self.issue_provider
                    .list_attachments(&project, TaskProviderKind::Gitlab, item_id)
                    .await
            }
            TaskProviderKind::Local | TaskProviderKind::Github => {
                self.local_store.list_task_attachments(item_id)
            }
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?} attachments"
            ))),
        }
    }

    pub async fn task_attachment_path(
        &self,
        project_id: &str,
        item_id: &str,
        attachment_id: &str,
    ) -> Result<String, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            TaskProviderKind::Gitlab => Ok(self
                .issue_provider
                .download_attachment(&project, TaskProviderKind::Gitlab, item_id, attachment_id)
                .await?
                .display()
                .to_string()),
            TaskProviderKind::Local | TaskProviderKind::Github => Ok(self
                .local_store
                .task_attachment_path(attachment_id)?
                .display()
                .to_string()),
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?} attachments"
            ))),
        }
    }

    pub async fn delete_task_attachment(
        &self,
        project_id: &str,
        item_id: &str,
        attachment_id: &str,
    ) -> Result<(), TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            TaskProviderKind::Gitlab => {
                self.issue_provider
                    .delete_attachment(&project, TaskProviderKind::Gitlab, item_id, attachment_id)
                    .await
            }
            TaskProviderKind::Local | TaskProviderKind::Github => {
                self.local_store.delete_task_attachment(attachment_id)
            }
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?} attachments"
            ))),
        }
    }

    pub async fn create_delivery(
        &self,
        project_id: &str,
        item_id: &str,
        input: DeliveryCreate,
    ) -> Result<Delivery, TaskRuntimeError> {
        let persisted = self.content_target(project_id, item_id).await?;
        self.local_store
            .create_delivery(project_id, item_id, persisted, input)
    }

    pub fn add_delivery_asset(
        &self,
        delivery_id: &str,
        relative_path: &str,
        input: BinaryInput,
    ) -> Result<DeliveryAsset, TaskRuntimeError> {
        self.local_store
            .add_delivery_asset(delivery_id, relative_path, input)
    }

    pub fn finalize_delivery(
        &self,
        item_id: &str,
        delivery_id: &str,
    ) -> Result<Delivery, TaskRuntimeError> {
        self.local_store.finalize_delivery(item_id, delivery_id)
    }

    pub fn discard_delivery(&self, delivery_id: &str) -> Result<(), TaskRuntimeError> {
        self.local_store.discard_delivery(delivery_id)
    }

    pub fn list_deliveries(&self, item_id: &str) -> Result<Vec<Delivery>, TaskRuntimeError> {
        self.local_store.list_deliveries(item_id)
    }

    pub fn delivery_detail(&self, delivery_id: &str) -> Result<DeliveryDetail, TaskRuntimeError> {
        self.local_store.delivery_detail(delivery_id)
    }

    pub fn delivery_asset_path(&self, asset_id: &str) -> Result<String, TaskRuntimeError> {
        Ok(self
            .local_store
            .delivery_asset_path(asset_id)?
            .display()
            .to_string())
    }

    async fn content_target(
        &self,
        project_id: &str,
        item_id: &str,
    ) -> Result<bool, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            TaskProviderKind::Local => {
                self.local_store.get_task(project_id, item_id)?;
                Ok(true)
            }
            provider @ (TaskProviderKind::Github | TaskProviderKind::Gitlab) => {
                self.issue_provider.get(&project, provider, item_id).await?;
                Ok(false)
            }
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?} content"
            ))),
        }
    }
}

fn mask_project(mut project: LoopItem) -> LoopItem {
    if let Some(provider_config) = project.metadata.get_mut("provider_config") {
        mask_provider_config(provider_config);
    }
    project
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{
        extract::{Multipart, State},
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::get,
        Json, Router,
    };
    use serde_json::json;

    use crate::task_runtime::ProjectStoreKind;

    use super::*;

    async fn github_issues() -> Json<serde_json::Value> {
        Json(json!([
            {
                "number": 7,
                "title": "External issue",
                "body": "Details\n\nWegent-Parent: #3",
                "state": "open",
                "html_url": "https://github.test/acme/repo/issues/7",
                "user": {"login": "octocat"},
                "labels": [
                    {"name": "bug"},
                    {"name": "wegent:status:in_review"}
                ],
                "comments": 2,
                "created_at": "2026-07-01T00:00:00Z",
                "updated_at": "2026-07-02T00:00:00Z",
                "closed_at": null,
                "pull_request": null
            },
            {
                "number": 8,
                "title": "Pull request",
                "body": null,
                "state": "open",
                "html_url": "https://github.test/acme/repo/pull/8",
                "user": {"login": "octocat"},
                "labels": [],
                "comments": 0,
                "created_at": "2026-07-01T00:00:00Z",
                "updated_at": "2026-07-02T00:00:00Z",
                "closed_at": null,
                "pull_request": {"url": "https://api.github.test/pulls/8"}
            }
        ]))
    }

    async fn github_issue() -> Json<serde_json::Value> {
        Json(github_issues().await.0[0].clone())
    }

    fn github_issue_response(
        number: i64,
        title: &str,
        body: &str,
        state: &str,
        labels: &[&str],
    ) -> serde_json::Value {
        json!({
            "number": number,
            "title": title,
            "body": body,
            "state": state,
            "html_url": format!("https://github.test/acme/repo/issues/{number}"),
            "user": {"login": "octocat"},
            "labels": labels
                .iter()
                .map(|name| json!({"name": name}))
                .collect::<Vec<_>>(),
            "comments": 0,
            "created_at": "2026-07-05T00:00:00Z",
            "updated_at": "2026-07-06T00:00:00Z",
            "closed_at": (state == "closed").then_some("2026-07-06T00:00:00Z"),
            "pull_request": null
        })
    }

    async fn create_github_issue(
        headers: HeaderMap,
        Json(body): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        assert_eq!(headers.get("authorization").unwrap(), "Bearer test-token");
        assert_eq!(body["title"], "Created issue");
        assert_eq!(body["body"], "Description\n\nWegent-Parent: #7");
        assert_eq!(body["labels"], json!(["bug", "wegent:status:pending"]));
        Json(github_issue_response(
            10,
            "Created issue",
            body["body"].as_str().unwrap(),
            "open",
            &["bug", "wegent:status:pending"],
        ))
    }

    async fn get_created_github_issue() -> Json<serde_json::Value> {
        Json(github_issue_response(
            10,
            "Created issue",
            "Description\n\nWegent-Parent: #7",
            "open",
            &["bug", "wegent:status:pending"],
        ))
    }

    async fn update_github_issue(
        headers: HeaderMap,
        Json(body): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        assert_eq!(headers.get("authorization").unwrap(), "Bearer test-token");
        let completed = body["state"] == "closed";
        let expected_status = if completed {
            "wegent:status:completed"
        } else {
            "wegent:status:in_progress"
        };
        assert_eq!(body["labels"], json!(["bug", expected_status]));
        Json(github_issue_response(
            10,
            body["title"].as_str().unwrap_or("Created issue"),
            "Description\n\nWegent-Parent: #7",
            if completed { "closed" } else { "open" },
            &["bug", expected_status],
        ))
    }

    async fn create_github_comment(
        headers: HeaderMap,
        Json(body): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        assert_eq!(headers.get("authorization").unwrap(), "Bearer test-token");
        assert_eq!(body["body"], "Shipped");
        Json(json!({
            "id": 99,
            "body": "Shipped",
            "html_url": "https://github.test/acme/repo/issues/10#issuecomment-99",
            "user": {"login": "octocat"},
            "created_at": "2026-07-06T01:00:00Z",
            "updated_at": "2026-07-06T01:00:00Z"
        }))
    }

    async fn gitlab_issues() -> Json<serde_json::Value> {
        Json(json!([{
            "iid": 9,
            "title": "GitLab issue",
            "description": "Done",
            "state": "closed",
            "web_url": "https://gitlab.test/acme/repo/-/issues/9",
            "author": {"username": "fox"},
            "labels": ["delivery", "wegent:status:in_progress"],
            "user_notes_count": 4,
            "created_at": "2026-07-03T00:00:00Z",
            "updated_at": "2026-07-04T00:00:00Z",
            "closed_at": "2026-07-04T00:00:00Z"
        }]))
    }

    fn gitlab_issue_response(title: &str, state: &str, labels: &[&str]) -> serde_json::Value {
        json!({
            "iid": 11,
            "title": title,
            "description": "GitLab body\n\nWegent-Parent: #9",
            "state": state,
            "web_url": "https://gitlab.test/acme/repo/-/issues/11",
            "author": {"username": "fox"},
            "labels": labels,
            "user_notes_count": 0,
            "created_at": "2026-07-07T00:00:00Z",
            "updated_at": "2026-07-08T00:00:00Z",
            "closed_at": (state == "closed").then_some("2026-07-08T00:00:00Z")
        })
    }

    async fn create_gitlab_issue(
        headers: HeaderMap,
        Json(body): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        assert_eq!(headers.get("private-token").unwrap(), "test-token");
        assert_eq!(body["title"], "GitLab created");
        assert_eq!(body["description"], "GitLab body\n\nWegent-Parent: #9");
        assert_eq!(body["labels"], "delivery,wegent:status:pending");
        Json(gitlab_issue_response(
            "GitLab created",
            "opened",
            &["delivery", "wegent:status:pending"],
        ))
    }

    async fn get_created_gitlab_issue() -> Json<serde_json::Value> {
        Json(gitlab_issue_response(
            "GitLab created",
            "opened",
            &["delivery", "wegent:status:pending"],
        ))
    }

    async fn update_gitlab_issue(
        headers: HeaderMap,
        Json(body): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        assert_eq!(headers.get("private-token").unwrap(), "test-token");
        let completed = body["state_event"] == "close";
        let expected_status = if completed {
            "wegent:status:completed"
        } else {
            "wegent:status:in_progress"
        };
        assert_eq!(body["labels"], format!("delivery,{expected_status}"));
        Json(gitlab_issue_response(
            "GitLab created",
            if completed { "closed" } else { "opened" },
            &["delivery", expected_status],
        ))
    }

    async fn create_gitlab_comment(
        headers: HeaderMap,
        Json(body): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        assert_eq!(headers.get("private-token").unwrap(), "test-token");
        assert_eq!(body["body"], "GitLab shipped");
        Json(json!({
            "id": 101,
            "body": "GitLab shipped",
            "author": {"username": "fox"},
            "created_at": "2026-07-08T01:00:00Z",
            "updated_at": "2026-07-08T01:00:00Z"
        }))
    }

    #[derive(Clone, Default)]
    struct GitlabAttachmentState {
        description: Arc<Mutex<String>>,
        upload_deleted: Arc<Mutex<bool>>,
    }

    fn gitlab_attachment_issue(description: &str) -> serde_json::Value {
        json!({
            "iid": 11,
            "title": "GitLab attachment issue",
            "description": description,
            "state": "opened",
            "web_url": "https://gitlab.test/acme/repo/-/issues/11",
            "author": {"username": "fox"},
            "labels": ["wegent:status:pending"],
            "user_notes_count": 0,
            "created_at": "2026-07-27T00:00:00Z",
            "updated_at": "2026-07-27T00:00:00Z",
            "closed_at": null
        })
    }

    async fn get_gitlab_attachment_issue(
        State(state): State<GitlabAttachmentState>,
    ) -> Json<serde_json::Value> {
        Json(gitlab_attachment_issue(&state.description.lock().unwrap()))
    }

    async fn update_gitlab_attachment_issue(
        State(state): State<GitlabAttachmentState>,
        headers: HeaderMap,
        Json(body): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        assert_eq!(headers.get("private-token").unwrap(), "test-token");
        let description = body["description"].as_str().unwrap().to_owned();
        *state.description.lock().unwrap() = description.clone();
        Json(gitlab_attachment_issue(&description))
    }

    async fn upload_gitlab_attachment(
        headers: HeaderMap,
        mut multipart: Multipart,
    ) -> Json<serde_json::Value> {
        assert_eq!(headers.get("private-token").unwrap(), "test-token");
        let field = multipart.next_field().await.unwrap().unwrap();
        assert_eq!(field.name(), Some("file"));
        assert_eq!(field.file_name(), Some("notes.txt"));
        assert_eq!(field.bytes().await.unwrap().as_ref(), b"hello gitlab");
        Json(json!({
            "id": 55,
            "url": "/uploads/upload-secret/notes.txt",
            "full_path": "/-/project/12/uploads/upload-secret/notes.txt",
            "markdown": "[notes.txt](/uploads/upload-secret/notes.txt)"
        }))
    }

    async fn download_gitlab_attachment(headers: HeaderMap) -> impl IntoResponse {
        assert_eq!(headers.get("private-token").unwrap(), "test-token");
        (StatusCode::OK, b"hello gitlab".to_vec())
    }

    async fn delete_gitlab_attachment(
        State(state): State<GitlabAttachmentState>,
        headers: HeaderMap,
    ) -> StatusCode {
        assert_eq!(headers.get("private-token").unwrap(), "test-token");
        *state.upload_deleted.lock().unwrap() = true;
        StatusCode::NO_CONTENT
    }

    #[tokio::test]
    async fn routes_github_issues_without_persisting_task_rows() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/repos/acme/repo/issues", get(github_issues))
                    .route("/repos/acme/repo/issues/7", get(github_issue)),
            )
            .await
            .unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "GitHub".to_owned(),
                project_key: Some("GH".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Github,
                provider_config: json!({
                    "repository": "acme/repo",
                    "domain": "127.0.0.1",
                    "api_base": format!("http://{address}")
                }),
            })
            .unwrap();
        let runtime = TaskRuntime::new(store.clone()).unwrap();

        let issues = runtime.list_tasks(&project.id).await.unwrap();

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].id, "GH-7");
        assert_eq!(issues[0].parent_id.as_deref(), Some("GH-3"));
        assert_eq!(issues[0].status.as_deref(), Some("in_review"));
        assert_eq!(issues[0].metadata["labels"], json!(["bug"]));
        let issue = runtime.get_task(&project.id, "GH-7").await.unwrap();
        assert_eq!(issue.title.as_deref(), Some("External issue"));
        assert!(matches!(
            store.get_task(&project.id, "GH-7"),
            Err(TaskRuntimeError::TaskNotFound)
        ));
        server.abort();
    }

    #[tokio::test]
    async fn routes_gitlab_issues_and_maps_closed_state() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/projects/12/issues", get(gitlab_issues)),
            )
            .await
            .unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "GitLab".to_owned(),
                project_key: Some("GL".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Gitlab,
                provider_config: json!({
                    "repository": "12",
                    "domain": "127.0.0.1",
                    "api_base": format!("http://{address}")
                }),
            })
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();

        let issues = runtime.list_tasks(&project.id).await.unwrap();

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].id, "GL-9");
        assert_eq!(issues[0].status.as_deref(), Some("completed"));
        assert_eq!(
            issues[0].completed_at.as_deref(),
            Some("2026-07-04T00:00:00Z")
        );
        server.abort();
    }

    #[tokio::test]
    async fn creates_updates_and_comments_on_github_without_task_rows() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route(
                        "/repos/acme/repo/issues",
                        get(github_issues).post(create_github_issue),
                    )
                    .route(
                        "/repos/acme/repo/issues/10",
                        get(get_created_github_issue).patch(update_github_issue),
                    )
                    .route(
                        "/repos/acme/repo/issues/10/comments",
                        axum::routing::post(create_github_comment),
                    ),
            )
            .await
            .unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "GitHub writes".to_owned(),
                project_key: Some("GH".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Github,
                provider_config: json!({
                    "repository": "acme/repo",
                    "domain": "127.0.0.1",
                    "api_base": format!("http://{address}"),
                    "token": "test-token"
                }),
            })
            .unwrap();
        let runtime = TaskRuntime::new(store.clone()).unwrap();

        let created = runtime
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Created issue".to_owned(),
                    description: "Description".to_owned(),
                    status: "pending".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: Some("GH-7".to_owned()),
                    tags: vec!["bug".to_owned()],
                },
            )
            .await
            .unwrap();
        let in_progress = runtime
            .update_task(
                &project.id,
                &created.id,
                TaskUpdate {
                    version: created.version,
                    status: Some("in_progress".to_owned()),
                    ..TaskUpdate::default()
                },
            )
            .await
            .unwrap();
        let completed = runtime
            .update_task(
                &project.id,
                &created.id,
                TaskUpdate {
                    version: created.version,
                    title: Some("Finished issue".to_owned()),
                    status: Some("completed".to_owned()),
                    ..TaskUpdate::default()
                },
            )
            .await
            .unwrap();
        let comment = runtime
            .add_comment(&project.id, &created.id, "Shipped")
            .await
            .unwrap();

        assert_eq!(created.id, "GH-10");
        assert_eq!(in_progress.status.as_deref(), Some("in_progress"));
        assert_eq!(in_progress.metadata["labels"], json!(["bug"]));
        assert_eq!(completed.status.as_deref(), Some("completed"));
        assert_eq!(comment.id, "99");
        assert!(matches!(
            store.get_task(&project.id, "GH-10"),
            Err(TaskRuntimeError::TaskNotFound)
        ));
        server.abort();
    }

    #[tokio::test]
    async fn creates_updates_and_comments_on_gitlab_without_task_rows() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route(
                        "/projects/12/issues",
                        get(gitlab_issues).post(create_gitlab_issue),
                    )
                    .route(
                        "/projects/12/issues/11",
                        get(get_created_gitlab_issue).put(update_gitlab_issue),
                    )
                    .route(
                        "/projects/12/issues/11/notes",
                        axum::routing::post(create_gitlab_comment),
                    ),
            )
            .await
            .unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let runtime = TaskRuntime::new(store.clone()).unwrap();
        let project = runtime
            .configure_external_project(ProjectDescriptor {
                id: "cloud-gitlab-12".to_owned(),
                public_id: Some("cloud-gitlab-public".to_owned()),
                name: "GitLab writes".to_owned(),
                project_key: "GL".to_owned(),
                description: String::new(),
                project_store: ProjectStoreKind::Backend,
                task_provider: TaskProviderKind::Gitlab,
                provider_config: json!({
                    "repository": "12",
                    "domain": "127.0.0.1",
                    "api_base": format!("http://{address}"),
                    "token": "test-token"
                }),
                version: 1,
            })
            .unwrap();

        let created = runtime
            .create_task(
                &project.id,
                TaskCreate {
                    title: "GitLab created".to_owned(),
                    description: "GitLab body".to_owned(),
                    status: "pending".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: Some("GL-9".to_owned()),
                    tags: vec!["delivery".to_owned()],
                },
            )
            .await
            .unwrap();
        let in_progress = runtime
            .update_task(
                &project.id,
                &created.id,
                TaskUpdate {
                    version: created.version,
                    status: Some("in_progress".to_owned()),
                    ..TaskUpdate::default()
                },
            )
            .await
            .unwrap();
        let completed = runtime
            .update_task(
                &project.id,
                &created.id,
                TaskUpdate {
                    version: created.version,
                    status: Some("completed".to_owned()),
                    ..TaskUpdate::default()
                },
            )
            .await
            .unwrap();
        let comment = runtime
            .add_comment(&project.id, &created.id, "GitLab shipped")
            .await
            .unwrap();

        assert_eq!(created.id, "GL-11");
        assert_eq!(
            project.metadata["project_store"],
            json!(ProjectStoreKind::Backend)
        );
        assert_eq!(in_progress.status.as_deref(), Some("in_progress"));
        assert_eq!(in_progress.metadata["labels"], json!(["delivery"]));
        assert_eq!(completed.status.as_deref(), Some("completed"));
        assert_eq!(comment.id, "101");
        assert!(matches!(
            store.get_task(&project.id, "GL-11"),
            Err(TaskRuntimeError::TaskNotFound)
        ));
        server.abort();
    }

    #[tokio::test]
    async fn stores_gitlab_task_attachments_in_project_uploads() {
        let state = GitlabAttachmentState {
            description: Arc::new(Mutex::new("Issue details".to_owned())),
            upload_deleted: Arc::new(Mutex::new(false)),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route(
                        "/projects/12/issues/11",
                        get(get_gitlab_attachment_issue).put(update_gitlab_attachment_issue),
                    )
                    .route(
                        "/projects/12/uploads",
                        axum::routing::post(upload_gitlab_attachment),
                    )
                    .route(
                        "/projects/12/uploads/upload-secret/notes.txt",
                        get(download_gitlab_attachment),
                    )
                    .route(
                        "/projects/12/uploads/upload-secret",
                        axum::routing::delete(delete_gitlab_attachment),
                    )
                    .with_state(server_state),
            )
            .await
            .unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "GitLab attachments".to_owned(),
                project_key: Some("GL".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Gitlab,
                provider_config: json!({
                    "repository": "12",
                    "domain": "127.0.0.1",
                    "api_base": format!("http://{address}"),
                    "token": "test-token"
                }),
            })
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();

        let uploaded = runtime
            .add_task_attachment(
                &project.id,
                "GL-11",
                BinaryInput {
                    display_name: "notes.txt".to_owned(),
                    content_type: Some("text/plain".to_owned()),
                    base64: "aGVsbG8gZ2l0bGFi".to_owned(),
                },
            )
            .await
            .unwrap();

        assert_eq!(uploaded.id, "gitlab-11-upload-secret");
        assert_eq!(uploaded.loop_item_id, "GL-11");
        assert!(state
            .description
            .lock()
            .unwrap()
            .contains("<!-- wegent-attachments:v1:start -->"));
        let attachments = runtime
            .list_task_attachments(&project.id, "GL-11")
            .await
            .unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].display_name, "notes.txt");

        let path = runtime
            .task_attachment_path(&project.id, "GL-11", &uploaded.id)
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "hello gitlab");

        runtime
            .update_task(
                &project.id,
                "GL-11",
                TaskUpdate {
                    version: 1,
                    description: Some("Updated issue details".to_owned()),
                    ..TaskUpdate::default()
                },
            )
            .await
            .unwrap();
        let updated_description = state.description.lock().unwrap().clone();
        assert!(updated_description.starts_with("Updated issue details"));
        assert!(updated_description.contains("notes.txt"));

        runtime
            .delete_task_attachment(&project.id, "GL-11", &uploaded.id)
            .await
            .unwrap();
        assert!(*state.upload_deleted.lock().unwrap());
        assert_eq!(
            state.description.lock().unwrap().as_str(),
            "Updated issue details"
        );
        assert!(runtime
            .list_task_attachments(&project.id, "GL-11")
            .await
            .unwrap()
            .is_empty());
        server.abort();
    }

    fn aitable_project(store: &LocalTaskStore) -> LoopItem {
        store
            .create_project(ProjectCreate {
                name: "AI Table".to_owned(),
                project_key: Some("AIT".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::DingtalkAitable,
                provider_config: json!({
                    "base_id": "base-1",
                    "table_id": "table-1",
                    "board_mapping": {
                        "title_field_id": "fld_title",
                        "status_field_id": "fld_status"
                    }
                }),
            })
            .unwrap()
    }

    #[tokio::test]
    async fn routes_aitable_board_projection_without_task_rows() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = aitable_project(&store);
        let runtime = TaskRuntime::new(store).unwrap();
        assert!(matches!(
            runtime.list_tasks(&project.id).await,
            Err(TaskRuntimeError::ProviderRequest(_))
        ));
    }

    #[tokio::test]
    async fn aitable_native_describe_returns_dynamic_fields() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = aitable_project(&store);
        let runtime = TaskRuntime::new(store).unwrap();
        assert!(matches!(
            runtime.aitable_describe(&project.id).await,
            Err(TaskRuntimeError::ProviderRequest(_))
        ));
    }

    #[tokio::test]
    async fn aitable_record_write_requires_dws_authentication() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = aitable_project(&store);
        let runtime = TaskRuntime::new(store).unwrap();

        let mut cells = serde_json::Map::new();
        cells.insert("fld_title".to_owned(), json!("x"));
        let result = runtime.aitable_create_record(&project.id, cells).await;

        assert!(matches!(result, Err(TaskRuntimeError::ProviderRequest(_))));
    }

    #[test]
    fn aitable_provider_combinations_are_valid() {
        assert!(crate::task_runtime::store::validate_provider(
            ProjectStoreKind::Local,
            TaskProviderKind::DingtalkAitable
        )
        .is_ok());
        assert!(crate::task_runtime::store::validate_provider(
            ProjectStoreKind::Backend,
            TaskProviderKind::DingtalkAitable
        )
        .is_ok());
    }
}
