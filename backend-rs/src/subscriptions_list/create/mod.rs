// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/subscriptions` — create a Subscription configuration.
//!
//! Mirrors `app.api.endpoints.adapter.subscriptions.create_subscription`
//! (route `""`, router prefix `/subscriptions`, under `/api`) and
//! `SubscriptionService.create_subscription`
//! (`app.services.subscription.service`).
//!
//! Source pipeline:
//! 1. FastAPI validates the JSON body against `SubscriptionCreate` — a missing
//!    required field or a bad type/enum/range renders 422 before the handler
//!    body or any dependency traffic.
//! 2. `security.get_current_user` — JWT session decode plus the `users` lookup.
//! 3. `_validate_trigger_config` — the minimum-interval rule (400 on failure).
//! 4. Name: an absent `name` runs `generate_unique_subscription_name`
//!    (`sub-` plus 8 `[a-z0-9]` characters, up to 3 tries, each guarded by a
//!    uniqueness SELECT); a provided name is checked for uniqueness (400 when
//!    taken).
//! 5. Team lookup (400 when absent), then Workspace selection: an explicit
//!    `workspace_id` loads the owned active Workspace (400 when absent); a git
//!    reference creates or reuses one.
//! 6. Event triggers mint a webhook token and HMAC key; the market whitelist is
//!    filtered against existing users; the execution target is validated.
//! 7. `build_subscription_crd` + `_internal`, then a `kinds` INSERT, the Kind
//!    cache invalidation, and `db.commit()`.
//! 8. `db.refresh` re-reads the row and `_convert_to_subscription_in_db` renders
//!    `SubscriptionInDB` with status 201.

use std::collections::HashMap;

use brz_http_server::{Response, StatusCode};
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use chrono::{NaiveDateTime, Utc};
use serde_json::{Value, json};

use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::subscriptions_item::{
    TEAM_QUERY, active_workspace, build_crd_document, build_trigger_value,
    calculate_next_execution_time, create_or_get_workspace, filter_existing_market_users,
    internal_error, invalidate_kind_cache, now_utc, python_json_dumps, random_token_urlsafe,
    truthy, updated_at_bind, validate_execution_target, validate_trigger_config,
};
use crate::subscriptions_list::convert::{convert_to_subscription_in_db, pydantic_datetime};
use crate::subscriptions_list::workspaces::RepoFields;

use super::KindRow;

/// `db.add(subscription); db.commit()` — SQLAlchemy renders every column set on
/// the new row plus its `created_at`/`updated_at` defaults.
const INSERT_SUBSCRIPTION_QUERY: &str = "INSERT INTO kinds \
     (user_id, kind, name, namespace, json, is_active, created_at, updated_at) \
     VALUES (?, 'Subscription', ?, ?, ?, 1, ?, ?)";

/// `db.refresh(subscription)` — the ORM re-selects the row by primary key with
/// unaliased columns.
const REFRESH_SUBSCRIPTION_QUERY: &str = "SELECT kinds.id, kinds.user_id, kinds.kind, \
     kinds.name, kinds.namespace, kinds.json, kinds.is_active, kinds.created_at, \
     kinds.updated_at \nFROM kinds \nWHERE kinds.id = ?";

/// A `kinds` row selected by `db.refresh` (unaliased columns).
#[derive(FromMysqlRow)]
struct RefreshedRow {
    #[mysql(rename = "id")]
    id: i32,
    #[mysql(rename = "user_id")]
    user_id: i32,
    #[mysql(rename = "kind")]
    kind: String,
    #[mysql(rename = "name")]
    name: String,
    #[mysql(rename = "namespace")]
    namespace: String,
    #[mysql(rename = "json")]
    json: Json<Value>,
    #[mysql(rename = "is_active")]
    is_active: i8,
    #[mysql(rename = "created_at")]
    created_at: NaiveDateTime,
    #[mysql(rename = "updated_at")]
    updated_at: NaiveDateTime,
}

