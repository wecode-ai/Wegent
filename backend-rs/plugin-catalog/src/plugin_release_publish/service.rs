// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PluginPublicationService.publish_enterprise_release`
//! (`app.services.plugin_publication_service`).
//!
//! The endpoint has already authenticated the release key and validated the
//! envelope. This module binds the idempotency key to the exact request,
//! authorizes the protected GitLab provenance, publishes the catalog release,
//! and records the publication workflow outcome. A failure persists the
//! failure binding and leaves the previously latest release active.

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use chrono::NaiveDateTime;
use serde_json::{Value, json};

use crate::CatalogState;
use crate::http_compat::FastApiError;
use crate::transaction_outcome::{self, Completion};

use super::PluginReleasePublishResponse;
use super::artifact;
use super::gitlab::{self, ProvenanceFailure};
use super::marketplace::{self, PublishedRelease};
use super::metadata::PluginReleaseMetadata;

/// `TERMINAL_PUBLICATION_STATUSES`
const TERMINAL_PUBLICATION_STATUSES: [&str; 3] = ["published", "withdrawn", "closed"];
/// `CODE_REVIEW_STATUSES`
const CODE_REVIEW_STATUSES: [&str; 7] = [
    "admin_accepted",
    "materializing",
    "draft_mr_open",
    "ci_running",
    "code_changes_requested",
    "merge_ready",
    "merged",
];

/// The published release plus the response the endpoint renders.
pub(crate) struct PublishOutcome {
    pub response: PluginReleasePublishResponse,
    pub created: bool,
}

/// `publish_enterprise_release`.
pub(crate) async fn publish_enterprise_release(
    state: &CatalogState,
    package: Vec<u8>,
    metadata: &PluginReleaseMetadata,
    idempotency_key: &str,
    release_key_id: i64,
) -> Result<PluginReleasePublishResponse, FastApiError> {
    if release_key_id <= 0 {
        return Err(FastApiError::unauthorized(
            "Authenticated plugin release principal is required",
        ));
    }
    let release_envelope = metadata.to_json();
    artifact::validate_release_idempotency_key(idempotency_key, &release_envelope)?;
    let actual_sha256 = wegent_storage::s3_signing::hex_sha256(&package);
    if actual_sha256 != metadata.artifact.sha256 {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Artifact SHA256 mismatch",
        ));
    }
    let envelope = json!({
        "principal": {"type": "plugin_release_key", "id": release_key_id},
        "release": release_envelope,
    });
    let request_sha256 = artifact::release_envelope_sha256(&envelope);
    let (binding_id, cached) = claim_idempotency(
        state,
        idempotency_key,
        &request_sha256,
        &metadata.artifact.sha256,
        &envelope,
    )
    .await?;
    if let Some(cached) = cached {
        return Ok(cached);
    }

    let context = PublishContext {
        package,
        metadata: metadata.clone(),
        idempotency_key: idempotency_key.to_owned(),
        release_key_id,
        binding_id,
    };
    let outcome = transaction_outcome::run(
        &state.mysql,
        async |transaction| {
            let outcome = publish(transaction, &context).await?;
            Ok(Completion::Commit(outcome))
        },
        FastApiError::unhandled,
    )
    .await;
    match outcome {
        Ok(outcome) => {
            if outcome.created {
                let plugin_id = outcome.response.plugin_id;
                let release_id = outcome.response.release_id;
                let version = outcome.response.version.clone();
                if let Err(error) =
                    marketplace::notify_release(state, plugin_id, release_id, &version).await
                {
                    tracing::warn!(
                        plugin_id,
                        release_id,
                        %error,
                        "Plugin release notification failed after publication"
                    );
                }
            }
            Ok(outcome.response)
        }
        Err(error) => {
            persist_release_failure(
                state,
                idempotency_key,
                &request_sha256,
                &metadata.artifact.sha256,
                &envelope,
                metadata.request_id,
                metadata.revision,
                &error,
            )
            .await?;
            Err(error)
        }
    }
}

