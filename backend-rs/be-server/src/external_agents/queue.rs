// SPDX-License-Identifier: Apache-2.0

use std::{sync::Arc, time::Duration};

use brz_http_server::StatusCode;
use brz_mysql::{Json, MysqlResult, MysqlTransaction};
use hmac::Mac;
use serde_json::{Value, json};

use super::hook::Hook;
use super::protocol::{self, ReplyEvent};
use super::registration::{active_agent, allowed_origins, callback_base, config_id};
use super::{AGENT_KIND, INVOCATION_KIND, database, hex, invalid, mac};
use crate::background_jobs::BackgroundJobRegistry;
use crate::background_jobs::project::{
    authority,
    store::{self, DATABASE_NOW_SQL},
};
use crate::http_compat::FastApiError;
use crate::socketio::device_lifecycle::publish_room_event;
use crate::socketio::device_runtime_event::{
    PROJECT_CHAT_CREATED_EVENT, RUNTIME_NAMESPACE, project_chat_room,
};
use crate::socketio::project_chat_messages::{self as messages, InsertMessage, MessageRow};
use crate::state::AppState;

pub(crate) async fn enqueue(
    tx: &mut impl MysqlTransaction,
    agent: &store::Node,
    trigger: &MessageRow,
    actor: i64,
) -> MysqlResult<i64> {
    let id = messages::uuid4();
    let hook = agent.metadata.0["external_transport"] == "hook";
    store::insert(
        tx,
        INVOCATION_KIND,
        json!({
            "id": id, "cloud_project_id": trigger.project_id, "loop_item_id": agent.id,
            "task_id": trigger.task_id, "created_by_user_id":actor,
            "status":if hook {"external_hook_pending"} else {"external_worker_pending"},
            "metadata":{"input":trigger.content},
        }),
    )
    .await?;
    messages::insert_message_on(
        tx,
        &InsertMessage {
            message_id: &id,
            client_message_id: &id,
            project_id: &trigger.project_id,
            task_id: &trigger.task_id,
            sender_type: "agent",
            sender_id: &agent.id,
            sender_name: &agent.title,
            message_type: "text",
            content: "",
            metadata: json!({"externalInvocation":true,"run_status":"pending"}),
            trigger_message_id: &trigger.message_id,
            reply_to_message_id: &trigger.message_id,
            thread_root_message_id: if trigger.thread_root_message_id.is_empty() {
                &trigger.message_id
            } else {
                &trigger.thread_root_message_id
            },
            agent_id: &agent.id,
            runtime_device_id: "",
            runtime_task_id: "",
            runtime_activity_key: "",
            status: "pending",
        },
    )
    .await
}

async fn scope_active(state: &AppState, invocation: &store::Node, config: &store::Node) -> bool {
    if config.cloud_project_id != invocation.cloud_project_id
        || config.loop_item_id != invocation.loop_item_id
        || active_agent(state, config, invocation.created_by_user_id)
            .await
            .is_none()
    {
        return false;
    }
    let mut query = &state.mysql;
    let Ok(access) = authority::execution_access_on(
        &mut query,
        &invocation.cloud_project_id,
        invocation.created_by_user_id,
    )
    .await
    else {
        return false;
    };
    let Ok(Some(issue)) = store::get(&state.mysql, "task", &invocation.task_id).await else {
        return false;
    };
    authority::require_issue_with_priority_on(
        &mut query,
        &access.project,
        &issue,
        invocation.created_by_user_id,
        access.priority,
    )
    .await
    .is_ok()
        && !matches!(issue.status.as_str(), "archived" | "deleted")
}

