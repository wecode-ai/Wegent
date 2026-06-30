// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    env, fs,
    io::Cursor,
    path::{Component, Path, PathBuf},
    time::Duration,
};

use reqwest::StatusCode;
use serde_json::{json, Map, Value};

use crate::{
    agents::{claude_config_dir, claude_task_dir, extract_claude_options},
    attachments::{process_prompt, AttachmentPromptProcessor, AttachmentRecord},
    logging::{log_executor_event, task_fields},
    process::CommandSpec,
    protocol::ExecutionRequest,
    services::skill_deployer::{
        build_skill_deployment_plan, SkillDeploymentOptions, SkillDeploymentPlan, SkillRef,
    },
};

const QUERY_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);

pub async fn prepare_claude_execution_request(mut request: ExecutionRequest) -> ExecutionRequest {
    if request.extra.get("interactive_form_answer").is_some() {
        return request;
    }
    let attachments = attachment_records(&request);
    if attachments.is_empty() {
        return request;
    }
    log_runtime_event(
        &request,
        "claude attachment payload received",
        vec![
            ("attachment_count", attachments.len().to_string()),
            ("attachment_ids", attachment_ids(&attachments)),
            (
                "has_auth_token",
                request
                    .auth_token
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty())
                    .to_string(),
            ),
            (
                "backend_url_present",
                request
                    .backend_url
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty())
                    .to_string(),
            ),
        ],
    );

    let mut success = prepared_success_attachments(&attachments);
    let mut failed = prepared_failed_attachments(&attachments);
    let download_candidates = pending_download_attachments(&attachments);

    if download_candidates.is_empty() {
        let attachment_subtask_id = attachment_subtask_id(&attachments, &request);
        apply_attachment_prompt_updates(&mut request, &success, &failed, attachment_subtask_id);
        log_runtime_event(
            &request,
            "claude attachments prepared from sync result",
            vec![
                ("success_count", success.len().to_string()),
                ("failed_count", failed.len().to_string()),
            ],
        );
        return request;
    }

    let Some(auth_token) = request
        .auth_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
    else {
        log_runtime_event(
            &request,
            "claude attachment download skipped",
            vec![
                ("reason", "missing_auth_token".to_owned()),
                ("attachment_count", download_candidates.len().to_string()),
                ("attachment_ids", attachment_ids(&download_candidates)),
            ],
        );
        return request;
    };

    let attachment_subtask_id = attachment_subtask_id(&download_candidates, &request);
    let (attachments_dir, project_layout) =
        resolve_attachments_dir(&request, &download_candidates, attachment_subtask_id);
    let api_base_url = request_api_base_url(&request);
    log_runtime_event(
        &request,
        "claude attachment download starting",
        vec![
            ("attachment_count", download_candidates.len().to_string()),
            ("attachment_ids", attachment_ids(&download_candidates)),
            ("attachments_dir", attachments_dir.display().to_string()),
            ("project_layout", project_layout.to_string()),
            (
                "api_base_url_present",
                (!api_base_url.trim().is_empty()).to_string(),
            ),
        ],
    );
    let result = download_attachments(
        &download_candidates,
        &attachments_dir,
        &api_base_url,
        &auth_token,
        request.task_id,
        request.subtask_id,
    )
    .await;

    let downloaded_success_count = result.success.len();
    let downloaded_failed_count = result.failed.len();
    success.extend(result.success);
    failed.extend(result.failed);
    apply_attachment_prompt_updates(&mut request, &success, &failed, attachment_subtask_id);

    log_runtime_event(
        &request,
        "claude attachments prepared",
        vec![
            ("success_count", downloaded_success_count.to_string()),
            ("failed_count", downloaded_failed_count.to_string()),
        ],
    );
    request
}

pub async fn sync_attachments_for_request(request: ExecutionRequest) -> Value {
    let attachments = attachment_records(&request);
    let attachment_subtask_id = attachment_subtask_id(&attachments, &request);
    if attachments.is_empty() {
        return attachment_sync_response(request.task_id, request.subtask_id, &[], &[]);
    }

    log_runtime_event(
        &request,
        "attachment sync payload received",
        vec![
            ("attachment_count", attachments.len().to_string()),
            ("attachment_ids", attachment_ids(&attachments)),
            (
                "has_auth_token",
                request
                    .auth_token
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty())
                    .to_string(),
            ),
            (
                "backend_url_present",
                request
                    .backend_url
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty())
                    .to_string(),
            ),
        ],
    );

    let Some(auth_token) = request
        .auth_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
    else {
        let failed = mark_attachments_failed(&attachments, "missing auth_token");
        return attachment_sync_response(request.task_id, request.subtask_id, &[], &failed);
    };

    let api_base_url = request_api_base_url(&request);
    if api_base_url.trim().is_empty() {
        let failed = mark_attachments_failed(&attachments, "missing backend_url");
        return attachment_sync_response(request.task_id, request.subtask_id, &[], &failed);
    }

    let (attachments_dir, project_layout) =
        resolve_attachments_dir(&request, &attachments, attachment_subtask_id);
    log_runtime_event(
        &request,
        "attachment sync download starting",
        vec![
            ("attachment_count", attachments.len().to_string()),
            ("attachment_ids", attachment_ids(&attachments)),
            ("attachments_dir", attachments_dir.display().to_string()),
            ("project_layout", project_layout.to_string()),
        ],
    );
    let result = download_attachments(
        &attachments,
        &attachments_dir,
        &api_base_url,
        &auth_token,
        request.task_id,
        request.subtask_id,
    )
    .await;
    attachment_sync_response(
        request.task_id,
        request.subtask_id,
        &result.success,
        &result.failed,
    )
}

