// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wire task projections to the deployment's store and extensions.

use std::sync::Arc;

use wegent_task_views::TaskViewsState;

use crate::AppState;

pub(crate) fn build(app: &AppState) -> TaskViewsState {
    TaskViewsState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        entity_resolvers: app.entity_resolvers.clone(),
        erp: app.erp.clone(),
        task_store: Arc::clone(&app.task_store),
        auth: app.auth.clone(),
        attachment_http: app.attachment_http.clone(),
        video_result_urls: Arc::clone(&app.video_result_urls),
        user_profile: Arc::clone(&app.user_profile),
    }
}

/// Bind mutating task routes to the retained store and executor client.
pub(crate) fn mutations(app: &AppState) -> wegent_task_mutations::TaskMutationsState {
    wegent_task_mutations::TaskMutationsState {
        views: Arc::new(build(app)),
        executor_manager: app.executor_manager.clone(),
        user_reader: Arc::clone(&app.user_reader),
    }
}
