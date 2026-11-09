// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Business exports for `app/api/ws`.
//!
//! Namespace admission retains authentication. Migrated event bodies delegate
//! to their business modules; events that are not migrated yet return
//! `NOT_IMPLEMENTED` explicitly so a registered handler never claims
//! compatibility. Transport, packets, rooms and ACKs belong to the framework.

use std::sync::Arc;

use brz_socket_io::{ClientError, Server};
use serde_json::Value;

use crate::socketio::runtime::SocketRuntime;
use crate::{AppState, BoxError};

mod admission;
mod chat;
mod device;
mod runtime;
mod terminal;

use admission::AuthenticatedUser;

/// Register every public namespace on the shared HTTP service.
pub async fn build(state: Arc<AppState>) -> Result<Server, BoxError> {
    let server = Server::builder().build().await?;
    let (socket_runtime, jobs, rpc_jobs, reconcile_jobs, emit_jobs) = SocketRuntime::new();
    brz_socket_io::handlers!(
        server.io(),
        app = state.clone(),
        runtime = socket_runtime.clone()
    )
    .await?;
    // Namespaces now exist, so the outgoing event handles can be built and the
    // registration follow-up workers started; no handler runs before this.
    socket_runtime.install(state, &server, jobs, rpc_jobs, reconcile_jobs, emit_jobs)?;
    Ok(server)
}

fn not_implemented() -> Result<Value, ClientError> {
    Err(ClientError::new(
        "NOT_IMPLEMENTED",
        "Socket.IO business handler is not implemented",
    ))
}

macro_rules! placeholder {
    ($namespace:literal, $event:literal, $name:ident) => {
        #[brz_socket_io::event($event, namespace = $namespace)]
        async fn $name(
            #[payload] _input: serde_json::Value,
            #[auth] _user: &super::AuthenticatedUser,
        ) -> Result<serde_json::Value, brz_socket_io::ClientError> {
            super::not_implemented()
        }
    };
}
pub(super) use placeholder;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_report_an_explicit_failure() {
        let error = not_implemented().expect_err("scaffolding cannot report business success");
        assert_eq!(error.code, "NOT_IMPLEMENTED");
    }

    #[test]
    fn namespace_inventory_covers_the_source_mounts() {
        let mut namespaces = brz_socket_io::__private::inventory::iter::<
            crate::__socket_registry_socket_apis::Namespace,
        >
            .into_iter()
            .map(|entry| entry.0.namespace)
            .collect::<Vec<_>>();
        namespaces.sort_unstable();
        assert_eq!(
            namespaces,
            ["/chat", "/local-executor", "/terminal", "/wework-runtime"]
        );
    }

    #[test]
    fn source_event_groups_and_dynamic_executor_entry_are_exported() {
        let mut explicit = std::collections::BTreeMap::new();
        let mut fallbacks = Vec::new();
        for entry in
            brz_socket_io::__private::inventory::iter::<crate::__socket_registry_socket_apis::Event>
        {
            if entry.0.event.is_some() {
                *explicit.entry(entry.0.namespace).or_insert(0) += 1;
            } else {
                fallbacks.push(entry.0.namespace);
            }
        }
        assert_eq!(
            explicit,
            std::collections::BTreeMap::from([
                ("/chat", 10),
                ("/local-executor", 27),
                ("/terminal", 5),
                ("/wework-runtime", 8),
            ])
        );
        assert_eq!(fallbacks, ["/local-executor"]);
    }
}
