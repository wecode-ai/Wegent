// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Public application assembly and the common result consumed by the server.
use crate::{auth::AppAuthenticator, startup, state::AppState};
use anyhow::Result;
use brz_http_server::Router;
use std::sync::Arc;

pub struct Application {
    pub state: Arc<AppState>,
    pub routes: Router<AppAuthenticator>,
}

impl Application {
    /// Assemble public routes from a state already created by either entrypoint.
    pub async fn build(state: Arc<AppState>) -> Result<Self> {
        let routes = match startup::routes::build(state.clone()).await {
            Ok(routes) => routes,
            Err(error) => {
                state.mysql.close().await;
                return Err(error);
            }
        };
        Ok(Self { state, routes })
    }

    /// Extend public routes without introducing a dependency on private state.
    pub fn with_routes(self, routes: Router<AppAuthenticator>) -> Self {
        Self {
            state: self.state,
            routes: self.routes.merge(routes),
        }
    }
}