pub(super) async fn claim_worker(
    state: &AppState,
    config: &store::Node,
) -> Result<Option<Value>, FastApiError> {
    let claimed = state.mysql.with_transaction(async |tx| {
        let pending: Option<(String,)> = tx.fetch_optional(
            format!("SELECT id FROM loop_items WHERE loop_item_id=? AND resource_type='external_invocation'
             AND (status='external_worker_pending' OR (status='external_worker_leased' AND due_at < ({DATABASE_NOW_SQL})))
             AND created_at > ({DATABASE_NOW_SQL})-INTERVAL 1 DAY
             ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED"),
            (config.loop_item_id.as_str(),)).await?;
        let Some((id,)) = pending else { return Ok(None) };
        claim_on(tx, &id, false).await
    }).await.map_err(database)?;
    let Some((invocation, delivery)) = claimed else {
        return Ok(None);
    };
    if !scope_active(state, &invocation, config).await {
        fail(
            state,
            &invocation.id,
            &delivery,
            "The project or issue grant has changed",
        )
        .await
        .map_err(database)?;
        return Ok(None);
    }
    Ok(Some(task(&invocation, &delivery)))
}

async fn claim_on(
    tx: &mut impl MysqlTransaction,
    id: &str,
    hook: bool,
) -> MysqlResult<Option<(store::Node, String)>> {
    let Some(invocation) = store::locked(tx, INVOCATION_KIND, id).await? else {
        return Ok(None);
    };
    if hook && invocation.status != "external_hook_pending" {
        return Ok(None);
    }
    let delivery = messages::uuid4();
    tx.execute(
        format!(
            "UPDATE loop_items SET status=?,due_at=({DATABASE_NOW_SQL})+INTERVAL 60 SECOND,
         metadata=JSON_SET(metadata,'$.deliveryId',?) WHERE id=?"
        ),
        (
            if hook {
                "external_hook_sent"
            } else {
                "external_worker_leased"
            },
            delivery.as_str(),
            id,
        ),
    )
    .await?;
    tx.execute(
        "UPDATE project_chat_messages SET content='',status='pending',metadata=JSON_REMOVE(
            JSON_SET(metadata,'$.run_status','pending'),'$.externalReplySequence','$.externalProgress')
         WHERE message_id=?",
        (id,),
    ).await?;
    Ok(Some((invocation, delivery)))
}

fn task(invocation: &store::Node, delivery: &str) -> Value {
    json!({
        "invocationId":invocation.id, "deliveryId":delivery, "projectId":invocation.cloud_project_id,
        "issueId":invocation.task_id, "input":invocation.metadata.0["input"],
    })
}