fn apply_attachment_prompt_updates(
    request: &mut ExecutionRequest,
    success: &[AttachmentRecord],
    failed: &[AttachmentRecord],
    attachment_subtask_id: i64,
) {
    if success.is_empty() && failed.is_empty() {
        return;
    }
    let mut prompt = process_prompt(
        &request.prompt,
        success,
        failed,
        Some(request.task_id),
        Some(attachment_subtask_id),
    );
    if let Value::String(text) = &mut prompt {
        let context = AttachmentPromptProcessor::build_attachment_context(success);
        if !context.is_empty() {
            text.push_str(&context);
        }
    }
    request.prompt = prompt;
}

pub async fn prepare_claude_runtime(
    request: &ExecutionRequest,
    mut spec: CommandSpec,
) -> Result<CommandSpec, String> {
    let task_dir = spec
        .current_dir()
        .cloned()
        .or_else(|| claude_task_dir(request))
        .unwrap_or_else(|| workspace_root().join(request.task_id.to_string()));
    fs::create_dir_all(&task_dir).map_err(|error| {
        format!(
            "failed to create Claude runtime task dir {}: {error}",
            task_dir.display()
        )
    })?;

    let config_dir =
        claude_config_dir(request, Some(&task_dir)).unwrap_or_else(|| task_dir.join(".claude"));
    fs::create_dir_all(&config_dir).map_err(|error| {
        format!(
            "failed to create Claude config dir {}: {error}",
            config_dir.display()
        )
    })?;

    write_claude_user_config(&config_dir);
    install_deferred_mcp_hook(&config_dir);
    prepare_project_custom_instructions(&task_dir);
    setup_coordinate_subagents(request, &task_dir);
    let skills_dir = spec
        .envs()
        .get("SKILLS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| config_dir.join("skills"));
    deploy_request_skills(request, &skills_dir).await;

    let global_mcps = load_global_mcp_records();
    let claude_options = extract_claude_options(request, &global_mcps);
    if !claude_options.mcp_servers.is_empty() {
        let mcp_config_path = config_dir.join("mcp.json");
        let content = json!({"mcpServers": claude_options.mcp_servers});
        if write_json_file(&mcp_config_path, &content).is_ok() {
            spec = spec
                .arg("--mcp-config")
                .arg(mcp_config_path.display().to_string())
                .env(
                    "WEGENT_MCP_CONFIG_PATH",
                    mcp_config_path.display().to_string(),
                );
            log_runtime_event(
                request,
                "claude mcp config prepared",
                vec![("mcp_config", mcp_config_path.display().to_string())],
            );
        }
    }

    Ok(spec)
}

pub async fn prepare_codex_runtime(request: &ExecutionRequest) {
    let task_dir = request
        .cwd()
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root().join(request.task_id.to_string()));
    let codex_skills_dir = codex_skills_dir(&task_dir);
    deploy_request_skills(request, &codex_skills_dir).await;
}

pub fn request_mcp_config_overrides(request: &ExecutionRequest) -> Vec<String> {
    let mut overrides = Vec::new();
    let mcp_servers = collect_request_mcp_servers(request);
    for (name, server) in mcp_servers {
        overrides.extend(codex_mcp_server_overrides(&name, &server));
    }
    overrides
}

async fn deploy_request_skills(request: &ExecutionRequest, skills_dir: &Path) {
    let Some(primary_bot) = primary_bot(request) else {
        return;
    };
    let Some(plan) = build_skill_deployment_plan(
        primary_bot,
        request,
        SkillDeploymentOptions {
            skills_dir: skills_dir.to_path_buf(),
            clear_cache: is_docker_mode(),
            skip_existing: !is_docker_mode(),
        },
    ) else {
        return;
    };

    let api_base_url = request_api_base_url(request);
    if let Err(error) = deploy_skills(&plan, &api_base_url).await {
        let mut fields = task_fields(request.task_id, request.subtask_id);
        fields.push(("error_len", error.len().to_string()));
        log_executor_event("skill deployment skipped after error", &fields);
    }
}

struct AttachmentDownloadOutcome {
    success: Vec<AttachmentRecord>,
    failed: Vec<AttachmentRecord>,
}