/// `POST /api/subscriptions`.
pub(super) async fn create_subscription(
    state: &AppState,
    user_id: i64,
    create: &Create,
) -> Result<Response, FastApiError> {
    // `_validate_trigger_config` runs before any dependency traffic.
    if let Err(message) = validate_trigger_config(&create.trigger_type, &create.trigger_config) {
        return Err(FastApiError::detail(StatusCode::BAD_REQUEST, message));
    }

    let outcome = state
        .mysql
        .with_transaction(async |transaction| {
            apply_create(transaction, state, user_id, create).await
        })
        .await
        .map_err(internal_error)?;

    match outcome {
        CreateOutcome::Created { id, workspace_id } => {
            let row = refreshed_row(state, id).await?;
            let cache = workspace_cache(state, workspace_id).await?;
            let item = convert_to_subscription_in_db(&row, &cache);
            let body = serde_json::to_string(&item).map_err(|_| FastApiError::internal())?;
            Ok(Response::owned_bytes(StatusCode::CREATED, body).content_type("application/json"))
        }
        CreateOutcome::BadRequest(message) => {
            Err(FastApiError::detail(StatusCode::BAD_REQUEST, message))
        }
        // The source lets the `RuntimeError` escape to `python_exception_handler`,
        // whose body is `{"error_code": 500, "detail": "Internal server error"}`.
        CreateOutcome::NameGenerationFailed => Err(FastApiError::unhandled()),
    }
}

/// The observable outcomes of the create transaction.
enum CreateOutcome {
    /// The row was inserted; carries the new id and the stored workspace id.
    Created { id: i64, workspace_id: i64 },
    /// A `HTTPException(400, ...)` raised inside the service.
    BadRequest(String),
    /// `generate_unique_subscription_name` exhausted its retries (RuntimeError).
    NameGenerationFailed,
}

/// The transaction body of `create_subscription`.
async fn apply_create<T: MysqlTransaction>(
    transaction: &mut T,
    state: &AppState,
    user_id: i64,
    create: &Create,
) -> Result<CreateOutcome, brz_mysql::MysqlError> {
    // Name: auto-generated or a caller-provided unique name.
    let name = match &create.name {
        Some(name) => {
            if name_exists(transaction, user_id, name, &create.namespace).await? {
                return Ok(CreateOutcome::BadRequest(format!(
                    "Subscription with name '{name}' already exists"
                )));
            }
            name.clone()
        }
        None => match generate_unique_name(transaction, user_id, &create.namespace).await? {
            Some(name) => name,
            None => return Ok(CreateOutcome::NameGenerationFailed),
        },
    };

    // Team must exist.
    let Some(team) = transaction
        .fetch_optional::<_, _, KindRow>(TEAM_QUERY, (create.team_id,))
        .await?
    else {
        return Ok(CreateOutcome::BadRequest(format!(
            "Team with id {} not found",
            create.team_id
        )));
    };

    // Workspace: an explicit id (validated), or one derived from a git repo.
    let mut workspace_ref = Value::Null;
    let mut workspace_id = create.workspace_id.unwrap_or(0);
    if workspace_id != 0 {
        match active_workspace(transaction, workspace_id, Some(user_id)).await? {
            Some(workspace) => {
                workspace_ref = json!({
                    "name": workspace.name,
                    "namespace": workspace.namespace,
                });
            }
            None => {
                return Ok(CreateOutcome::BadRequest(format!(
                    "Workspace with id {workspace_id} not found"
                )));
            }
        }
    } else if let Some(git_repo) = create.git_repo.as_deref().filter(|repo| !repo.is_empty()) {
        workspace_id = create_or_get_workspace(
            transaction,
            user_id,
            git_repo,
            create.git_repo_id,
            create.git_domain.as_deref().unwrap_or("github.com"),
            create.branch_name.as_deref().unwrap_or("main"),
        )
        .await?;
    }

    // Event triggers mint a webhook token and HMAC key.
    let (webhook_token, webhook_key) = if create.trigger_type == "event" {
        (random_token_urlsafe(32), random_token_urlsafe(32))
    } else {
        (String::new(), String::new())
    };

    let market_whitelist_user_ids =
        filter_existing_market_users(transaction, &create.market_whitelist_user_ids).await?;

    let execution_target =
        match validate_execution_target(transaction, user_id, &create.execution_target).await? {
            Ok(normalized) => normalized,
            Err(message) => return Ok(CreateOutcome::BadRequest(message)),
        };

    // `calculate_next_execution_time`, defaulting to now when absent.
    let next_execution_time = calculate_next_execution_time(
        &create.trigger_type,
        &create.trigger_config,
        Utc::now().naive_utc(),
    )
    .unwrap_or_else(|| Utc::now().naive_utc());

    let webhook_url = if webhook_token.is_empty() {
        Value::Null
    } else {
        json!(format!("/api/subscriptions/webhook/{webhook_token}"))
    };

    let document = build_document(create, &team, webhook_url, &execution_target, workspace_ref);
    let mut document = build_crd_document(&document);
    document.insert(
        "_internal".to_string(),
        build_internal(
            create,
            workspace_id,
            &webhook_token,
            &webhook_key,
            next_execution_time,
            &market_whitelist_user_ids,
        ),
    );
    let json = python_json_dumps(&Value::Object(document));

    let created_at = updated_at_bind(now_utc());
    let updated_at = updated_at_bind(now_utc());
    let execution = transaction
        .execute(
            INSERT_SUBSCRIPTION_QUERY,
            (
                user_id,
                name.as_str(),
                create.namespace.as_str(),
                json,
                created_at,
                updated_at,
            ),
        )
        .await?;
    let id = execution.last_insert_id as i64;

    // The Kind `after_insert` cache event fires during flush.
    invalidate_kind_cache(
        state.redis.as_ref(),
        "Subscription",
        id,
        user_id,
        &create.namespace,
        &name,
    )
    .await;

    Ok(CreateOutcome::Created { id, workspace_id })
}

