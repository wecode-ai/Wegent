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
    pub background_jobs: crate::background_jobs::BackgroundJobRegistry,
}

impl Application {
    /// Assemble public routes from a state already created by either entrypoint.
    pub async fn build(state: Arc<AppState>) -> Result<Self> {
        let _ = state.completion_app.set(Arc::downgrade(&state));
        let routes = match startup::routes::build(state.clone()).await {
            Ok(routes) => routes,
            Err(error) => {
                state.mysql.close().await;
                return Err(error);
            }
        };
        let mut background_jobs = crate::background_jobs::BackgroundJobRegistry::default();
        crate::background_jobs::register_public_jobs(&mut background_jobs, state.clone())?;
        Ok(Self {
            state,
            routes,
            background_jobs,
        })
    }

    /// Extend public routes without introducing a dependency on private state.
    pub fn with_routes(self, routes: Router<AppAuthenticator>) -> Self {
        Self {
            state: self.state,
            routes: self.routes.merge(routes),
            background_jobs: self.background_jobs,
        }
    }

    /// Register distribution-owned jobs before the shared runtime starts.
    pub fn with_background_jobs(
        mut self,
        register: impl FnOnce(&mut crate::background_jobs::BackgroundJobRegistry) -> Result<()>,
    ) -> Result<Self> {
        register(&mut self.background_jobs)?;
        Ok(self)
    }
}
