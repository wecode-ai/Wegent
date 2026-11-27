// SPDX-License-Identifier: Apache-2.0

use brz_socket_io::{Accept, ClientError, Reply};
use serde::Deserialize;
use serde_json::{Value, json};

use super::protocol::ReplyEvent;
use super::{
    queue,
    registration::{mark_connected, worker_authorized},
};
use crate::state::AppState;

pub(crate) const NAMESPACE: &str = "/wework-worker";
pub(crate) const WORK_AVAILABLE: &str = "work_available";

pub(crate) fn room(agent: &str) -> String {
    format!("external-agent:{agent}")
}

#[derive(Debug)]
struct WorkerSession(String);

#[brz_socket_io::namespace("/wework-worker")]
async fn worker(
    #[payload] credential: Value,
    #[inject(app)] state: &AppState,
) -> Result<Accept<WorkerSession>, ClientError> {
    let token = credential["token"].as_str().unwrap_or_default();
    let config = worker_authorized(state, token)
        .await
        .ok_or_else(unauthenticated)?;
    mark_connected(state, &config).await.map_err(client_error)?;
    Ok(Accept::new(WorkerSession(token.to_owned())).join(room(&config.loop_item_id)))
}

fn unauthenticated() -> ClientError {
    ClientError::new("UNAUTHENTICATED", "Invalid or revoked Worker credential")
}

#[brz_socket_io::event("claim", namespace = "/wework-worker")]
async fn claim(
    #[session] session: &WorkerSession,
    #[inject(app)] state: &AppState,
) -> Result<Reply<Value>, ClientError> {
    let config = worker_authorized(state, &session.0)
        .await
        .ok_or_else(unauthenticated)?;
    mark_connected(state, &config).await.map_err(client_error)?;
    let task = queue::claim_worker(state, &config)
        .await
        .map_err(client_error)?;
    Ok(Reply::payload(json!({"ok":true,"task":task})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lease {
    invocation_id: String,
    delivery_id: String,
}

#[brz_socket_io::event("renew", namespace = "/wework-worker")]
async fn renew(
    #[payload] lease: Lease,
    #[session] session: &WorkerSession,
    #[inject(app)] state: &AppState,
) -> Result<Reply<Value>, ClientError> {
    let config = worker_authorized(state, &session.0)
        .await
        .ok_or_else(unauthenticated)?;
    mark_connected(state, &config).await.map_err(client_error)?;
    let ok = queue::renew(state, &config, &lease.invocation_id, &lease.delivery_id)
        .await
        .map_err(client_error)?;
    Ok(Reply::payload(json!({"ok":ok})))
}

#[brz_socket_io::event("reply", namespace = "/wework-worker")]
async fn reply(
    #[payload] event: ReplyEvent,
    #[session] session: &WorkerSession,
    #[inject(app)] state: &AppState,
) -> Result<Reply<Value>, ClientError> {
    let config = worker_authorized(state, &session.0)
        .await
        .ok_or_else(unauthenticated)?;
    let value = queue::reply(state, Some(&config), event)
        .await
        .map_err(client_error)?;
    Ok(Reply::payload(value))
}

fn client_error(error: crate::http_compat::FastApiError) -> ClientError {
    ClientError::new(
        "REPLY_REJECTED",
        error.detail_message().unwrap_or("Operation failed"),
    )
}