struct PublishContext {
    package: Vec<u8>,
    metadata: PluginReleaseMetadata,
    idempotency_key: String,
    release_key_id: i64,
    binding_id: i64,
}

/// The transactional part of `publish_enterprise_release`.
async fn publish<T: MysqlTransaction>(
    transaction: &mut T,
    context: &PublishContext,
) -> Result<PublishOutcome, FastApiError> {
    let authorized = authorize_release_provenance(transaction, context).await?;
    let provenance = release_provenance(context);
    let result = marketplace::publish_catalog_release(
        transaction,
        "enterprise",
        &context.metadata.plugin.slug,
        &context.package,
        &context.metadata.plugin.listing_type,
        "workspace",
        authorized.request_source_plugin_id.unwrap_or(0),
        authorized.revision_id.unwrap_or(0),
        &context.metadata.source.source_commit_sha,
        provenance,
    )
    .await?;
    if let (Some(request_id), Some(revision_id)) = (authorized.request_id, authorized.revision_id) {
        mark_published(
            transaction,
            request_id,
            revision_id,
            &result,
            &context.metadata,
        )
        .await?;
    }
    let response = PluginReleasePublishResponse {
        plugin_id: result.plugin_id,
        release_id: result.release_id,
        created: result.created,
        catalog_namespace: "enterprise",
        slug: context.metadata.plugin.slug.clone(),
        version: context.metadata.plugin.version.clone(),
        sha256: context.metadata.artifact.sha256.clone(),
    };
    update_completed_binding(transaction, context.binding_id, &response, &result).await?;
    Ok(PublishOutcome {
        response,
        created: result.created,
    })
}

fn release_provenance(context: &PublishContext) -> Value {
    let source = &context.metadata.source;
    json!({
        "kind": "gitlab_protected_master",
        "projectId": source.project_id,
        "ref": source.git_ref,
        "pipelineId": source.pipeline_id,
        "pipelineUrl": source.pipeline_url,
        "commitSha": source.source_commit_sha,
        "artifactSha256": context.metadata.artifact.sha256,
        "requestId": context.metadata.request_id,
        "revision": context.metadata.revision,
        "idempotencyKey": context.idempotency_key,
        "releaseKeyId": context.release_key_id,
        "projectPath": source.metadata.project_path,
    })
}

async fn mark_published<T: MysqlTransaction>(
    transaction: &mut T,
    request_id: i64,
    revision_id: i64,
    result: &PublishedRelease,
    metadata: &PluginReleaseMetadata,
) -> Result<(), FastApiError> {
    transaction
        .execute(
            "UPDATE plugin_publication_requests SET aggregate_status = 'published', \
             target_plugin_id = ? WHERE plugin_publication_requests.id = ?",
            (result.plugin_id, request_id),
        )
        .await
        .map_err(database_error)?;
    transaction
        .execute(
            "UPDATE plugin_publication_revisions SET status = 'published' \
             WHERE plugin_publication_revisions.id = ?",
            (revision_id,),
        )
        .await
        .map_err(database_error)?;
    insert_event(
        transaction,
        revision_id,
        "release.published",
        "release_service",
        &format!("Enterprise release {} published", metadata.plugin.version),
        &json!({
            "pluginId": result.plugin_id,
            "releaseId": result.release_id,
        }),
    )
    .await
    .map_err(database_error)
}

async fn update_completed_binding<T: MysqlTransaction>(
    transaction: &mut T,
    binding_id: i64,
    response: &PluginReleasePublishResponse,
    release: &PublishedRelease,
) -> Result<(), FastApiError> {
    transaction
        .execute(
            "UPDATE plugin_release_idempotency SET status = 'completed', response_json = ?, \
             plugin_id = ?, release_id = ?, last_error = '' \
             WHERE plugin_release_idempotency.id = ?",
            (
                Json(response.to_json()),
                release.plugin_id,
                release.release_id,
                binding_id,
            ),
        )
        .await
        .map_err(database_error)?;
    Ok(())
}