fn prepared_success_attachments(attachments: &[AttachmentRecord]) -> Vec<AttachmentRecord> {
    attachments
        .iter()
        .filter(|attachment| {
            attachment
                .local_path
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
                && !attachment_failed_status(attachment)
        })
        .cloned()
        .collect()
}

fn prepared_failed_attachments(attachments: &[AttachmentRecord]) -> Vec<AttachmentRecord> {
    attachments
        .iter()
        .filter(|attachment| attachment_failed_status(attachment))
        .cloned()
        .collect()
}

fn pending_download_attachments(attachments: &[AttachmentRecord]) -> Vec<AttachmentRecord> {
    attachments
        .iter()
        .filter(|attachment| {
            attachment
                .local_path
                .as_deref()
                .map(str::trim)
                .is_none_or(|value| value.is_empty())
                && !attachment_failed_status(attachment)
        })
        .cloned()
        .collect()
}

fn attachment_failed_status(attachment: &AttachmentRecord) -> bool {
    attachment
        .error
        .as_deref()
        .is_some_and(|value| !value.is_empty())
        || attachment
            .status
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("failed"))
}

fn resolve_attachments_dir(
    request: &ExecutionRequest,
    attachments: &[AttachmentRecord],
    fallback_subtask_id: i64,
) -> (PathBuf, bool) {
    let (workspace, project_layout) = resolve_attachment_workspace(request);
    let attachment_subtask_id = attachments
        .iter()
        .find_map(|attachment| attachment.subtask_id)
        .unwrap_or(fallback_subtask_id);
    let attachments_dir = if project_layout {
        workspace
            .join(request.task_id.to_string())
            .join(attachment_subtask_id.to_string())
    } else {
        workspace
            .join(attachments_subdir_name(&request.task_id.to_string()))
            .join(attachment_subtask_id.to_string())
    };
    (attachments_dir, project_layout)
}

fn mark_attachments_failed(attachments: &[AttachmentRecord], error: &str) -> Vec<AttachmentRecord> {
    attachments
        .iter()
        .map(|attachment| {
            let mut failed = attachment.clone();
            failed.status = Some("failed".to_owned());
            failed.error = Some(error.to_owned());
            failed
        })
        .collect()
}

fn attachment_sync_response(
    task_id: i64,
    subtask_id: i64,
    success: &[AttachmentRecord],
    failed: &[AttachmentRecord],
) -> Value {
    let mut attachments = Vec::with_capacity(success.len() + failed.len());
    for attachment in success {
        attachments.push(attachment_sync_item(attachment, "success"));
    }
    for attachment in failed {
        attachments.push(attachment_sync_item(attachment, "failed"));
    }
    json!({
        "task_id": task_id,
        "subtask_id": subtask_id,
        "attachments": attachments,
        "success_count": success.len(),
        "failed_count": failed.len(),
    })
}

fn attachment_sync_item(attachment: &AttachmentRecord, status: &str) -> Value {
    let mut item = json!({
        "id": attachment.id,
        "status": status,
        "original_filename": attachment.original_filename,
    });
    let Some(object) = item.as_object_mut() else {
        return item;
    };
    if let Some(local_path) = attachment
        .local_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        object.insert(
            "local_path".to_owned(),
            Value::String(local_path.to_owned()),
        );
    }
    if let Some(error) = attachment
        .error
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        object.insert("error".to_owned(), Value::String(error.to_owned()));
    }
    if let Some(mime_type) = attachment.mime_type.clone() {
        object.insert("mime_type".to_owned(), Value::String(mime_type));
    }
    if let Some(file_size) = attachment.file_size {
        object.insert("file_size".to_owned(), Value::from(file_size));
    }
    if let Some(subtask_id) = attachment.subtask_id {
        object.insert("subtask_id".to_owned(), Value::from(subtask_id));
    }
    item
}

async fn download_attachments(
    attachments: &[AttachmentRecord],
    attachments_dir: &Path,
    api_base_url: &str,
    auth_token: &str,
    task_id: i64,
    subtask_id: i64,
) -> AttachmentDownloadOutcome {
    let _ = fs::create_dir_all(attachments_dir);
    let client = reqwest::Client::new();
    let mut success = Vec::new();
    let mut failed = Vec::new();
    for attachment in attachments {
        log_executor_event(
            "attachment download item started",
            &[
                ("task_id", task_id.to_string()),
                ("subtask_id", subtask_id.to_string()),
                ("attachment_id", attachment.id.to_string()),
                ("filename", attachment.original_filename.clone()),
                ("target_dir", attachments_dir.display().to_string()),
                (
                    "api_base_url_present",
                    (!api_base_url.trim().is_empty()).to_string(),
                ),
            ],
        );
        match download_attachment(
            &client,
            attachment,
            attachments_dir,
            api_base_url,
            auth_token,
        )
        .await
        {
            Ok(local_path) => {
                let mut downloaded = attachment.clone();
                downloaded.status = Some("success".to_owned());
                downloaded.local_path = Some(local_path.display().to_string());
                downloaded.error = None;
                success.push(downloaded);
            }
            Err(error) => {
                log_executor_event(
                    "attachment download item failed",
                    &[
                        ("task_id", task_id.to_string()),
                        ("subtask_id", subtask_id.to_string()),
                        ("attachment_id", attachment.id.to_string()),
                        ("error", error.clone()),
                    ],
                );
                let mut failed_attachment = attachment.clone();
                failed_attachment.status = Some("failed".to_owned());
                failed_attachment.error = Some(error);
                failed.push(failed_attachment);
            }
        }
    }
    log_executor_event(
        "attachment download completed",
        &[
            ("task_id", task_id.to_string()),
            ("subtask_id", subtask_id.to_string()),
            ("success_count", success.len().to_string()),
            ("failed_count", failed.len().to_string()),
        ],
    );
    AttachmentDownloadOutcome { success, failed }
}