/// Build the pre-normalization CRD document (`build_subscription_crd`).
fn build_document(
    create: &Create,
    team: &KindRow,
    webhook_url: Value,
    execution_target: &Value,
    workspace_ref: Value,
) -> Value {
    let model_ref = if truthy(&create.model_ref) {
        json!({
            "name": create.model_ref.get("name").and_then(Value::as_str).unwrap_or(""),
            "namespace": create
                .model_ref
                .get("namespace")
                .and_then(Value::as_str)
                .unwrap_or("default"),
        })
    } else {
        Value::Null
    };
    json!({
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Subscription",
        "metadata": {
            "name": create.name.clone().unwrap_or_default(),
            "namespace": create.namespace,
            "displayName": create.display_name,
        },
        "spec": {
            "displayName": create.display_name,
            "taskType": create.task_type,
            "visibility": create.visibility,
            "trigger": build_trigger_value(&create.trigger_type, &create.trigger_config),
            "teamRef": {"name": team.name, "namespace": team.namespace},
            "workspaceRef": workspace_ref,
            "modelRef": model_ref,
            "forceOverrideBotModel": create.force_override_bot_model,
            "promptTemplate": create.prompt_template,
            "retryCount": create.retry_count,
            "timeoutSeconds": create.timeout_seconds,
            "enabled": create.enabled,
            "executionTarget": execution_target,
            "description": create.description,
            "preserveHistory": create.preserve_history,
            "historyMessageCount": create.history_message_count,
            "sourceSubscriptionRef": Value::Null,
            "knowledgeBaseRefs": create.knowledge_base_refs,
            "codeWikiRef": Value::Null,
            "notificationWebhooks": create.notification_webhooks,
            "skillRefs": create.skill_refs,
        },
        "status": {"webhookUrl": webhook_url},
    })
}

/// The `_internal` object stored with the CRD.
fn build_internal(
    create: &Create,
    workspace_id: i64,
    webhook_token: &str,
    webhook_key: &str,
    next_execution_time: NaiveDateTime,
    market_whitelist_user_ids: &[i64],
) -> Value {
    json!({
        "team_id": create.team_id,
        "workspace_id": workspace_id,
        "webhook_token": webhook_token,
        "webhook_secret": webhook_key,
        "enabled": create.enabled,
        "trigger_type": create.trigger_type,
        "next_execution_time": pydantic_datetime(next_execution_time),
        "last_execution_time": Value::Null,
        "last_execution_status": "",
        "execution_count": 0,
        "success_count": 0,
        "failure_count": 0,
        "bound_task_id": 0,
        "market_whitelist_user_ids": market_whitelist_user_ids,
        "expires_at": create.expires_at,
    })
}

/// `db.query(Kind).filter(user_id, kind='Subscription', name, namespace,
/// is_active).first()` — the name-uniqueness probe.
async fn name_exists<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    name: &str,
    namespace: &str,
) -> Result<bool, brz_mysql::MysqlError> {
    let sql = format!(
        "SELECT {} \nFROM kinds \nWHERE kinds.user_id = ? AND kinds.kind = 'Subscription' \
         AND kinds.name = ? AND kinds.namespace = ? AND kinds.is_active = true \n LIMIT 1",
        KindRow::COLUMNS
    );
    Ok(transaction
        .fetch_optional::<_, _, KindRow>(sql, (user_id, name, namespace))
        .await?
        .is_some())
}