fn database_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "plugin release database dependency failure");
    FastApiError::unhandled()
}

/// `_claim_release_idempotency` plus `_reuse_release_idempotency`.
async fn claim_idempotency(
    state: &CatalogState,
    idempotency_key: &str,
    request_sha256: &str,
    artifact_sha256: &str,
    envelope: &Value,
) -> Result<(i64, Option<PluginReleasePublishResponse>), FastApiError> {
    let existing = lock_binding(state, idempotency_key).await?;
    if let Some(existing) = existing {
        return reuse_idempotency(existing, request_sha256, artifact_sha256);
    }
    let insert = state
        .mysql
        .with_transaction(async |transaction| {
            let inserted = transaction
                .execute(
                    "INSERT INTO plugin_release_idempotency \
                     (idempotency_key, request_sha256, artifact_sha256, envelope_json, status, \
                     response_json, plugin_id, release_id, last_error) \
                     VALUES (?, ?, ?, ?, 'processing', '{}', 0, 0, '')",
                    (
                        idempotency_key,
                        request_sha256,
                        artifact_sha256,
                        Json(envelope),
                    ),
                )
                .await?;
            Ok(inserted.last_insert_id as i64)
        })
        .await;
    match insert {
        Ok(binding_id) => Ok((binding_id, None)),
        Err(error) if error.database_code() == Some(1062) => {
            // `except IntegrityError`: roll back and reuse the winning row.
            let concurrent = lock_binding(state, idempotency_key)
                .await?
                .ok_or_else(|| database_error(error))?;
            reuse_idempotency(concurrent, request_sha256, artifact_sha256)
        }
        Err(error) => Err(database_error(error)),
    }
}

/// The `with_for_update()` idempotency read.
async fn lock_binding(
    state: &CatalogState,
    idempotency_key: &str,
) -> Result<Option<IdempotencyRow>, FastApiError> {
    state
        .mysql
        .with_transaction(async |transaction| {
            transaction
                .fetch_optional(
                    format!("{IDEMPOTENCY_QUERY} FOR UPDATE"),
                    (idempotency_key,),
                )
                .await
        })
        .await
        .map_err(database_error)
}

/// `_reuse_release_idempotency`.
fn reuse_idempotency(
    binding: IdempotencyRow,
    request_sha256: &str,
    artifact_sha256: &str,
) -> Result<(i64, Option<PluginReleasePublishResponse>), FastApiError> {
    if binding.request_sha256 != request_sha256 || binding.artifact_sha256 != artifact_sha256 {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Idempotency-Key is already bound to another release request",
        ));
    }
    match binding.status.as_str() {
        "completed" => {
            let response = PluginReleasePublishResponse::from_stored(&binding.response_json.0)
                .ok_or_else(|| {
                    tracing::error!(
                        binding_id = binding.id,
                        "stored release response is invalid"
                    );
                    FastApiError::unhandled()
                })?;
            Ok((binding.id, Some(response)))
        }
        "processing" => Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Release with this Idempotency-Key is still processing",
        )),
        _ => Ok((binding.id, None)),
    }
}

#[derive(Debug, FromMysqlRow)]
struct IdempotencyRow {
    #[mysql(rename = "plugin_release_idempotency_id")]
    id: i64,
    #[mysql(rename = "plugin_release_idempotency_request_sha256")]
    request_sha256: String,
    #[mysql(rename = "plugin_release_idempotency_artifact_sha256")]
    artifact_sha256: String,
    #[mysql(rename = "plugin_release_idempotency_status")]
    status: String,
    #[mysql(rename = "plugin_release_idempotency_response_json")]
    response_json: Json<Value>,
}