async fn download_attachment(
    client: &reqwest::Client,
    attachment: &AttachmentRecord,
    attachments_dir: &Path,
    api_base_url: &str,
    auth_token: &str,
) -> Result<PathBuf, String> {
    let url = api_url(
        api_base_url,
        &format!("/api/attachments/{}/executor-download", attachment.id),
    );
    let response = client
        .get(url)
        .bearer_auth(auth_token)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("Request error: {error}"))?;
    let status = response.status();
    if status != StatusCode::OK {
        let body_preview = response
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect::<String>();
        return Err(format!("HTTP {status}; body={body_preview}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Read error: {error}"))?;
    let path = attachments_dir.join(sanitize_filename(&attachment.original_filename));
    fs::write(&path, bytes).map_err(|error| format!("IO error: {error}"))?;
    Ok(path)
}

fn attachment_ids(attachments: &[AttachmentRecord]) -> String {
    attachments
        .iter()
        .map(|attachment| attachment.id.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

async fn deploy_skills(plan: &SkillDeploymentPlan, api_base_url: &str) -> Result<(), String> {
    fs::create_dir_all(&plan.skills_dir).map_err(|error| {
        format!(
            "failed to create skills dir {}: {error}",
            plan.skills_dir.display()
        )
    })?;

    let client = reqwest::Client::new();
    let mut success_count = 0;
    for skill in &plan.skills {
        let target = plan.skills_dir.join(skill);
        if plan.skip_existing && target.is_dir() {
            success_count += 1;
            continue;
        }
        if plan.clear_cache && target.exists() {
            let _ = fs::remove_dir_all(&target);
        }
        let skill_ref = plan.resolved_skill_map.get(skill);
        match download_skill(&client, plan, skill, skill_ref, api_base_url).await {
            Ok(true) => success_count += 1,
            Ok(false) => {}
            Err(error) => {
                log_executor_event(
                    "skill deployment item skipped after error",
                    &[
                        ("skill", skill.clone()),
                        ("error_len", error.len().to_string()),
                    ],
                );
            }
        }
    }

    log_executor_event(
        "skills deployed",
        &[
            ("skill_count", plan.skills.len().to_string()),
            ("success_count", success_count.to_string()),
            ("skills_dir", plan.skills_dir.display().to_string()),
        ],
    );
    Ok(())
}

async fn download_skill(
    client: &reqwest::Client,
    plan: &SkillDeploymentPlan,
    skill_name: &str,
    skill_ref: Option<&SkillRef>,
    api_base_url: &str,
) -> Result<bool, String> {
    let Some((skill_id, namespace)) =
        resolve_skill(client, plan, skill_name, skill_ref, api_base_url).await?
    else {
        return Ok(false);
    };
    let mut path = format!("/api/v1/kinds/skills/{skill_id}/download?namespace={namespace}");
    if let Some(task_id) = plan.task_id {
        path.push_str(&format!("&task_id={task_id}"));
    }
    let bytes = get_bytes(
        client,
        &plan.auth_token,
        api_base_url,
        &path,
        DOWNLOAD_TIMEOUT,
    )
    .await?;
    extract_skill_zip(skill_name, &bytes, &plan.skills_dir)
}

async fn resolve_skill(
    client: &reqwest::Client,
    plan: &SkillDeploymentPlan,
    skill_name: &str,
    skill_ref: Option<&SkillRef>,
    api_base_url: &str,
) -> Result<Option<(i64, String)>, String> {
    if let Some(skill_ref) = skill_ref {
        return Ok(Some((skill_ref.skill_id, skill_ref.namespace.clone())));
    }

    let mut path = format!(
        "/api/v1/kinds/skills?name={skill_name}&namespace={}",
        plan.team_namespace
    );
    if let Some(task_id) = plan.task_id {
        path.push_str(&format!("&task_id={task_id}"));
    }
    let value = get_json(client, &plan.auth_token, api_base_url, &path, QUERY_TIMEOUT).await?;
    let Some(item) = value
        .get("items")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
    else {
        return Ok(None);
    };
    let Some(skill_id) = value_i64(item.pointer("/metadata/labels/id")) else {
        return Ok(None);
    };
    let namespace = item
        .pointer("/metadata/namespace")
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_owned();
    Ok(Some((skill_id, namespace)))
}

async fn get_json(
    client: &reqwest::Client,
    auth_token: &str,
    api_base_url: &str,
    path: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let response = client
        .get(api_url(api_base_url, path))
        .bearer_auth(auth_token)
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| format!("backend request failed: {error}"))?;
    if response.status() != StatusCode::OK {
        return Err(format!(
            "backend request failed with HTTP {}",
            response.status()
        ));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("backend response JSON parse failed: {error}"))
}

async fn get_bytes(
    client: &reqwest::Client,
    auth_token: &str,
    api_base_url: &str,
    path: &str,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(api_url(api_base_url, path))
        .bearer_auth(auth_token)
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| format!("backend download failed: {error}"))?;
    if response.status() != StatusCode::OK {
        return Err(format!(
            "backend download failed with HTTP {}",
            response.status()
        ));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("backend download body read failed: {error}"))
}

