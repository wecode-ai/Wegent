// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Route composition shared by the public and application applications.
use crate::{auth::AppAuthenticator, models_unified, state::AppState};
use anyhow::{Context as _, Result};
use std::sync::Arc;

pub async fn build(app: Arc<AppState>) -> Result<brz_http_server::Router<AppAuthenticator>> {
    let status_state = super::remote_workspace_status::build(
        app.mysql.clone(),
        Arc::clone(&app.task_store),
        Arc::clone(&app.erp),
        app.entity_resolvers.clone(),
        crate::remote_workspace_status::app_state::VideoRefresh {
            client: app.attachment_http.clone(),
            extension: Arc::clone(&app.video_result_urls),
        },
    )
    .await
    .context("failed to initialize remote-workspace status dependencies")?;
    let tree_state = super::remote_workspace_tree::build(
        app.mysql.clone(),
        Arc::clone(&app.task_store),
        Arc::clone(&app.erp),
        app.entity_resolvers.clone(),
        app.attachment_http.clone(),
        Arc::clone(&app.video_result_urls),
    )
    .await
    .context("failed to build remote-workspace tree dependencies")?;
    let runtime_check_state =
        super::runtime_check::build(app.mysql.clone(), Arc::clone(&app.task_store))
            .await
            .context("failed to connect runtime-check dependencies")?;
    let models_unified_config = models_unified::config::AppConfig::from_env();
    let models_unified_state = super::models_unified::build(
        app.mysql.clone(),
        &models_unified_config,
        app.entity_resolvers.clone(),
    )
    .await
    .context("failed to connect models-unified dependencies")?;

    // `POST /api/runtime-work/llm-responses-proxy/responses` forwards every
    // `x-wegent-upstream-header-*` header, which the function API's named-header
    // parameters cannot express; it is therefore a hand-written handler merged
    // into the same router.
    let llm_responses_proxy = crate::llm_proxy::LlmResponsesProxyRoute::new(Arc::clone(&app))
        .context("failed to initialize the LLM proxy transport")?;

    let sites = Arc::clone(&app.sites);
    let git = Arc::new(wegent_git_repositories::GitState {
        git_repositories: Arc::clone(&app.git_repositories),
        repository_tokens: Arc::clone(&app.repository_tokens),
    });
    let capabilities = Arc::new(wegent_capabilities::state::AppState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        task_store: Arc::clone(&app.task_store),
        erp: Arc::clone(&app.erp),
        entity_resolvers: app.entity_resolvers.clone(),
    });
    let users = Arc::new(wegent_backend_users::state::AppState {
        mysql: app.mysql.clone(),
        auth: app.auth.clone(),
        user_profile: Arc::clone(&app.user_profile),
        user_git_info: Arc::clone(&app.user_git_info),
        user_git_info_mask: Arc::clone(&app.user_git_info_mask),
        user_reader: Arc::clone(&app.user_reader),
        git_http: app.git_repositories.client(),
    });
    let authentication = Arc::new(wegent_authentication::state::AppState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        auth: app.auth.clone(),
        frontend_url: app.oidc_config.frontend_url.clone(),
    });
    let oidc = Arc::new(wegent_oidc::state::AppState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        auth: app.auth.clone(),
        oidc_config: app.oidc_config.clone(),
        oidc: Arc::clone(&app.oidc),
        oidc_callback: Arc::clone(&app.oidc_callback),
        seed_tasks: Arc::clone(&app.seed_tasks),
        onboarding: Arc::new(wegent_onboarding::state::AppState {
            mysql: app.mysql.clone(),
            redis: app.redis.clone(),
            entity_resolvers: app.entity_resolvers.clone(),
            task_store: Arc::clone(&app.task_store),
        }),
    });
    let handler = brz_http_server::handlers!(state = app)
        .map_err(|error| anyhow::anyhow!("API route registration failed: {error}"))?
        .merge(
            wegent_remote_workspace::routes(status_state, tree_state)
                .context("failed to register workspace routes")?,
        )
        .merge(
            wegent_runtime_check::routes(runtime_check_state)
                .map_err(|error| anyhow::anyhow!("API route registration failed: {error}"))?,
        )
        .merge(
            wegent_models::routes(models_unified_state)
                .map_err(|error| anyhow::anyhow!("API route registration failed: {error}"))?,
        )
        .merge(
            wegent_capabilities::routes(capabilities)
                .context("failed to register capability routes")?,
        )
        .merge(wegent_backend_users::routes(users).context("failed to register user routes")?)
        .merge(
            wegent_authentication::routes(authentication)
                .context("failed to register authentication routes")?,
        )
        .merge(wegent_oidc::routes(oidc).context("failed to register OIDC routes")?)
        .merge(llm_responses_proxy)
        .merge(wegent_git_repositories::routes(git).context("failed to register Git routes")?)
        .merge(wegent_sites::routes(sites).context("failed to register Sites routes")?);

    Ok(handler)
}
