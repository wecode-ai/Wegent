// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use chrono::Utc;
use reqwest::{
    multipart::{Form, Part},
    Client, RequestBuilder,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::{form_urlencoded::byte_serialize, Url};

use crate::logging::{format_executor_log, write_executor_log_line};

use super::{
    credentials::decrypt_provider_credential, BinaryInput, IssueComment, LoopItem, TaskAttachment,
    TaskCreate, TaskProviderKind, TaskRuntimeError, TaskUpdate,
};

const PARENT_MARKER: &str = "Wegent-Parent:";
const PRIORITY_LABEL_PREFIX: &str = "wegent:priority:";
const STATUS_LABEL_PREFIX: &str = "wegent:status:";
const CREATOR_LABEL_PREFIX: &str = "wegent:creator:";
const ATTACHMENT_BLOCK_START: &str = "<!-- wegent-attachments:v1:start -->";
const ATTACHMENT_BLOCK_END: &str = "<!-- wegent-attachments:v1:end -->";
const ATTACHMENT_DATA_PREFIX: &str = "<!-- wegent-attachments:data:";
const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = 100;

#[derive(Clone)]
pub(crate) struct IssueProvider {
    client: Client,
    database_path: PathBuf,
}

impl IssueProvider {
    pub(crate) fn new(database_path: PathBuf) -> Result<Self, TaskRuntimeError> {
        let client = Client::builder()
            .user_agent(concat!("wegent-executor/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(provider_error)?;
        Ok(Self {
            client,
            database_path,
        })
    }

    pub(crate) async fn list(
        &self,
        project: &LoopItem,
        provider: TaskProviderKind,
    ) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let config = self.provider_config(project, provider)?;
        match provider {
            TaskProviderKind::Github => self.list_github(project, &config).await,
            TaskProviderKind::Gitlab => self.list_gitlab(project, &config).await,
            _ => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            ))),
        }
    }

    pub(crate) async fn get(
        &self,
        project: &LoopItem,
        provider: TaskProviderKind,
        task_id: &str,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let config = self.provider_config(project, provider)?;
        let number = issue_number(project, task_id)?;
        match provider {
            TaskProviderKind::Github => self.get_github(project, &config, number).await,
            TaskProviderKind::Gitlab => self.get_gitlab(project, &config, number).await,
            _ => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            ))),
        }
    }

    pub(crate) async fn create(
        &self,
        project: &LoopItem,
        provider: TaskProviderKind,
        input: TaskCreate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        validate_external_title(&input.title)?;
        validate_external_status(&input.status)?;
        let config = self.provider_config(project, provider)?;
        config.require_write_token()?;
        let description = with_parent_marker(
            &input.description,
            input
                .parent_id
                .as_deref()
                .map(|parent_id| issue_number(project, parent_id))
                .transpose()?,
        );
        match provider {
            TaskProviderKind::Github => {
                let url = format!("{}/repos/{}/issues", config.api_base, config.repository);
                let issue = self
                    .send(
                        provider,
                        "create",
                        &config.repository,
                        config
                            .authorize(self.client.post(url), provider)
                            .json(&json!({
                                "title": input.title,
                                "body": description,
                                "labels": labels_for_write(
                                    input.tags,
                                    &input.priority,
                                    &input.status,
                                ),
                            })),
                    )
                    .await?
                    .json::<GithubIssue>()
                    .await
                    .map_err(provider_error)?;
                let item = github_loop_item(project, issue);
                if input.status == "completed" {
                    return self
                        .update(
                            project,
                            provider,
                            &item.id,
                            TaskUpdate {
                                version: item.version,
                                status: Some(input.status),
                                ..TaskUpdate::default()
                            },
                        )
                        .await;
                }
                Ok(item)
            }
            TaskProviderKind::Gitlab => {
                let repository = encode_path_segment(&config.repository);
                let url = format!("{}/projects/{repository}/issues", config.api_base);
                let issue = self
                    .send(
                        provider,
                        "create",
                        &config.repository,
                        config
                            .authorize(self.client.post(url), provider)
                            .json(&json!({
                                "title": input.title,
                                "description": description,
                                "labels": labels_for_write(
                                    input.tags,
                                    &input.priority,
                                    &input.status,
                                ).join(","),
                            })),
                    )
                    .await?
                    .json::<GitlabIssue>()
                    .await
                    .map_err(provider_error)?;
                let item = gitlab_loop_item(project, issue);
                if input.status == "completed" {
                    return self
                        .update(
                            project,
                            provider,
                            &item.id,
                            TaskUpdate {
                                version: item.version,
                                status: Some(input.status),
                                ..TaskUpdate::default()
                            },
                        )
                        .await;
                }
                Ok(item)
            }
            _ => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            ))),
        }
    }

    pub(crate) async fn update(
        &self,
        project: &LoopItem,
        provider: TaskProviderKind,
        task_id: &str,
        input: TaskUpdate,
    ) -> Result<LoopItem, TaskRuntimeError> {
        if let Some(priority) = input.priority.as_deref() {
            validate_external_priority(priority)?;
        }
        if let Some(title) = input.title.as_deref() {
            validate_external_title(title)?;
        }
        if let Some(status) = input.status.as_deref() {
            validate_external_status(status)?;
        }
        let config = self.provider_config(project, provider)?;
        config.require_write_token()?;
        let number = issue_number(project, task_id)?;
        let updates_labels =
            input.tags.is_some() || input.priority.is_some() || input.status.is_some();
        let updates_description = input.description.is_some() || input.parent_id.is_some();
        let needs_current = (input.description.is_none() && input.parent_id.is_some())
            || (provider == TaskProviderKind::Gitlab && updates_description)
            || updates_labels;
        let current = if needs_current {
            Some(self.get(project, provider, task_id).await?)
        } else {
            None
        };
        let labels = if updates_labels {
            let mut tags = input.tags.clone().unwrap_or_else(|| {
                current
                    .as_ref()
                    .and_then(|item| item.metadata.get("labels"))
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToOwned::to_owned)
                            .collect()
                    })
                    .unwrap_or_default()
            });
            tags.retain(|label| !label.starts_with(CREATOR_LABEL_PREFIX));
            if let Some(created_by_user_id) = current
                .as_ref()
                .map(|item| item.created_by_user_id)
                .filter(|value| *value > 0)
            {
                tags.push(format!("{CREATOR_LABEL_PREFIX}{created_by_user_id}"));
            }
            let priority = input
                .priority
                .as_deref()
                .or_else(|| current.as_ref().and_then(|item| item.priority.as_deref()))
                .unwrap_or("none");
            let status = input
                .status
                .as_deref()
                .or_else(|| current.as_ref().and_then(|item| item.status.as_deref()))
                .unwrap_or("pending");
            Some(labels_for_write(tags, priority, status))
        } else {
            None
        };
        let description = match (input.description, input.parent_id) {
            (Some(description), parent_id) => Some(with_parent_marker(
                &description,
                parent_id
                    .flatten()
                    .as_deref()
                    .map(|parent_id| issue_number(project, parent_id))
                    .transpose()?,
            )),
            (None, Some(parent_id)) => Some(with_parent_marker(
                current
                    .as_ref()
                    .map(|item| item.description.as_str())
                    .unwrap_or_default(),
                parent_id
                    .as_deref()
                    .map(|parent_id| issue_number(project, parent_id))
                    .transpose()?,
            )),
            (None, None) => None,
        };
        match provider {
            TaskProviderKind::Github => {
                let url = format!(
                    "{}/repos/{}/issues/{number}",
                    config.api_base, config.repository
                );
                let mut body = serde_json::Map::new();
                insert_optional(&mut body, "title", input.title);
                insert_optional(&mut body, "body", description);
                insert_optional(&mut body, "labels", labels);
                if let Some(status) = input.status {
                    body.insert(
                        "state".to_owned(),
                        json!(if status == "completed" {
                            "closed"
                        } else {
                            "open"
                        }),
                    );
                }
                let issue = self
                    .send(
                        provider,
                        "update",
                        &config.repository,
                        config
                            .authorize(self.client.patch(url), provider)
                            .json(&body),
                    )
                    .await?
                    .json::<GithubIssue>()
                    .await
                    .map_err(provider_error)?;
                Ok(github_loop_item(project, issue))
            }
            TaskProviderKind::Gitlab => {
                let repository = encode_path_segment(&config.repository);
                let url = format!("{}/projects/{repository}/issues/{number}", config.api_base);
                let mut body = serde_json::Map::new();
                insert_optional(&mut body, "title", input.title);
                let description = description
                    .map(|description| {
                        let attachments = current
                            .as_ref()
                            .map(gitlab_attachment_records)
                            .transpose()?
                            .unwrap_or_default();
                        render_gitlab_attachment_manifest(&description, &attachments)
                    })
                    .transpose()?;
                insert_optional(&mut body, "description", description);
                if let Some(labels) = labels {
                    body.insert("labels".to_owned(), json!(labels.join(",")));
                }
                if let Some(status) = input.status {
                    body.insert(
                        "state_event".to_owned(),
                        json!(if status == "completed" {
                            "close"
                        } else {
                            "reopen"
                        }),
                    );
                }
                let issue = self
                    .send(
                        provider,
                        "update",
                        &config.repository,
                        config.authorize(self.client.put(url), provider).json(&body),
                    )
                    .await?
                    .json::<GitlabIssue>()
                    .await
                    .map_err(provider_error)?;
                Ok(gitlab_loop_item(project, issue))
            }
            _ => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            ))),
        }
    }

    pub(crate) async fn add_comment(
        &self,
        project: &LoopItem,
        provider: TaskProviderKind,
        task_id: &str,
        body: &str,
    ) -> Result<IssueComment, TaskRuntimeError> {
        if body.trim().is_empty() {
            return Err(invalid("comment body is required"));
        }
        let config = self.provider_config(project, provider)?;
        config.require_write_token()?;
        let number = issue_number(project, task_id)?;
        match provider {
            TaskProviderKind::Github => {
                let url = format!(
                    "{}/repos/{}/issues/{number}/comments",
                    config.api_base, config.repository
                );
                let comment = self
                    .send(
                        provider,
                        "comment",
                        &config.repository,
                        config
                            .authorize(self.client.post(url), provider)
                            .json(&json!({"body": body.trim()})),
                    )
                    .await?
                    .json::<GithubComment>()
                    .await
                    .map_err(provider_error)?;
                Ok(IssueComment {
                    id: comment.id.to_string(),
                    body: comment.body,
                    author: comment.user.login,
                    web_url: Some(comment.html_url),
                    created_at: comment.created_at,
                    updated_at: comment.updated_at,
                })
            }
            TaskProviderKind::Gitlab => {
                let repository = encode_path_segment(&config.repository);
                let url = format!(
                    "{}/projects/{repository}/issues/{number}/notes",
                    config.api_base
                );
                let comment = self
                    .send(
                        provider,
                        "comment",
                        &config.repository,
                        config
                            .authorize(self.client.post(url), provider)
                            .json(&json!({"body": body.trim()})),
                    )
                    .await?
                    .json::<GitlabComment>()
                    .await
                    .map_err(provider_error)?;
                Ok(IssueComment {
                    id: comment.id.to_string(),
                    body: comment.body,
                    author: comment.author.username,
                    web_url: None,
                    created_at: comment.created_at,
                    updated_at: comment.updated_at,
                })
            }
            _ => Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?}"
            ))),
        }
    }

    pub(crate) async fn list_attachments(
        &self,
        project: &LoopItem,
        provider: TaskProviderKind,
        task_id: &str,
    ) -> Result<Vec<TaskAttachment>, TaskRuntimeError> {
        if provider != TaskProviderKind::Gitlab {
            return Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?} attachments"
            )));
        }
        let item = self.get(project, provider, task_id).await?;
        Ok(gitlab_attachment_records(&item)?
            .into_iter()
            .map(|record| record.to_task_attachment(task_id))
            .collect())
    }

    pub(crate) async fn upload_attachment(
        &self,
        project: &LoopItem,
        provider: TaskProviderKind,
        task_id: &str,
        input: BinaryInput,
    ) -> Result<TaskAttachment, TaskRuntimeError> {
        if provider != TaskProviderKind::Gitlab {
            return Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?} attachments"
            )));
        }
        let config = self.provider_config(project, provider)?;
        config.require_write_token()?;
        let number = issue_number(project, task_id)?;
        let current = self.get_gitlab(project, &config, number).await?;
        let bytes = STANDARD
            .decode(input.base64.as_bytes())
            .map_err(|error| invalid(format!("attachment base64 is invalid: {error}")))?;
        if input.display_name.trim().is_empty() {
            return Err(invalid("attachment display_name is required"));
        }
        let repository = encode_path_segment(&config.repository);
        let url = format!("{}/projects/{repository}/uploads", config.api_base);
        let mut part = Part::bytes(bytes.clone()).file_name(input.display_name.clone());
        if let Some(content_type) = input.content_type.as_deref() {
            part = part.mime_str(content_type).map_err(provider_error)?;
        }
        let upload = self
            .send(
                provider,
                "upload_attachment",
                &config.repository,
                config
                    .authorize(self.client.post(url), provider)
                    .multipart(Form::new().part("file", part)),
            )
            .await?
            .json::<GitlabUpload>()
            .await
            .map_err(provider_error)?;
        let secret = gitlab_upload_secret(&upload.url)?;
        let record = GitlabAttachmentRecord {
            id: format!("gitlab-{number}-{secret}"),
            upload_id: upload.id,
            secret,
            display_name: input.display_name,
            content_type: input.content_type,
            size_bytes: bytes.len() as i64,
            sha256: sha256_hex(&bytes),
            url: upload.url,
            full_path: upload.full_path,
            markdown: upload.markdown,
            created_at: Utc::now().to_rfc3339(),
        };
        let mut records = gitlab_attachment_records(&current)?;
        records.push(record.clone());
        if let Err(error) = self
            .update_gitlab_attachment_manifest(
                project,
                &config,
                number,
                &current.description,
                &records,
            )
            .await
        {
            let _ = self
                .delete_gitlab_upload(&config, provider, &record.secret)
                .await;
            return Err(error);
        }
        Ok(record.to_task_attachment(task_id))
    }

    pub(crate) async fn download_attachment(
        &self,
        project: &LoopItem,
        provider: TaskProviderKind,
        task_id: &str,
        attachment_id: &str,
    ) -> Result<PathBuf, TaskRuntimeError> {
        if provider != TaskProviderKind::Gitlab {
            return Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?} attachments"
            )));
        }
        let config = self.provider_config(project, provider)?;
        let item = self.get(project, provider, task_id).await?;
        let record = find_gitlab_attachment(&item, attachment_id)?;
        let repository = encode_path_segment(&config.repository);
        let filename = encode_path_segment(&record.display_name);
        let url = format!(
            "{}/projects/{repository}/uploads/{}/{filename}",
            config.api_base, record.secret
        );
        let bytes = self
            .send(
                provider,
                "download_attachment",
                &config.repository,
                config.authorize(self.client.get(url), provider),
            )
            .await?
            .bytes()
            .await
            .map_err(provider_error)?;
        if sha256_hex(&bytes) != record.sha256 {
            return Err(provider_error(
                "downloaded attachment checksum does not match",
            ));
        }
        let path = self.attachment_cache_path(task_id, &record)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| invalid(format!("cannot create attachment cache: {error}")))?;
        }
        fs::write(&path, &bytes)
            .map_err(|error| invalid(format!("cannot write attachment cache: {error}")))?;
        Ok(path)
    }

    pub(crate) async fn delete_attachment(
        &self,
        project: &LoopItem,
        provider: TaskProviderKind,
        task_id: &str,
        attachment_id: &str,
    ) -> Result<(), TaskRuntimeError> {
        if provider != TaskProviderKind::Gitlab {
            return Err(TaskRuntimeError::UnsupportedProvider(format!(
                "{provider:?} attachments"
            )));
        }
        let config = self.provider_config(project, provider)?;
        config.require_write_token()?;
        let number = issue_number(project, task_id)?;
        let current = self.get_gitlab(project, &config, number).await?;
        let records = gitlab_attachment_records(&current)?;
        let record = records
            .iter()
            .find(|record| record.id == attachment_id)
            .cloned()
            .ok_or(TaskRuntimeError::TaskNotFound)?;
        let remaining = records
            .iter()
            .filter(|candidate| candidate.id != attachment_id)
            .cloned()
            .collect::<Vec<_>>();
        self.update_gitlab_attachment_manifest(
            project,
            &config,
            number,
            &current.description,
            &remaining,
        )
        .await?;
        if let Err(error) = self
            .delete_gitlab_upload(&config, provider, &record.secret)
            .await
        {
            let _ = self
                .update_gitlab_attachment_manifest(
                    project,
                    &config,
                    number,
                    &current.description,
                    &records,
                )
                .await;
            return Err(error);
        }
        let cache_path = self.attachment_cache_path(task_id, &record)?;
        let _ = fs::remove_file(cache_path);
        Ok(())
    }

    async fn update_gitlab_attachment_manifest(
        &self,
        project: &LoopItem,
        config: &ProviderConfig,
        number: i64,
        description: &str,
        records: &[GitlabAttachmentRecord],
    ) -> Result<LoopItem, TaskRuntimeError> {
        let repository = encode_path_segment(&config.repository);
        let url = format!("{}/projects/{repository}/issues/{number}", config.api_base);
        let issue = self
            .send(
                TaskProviderKind::Gitlab,
                "update_attachment_manifest",
                &config.repository,
                config
                    .authorize(self.client.put(url), TaskProviderKind::Gitlab)
                    .json(&json!({
                        "description": render_gitlab_attachment_manifest(description, records)?
                    })),
            )
            .await?
            .json::<GitlabIssue>()
            .await
            .map_err(provider_error)?;
        Ok(gitlab_loop_item(project, issue))
    }

    async fn delete_gitlab_upload(
        &self,
        config: &ProviderConfig,
        provider: TaskProviderKind,
        secret: &str,
    ) -> Result<(), TaskRuntimeError> {
        let repository = encode_path_segment(&config.repository);
        let secret = encode_path_segment(secret);
        let url = format!("{}/projects/{repository}/uploads/{secret}", config.api_base);
        self.send(
            provider,
            "delete_attachment",
            &config.repository,
            config.authorize(self.client.delete(url), provider),
        )
        .await?;
        Ok(())
    }

    fn attachment_cache_path(
        &self,
        task_id: &str,
        record: &GitlabAttachmentRecord,
    ) -> Result<PathBuf, TaskRuntimeError> {
        let root = self
            .database_path
            .parent()
            .ok_or_else(|| invalid("task database path is invalid"))?
            .join("cache")
            .join("gitlab-attachments");
        Ok(root
            .join(safe_path_component(task_id)?)
            .join(safe_path_component(&record.id)?)
            .join(safe_file_name(&record.display_name)))
    }

    async fn list_github(
        &self,
        project: &LoopItem,
        config: &ProviderConfig,
    ) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let mut issues = Vec::new();
        for page in 1..=MAX_PAGES {
            let url = format!(
                "{}/repos/{}/issues?state=all&per_page={PAGE_SIZE}&page={page}",
                config.api_base, config.repository
            );
            let mut batch = self
                .send(
                    TaskProviderKind::Github,
                    "list",
                    &config.repository,
                    config.authorize(self.client.get(url), TaskProviderKind::Github),
                )
                .await?
                .json::<Vec<GithubIssue>>()
                .await
                .map_err(provider_error)?;
            let complete = batch.len() < PAGE_SIZE;
            issues.append(&mut batch);
            if complete {
                break;
            }
        }
        Ok(issues
            .into_iter()
            .filter(|issue| issue.pull_request.is_none())
            .map(|issue| github_loop_item(project, issue))
            .collect())
    }

    fn provider_config(
        &self,
        project: &LoopItem,
        provider: TaskProviderKind,
    ) -> Result<ProviderConfig, TaskRuntimeError> {
        ProviderConfig::from_project(project, provider, &self.database_path)
    }

    async fn get_github(
        &self,
        project: &LoopItem,
        config: &ProviderConfig,
        number: i64,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let url = format!(
            "{}/repos/{}/issues/{number}",
            config.api_base, config.repository
        );
        let issue = self
            .send(
                TaskProviderKind::Github,
                "get",
                &config.repository,
                config.authorize(self.client.get(url), TaskProviderKind::Github),
            )
            .await?
            .json::<GithubIssue>()
            .await
            .map_err(provider_error)?;
        if issue.pull_request.is_some() {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        Ok(github_loop_item(project, issue))
    }

    async fn list_gitlab(
        &self,
        project: &LoopItem,
        config: &ProviderConfig,
    ) -> Result<Vec<LoopItem>, TaskRuntimeError> {
        let repository = encode_path_segment(&config.repository);
        let mut issues = Vec::new();
        for page in 1..=MAX_PAGES {
            let url = format!(
                "{}/projects/{repository}/issues?scope=all&per_page={PAGE_SIZE}&page={page}",
                config.api_base
            );
            let mut batch = self
                .send(
                    TaskProviderKind::Gitlab,
                    "list",
                    &config.repository,
                    config.authorize(self.client.get(url), TaskProviderKind::Gitlab),
                )
                .await?
                .json::<Vec<GitlabIssue>>()
                .await
                .map_err(provider_error)?;
            let complete = batch.len() < PAGE_SIZE;
            issues.append(&mut batch);
            if complete {
                break;
            }
        }
        Ok(issues
            .into_iter()
            .map(|issue| gitlab_loop_item(project, issue))
            .collect())
    }

    async fn get_gitlab(
        &self,
        project: &LoopItem,
        config: &ProviderConfig,
        number: i64,
    ) -> Result<LoopItem, TaskRuntimeError> {
        let repository = encode_path_segment(&config.repository);
        let url = format!("{}/projects/{repository}/issues/{number}", config.api_base);
        let issue = self
            .send(
                TaskProviderKind::Gitlab,
                "get",
                &config.repository,
                config.authorize(self.client.get(url), TaskProviderKind::Gitlab),
            )
            .await?
            .json::<GitlabIssue>()
            .await
            .map_err(provider_error)?;
        Ok(gitlab_loop_item(project, issue))
    }

    async fn send(
        &self,
        provider: TaskProviderKind,
        operation: &str,
        repository: &str,
        request: RequestBuilder,
    ) -> Result<reqwest::Response, TaskRuntimeError> {
        let request = request.build().map_err(provider_error)?;
        let method = request.method().to_string();
        let endpoint = provider_log_endpoint(operation, request.url());
        let fields = [
            ("provider", provider_key(provider).to_owned()),
            ("operation", operation.to_owned()),
            ("repository", repository.to_owned()),
            ("method", method),
            ("endpoint", endpoint),
        ];
        write_executor_log_line(&format_executor_log(
            "external issue request started",
            &fields,
        ));
        let response = match self.client.execute(request).await {
            Ok(response) => response,
            Err(error) => {
                write_executor_log_line(&format_executor_log(
                    "external issue request failed",
                    &[
                        ("provider", provider_key(provider).to_owned()),
                        ("operation", operation.to_owned()),
                        ("repository", repository.to_owned()),
                        ("error", error.to_string()),
                    ],
                ));
                return Err(provider_error(error));
            }
        };
        write_executor_log_line(&format_executor_log(
            "external issue request finished",
            &[
                ("provider", provider_key(provider).to_owned()),
                ("operation", operation.to_owned()),
                ("repository", repository.to_owned()),
                ("status", response.status().as_u16().to_string()),
            ],
        ));
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(TaskRuntimeError::TaskNotFound);
        }
        response.error_for_status().map_err(provider_error)
    }
}

