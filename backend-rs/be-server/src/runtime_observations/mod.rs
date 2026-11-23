// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bind Runtime observation routes and jobs to the gateway's services.

use std::{sync::Arc, time::Duration};

use serde_json::Value;
use wegent_runtime_observations::{ObservationJobState, ObservationRpc, ObservationState};

use crate::{AppState, background_jobs::project::runtime_rpc};

pub(crate) fn state(app: &AppState) -> ObservationState {
    ObservationState {
        mysql: app.mysql.clone(),
        auth: app.auth.clone(),
    }
}

pub(crate) fn job_state(app: Arc<AppState>) -> ObservationJobState {
    ObservationJobState {
        observations: state(&app),
        background_jobs: app.background_jobs.clone(),
        runtime_rpc: Arc::new(OwnedRuntimeRpc(app)),
    }
}

struct OwnedRuntimeRpc(Arc<AppState>);

#[async_trait::async_trait]
impl ObservationRpc for OwnedRuntimeRpc {
    async fn call(
        &self,
        owner: i64,
        device: &str,
        method: &str,
        payload: Value,
        timeout: Duration,
    ) -> anyhow::Result<Value> {
        runtime_rpc::call(&self.0, owner, device, method, payload, timeout).await
    }
}

#[cfg(test)]
mod collector_mysql_tests;
#[cfg(test)]
mod mysql_tests;

#[test]
fn routes_are_registered_and_selected_for_rust() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
    let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
    let registered = wegent_runtime_observations::registered_routes();
    for (method, path) in [
        (http::Method::POST, "/api/runtime-observations/command"),
        (http::Method::POST, "/api/runtime-observations/collector"),
        (
            http::Method::POST,
            "/api/internal/runtime-observations/command",
        ),
        (
            http::Method::GET,
            "/api/internal/runtime-observations/accounts",
        ),
    ] {
        assert!(table.matches(&method, path));
        let registrations = registered
            .iter()
            .filter(|(route, _)| *route == path)
            .count();
        let gateway_registrations =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)().iter())
                .filter(|route| route.path == path)
                .count();
        assert_eq!(registrations + gateway_registrations, 1, "{method} {path}");
        assert_eq!(registrations, 1, "{method} {path} belongs to observations");
    }
}