const IDEMPOTENCY_QUERY: &str = "SELECT plugin_release_idempotency.id AS plugin_release_idempotency_id, \
     plugin_release_idempotency.idempotency_key AS plugin_release_idempotency_idempotency_key, \
     plugin_release_idempotency.request_sha256 AS plugin_release_idempotency_request_sha256, \
     plugin_release_idempotency.artifact_sha256 AS plugin_release_idempotency_artifact_sha256, \
     plugin_release_idempotency.envelope_json AS plugin_release_idempotency_envelope_json, \
     plugin_release_idempotency.status AS plugin_release_idempotency_status, \
     plugin_release_idempotency.response_json AS plugin_release_idempotency_response_json, \
     plugin_release_idempotency.plugin_id AS plugin_release_idempotency_plugin_id, \
     plugin_release_idempotency.release_id AS plugin_release_idempotency_release_id, \
     plugin_release_idempotency.last_error AS plugin_release_idempotency_last_error, \
     plugin_release_idempotency.created_at AS plugin_release_idempotency_created_at, \
     plugin_release_idempotency.updated_at AS plugin_release_idempotency_updated_at \
     FROM plugin_release_idempotency \
     WHERE plugin_release_idempotency.idempotency_key = ? LIMIT 1";

/// `_authorize_release_provenance`'s resolved workflow pointers.
struct AuthorizedProvenance {
    request_id: Option<i64>,
    revision_id: Option<i64>,
    request_source_plugin_id: Option<i64>,
}

async fn authorize_release_provenance<T: MysqlTransaction>(
    transaction: &mut T,
    context: &PublishContext,
) -> Result<AuthorizedProvenance, FastApiError> {
    let metadata = &context.metadata;
    if let Some(request_id) = metadata.request_id {
        let request: Option<PublicationRequestRow> = transaction
            .fetch_optional(
                format!("{PUBLICATION_REQUEST_QUERY} FOR UPDATE"),
                (request_id,),
            )
            .await
            .map_err(database_error)?;
        let request =
            request.ok_or_else(|| FastApiError::not_found("Publication request not found"))?;
        if matches!(request.aggregate_status.as_str(), "withdrawn" | "closed") {
            return Err(FastApiError::detail(
                StatusCode::CONFLICT,
                "Withdrawn publication requests cannot be released",
            ));
        }
        if metadata.revision != Some(request.current_revision) {
            return Err(FastApiError::detail(
                StatusCode::CONFLICT,
                "Publication revision is stale",
            ));
        }
        let revision = current_revision(transaction, &request).await?;
        let revision = revision.ok_or_else(|| {
            FastApiError::detail(
                StatusCode::CONFLICT,
                "Published version does not match the accepted revision",
            )
        })?;
        if revision.requested_version != metadata.plugin.version {
            return Err(FastApiError::detail(
                StatusCode::CONFLICT,
                "Published version does not match the accepted revision",
            ));
        }
        if revision.gitlab_project_id != metadata.source.project_id
            || revision.merge_request_iid == 0
            || revision.source_branch.is_empty()
        {
            return Err(FastApiError::detail(
                StatusCode::CONFLICT,
                "Publication revision has no controlled GitLab merge request",
            ));
        }
        validate_materialized_risk_contract(&context.package, &revision)?;
        if !CODE_REVIEW_STATUSES.contains(&request.aggregate_status.as_str())
            && !matches!(
                request.aggregate_status.as_str(),
                "publishing" | "publish_failed" | "published"
            )
        {
            return Err(FastApiError::detail(
                StatusCode::CONFLICT,
                "Publication request has not reached code review",
            ));
        }
        verify_provenance(
            metadata,
            revision.merge_request_iid,
            &revision.source_branch,
            &context.package,
        )
        .await?;
        transaction
            .execute(
                "UPDATE plugin_publication_requests SET aggregate_status = 'publishing' \
                 WHERE plugin_publication_requests.id = ?",
                (request_id,),
            )
            .await
            .map_err(database_error)?;
        transaction
            .execute(
                "UPDATE plugin_publication_revisions SET status = 'publishing', commit_sha = ? \
                 WHERE plugin_publication_revisions.id = ?",
                (metadata.source.source_commit_sha.as_str(), revision.id),
            )
            .await
            .map_err(database_error)?;
        return Ok(AuthorizedProvenance {
            request_id: Some(request_id),
            revision_id: Some(revision.id),
            request_source_plugin_id: Some(request.source_plugin_id),
        });
    }
    let active: Option<(i64,)> = transaction
        .fetch_optional(ACTIVE_REQUEST_QUERY, (metadata.plugin.slug.as_str(),))
        .await
        .map_err(database_error)?;
    if active.is_some() {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "This slug has an active controlled publication request; requestId and revision are required",
        ));
    }
    verify_provenance(metadata, 0, "", &context.package).await?;
    Ok(AuthorizedProvenance {
        request_id: None,
        revision_id: None,
        request_source_plugin_id: None,
    })
}