fn provider_key(provider: TaskProviderKind) -> &'static str {
    match provider {
        TaskProviderKind::Github => "github",
        TaskProviderKind::Gitlab => "gitlab",
        TaskProviderKind::Local => "local",
        TaskProviderKind::Backend => "backend",
    }
}

fn provider_log_endpoint(operation: &str, url: &Url) -> String {
    if !matches!(operation, "download_attachment" | "delete_attachment") {
        return url.to_string();
    }
    let mut sanitized = url.clone();
    let segments = sanitized
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .unwrap_or_default();
    let Some(upload_index) = segments.iter().position(|segment| *segment == "uploads") else {
        return sanitized.to_string();
    };
    let redacted = segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            if index == upload_index + 1 {
                "***"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>()
        .join("/");
    sanitized.set_path(&format!("/{redacted}"));
    sanitized.to_string()
}

fn normalize_repository(
    repository: &str,
    provider: TaskProviderKind,
) -> Result<String, TaskRuntimeError> {
    let normalized = repository.trim().trim_matches('/');
    let normalized = if provider == TaskProviderKind::Gitlab {
        normalized.split("/-/").next().unwrap_or_default()
    } else {
        normalized
    };
    let normalized = normalized.trim_end_matches(".git");
    if normalized.is_empty() {
        return Err(invalid("provider_config.repository is required"));
    }
    Ok(normalized.to_owned())
}

struct ProviderConfig {
    repository: String,
    api_base: String,
    token: Option<String>,
}

impl ProviderConfig {
    fn from_project(
        project: &LoopItem,
        provider: TaskProviderKind,
        database_path: &std::path::Path,
    ) -> Result<Self, TaskRuntimeError> {
        let value = project
            .metadata
            .get("provider_config")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("provider_config must be an object"))?;
        let repository = value
            .get("repository")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid("provider_config.repository is required"))?;
        let repository = normalize_repository(repository, provider)?;
        let (default_domain, default_api_base) = match provider {
            TaskProviderKind::Github => ("github.com", "https://api.github.com"),
            TaskProviderKind::Gitlab => ("gitlab.com", "https://gitlab.com/api/v4"),
            _ => {
                return Err(TaskRuntimeError::UnsupportedProvider(format!(
                    "{provider:?}"
                )))
            }
        };
        let domain = string_config(value, "domain").unwrap_or_else(|| default_domain.to_owned());
        let api_base = string_config(value, "api_base")
            .unwrap_or_else(|| default_api_base.to_owned())
            .trim_end_matches('/')
            .to_owned();
        validate_provider_endpoint(provider, &domain, &api_base)?;
        if provider == TaskProviderKind::Github {
            validate_github_repository(&repository)?;
        }
        let token = decrypt_provider_credential(database_path, provider, value)?;
        Ok(Self {
            repository,
            api_base,
            token,
        })
    }

    fn authorize(&self, request: RequestBuilder, provider: TaskProviderKind) -> RequestBuilder {
        let Some(token) = self.token.as_deref() else {
            return request;
        };
        match provider {
            TaskProviderKind::Github => request
                .header("Authorization", format!("Bearer {token}"))
                .header("X-GitHub-Api-Version", "2022-11-28"),
            TaskProviderKind::Gitlab => request.header("PRIVATE-TOKEN", token),
            _ => request,
        }
    }

    fn require_write_token(&self) -> Result<(), TaskRuntimeError> {
        self.token
            .as_ref()
            .filter(|token| !token.trim().is_empty())
            .map(|_| ())
            .ok_or_else(|| invalid("provider credentials are required for write operations"))
    }
}