fn extract_skill_zip(skill_name: &str, content: &[u8], skills_dir: &Path) -> Result<bool, String> {
    let cursor = Cursor::new(content);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| format!("invalid ZIP for skill {skill_name}: {error}"))?;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("failed to read ZIP entry: {error}"))?;
        let Some(enclosed) = file.enclosed_name().map(PathBuf::from) else {
            return Err(format!("unsafe ZIP path for skill {skill_name}"));
        };
        if enclosed
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir))
        {
            return Err(format!("unsafe ZIP path for skill {skill_name}"));
        }
        let target = skills_dir.join(enclosed);
        if file.name().ends_with('/') {
            fs::create_dir_all(&target)
                .map_err(|error| format!("failed to create skill dir: {error}"))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create skill parent dir: {error}"))?;
        }
        let mut output = fs::File::create(&target).map_err(|error| {
            format!("failed to create skill file {}: {error}", target.display())
        })?;
        std::io::copy(&mut file, &mut output)
            .map_err(|error| format!("failed to extract skill file: {error}"))?;
    }
    Ok(skills_dir.join(skill_name).is_dir())
}

fn setup_coordinate_subagents(request: &ExecutionRequest, task_dir: &Path) {
    if request_mode(request).as_deref() != Some("coordinate") {
        return;
    }
    let Some(bots) = request.bot.as_array() else {
        return;
    };
    if bots.len() <= 1 {
        return;
    }
    let agents_dir = task_dir.join(".claude/agents");
    if fs::create_dir_all(&agents_dir).is_err() {
        return;
    }
    for bot in bots.iter().skip(1) {
        if let Some((name, content)) = subagent_file(bot) {
            let _ = fs::write(agents_dir.join(format!("{name}.md")), content);
        }
    }
}

fn prepare_project_custom_instructions(project_path: &Path) {
    let custom_rules = load_custom_instruction_files(project_path);
    if !custom_rules.is_empty() {
        let claudecode_dir = project_path.join(".claudecode");
        if fs::create_dir_all(&claudecode_dir).is_ok() {
            for (relative_path, content) in custom_rules {
                let Some(file_name) = relative_path.file_name() else {
                    continue;
                };
                let _ = fs::write(claudecode_dir.join(file_name), content);
            }
            add_to_git_exclude(project_path, ".claudecode/");
        }
    }
    setup_claude_md_symlink(project_path);
}

fn attachment_records(request: &ExecutionRequest) -> Vec<AttachmentRecord> {
    request
        .extra
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(attachment_record)
        .collect()
}

fn attachment_record(value: &Value) -> Option<AttachmentRecord> {
    Some(AttachmentRecord {
        id: value_i64(value.get("id"))?,
        original_filename: value
            .get("original_filename")
            .or_else(|| value.get("originalFilename"))
            .or_else(|| value.get("filename"))
            .or_else(|| value.get("name"))
            .and_then(|value| value_string(Some(value)))
            .unwrap_or_else(|| "attachment".to_owned()),
        status: value
            .get("status")
            .and_then(|value| value_string(Some(value))),
        local_path: value
            .get("local_path")
            .or_else(|| value.get("localPath"))
            .and_then(|value| value_string(Some(value))),
        file_size: value
            .get("file_size")
            .or_else(|| value.get("fileSize"))
            .and_then(|value| value_u64(Some(value))),
        mime_type: value
            .get("mime_type")
            .or_else(|| value.get("mimeType"))
            .and_then(|value| value_string(Some(value))),
        subtask_id: value
            .get("subtask_id")
            .or_else(|| value.get("subtaskId"))
            .and_then(|value| value_i64(Some(value))),
        error: value
            .get("error")
            .and_then(|value| value_string(Some(value))),
    })
}