async fn verify_provenance(
    metadata: &PluginReleaseMetadata,
    merge_request_iid: i64,
    source_branch: &str,
    package: &[u8],
) -> Result<(), FastApiError> {
    let (artifact_tree_sha256, requires_build) = artifact::release_source_tree(package, true)?;
    let build_artifact_sha256 = if requires_build {
        wegent_storage::s3_signing::hex_sha256(package)
    } else {
        String::default()
    };
    gitlab::verify_release_provenance(gitlab::ReleaseProvenance {
        project_id: &metadata.source.project_id,
        git_ref: &metadata.source.git_ref,
        commit_sha: &metadata.source.source_commit_sha,
        pipeline_id: metadata.source.pipeline_id,
        pipeline_url: &metadata.source.pipeline_url,
        slug: &metadata.plugin.slug,
        artifact_tree_sha256: &artifact_tree_sha256,
        build_artifact_sha256: &build_artifact_sha256,
        merge_request_iid,
        source_branch,
    })
    .await
    .map_err(|failure| match failure {
        ProvenanceFailure::Verification(message) => {
            FastApiError::detail(StatusCode::CONFLICT, message)
        }
        ProvenanceFailure::GitLab(message) => {
            FastApiError::detail(StatusCode::BAD_GATEWAY, message)
        }
        ProvenanceFailure::Unexpected(message) => {
            tracing::error!(%message, "plugin release provenance response was invalid");
            FastApiError::unhandled()
        }
    })
}

async fn current_revision<T: MysqlTransaction>(
    transaction: &mut T,
    request: &PublicationRequestRow,
) -> Result<Option<PublicationRevisionRow>, FastApiError> {
    transaction
        .fetch_optional(
            format!("{PUBLICATION_REVISION_QUERY} AND plugin_publication_revisions.request_id = ? LIMIT 1"),
            (request.current_revision_id, request.id),
        )
        .await
        .map_err(database_error)
}

#[derive(Debug, FromMysqlRow)]
struct PublicationRequestRow {
    #[mysql(rename = "plugin_publication_requests_id")]
    id: i64,
    #[mysql(rename = "plugin_publication_requests_source_plugin_id")]
    source_plugin_id: i64,
    #[mysql(rename = "plugin_publication_requests_current_revision_id")]
    current_revision_id: i64,
    #[mysql(rename = "plugin_publication_requests_current_revision")]
    current_revision: i64,
    #[mysql(rename = "plugin_publication_requests_aggregate_status")]
    aggregate_status: String,
}

/// `_authorize_release_provenance`'s active-request probe: a slug with a
/// controlled request in any code-review or publishing state cannot release
/// without its own `requestId`/`revision`.
const ACTIVE_REQUEST_QUERY: &str = "SELECT plugin_publication_requests.id AS plugin_publication_requests_id \
     FROM plugin_publication_requests JOIN plugins \
     ON plugins.id = plugin_publication_requests.source_plugin_id \
     WHERE plugins.slug = ? AND plugin_publication_requests.aggregate_status IN \
     ('admin_accepted', 'materializing', 'draft_mr_open', 'ci_running', \
     'code_changes_requested', 'merge_ready', 'merged', 'publishing', 'publish_failed') \
     LIMIT 1";

