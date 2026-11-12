// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Business exports for `app/api/ws`.
//!
//! Namespace admission retains authentication. Migrated event bodies delegate
//! to their business modules. Transport, packets, rooms and ACKs belong to the
//! framework.

use std::sync::Arc;

use brz_socket_io::Server;

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
    let (socket_runtime, workers) = SocketRuntime::new();
    brz_socket_io::handlers!(
        server.io(),
        app = state.clone(),
        runtime = socket_runtime.clone()
    )
    .await?;
    // Namespaces now exist, so the outgoing event handles can be built and the
    // registration follow-up workers started; no handler runs before this.
    socket_runtime.install(state, &server, workers)?;
    Ok(server)
}

#[cfg(test)]
mod tests {
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