pub(super) async fn renew(
    state: &AppState,
    config: &store::Node,
    id: &str,
    delivery: &str,
) -> Result<bool, FastApiError> {
    let execution = state
        .mysql
        .execute(
            format!("UPDATE loop_items SET due_at=({DATABASE_NOW_SQL})+INTERVAL 60 SECOND
         WHERE id=? AND resource_type='external_invocation' AND loop_item_id=?
           AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.deliveryId'))=?
           AND status='external_worker_leased' AND created_at > ({DATABASE_NOW_SQL})-INTERVAL 1 DAY"),
            (id, config.loop_item_id.as_str(), delivery),
        )
        .await
        .map_err(database)?;
    Ok(execution.rows_affected != 0)
}

pub(super) async fn reply(
    state: &AppState,
    worker: Option<&store::Node>,
    event: ReplyEvent,
) -> Result<Value, FastApiError> {
    let id = &event.invocation_id;
    let invocation = store::get(&state.mysql, INVOCATION_KIND, id)
        .await
        .map_err(database)?
        .ok_or_else(stale)?;
    let config = store::get(
        &state.mysql,
        AGENT_KIND,
        &config_id(&invocation.loop_item_id),
    )
    .await
    .map_err(database)?
    .ok_or_else(stale)?;
    if !match worker {
        Some(worker) => worker.id == config.id,
        None => config.metadata.0["hook"].is_string(),
    } || !scope_active(state, &invocation, &config).await
    {
        return Err(stale());
    }
    let outcome = state.mysql.with_transaction(async |tx| {
        let Some(invocation) = store::locked(tx, INVOCATION_KIND, id).await? else { return Ok(Err(stale())) };
        if invocation.metadata.0["deliveryId"] != event.delivery_id {
            return Ok(Err(stale()));
        }
        let recent: Option<(String,)> = tx.fetch_optional(
            format!("SELECT id FROM loop_items WHERE id=? AND created_at > ({DATABASE_NOW_SQL})-INTERVAL 1 DAY"),
            (id.as_str(),),
        ).await?;
        if recent.is_none() {
            return Ok(Err(stale()));
        }
        let Some(message) = lock_message(tx, id).await? else { return Ok(Err(stale())) };
        let projection = match protocol::apply(&event, &message.content, &message.status, message.metadata()) {
            Ok(Some(value)) => value,
            Ok(None) => return Ok(Ok(Some(message.id))),
            Err(message) => return Ok(Err(invalid(message))),
        };
        let terminal = matches!(projection.status, "completed" | "failed");
        tx.execute(
            format!("UPDATE project_chat_messages SET content=?,status=?,metadata=?,updated_at=({DATABASE_NOW_SQL}) WHERE id=?"),
            (projection.text, projection.status,
             Json(projection.metadata), message.id),
        ).await?;
        if terminal {
            tx.execute("UPDATE loop_items SET status='external_finished',metadata=JSON_REMOVE(metadata,'$.input') WHERE id=?", (id.as_str(),)).await?;
        } else if worker.is_some() {
            tx.execute(format!("UPDATE loop_items SET due_at=({DATABASE_NOW_SQL})+INTERVAL 60 SECOND WHERE id=?"), (id.as_str(),)).await?;
        }
        Ok(Ok(Some(message.id)))
    }).await.map_err(database)??;
    if let Some(row_id) = outcome {
        publish(state, row_id).await;
    }
    Ok(json!({"ok":true,"sequence":event.seq}))
}

fn stale() -> FastApiError {
    FastApiError::detail(
        StatusCode::CONFLICT,
        "The invocation or delivery is no longer available",
    )
}

async fn lock_message(tx: &mut impl MysqlTransaction, id: &str) -> MysqlResult<Option<MessageRow>> {
    tx.fetch_optional(
        format!(
            "SELECT {} FROM project_chat_messages WHERE message_id=? AND {} FOR UPDATE",
            messages::MESSAGE_COLUMNS,
            store::LIVE
        ),
        (id,),
    )
    .await
}

async fn publish(state: &AppState, row_id: i64) {
    if let Ok(Some(row)) = messages::load_message_by_id(state, row_id).await {
        let view = messages::shared_message_payload(&messages::message_view(&row));
        let room = project_chat_room(&row.project_id, Some(&row.task_id));
        crate::socketio::runtime::deliver_local_emit(
            RUNTIME_NAMESPACE,
            PROJECT_CHAT_CREATED_EVENT,
            &room,
            None,
            &view,
        )
        .await;
        publish_room_event(
            state,
            PROJECT_CHAT_CREATED_EVENT,
            &view,
            RUNTIME_NAMESPACE,
            &room,
        )
        .await;
    }
}

async fn fail(state: &AppState, id: &str, delivery: &str, reason: &str) -> MysqlResult<()> {
    let row_id = state.mysql.with_transaction(async |tx| {
        let Some(invocation) = store::locked(tx, INVOCATION_KIND, id).await? else { return Ok(None) };
        if invocation.status == "external_finished"
            || invocation.metadata.0["deliveryId"].as_str().unwrap_or_default() != delivery
        {
            return Ok(None);
        }
        tx.execute("UPDATE loop_items SET status='external_finished',metadata=JSON_REMOVE(metadata,'$.input') WHERE id=?", (id,)).await?;
        let Some(message) = lock_message(tx, id).await? else { return Ok(None) };
        tx.execute(
            format!("UPDATE project_chat_messages SET status='failed',message_type='text',metadata=JSON_SET(
             metadata,'$.run_status','failed','$.externalProgress',?,'$.externalReplyRevision',
             CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.externalReplyRevision')),0)+1 AS CHAR)),
             updated_at=({DATABASE_NOW_SQL}) WHERE id=?"),
            (reason, message.id),
        ).await?;
        Ok(Some(message.id))
    }).await?;
    if let Some(row_id) = row_id {
        publish(state, row_id).await;
    }
    Ok(())
}

async fn send_hook(
    state: &AppState,
    invocation: &store::Node,
    delivery: &str,
) -> anyhow::Result<()> {
    use anyhow::{Context, anyhow};
    let config = store::get(
        &state.mysql,
        AGENT_KIND,
        &config_id(&invocation.loop_item_id),
    )
    .await?
    .context("External agent configuration was removed")?;
    if !scope_active(state, invocation, &config).await {
        anyhow::bail!("The project or issue grant has changed");
    }
    let encrypted = config.metadata.0["hook"]
        .as_str()
        .context("Hook configuration is missing")?;
    let secret = super::hook::unprotect(&state.auth.jwt_key, &invocation.loop_item_id, encrypted)
        .context("Cannot decrypt Hook configuration")?;
    let hook: Hook = serde_json::from_slice(&secret)?;
    let url = hook
        .validate(&allowed_origins())
        .map_err(|error| anyhow!(error))?;
    let callback = callback_base()
        .context("Callback origin is missing")?
        .join("/api/v1/external-agent-replies")?;
    let mut data = task(invocation, delivery);
    let token = mac(
        &state.auth.jwt_key,
        "external-hook-callback",
        &[&invocation.id, delivery],
    );
    data["callbackUrl"] = json!(callback.as_str());
    data["callbackToken"] = json!(hex(&token.finalize().into_bytes()));
    let body = hook.render(&data).map_err(|error| anyhow!(error))?;
    let client = brz_http::Client::builder()
        .timeout(Duration::from_secs(10))
        .configure(|builder| builder.redirect(brz_http::reqwest::redirect::Policy::none()))
        .build()?;
    let method = brz_http::Method::from_bytes(hook.method.as_bytes())?;
    let mut request = client
        .request(method, url)?
        .header("content-type", hook.content_type)
        .header("idempotency-key", invocation.id.as_str());
    for (key, value) in hook.headers {
        request = request.header(key, value);
    }
    if !request
        .body(body)
        .send()
        .await
        .map_err(|_| anyhow!("Hook delivery status is unknown"))?
        .status()
        .is_success()
    {
        anyhow::bail!("Hook rejected the request");
    }
    Ok(())
}

pub(crate) const DELIVERY_JOB: &str = "external_agent_delivery";

pub(crate) fn register_jobs(
    registry: &mut BackgroundJobRegistry,
    state: Arc<AppState>,
) -> anyhow::Result<()> {
    registry.register(DELIVERY_JOB, move |_, _| {
        let state = state.clone();
        async move {
            dispatch_hooks(&state).await?;
            expire(&state).await?;
            Ok(json!({}))
        }
    })?;
    registry.interval(DELIVERY_JOB, Duration::from_secs(3), false)
}

async fn dispatch_hooks(state: &AppState) -> anyhow::Result<()> {
    let ids: Vec<(String,)> = state.mysql.fetch_all(
        format!("SELECT id FROM loop_items WHERE status='external_hook_pending' AND resource_type='external_invocation'
         AND created_at > ({DATABASE_NOW_SQL})-INTERVAL 1 DAY ORDER BY id LIMIT 8"), (),
    ).await?;
    for (id,) in ids {
        let claim = state
            .mysql
            .with_transaction(async |tx| claim_on(tx, &id, true).await)
            .await?;
        if let Some((invocation, delivery)) = claim
            && send_hook(state, &invocation, &delivery).await.is_err()
        {
            tracing::warn!(invocation_id = id, "External Hook delivery failed");
            fail(
                state,
                &id,
                &delivery,
                "Hook delivery failed. Check the endpoint configuration.",
            )
            .await?;
        }
    }
    Ok(())
}

async fn expire(state: &AppState) -> anyhow::Result<()> {
    let expired: Vec<(String, String)> = state.mysql.fetch_all(
        format!("SELECT id,COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.deliveryId')),'')
         FROM loop_items WHERE resource_type='external_invocation'
         AND status IN ('external_worker_pending','external_worker_leased','external_hook_pending','external_hook_sent')
         AND created_at < ({DATABASE_NOW_SQL})-INTERVAL 1 DAY LIMIT 32"), (),
    ).await?;
    for (id, delivery) in expired {
        fail(
            state,
            &id,
            &delivery,
            "External agent did not finish within the delivery window.",
        )
        .await?;
    }
    state.mysql.execute(
        format!("DELETE FROM loop_items WHERE resource_type='external_invocation' AND status='external_finished'
         AND created_at < ({DATABASE_NOW_SQL})-INTERVAL 2 DAY LIMIT 32"), (),
    ).await?;
    Ok(())
}