#[derive(Debug, FromMysqlRow)]
pub(crate) struct PublicationRevisionRow {
    #[mysql(rename = "plugin_publication_revisions_id")]
    pub id: i64,
    #[mysql(rename = "plugin_publication_revisions_request_id")]
    pub request_id: i64,
    #[mysql(rename = "plugin_publication_revisions_revision")]
    pub revision: i64,
    #[mysql(rename = "plugin_publication_revisions_requested_version")]
    pub requested_version: String,
    #[mysql(rename = "plugin_publication_revisions_gitlab_project_id")]
    pub gitlab_project_id: String,
    #[mysql(rename = "plugin_publication_revisions_merge_request_iid")]
    pub merge_request_iid: i64,
    #[mysql(rename = "plugin_publication_revisions_source_branch")]
    pub source_branch: String,
    #[mysql(rename = "plugin_publication_revisions_risk_declaration")]
    pub risk_declaration: Json<Value>,
    #[mysql(rename = "plugin_publication_revisions_test_notes")]
    pub test_notes: String,
    #[mysql(rename = "plugin_publication_revisions_source_tree_sha256")]
    pub source_tree_sha256: String,
    #[mysql(rename = "plugin_publication_revisions_snapshot_sha256")]
    pub snapshot_sha256: String,
}

const PUBLICATION_REQUEST_QUERY: &str = "SELECT plugin_publication_requests.id AS plugin_publication_requests_id, \
     plugin_publication_requests.source_plugin_id AS plugin_publication_requests_source_plugin_id, \
     plugin_publication_requests.target_plugin_id AS plugin_publication_requests_target_plugin_id, \
     plugin_publication_requests.submitter_user_id AS plugin_publication_requests_submitter_user_id, \
     plugin_publication_requests.current_revision_id AS plugin_publication_requests_current_revision_id, \
     plugin_publication_requests.current_revision AS plugin_publication_requests_current_revision, \
     plugin_publication_requests.aggregate_status AS plugin_publication_requests_aggregate_status, \
     plugin_publication_requests.risk_level AS plugin_publication_requests_risk_level, \
     plugin_publication_requests.submitted_at AS plugin_publication_requests_submitted_at, \
     plugin_publication_requests.created_at AS plugin_publication_requests_created_at, \
     plugin_publication_requests.updated_at AS plugin_publication_requests_updated_at \
     FROM plugin_publication_requests \
     WHERE plugin_publication_requests.id = ? LIMIT 1";

const PUBLICATION_REVISION_QUERY: &str = "SELECT plugin_publication_revisions.id AS plugin_publication_revisions_id, \
     plugin_publication_revisions.request_id AS plugin_publication_revisions_request_id, \
     plugin_publication_revisions.revision AS plugin_publication_revisions_revision, \
     plugin_publication_revisions.requested_version AS plugin_publication_revisions_requested_version, \
     plugin_publication_revisions.gitlab_project_id AS plugin_publication_revisions_gitlab_project_id, \
     plugin_publication_revisions.merge_request_iid AS plugin_publication_revisions_merge_request_iid, \
     plugin_publication_revisions.source_branch AS plugin_publication_revisions_source_branch, \
     plugin_publication_revisions.risk_declaration AS plugin_publication_revisions_risk_declaration, \
     plugin_publication_revisions.test_notes AS plugin_publication_revisions_test_notes, \
     plugin_publication_revisions.source_tree_sha256 AS plugin_publication_revisions_source_tree_sha256, \
     plugin_publication_revisions.snapshot_sha256 AS plugin_publication_revisions_snapshot_sha256 \
     FROM plugin_publication_revisions \
     WHERE plugin_publication_revisions.id = ?";