/// `generate_unique_subscription_name`: up to three `sub-` + 8 `[a-z0-9]`
/// draws, each guarded by a uniqueness probe.
async fn generate_unique_name<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    namespace: &str,
) -> Result<Option<String>, brz_mysql::MysqlError> {
    for _ in 0..3 {
        let name = random_subscription_name();
        if !name_exists(transaction, user_id, &name, namespace).await? {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

/// `"sub-" + "".join(secrets.choice(ascii_lowercase + digits) for _ in range(8))`.
fn random_subscription_name() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut bytes = [0u8; 8];
    if getrandom::getrandom(&mut bytes).is_err() {
        // Entropy failure: fall back to the timestamp so a name is still
        // produced, mirroring the source's non-raising contract.
        return format!(
            "sub-{:08}",
            now_utc().and_utc().timestamp() as u64 % 100_000_000
        );
    }
    let mut name = String::from("sub-");
    for byte in bytes {
        name.push(ALPHABET[byte as usize % ALPHABET.len()] as char);
    }
    name
}

/// `db.refresh(subscription)` then rebuild the aliased `kinds` projection.
async fn refreshed_row(state: &AppState, id: i64) -> Result<KindRow, FastApiError> {
    let row = state
        .mysql
        .fetch_optional::<_, _, RefreshedRow>(REFRESH_SUBSCRIPTION_QUERY, (id,))
        .await
        .map_err(internal_error)?
        .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Subscription not found"))?;
    Ok(KindRow {
        id: row.id,
        user_id: row.user_id,
        kind: row.kind,
        name: row.name,
        namespace: row.namespace,
        json: row.json,
        is_active: row.is_active,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// `resolve_workspace_repo_fields` for the single created row.
async fn workspace_cache(
    state: &AppState,
    workspace_id: i64,
) -> Result<HashMap<i64, RepoFields>, FastApiError> {
    if workspace_id == 0 {
        return Ok(HashMap::new());
    }
    state
        .workspace_repository
        .fetch_repo_fields(&state.mysql, &[workspace_id])
        .await
        .map_err(internal_error)
}

/// A validated `SubscriptionCreate`: pydantic defaults applied, present keys
/// coerced, unknown keys ignored.
#[derive(Debug)]
pub(crate) struct Create {
    name: Option<String>,
    display_name: String,
    description: Option<String>,
    task_type: String,
    visibility: String,
    trigger_type: String,
    trigger_config: Value,
    team_id: i64,
    workspace_id: Option<i64>,
    git_repo: Option<String>,
    git_repo_id: Option<i64>,
    git_domain: Option<String>,
    branch_name: Option<String>,
    model_ref: Value,
    force_override_bot_model: bool,
    prompt_template: String,
    retry_count: i64,
    timeout_seconds: i64,
    enabled: bool,
    execution_target: Value,
    preserve_history: bool,
    history_message_count: i64,
    knowledge_base_refs: Value,
    notification_webhooks: Value,
    skill_refs: Value,
    market_whitelist_user_ids: Value,
    namespace: String,
    expires_at: Option<String>,
}

mod body;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_statement_lists_the_source_columns() {
        assert!(INSERT_SUBSCRIPTION_QUERY.contains(
            "INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at)"
        ));
        assert!(INSERT_SUBSCRIPTION_QUERY.contains("VALUES (?, 'Subscription', ?, ?, ?, 1, ?, ?)"));
    }

    #[test]
    fn refresh_statement_is_unaliased() {
        assert!(REFRESH_SUBSCRIPTION_QUERY.starts_with("SELECT kinds.id, kinds.user_id"));
        assert!(REFRESH_SUBSCRIPTION_QUERY.contains("FROM kinds"));
        assert!(REFRESH_SUBSCRIPTION_QUERY.ends_with("WHERE kinds.id = ?"));
    }

    #[test]
    fn generated_names_have_the_source_shape() {
        for _ in 0..16 {
            let name = random_subscription_name();
            assert!(name.starts_with("sub-"), "{name}");
            assert_eq!(name.len(), 12, "{name}");
            assert!(
                name[4..]
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit()),
                "{name}"
            );
        }
    }
}