fn resolve_attachment_workspace(request: &ExecutionRequest) -> (PathBuf, bool) {
    if let Some(project_workspace) = project_workspace_path(request) {
        return (project_workspace.join(".wegent/attachments"), true);
    }
    (workspace_root().join(request.task_id.to_string()), false)
}

fn project_workspace_path(request: &ExecutionRequest) -> Option<PathBuf> {
    if let Some(path) = request
        .project_workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            return Some(path);
        }
        return Some(workspace_root().join(path));
    }

    let project_id = crate::local::capabilities::get_project_id(request);
    if project_id.is_empty() {
        return None;
    }
    let git_url = request.git_url()?;
    let repo_name = repo_name_from_url(&git_url)?;
    Some(
        workspace_root()
            .join("projects")
            .join(project_id)
            .join(repo_name.replace(['/', '\\'], "_")),
    )
}

fn repo_name_from_url(git_url: &str) -> Option<String> {
    git_url
        .trim()
        .trim_end_matches(".git")
        .rsplit(['/', ':'])
        .next()
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
}

fn attachment_subtask_id(attachments: &[AttachmentRecord], request: &ExecutionRequest) -> i64 {
    attachments
        .iter()
        .find_map(|attachment| attachment.subtask_id)
        .or_else(|| {
            request
                .extra
                .get("user_subtask_id")
                .or_else(|| request.extra.get("userSubtaskId"))
                .and_then(|value| value_i64(Some(value)))
        })
        .unwrap_or(request.subtask_id)
}

fn attachments_subdir_name(task_id: &str) -> String {
    let raw = format!("{task_id}:executor:attachments");
    if cfg!(windows) {
        raw.replace(':', "_")
    } else {
        raw
    }
}

fn sanitize_filename(filename: &str) -> String {
    let basename = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(filename)
        .replace(['\n', '\r'], "")
        .replace(['/', '\\'], "_");
    if basename.is_empty() {
        "document".to_owned()
    } else {
        basename
    }
}

fn load_custom_instruction_files(project_path: &Path) -> Vec<(PathBuf, String)> {
    custom_instruction_file_names()
        .into_iter()
        .filter_map(|relative| {
            safe_relative_path(&relative).and_then(|relative_path| {
                fs::read_to_string(project_path.join(&relative_path))
                    .ok()
                    .map(|content| (relative_path, content))
            })
        })
        .collect()
}

fn custom_instruction_file_names() -> Vec<String> {
    env::var("CUSTOM_INSTRUCTION_FILES")
        .unwrap_or_else(|_| ".cursorrules,.windsurfrules".to_owned())
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn safe_relative_path(value: &str) -> Option<PathBuf> {
    let path = Path::new(value);
    if path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!normalized.as_os_str().is_empty()).then_some(normalized)
}

fn setup_claude_md_symlink(project_path: &Path) {
    let Some(agents_file) = ["AGENTS.md", "Agents.md", "agents.md"]
        .iter()
        .find(|name| project_path.join(name).exists())
    else {
        return;
    };
    let claude_md = project_path.join("CLAUDE.md");
    if claude_md.exists() {
        if !is_symlink(&claude_md) {
            return;
        }
        let _ = fs::remove_file(&claude_md);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        if symlink(agents_file, &claude_md).is_ok() {
            add_to_git_exclude(project_path, "CLAUDE.md");
        }
    }
    #[cfg(not(unix))]
    {
        if fs::copy(project_path.join(agents_file), &claude_md).is_ok() {
            add_to_git_exclude(project_path, "CLAUDE.md");
        }
    }
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn add_to_git_exclude(project_path: &Path, pattern: &str) {
    let git_dir = project_path.join(".git");
    if !git_dir.exists() {
        return;
    }
    let info_dir = git_dir.join("info");
    if fs::create_dir_all(&info_dir).is_err() {
        return;
    }
    let exclude_path = info_dir.join("exclude");
    let mut content = fs::read_to_string(&exclude_path).unwrap_or_default();
    if content.lines().any(|line| line.trim() == pattern) {
        return;
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(pattern);
    content.push('\n');
    let _ = fs::write(exclude_path, content);
}

fn subagent_file(bot: &Value) -> Option<(String, String)> {
    let raw_name = bot
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("unnamed")
        .trim();
    let bot_id = value_i64(bot.get("id"));
    let mut name = raw_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character.to_ascii_lowercase()
            } else if character == '_' || character.is_whitespace() {
                '-'
            } else {
                '\0'
            }
        })
        .filter(|character| *character != '\0')
        .collect::<String>()
        .trim_matches('-')
        .to_owned();
    if name.is_empty() {
        name = "unnamed".to_owned();
    }
    if let Some(bot_id) = bot_id {
        name.push_str(&format!("-{bot_id}"));
    }
    let description = bot
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or(raw_name)
        .replace('"', "\\\"")
        .replace('\n', " ");
    let system_prompt = bot
        .get("system_prompt")
        .and_then(Value::as_str)
        .unwrap_or("");
    Some((
        name.clone(),
        format!(
            "---\nname: {name}\ndescription: \"{description}\"\nmodel: inherit\n---\n\n{system_prompt}\n"
        ),
    ))
}