/// `_validate_materialized_risk_contract`.
fn validate_materialized_risk_contract(
    package: &[u8],
    revision: &PublicationRevisionRow,
) -> Result<(), FastApiError> {
    let risk: Value = read_json_member(package, "plugin-risk.json")?;
    let marker: Value = read_json_member(package, ".wework-publication.json")?;
    let risk_declaration = match &revision.risk_declaration.0 {
        Value::Object(object) if !object.is_empty() => revision.risk_declaration.0.clone(),
        _ => json!({}),
    };
    let expected_risk = json!({
        "schemaVersion": 1,
        "riskDeclaration": risk_declaration,
        "testNotes": revision.test_notes,
    });
    if risk != expected_risk {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Published risk declaration does not match the accepted revision",
        ));
    }
    let (actual_tree_sha256, _) = artifact::release_source_tree(package, false)?;
    if actual_tree_sha256 != revision.source_tree_sha256 {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Published source tree does not match the accepted revision",
        ));
    }
    let expected_marker = json!({
        "requestId": revision.request_id,
        "revision": revision.revision,
        "snapshotSha256": revision.snapshot_sha256,
        "sourceTreeSha256": revision.source_tree_sha256,
    });
    if marker != expected_marker {
        return Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Published artifact is not linked to the accepted snapshot",
        ));
    }
    Ok(())
}

/// `_read_single_json_member`.
fn read_json_member(package: &[u8], filename: &str) -> Result<Value, FastApiError> {
    let bytes = artifact::read_plugin_root_member(package, filename)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| {
        FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid materialized publication metadata",
        )
    })?;
    let value: Value = serde_json::from_str(text).map_err(|_| {
        FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid materialized publication metadata",
        )
    })?;
    if !value.is_object() {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("{filename} must contain a JSON object"),
        ));
    }
    Ok(value)
}

async fn insert_event<T: MysqlTransaction>(
    transaction: &mut T,
    revision_id: i64,
    event_type: &str,
    actor_type: &str,
    message: &str,
    payload: &Value,
) -> brz_mysql::MysqlResult<()> {
    let external_event_id = format!("internal:{}", uuid4());
    let message = message.chars().take(1000).collect::<String>();
    transaction
        .execute(
            "INSERT INTO plugin_publication_events \
             (revision_id, event_type, actor_type, actor_id, actor_name, message, payload_json, \
             external_event_id, created_at) \
             VALUES (?, ?, ?, 0, '', ?, ?, ?, ?)",
            (
                revision_id,
                event_type,
                actor_type,
                message,
                Json(payload.clone()),
                external_event_id,
                sql_datetime(now_local()),
            ),
        )
        .await?;
    Ok(())
}

