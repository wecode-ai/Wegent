// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::{
    credentials::mask_provider_config, issue_provider::IssueProvider, store::task_provider,
    BinaryInput, Delivery, DeliveryAsset, DeliveryCreate, DeliveryDetail, IssueComment,
    LocalTaskStore, LoopItem, ProjectCreate, ProjectDescriptor, ProjectFile, ProjectUpdate,
    RuntimeTaskAddress, TaskAttachment, TaskBinding, TaskCreate, TaskProviderKind, TaskReorder,
    TaskRuntimeError, TaskUpdate,
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
}

impl TaskRuntime {
    pub fn from_env() -> Result<Self, TaskRuntimeError> {
        Self::new(LocalTaskStore::from_env()?)
    }

    pub fn new(local_store: LocalTaskStore) -> Result<Self, TaskRuntimeError> {
        let issue_provider = IssueProvider::new(local_store.path().to_owned())?;
        Ok(Self {
            local_store,
            issue_provider,
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

    pub fn configure_external_project(
        &self,
        project: ProjectDescriptor,
    ) -> Result<LoopItem, TaskRuntimeError> {
        self.local_store
            .configure_external_project(project)
            .map(mask_project)
    }

    pub async fn list_external_tasks(
        &self,
        project: ProjectDescriptor,
    ) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let provider = project.task_provider;
        let project = self.local_store.external_project(project)?;
        self.issue_provider.list(&project, provider).await
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

    pub async fn list_tasks(&self, project_id: &str) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let project = self.local_store.get_project(project_id)?;
        match task_provider(&project)? {
            TaskProviderKind::Local => self.local_store.list_tasks(project_id),
            provider @ (TaskProviderKind::Github | TaskProviderKind::Gitlab) => {
                self.issue_provider.list(&project, provider).await
            }
            provider => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            ))),
        }
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
            TaskProviderKind::Github | TaskProviderKind::Gitlab => {
                self.list_tasks(project_id).await
            }
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
        let persisted = self.content_target(project_id, item_id).await?;
        self.local_store
            .add_task_attachment(project_id, item_id, persisted, input)
    }

    pub fn list_task_attachments(
        &self,
        item_id: &str,
    ) -> Result<Vec<TaskAttachment>, TaskRuntimeError> {
        self.local_store.list_task_attachments(item_id)
    }

    pub fn task_attachment_path(&self, attachment_id: &str) -> Result<String, TaskRuntimeError> {
        Ok(self
            .local_store
            .task_attachment_path(attachment_id)?
            .display()
            .to_string())
    }

    pub fn delete_task_attachment(&self, attachment_id: &str) -> Result<(), TaskRuntimeError> {
        self.local_store.delete_task_attachment(attachment_id)
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
    use axum::{http::HeaderMap, routing::get, Json, Router};
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
}