fn write_claude_user_config(config_dir: &Path) {
    let value = json!({
        "numStartups": 2,
        "installMethod": "unknown",
        "autoUpdates": true,
        "sonnet45MigrationComplete": true,
        "hasCompletedOnboarding": true,
        "bypassPermissionsModeAccepted": true,
        "isQualifiedForDataSharing": false,
    });
    let _ = write_json_file(&config_dir.join("claude.json"), &value);
}

fn install_deferred_mcp_hook(config_dir: &Path) {
    let hook_path = config_dir.join("defer-interactive-mcp-hook.sh");
    if write_deferred_mcp_hook_script(&hook_path).is_err() {
        return;
    }
    let settings_path = config_dir.join("settings.json");
    let mut settings = fs::read_to_string(&settings_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let Some(settings_object) = settings.as_object_mut() else {
        return;
    };
    let hooks = ensure_object(settings_object, "hooks");
    let pre_tool_use = hooks
        .entry("PreToolUse".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    let hook_command = hook_path.display().to_string();
    let hook_entry = json!({
        "matcher": "mcp__*interactive_form_question*",
        "hooks": [{
            "type": "command",
            "command": hook_command
        }]
    });
    if let Some(items) = pre_tool_use.as_array_mut() {
        items.retain(
            |item| match item.pointer("/hooks/0/command").and_then(Value::as_str) {
                Some(command) => command != hook_command,
                None => true,
            },
        );
        items.push(hook_entry);
    } else {
        *pre_tool_use = Value::Array(vec![hook_entry]);
    }
    let _ = write_json_file(&settings_path, &settings);
}

fn write_deferred_mcp_hook_script(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create hook dir {}: {error}", parent.display()))?;
    }
    let content = r#"#!/bin/sh
input=$(cat)
case "$input" in
  *interactive_form_question*)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"defer"}}'
    ;;
  *)
    printf '%s\n' '{}'
    ;;
esac
"#;
    fs::write(path, content)
        .map_err(|error| format!("failed to write hook script {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("failed to stat hook script {}: {error}", path.display()))?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("failed to chmod hook script {}: {error}", path.display()))?;
    }
    Ok(())
}

fn ensure_object<'a>(object: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let value = object
        .entry(key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("value was just made object")
}

fn collect_request_mcp_servers(request: &ExecutionRequest) -> BTreeMap<String, Value> {
    extract_claude_options(request, &BTreeMap::new()).mcp_servers
}

fn codex_mcp_server_overrides(name: &str, server: &Value) -> Vec<String> {
    let Some(object) = server.as_object() else {
        return Vec::new();
    };
    let key = toml_key_path(&["mcp_servers", name]);
    let server_type = object.get("type").and_then(Value::as_str).unwrap_or("");
    if server_type == "stdio" || object.get("command").is_some() {
        let Some(command) = object
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Vec::new();
        };
        let mut overrides = vec![format!("{key}.command={}", toml_value(command))];
        if let Some(args) = object.get("args").and_then(Value::as_array) {
            let args = args
                .iter()
                .filter_map(Value::as_str)
                .map(|value| Value::String(value.to_owned()))
                .collect::<Vec<_>>();
            overrides.push(format!(
                "{key}.args={}",
                toml_json_value(&Value::Array(args))
            ));
        }
        if let Some(env) = object.get("env").and_then(Value::as_object) {
            for (env_key, env_value) in env {
                if let Some(env_value) = env_value.as_str() {
                    overrides.push(format!(
                        "{key}.env.{}={}",
                        toml_key_segment(env_key),
                        toml_value(env_value)
                    ));
                }
            }
        }
        return overrides;
    }
    let Some(url) = object
        .get("url")
        .or_else(|| object.get("base_url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Vec::new();
    };
    let mut overrides = vec![format!("{key}.url={}", toml_value(url))];
    for (source_key, target_key) in [
        ("bearer_token_env_var", "bearer_token_env_var"),
        ("bearerTokenEnvVar", "bearer_token_env_var"),
        ("oauth_client_id", "oauth_client_id"),
        ("oauthClientId", "oauth_client_id"),
        ("oauth_resource", "oauth_resource"),
        ("oauthResource", "oauth_resource"),
    ] {
        if let Some(value) = object.get(source_key).and_then(Value::as_str) {
            overrides.push(format!("{key}.{target_key}={}", toml_value(value)));
        }
    }
    overrides
}

fn load_global_mcp_records() -> BTreeMap<String, Value> {
    let path = executor_home().join("capabilities/manifest.json");
    let Ok(content) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return BTreeMap::new();
    };
    value
        .get("mcps")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn request_api_base_url(request: &ExecutionRequest) -> String {
    request
        .backend_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(api_base_url)
}

fn api_url(api_base_url: &str, path: &str) -> String {
    format!("{}{}", api_base_url.trim_end_matches('/'), path)
}