/// `_persist_release_failure`.
#[allow(clippy::too_many_arguments)]
async fn persist_release_failure(
    state: &CatalogState,
    idempotency_key: &str,
    request_sha256: &str,
    artifact_sha256: &str,
    envelope: &Value,
    request_id: Option<i64>,
    revision_number: Option<i64>,
    error: &FastApiError,
) -> Result<(), FastApiError> {
    let message = error_message(error).chars().take(1000).collect::<String>();
    state
        .mysql
        .with_transaction(async |transaction| {
            let binding: Option<IdempotencyRow> = transaction
                .fetch_optional(IDEMPOTENCY_QUERY, (idempotency_key,))
                .await?;
            let completed = binding
                .as_ref()
                .is_some_and(|binding| binding.status == "completed");
            let binding_id = match binding {
                Some(binding) => binding.id,
                None => {
                    let inserted = transaction
                        .execute(
                            "INSERT INTO plugin_release_idempotency \
                             (idempotency_key, request_sha256, artifact_sha256, envelope_json, \
                             status, response_json, plugin_id, release_id, last_error) \
                             VALUES (?, ?, ?, ?, 'processing', '{}', 0, 0, '')",
                            (
                                idempotency_key,
                                request_sha256,
                                artifact_sha256,
                                Json(envelope),
                            ),
                        )
                        .await?;
                    inserted.last_insert_id as i64
                }
            };
            if !completed {
                transaction
                    .execute(
                        "UPDATE plugin_release_idempotency SET status = 'failed', last_error = ? \
                         WHERE plugin_release_idempotency.id = ?",
                        (message.clone(), binding_id),
                    )
                    .await?;
            }
            if let (Some(request_id), Some(revision_number)) = (request_id, revision_number) {
                let request: Option<PublicationRequestRow> = transaction
                    .fetch_optional(PUBLICATION_REQUEST_QUERY, (request_id,))
                    .await?;
                if let Some(request) = request
                    && request.current_revision == revision_number
                    && !TERMINAL_PUBLICATION_STATUSES.contains(&request.aggregate_status.as_str())
                {
                    let revision: Option<PublicationRevisionRow> = transaction
                        .fetch_optional(
                            format!(
                                "{PUBLICATION_REVISION_QUERY} \
                                 AND plugin_publication_revisions.request_id = ? LIMIT 1"
                            ),
                            (request.current_revision_id, request.id),
                        )
                        .await?;
                    if let Some(revision) = revision {
                        transaction
                            .execute(
                                "UPDATE plugin_publication_requests SET aggregate_status = 'publish_failed' \
                                 WHERE plugin_publication_requests.id = ?",
                                (request_id,),
                            )
                            .await?;
                        transaction
                            .execute(
                                "UPDATE plugin_publication_revisions SET status = 'publish_failed' \
                                 WHERE plugin_publication_revisions.id = ?",
                                (revision.id,),
                            )
                            .await?;
                        insert_event(
                            transaction,
                            revision.id,
                            "release.failed",
                            "release_service",
                            "Enterprise release failed; previous latest remains active",
                            &json!({}),
                        )
                        .await?;
                    }
                }
            }
            Ok(())
        })
        .await
        .map_err(database_error)
}

fn error_message(error: &FastApiError) -> String {
    error
        .detail_message()
        .map(str::to_owned)
        .unwrap_or_else(|| error.validation_detail())
}

/// `datetime.now()`.
pub(crate) fn now_local() -> NaiveDateTime {
    chrono::Local::now().naive_local()
}

/// SQLAlchemy binds a naive datetime as `'%Y-%m-%d %H:%M:%S.%f'`.
pub(crate) fn sql_datetime(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
}

/// `uuid.uuid4()`.
pub(crate) fn uuid4() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        tracing::error!("plugin publication event id random source failed");
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_event_ids_follow_the_source_shapes() {
        let id = uuid4();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[8], b'-');
        assert_eq!(&id[14..15], "4");
    }

    #[test]
    fn the_release_provenance_matches_the_release_envelope() {
        let metadata = super::super::metadata::parse(&json!({
            "schemaVersion": 1,
            "changed": true,
            "plugin": {"slug": "demo", "version": "1.0.0"},
            "artifact": {"file": "demo.zip", "sha256": "a".repeat(64), "sizeBytes": 1},
            "source": {
                "projectId": "42",
                "ref": "master",
                "sourceCommitSha": "b".repeat(40),
                "pipelineId": 7,
                "pipelineUrl": "https://git.invalid/7",
                "metadata": {"projectPath": "wework-plugins"}
            },
            "requestId": 12,
            "revision": 3
        }))
        .unwrap();
        let context = PublishContext {
            package: Vec::new(),
            metadata,
            idempotency_key: "k".to_owned(),
            release_key_id: 5,
            binding_id: 1,
        };
        let provenance = release_provenance(&context);
        assert_eq!(provenance["kind"], "gitlab_protected_master");
        assert_eq!(provenance["requestId"], 12);
        assert_eq!(provenance["projectPath"], "wework-plugins");
    }
}