#[derive(Deserialize)]
struct GithubIssue {
    number: i64,
    title: String,
    body: Option<String>,
    state: String,
    html_url: String,
    user: ProviderUser,
    labels: Vec<GithubLabel>,
    comments: i64,
    created_at: String,
    updated_at: String,
    closed_at: Option<String>,
    pull_request: Option<Value>,
}

#[derive(Deserialize)]
struct GithubLabel {
    name: String,
}

#[derive(Deserialize)]
struct ProviderUser {
    login: String,
}

#[derive(Deserialize)]
struct GithubComment {
    id: i64,
    body: String,
    html_url: String,
    user: ProviderUser,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct GitlabIssue {
    iid: i64,
    title: String,
    description: Option<String>,
    state: String,
    web_url: String,
    author: GitlabUser,
    labels: Vec<String>,
    user_notes_count: i64,
    created_at: String,
    updated_at: String,
    closed_at: Option<String>,
}

#[derive(Deserialize)]
struct GitlabUser {
    username: String,
}

#[derive(Deserialize)]
struct GitlabComment {
    id: i64,
    body: String,
    author: GitlabUser,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct GitlabUpload {
    id: Option<i64>,
    url: String,
    full_path: String,
    markdown: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct GitlabAttachmentRecord {
    id: String,
    upload_id: Option<i64>,
    secret: String,
    display_name: String,
    content_type: Option<String>,
    size_bytes: i64,
    sha256: String,
    url: String,
    full_path: String,
    markdown: String,
    created_at: String,
}

impl GitlabAttachmentRecord {
    fn to_task_attachment(&self, task_id: &str) -> TaskAttachment {
        TaskAttachment {
            id: self.id.clone(),
            loop_item_id: task_id.to_owned(),
            display_name: self.display_name.clone(),
            content_type: self.content_type.clone(),
            size_bytes: self.size_bytes,
            sha256: self.sha256.clone(),
            created_by_user_id: 0,
            created_at: self.created_at.clone(),
        }
    }
}

fn github_loop_item(project: &LoopItem, issue: GithubIssue) -> LoopItem {
    issue_loop_item(
        project,
        TaskProviderKind::Github,
        issue.number,
        issue.title,
        issue.body.unwrap_or_default(),
        issue.state,
        issue.html_url,
        issue.user.login,
        issue.labels.into_iter().map(|label| label.name).collect(),
        issue.comments,
        issue.created_at,
        issue.updated_at,
        issue.closed_at,
    )
}

fn gitlab_loop_item(project: &LoopItem, issue: GitlabIssue) -> LoopItem {
    let (description, attachments) =
        split_gitlab_attachment_manifest(issue.description.as_deref().unwrap_or_default());
    let mut item = issue_loop_item(
        project,
        TaskProviderKind::Gitlab,
        issue.iid,
        issue.title,
        description,
        issue.state,
        issue.web_url,
        issue.author.username,
        issue.labels,
        issue.user_notes_count,
        issue.created_at,
        issue.updated_at,
        issue.closed_at,
    );
    item.metadata["gitlab_attachments"] = json!(attachments);
    item
}

#[allow(clippy::too_many_arguments)]
fn issue_loop_item(
    project: &LoopItem,
    provider: TaskProviderKind,
    number: i64,
    title: String,
    description: String,
    provider_state: String,
    web_url: String,
    author: String,
    labels: Vec<String>,
    comments: i64,
    created_at: String,
    updated_at: String,
    closed_at: Option<String>,
) -> LoopItem {
    let id = issue_id(project, number);
    let parent_id = parent_number(&description).map(|number| issue_id(project, number));
    let status = status_from_labels(&provider_state, &labels);
    let priority = priority_from_labels(&labels);
    let created_by_user_id = creator_from_labels(&labels);
    let labels = labels
        .into_iter()
        .filter(|label| {
            !label.starts_with(PRIORITY_LABEL_PREFIX)
                && !label.starts_with(STATUS_LABEL_PREFIX)
                && !label.starts_with(CREATOR_LABEL_PREFIX)
        })
        .collect::<Vec<_>>();
    LoopItem {
        id,
        resource_type: "task".to_owned(),
        project_space: project.project_space.clone(),
        cloud_project_id: Some(project.id.clone()),
        parent_id,
        public_id: Some(web_url.clone()),
        project_key: project.project_key.clone(),
        name: None,
        title: Some(title),
        description,
        created_by_user_id,
        sequence_number: Some(number),
        next_item_number: None,
        status: Some(status),
        priority: Some(priority),
        sort_order: number,
        current_delivery_id: None,
        metadata: json!({
            "task_provider": provider,
            "issue_number": number,
            "provider_state": provider_state,
            "web_url": web_url,
            "author": author,
            "labels": labels,
            "comments": comments,
        }),
        version: 1,
        created_at,
        updated_at,
        completed_at: closed_at,
    }
}

fn issue_id(project: &LoopItem, number: i64) -> String {
    format!(
        "{}-{number}",
        project.project_key.as_deref().unwrap_or("ISSUE")
    )
}

fn issue_number(project: &LoopItem, task_id: &str) -> Result<i64, TaskRuntimeError> {
    let prefix = format!("{}-", project.project_key.as_deref().unwrap_or("ISSUE"));
    task_id
        .strip_prefix(&prefix)
        .unwrap_or(task_id)
        .parse()
        .map_err(|_| TaskRuntimeError::TaskNotFound)
}

fn validate_external_priority(priority: &str) -> Result<(), TaskRuntimeError> {
    if matches!(priority, "none" | "low" | "medium" | "high" | "urgent") {
        return Ok(());
    }
    Err(invalid(format!("unsupported task priority: {priority}")))
}

fn labels_for_write(mut tags: Vec<String>, priority: &str, status: &str) -> Vec<String> {
    tags.retain(|label| {
        !label.starts_with(PRIORITY_LABEL_PREFIX) && !label.starts_with(STATUS_LABEL_PREFIX)
    });
    if priority != "none" {
        tags.push(format!("{PRIORITY_LABEL_PREFIX}{priority}"));
    }
    tags.push(format!("{STATUS_LABEL_PREFIX}{status}"));
    tags
}

fn creator_from_labels(labels: &[String]) -> i64 {
    labels
        .iter()
        .find_map(|label| label.strip_prefix(CREATOR_LABEL_PREFIX))
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(0)
}

fn status_from_labels(provider_state: &str, labels: &[String]) -> String {
    if provider_state == "closed" {
        return "completed".to_owned();
    }
    labels
        .iter()
        .find_map(|label| label.strip_prefix(STATUS_LABEL_PREFIX))
        .filter(|status| matches!(*status, "inbox" | "pending" | "in_progress" | "in_review"))
        .unwrap_or("pending")
        .to_owned()
}

fn priority_from_labels(labels: &[String]) -> String {
    labels
        .iter()
        .find_map(|label| label.strip_prefix(PRIORITY_LABEL_PREFIX))
        .filter(|priority| matches!(*priority, "low" | "medium" | "high" | "urgent"))
        .unwrap_or("none")
        .to_owned()
}

fn validate_external_title(title: &str) -> Result<(), TaskRuntimeError> {
    if title.trim().is_empty() {
        return Err(invalid("task title is required"));
    }
    Ok(())
}

fn validate_external_status(status: &str) -> Result<(), TaskRuntimeError> {
    if matches!(
        status,
        "inbox" | "pending" | "in_progress" | "in_review" | "completed"
    ) {
        return Ok(());
    }
    Err(invalid(format!("unsupported task status: {status}")))
}

fn with_parent_marker(description: &str, parent: Option<i64>) -> String {
    let content = description
        .lines()
        .filter(|line| !line.trim().starts_with(PARENT_MARKER))
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_owned();
    match (content.is_empty(), parent) {
        (_, None) => content,
        (true, Some(number)) => format!("{PARENT_MARKER} #{number}"),
        (false, Some(number)) => format!("{content}\n\n{PARENT_MARKER} #{number}"),
    }
}

fn gitlab_attachment_records(
    item: &LoopItem,
) -> Result<Vec<GitlabAttachmentRecord>, TaskRuntimeError> {
    item.metadata
        .get("gitlab_attachments")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| invalid(format!("GitLab attachment metadata is invalid: {error}")))
        .map(Option::unwrap_or_default)
}

fn find_gitlab_attachment(
    item: &LoopItem,
    attachment_id: &str,
) -> Result<GitlabAttachmentRecord, TaskRuntimeError> {
    gitlab_attachment_records(item)?
        .into_iter()
        .find(|record| record.id == attachment_id)
        .ok_or(TaskRuntimeError::TaskNotFound)
}

fn split_gitlab_attachment_manifest(description: &str) -> (String, Vec<GitlabAttachmentRecord>) {
    let Some(start) = description.find(ATTACHMENT_BLOCK_START) else {
        return (description.to_owned(), Vec::new());
    };
    let block_tail = &description[start + ATTACHMENT_BLOCK_START.len()..];
    let Some(relative_end) = block_tail.find(ATTACHMENT_BLOCK_END) else {
        return (description.to_owned(), Vec::new());
    };
    let end = start + ATTACHMENT_BLOCK_START.len() + relative_end + ATTACHMENT_BLOCK_END.len();
    let block = &description[start..end];
    let Some(attachments) = attachment_manifest_payload(block)
        .and_then(|encoded| URL_SAFE_NO_PAD.decode(encoded.as_bytes()).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    else {
        return (description.to_owned(), Vec::new());
    };
    let before = description[..start].trim_end();
    let after = description[end..].trim_start();
    let visible = match (before.is_empty(), after.is_empty()) {
        (true, true) => String::new(),
        (false, true) => before.to_owned(),
        (true, false) => after.to_owned(),
        (false, false) => format!("{before}\n\n{after}"),
    };
    (visible, attachments)
}

fn attachment_manifest_payload(block: &str) -> Option<&str> {
    let start = block.find(ATTACHMENT_DATA_PREFIX)? + ATTACHMENT_DATA_PREFIX.len();
    let tail = &block[start..];
    let end = tail.find("-->")?;
    Some(tail[..end].trim())
}

fn render_gitlab_attachment_manifest(
    description: &str,
    attachments: &[GitlabAttachmentRecord],
) -> Result<String, TaskRuntimeError> {
    let (description, _) = split_gitlab_attachment_manifest(description);
    if attachments.is_empty() {
        return Ok(description.trim_end().to_owned());
    }
    let encoded = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(attachments)
            .map_err(|error| invalid(format!("cannot encode attachment metadata: {error}")))?,
    );
    let links = attachments
        .iter()
        .map(|attachment| {
            format!(
                "- [{}]({})",
                escape_markdown_label(&attachment.display_name),
                attachment.url
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let block = format!(
        "{ATTACHMENT_BLOCK_START}\n### Attachments\n\n{links}\n\
         {ATTACHMENT_DATA_PREFIX}{encoded} -->\n{ATTACHMENT_BLOCK_END}"
    );
    let description = description.trim_end();
    if description.is_empty() {
        Ok(block)
    } else {
        Ok(format!("{description}\n\n{block}"))
    }
}

fn gitlab_upload_secret(url: &str) -> Result<String, TaskRuntimeError> {
    let secret = url
        .split('/')
        .collect::<Vec<_>>()
        .windows(2)
        .find_map(|parts| (parts[0] == "uploads").then_some(parts[1]))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("GitLab upload response does not include an upload secret"))?;
    Ok(secret.to_owned())
}

fn escape_markdown_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn safe_path_component(value: &str) -> Result<String, TaskRuntimeError> {
    let mut components = Path::new(value).components();
    if matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none() {
        return Ok(value.to_owned());
    }
    Err(invalid("attachment cache key is invalid"))
}

fn safe_file_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| match character {
            '/' | '\\' | '\0' => '_',
            _ => character,
        })
        .collect::<String>();
    if sanitized.trim().is_empty() {
        "attachment".to_owned()
    } else {
        sanitized
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn insert_optional<T: serde::Serialize>(
    body: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<T>,
) {
    if let Some(value) = value {
        body.insert(key.to_owned(), json!(value));
    }
}

fn parent_number(description: &str) -> Option<i64> {
    description.lines().find_map(|line| {
        let marker = line.trim().strip_prefix(PARENT_MARKER)?.trim();
        marker.trim_start_matches('#').parse().ok()
    })
}

fn string_config(value: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn encode_path_segment(value: &str) -> String {
    byte_serialize(value.as_bytes()).collect()
}

fn validate_provider_endpoint(
    provider: TaskProviderKind,
    domain: &str,
    api_base: &str,
) -> Result<(), TaskRuntimeError> {
    let url = Url::parse(api_base).map_err(|_| invalid("provider api_base is not a valid URL"))?;
    let host = url
        .host_str()
        .ok_or_else(|| invalid("provider api_base must include a host"))?;
    let official_github_api = provider == TaskProviderKind::Github
        && domain.eq_ignore_ascii_case("github.com")
        && host.eq_ignore_ascii_case("api.github.com");
    if !host.eq_ignore_ascii_case(domain) && !official_github_api {
        return Err(invalid(
            "provider api_base host must match provider_config.domain",
        ));
    }
    let local_test_http =
        cfg!(test) && url.scheme() == "http" && matches!(host, "127.0.0.1" | "localhost" | "::1");
    if url.scheme() != "https" && !local_test_http {
        return Err(invalid("provider api_base must use HTTPS"));
    }
    if !url.username().is_empty()
        || api_base.contains('@')
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(
            "provider api_base cannot contain credentials, query, or fragment",
        ));
    }
    Ok(())
}

fn validate_github_repository(repository: &str) -> Result<(), TaskRuntimeError> {
    let mut segments = repository.split('/');
    let owner = segments.next().unwrap_or_default();
    let name = segments.next().unwrap_or_default();
    let valid_segment = |value: &str| {
        !value.is_empty()
            && value
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    };
    if !valid_segment(owner) || !valid_segment(name) || segments.next().is_some() {
        return Err(invalid(
            "GitHub repository must use the 'owner/repository' format",
        ));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(message.into())
}

fn provider_error(error: impl std::fmt::Display) -> TaskRuntimeError {
    TaskRuntimeError::ProviderRequest(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        creator_from_labels, labels_for_write, normalize_repository, parent_number,
        priority_from_labels, status_from_labels,
    };
    use crate::task_runtime::TaskProviderKind;

    #[test]
    fn removes_gitlab_web_page_suffix_from_repository() {
        assert_eq!(
            normalize_repository("hongyu91/tab-prompt/-/issues", TaskProviderKind::Gitlab).unwrap(),
            "hongyu91/tab-prompt"
        );
    }

    #[test]
    fn reads_controlled_parent_marker() {
        assert_eq!(parent_number("Details\n\nWegent-Parent: #42\n"), Some(42));
        assert_eq!(parent_number("No hierarchy"), None);
    }

    #[test]
    fn maps_workflow_fields_to_controlled_issue_labels() {
        let labels = labels_for_write(
            vec![
                "bug".to_owned(),
                "wegent:priority:low".to_owned(),
                "wegent:status:pending".to_owned(),
            ],
            "high",
            "in_review",
        );
        assert_eq!(
            labels,
            vec!["bug", "wegent:priority:high", "wegent:status:in_review"]
        );
        assert_eq!(priority_from_labels(&labels), "high");
        assert_eq!(status_from_labels("open", &labels), "in_review");
        assert_eq!(status_from_labels("opened", &labels), "in_review");
    }

    #[test]
    fn reads_wegent_creator_from_reserved_issue_label() {
        let labels = vec![
            "bug".to_owned(),
            "wegent:creator:42".to_owned(),
            "wegent:status:pending".to_owned(),
        ];
        assert_eq!(creator_from_labels(&labels), 42);
        assert_eq!(
            labels_for_write(labels, "none", "in_progress"),
            vec![
                "bug",
                "wegent:creator:42",
                "wegent:status:in_progress"
            ]
        );
    }

    #[test]
    fn closed_provider_state_wins_and_unlabeled_open_issues_default_to_pending() {
        assert_eq!(
            status_from_labels("closed", &["wegent:status:in_progress".to_owned()]),
            "completed"
        );
        assert_eq!(status_from_labels("open", &[]), "pending");
        assert_eq!(
            status_from_labels("opened", &["wegent:status:completed".to_owned()]),
            "pending"
        );
    }

    #[test]
    fn restores_every_open_workflow_status_from_labels() {
        for status in ["inbox", "pending", "in_progress", "in_review"] {
            let labels = labels_for_write(vec!["bug".to_owned()], "none", status);
            assert_eq!(status_from_labels("opened", &labels), status);
        }
    }
}