fn api_base_url() -> String {
    if is_local_mode() {
        if let Ok(value) = env::var("WEGENT_BACKEND_URL") {
            if !value.trim().is_empty() {
                return value.trim().to_owned();
            }
        }
    }
    env::var("TASK_API_DOMAIN")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://wegent-backend:8000".to_owned())
}

fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("failed to serialize JSON: {error}"))?;
    fs::write(path, content).map_err(|error| format!("failed to write {}: {error}", path.display()))
}

fn primary_bot(request: &ExecutionRequest) -> Option<&Value> {
    match &request.bot {
        Value::Array(bots) => bots.first(),
        Value::Object(_) => Some(&request.bot),
        _ => None,
    }
}

fn request_mode(request: &ExecutionRequest) -> Option<String> {
    request
        .extra
        .get("mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

fn workspace_root() -> PathBuf {
    if let Some(root) = env::var_os("WORKSPACE_ROOT")
        .map(PathBuf::from)
        .or_else(|| env::var_os("WEGENT_WORKSPACE_ROOT").map(PathBuf::from))
    {
        return root;
    }
    if is_local_mode() {
        return env::var_os("LOCAL_WORKSPACE_ROOT")
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("WEGENT_EXECUTOR_HOME")
                    .map(|home| PathBuf::from(home).join("workspace"))
            })
            .or_else(|| {
                env::var_os("HOME")
                    .map(|home| PathBuf::from(home).join(".wegent-executor/workspace"))
            })
            .unwrap_or_else(|| env::temp_dir().join("wegent-executor/workspace"));
    }
    PathBuf::from("/workspace")
}

fn executor_home() -> PathBuf {
    env::var_os("WEGENT_EXECUTOR_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/root"))
        })
}

fn codex_skills_dir(task_dir: &Path) -> PathBuf {
    task_dir.join(".codex/skills")
}

fn is_local_mode() -> bool {
    env::var("EXECUTOR_MODE")
        .ok()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("local"))
}

fn is_docker_mode() -> bool {
    !is_local_mode()
}

fn log_runtime_event(
    request: &ExecutionRequest,
    event: &'static str,
    extra: Vec<(&'static str, String)>,
) {
    let mut fields = task_fields(request.task_id, request.subtask_id);
    fields.extend(extra);
    log_executor_event(event, &fields);
}

fn value_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<i64>().ok()))
    })
}

fn value_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<u64>().ok()))
    })
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn toml_key_path(segments: &[&str]) -> String {
    segments
        .iter()
        .map(|segment| toml_key_segment(segment))
        .collect::<Vec<_>>()
        .join(".")
}

fn toml_key_segment(segment: &str) -> String {
    if segment
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-')
    {
        segment.to_owned()
    } else {
        serde_json::to_string(segment).unwrap_or_else(|_| "\"invalid\"".to_owned())
    }
}

fn toml_value(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

fn toml_json_value(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|item| match item {
                    Value::String(value) => toml_value(value),
                    _ => item.to_string(),
                })
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::String(value) => toml_value(value),
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(
        id: i64,
        status: Option<&str>,
        local_path: Option<&str>,
        error: Option<&str>,
    ) -> AttachmentRecord {
        AttachmentRecord {
            id,
            original_filename: format!("file-{id}.txt"),
            status: status.map(ToOwned::to_owned),
            local_path: local_path.map(ToOwned::to_owned),
            file_size: Some(12),
            mime_type: Some("text/plain".to_owned()),
            subtask_id: Some(203),
            error: error.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn classifies_prepared_success_and_failed_attachments() {
        let attachments = vec![
            attachment(1, Some("success"), Some("/workspace/a.txt"), None),
            attachment(2, Some("failed"), None, Some("HTTP 404")),
            attachment(3, None, None, None),
        ];

        assert_eq!(
            prepared_success_attachments(&attachments),
            vec![attachments[0].clone()]
        );
        assert_eq!(
            prepared_failed_attachments(&attachments),
            vec![attachments[1].clone()]
        );
        assert_eq!(
            pending_download_attachments(&attachments),
            vec![attachments[2].clone()]
        );
    }

    #[test]
    fn attachment_sync_response_serializes_status_and_paths() {
        let success = vec![attachment(
            1,
            Some("success"),
            Some("/workspace/a.txt"),
            None,
        )];
        let failed = vec![attachment(2, Some("failed"), None, Some("HTTP 404"))];

        let payload = attachment_sync_response(72, 204, &success, &failed);

        assert_eq!(payload["task_id"], 72);
        assert_eq!(payload["success_count"], 1);
        assert_eq!(payload["failed_count"], 1);
        assert_eq!(payload["attachments"][0]["status"], "success");
        assert_eq!(payload["attachments"][0]["local_path"], "/workspace/a.txt");
        assert_eq!(payload["attachments"][1]["status"], "failed");
        assert_eq!(payload["attachments"][1]["error"], "HTTP 404");
    }
}
