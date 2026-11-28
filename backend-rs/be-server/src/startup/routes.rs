// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Route composition shared by the public and internal applications.
use crate::{auth::AppAuthenticator, models_unified, state::AppState};
use anyhow::{Context as _, Result};
use std::sync::Arc;

struct RedisDevicePresence(Option<brz_redis::RedisService>);

impl RedisDevicePresence {
    async fn read_online_info<T: serde::de::DeserializeOwned>(
        &self,
        devices: &[(i32, String)],
    ) -> Vec<Option<T>> {
        let keys = devices
            .iter()
            .map(|(owner, device)| crate::devices::online_key(i64::from(*owner), device))
            .collect();
        crate::devices::cache_manager_mget(self.0.as_ref(), keys).await
    }
}

#[async_trait::async_trait]
impl wegent_workspaces::DevicePresence for RedisDevicePresence {
    async fn online_info(&self, devices: &[(i32, String)]) -> Vec<Option<serde_json::Value>> {
        self.read_online_info(devices).await
    }
}

#[async_trait::async_trait]
impl wegent_project_coordination::DevicePresence for RedisDevicePresence {
    async fn online_statuses(&self, devices: &[(i32, String)]) -> Vec<Option<String>> {
        self.read_online_info::<crate::devices::OnlineStateInput>(devices)
            .await
            .into_iter()
            .map(|entry| entry.and_then(|entry| entry.status_value().map(str::to_owned)))
            .collect()
    }
}

struct ResponseCommands {
    app: Arc<AppState>,
    task_mutations: Arc<wegent_task_mutations::TaskMutationsState>,
}

impl wegent_responses_api::ResponseCommands for ResponseCommands {
    fn create<'a>(
        &'a self,
        request: wegent_responses_api::CreateRequest<'a>,
    ) -> futures_util::future::BoxFuture<
        'a,
        Result<wegent_responses_api::CreateResponse, wegent_http_compat::FastApiError>,
    > {
        Box::pin(crate::responses::create::handler::create_response(
            &self.app, request,
        ))
    }

    fn delete(
        &self,
        user_id: i64,
        task_id: i64,
    ) -> futures_util::future::BoxFuture<'_, Result<(), wegent_http_compat::FastApiError>> {
        Box::pin(wegent_task_mutations::delete_task(
            &self.task_mutations,
            user_id,
            task_id,
            None,
        ))
    }
}

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

    // `POST /api/runtime-work/llm-responses-proxy/{responses,messages}` forwards
    // every `x-wegent-upstream-header-*` header, which the function API's
    // named-header parameters cannot express; it is therefore a hand-written
    // handler merged into the same router.
    let llm_responses_proxy =
        crate::llm_proxy::LlmResponsesProxyRoute::new(Arc::new(crate::llm_proxy::LlmProxyState {
            mysql: app.mysql.clone(),
            redis: app.redis.clone(),
            entity_resolvers: app.entity_resolvers.clone(),
            llm_proxy_credentials: Arc::clone(&app.llm_proxy_credentials),
        }))
        .context("failed to initialize the LLM proxy transport")?;

    let sites = Arc::clone(&app.sites);
    let device_artifacts = Arc::new(wegent_device_artifacts::DeviceArtifactState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        socketio_rpc: app.socketio_rpc.clone(),
        auth: app.auth.clone(),
        attachment_http: app.attachment_http.clone(),
        task_store: Arc::clone(&app.task_store),
    });
    let admin = Arc::new(wegent_admin_api::AdminState {
        mysql: app.mysql.clone(),
    });
    let decisions = Arc::new(wegent_model_decisions::DecisionState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        entity_resolvers: app.entity_resolvers.clone(),
        decision_http: app.decision_http.clone(),
        llm_proxy_credentials: Arc::clone(&app.llm_proxy_credentials),
    });
    let web_content = Arc::new(wegent_web_content::WebContentState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        entity_resolvers: app.entity_resolvers.clone(),
        url_metadata_http: app.url_metadata_http.clone(),
    });
    let knowledge_mcp = Arc::new(wegent_knowledge_mcp::KnowledgeMcpState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        auth: app.auth.clone(),
        entity_resolvers: app.entity_resolvers.clone(),
        attachment_http: app.attachment_http.clone(),
        external_knowledge_auth: Arc::clone(&app.external_knowledge_auth),
        document_download_policy: Arc::clone(&app.document_download_policy),
    });
    let smart_apps = Arc::new(wegent_smart_apps::SmartAppsState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        entity_resolvers: app.entity_resolvers.clone(),
        auth: app.auth.clone(),
        attachment_http: app.attachment_http.clone(),
    });
    let resource_readiness = Arc::new(wegent_resource_readiness::ResourceReadinessState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        erp: Arc::clone(&app.erp),
        entity_resolvers: app.entity_resolvers.clone(),
    });
    let git = Arc::new(wegent_git_repositories::GitState {
        git_repositories: Arc::clone(&app.git_repositories),
        repository_tokens: Arc::clone(&app.repository_tokens),
    });
    let git_inbox = Arc::new(wegent_git_inbox::GitInboxState {
        redis: app.redis.clone(),
        jwt_secret_keys: app.jwt_secret_keys.clone(),
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
    let tasks = Arc::new(wegent_tasks::TasksState {
        mysql: app.mysql.clone(),
        task_store: Arc::clone(&app.task_store),
        user_reader: Arc::clone(&app.user_reader),
    });
    let task_export = Arc::new(wegent_task_export_docx::TaskExportState {
        mysql: app.mysql.clone(),
        task_store: Arc::clone(&app.task_store),
        auth: app.auth.clone(),
    });
    let transcripts = Arc::new(wegent_wework_transcripts::TranscriptState {
        mysql: app.mysql.clone(),
        archive_http: app.attachment_http.clone(),
        jwt_key: app.auth.jwt_key.clone(),
    });
    let device_presence = Arc::new(RedisDevicePresence(app.redis.clone()));
    let workspaces = Arc::new(wegent_workspaces::WorkspaceState {
        mysql: app.mysql.clone(),
        device_presence: device_presence.clone(),
    });
    let mcp_providers = Arc::new(wegent_mcp_providers::ProviderState {
        mysql: app.mysql.clone(),
        mcp_providers: app.mcp_providers.clone(),
    });
    let teams = Arc::new(wegent_teams::TeamsState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        erp: Arc::clone(&app.erp),
        entity_resolvers: app.entity_resolvers.clone(),
        task_store: Arc::clone(&app.task_store),
    });
    let devices = Arc::new(app.devices_state());
    let runtime_work = Arc::new(wegent_runtime_work::RuntimeWorkState {
        devices: Arc::clone(&devices),
        issue_http: app.attachment_http.clone(),
        jwt_key: app.auth.jwt_key.clone(),
    });
    let subscriptions = Arc::new(wegent_subscriptions::SubscriptionState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        auth: app.auth.clone(),
        workspace_repository: Arc::clone(&app.workspace_repository),
    });
    let legacy_projects = Arc::new(wegent_legacy_projects::ProjectsState {
        mysql: app.mysql.clone(),
        task_store: Arc::clone(&app.task_store),
    });
    let task_views = Arc::new(crate::task_view_state::build(&app));
    let task_mutations = Arc::new(wegent_task_mutations::TaskMutationsState {
        views: Arc::clone(&task_views),
        executor_manager: app.executor_manager.clone(),
        user_reader: Arc::clone(&app.user_reader),
    });
    let archive = Arc::new(wegent_workspace_archive::ArchiveState {
        http: app.attachment_http.clone(),
        executor_manager: app.executor_manager.clone(),
        task_store: Arc::clone(&app.task_store),
    });
    let attachments = Arc::new(crate::attachment_access::build_state(&app));
    let responses = Arc::new(wegent_responses_api::ResponsesState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        task_store: Arc::clone(&app.task_store),
        user_reader: Arc::clone(&app.user_reader),
        auth: app.auth.clone(),
        commands: Arc::new(ResponseCommands {
            app: Arc::clone(&app),
            task_mutations: Arc::clone(&task_mutations),
        }),
    });
    let project = Arc::new(wegent_project_coordination::ProjectState {
        mysql: app.mysql.clone(),
        device_presence,
        attachment_http: app.attachment_http.clone(),
        jwt_key: app.auth.jwt_key.clone(),
        user_reader: Arc::clone(&app.user_reader),
        team_group_roles: Arc::new(crate::project_group_roles::ProjectGroupRoles::new(&app)),
    });
    let knowledge = Arc::new(crate::knowledge_dispatch::build_state(&app));
    let chat_history = Arc::new(wegent_chat_history::ChatHistoryState {
        mysql: app.mysql.clone(),
        task_store: Arc::clone(&app.task_store),
    });
    let connectors = Arc::new(wegent_connector_apps::ConnectorState {
        tasks_table: app.task_store.table_templates().tasks,
        mysql: app.mysql.clone(),
        auth: app.auth.clone(),
    });
    let resource_library = Arc::new(wegent_resource_library::ResourceLibraryState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        task_store: Arc::clone(&app.task_store),
        erp: Arc::clone(&app.erp),
        entity_resolvers: app.entity_resolvers.clone(),
    });
    let plugin_runtime = Arc::new(app.plugin_runtime_state());
    let runtime_observations = Arc::new(crate::runtime_observations::state(&app));
    let catalog = Arc::new(wegent_plugin_catalog::CatalogState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        entity_resolvers: app.entity_resolvers.clone(),
    });
    let participation = Arc::new(app.participation_state());
    let incoming_hook_mysql = Arc::new(app.mysql.clone());
    let notification_mysql = app.mysql.clone();
    let skill_market = app.skill_market.clone();
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
        .merge(
            wegent_resource_library::routes(resource_library)
                .context("failed to register resource library routes")?,
        )
        .merge(wegent_backend_users::routes(users).context("failed to register user routes")?)
        .merge(
            wegent_authentication::routes(authentication)
                .context("failed to register authentication routes")?,
        )
        .merge(wegent_oidc::routes(oidc).context("failed to register OIDC routes")?)
        .merge(wegent_tasks::routes(tasks).context("failed to register task query routes")?)
        .merge(
            wegent_task_export_docx::routes(task_export)
                .context("failed to register task export routes")?,
        )
        .merge(
            wegent_wework_transcripts::routes(transcripts)
                .context("failed to register transcript routes")?,
        )
        .merge(
            wegent_workspaces::routes(workspaces).context("failed to register workspace routes")?,
        )
        .merge(
            wegent_mcp_providers::routes(mcp_providers)
                .context("failed to register MCP provider routes")?,
        )
        .merge(wegent_teams::routes(teams).context("failed to register team routes")?)
        .merge(
            wegent_task_views::routes(task_views).context("failed to register task view routes")?,
        )
        .merge(
            wegent_task_mutations::routes(task_mutations)
                .context("failed to register task mutation routes")?,
        )
        .merge(
            wegent_subscriptions::routes(subscriptions)
                .context("failed to register subscription routes")?,
        )
        .merge(
            wegent_legacy_projects::routes(legacy_projects)
                .context("failed to register legacy project routes")?,
        )
        .merge(
            wegent_runtime_work::routes(runtime_work)
                .context("failed to register runtime work routes")?,
        )
        .merge(wegent_devices::routes(devices).context("failed to register device routes")?)
        .merge(
            wegent_device_artifacts::routes(device_artifacts)
                .context("failed to register device artifact routes")?,
        )
        .merge(
            wegent_workspace_archive::routes(archive)
                .context("failed to register workspace archive routes")?,
        )
        .merge(
            wegent_attachments::routes(attachments)
                .context("failed to register attachment routes")?,
        )
        .merge(
            wegent_responses_api::routes(responses)
                .context("failed to register response routes")?,
        )
        .merge(
            wegent_project_coordination::routes(project)
                .context("failed to register project coordination routes")?,
        )
        .merge(
            wegent_project_participation::routes(participation)
                .context("failed to register project participation routes")?,
        )
        .merge(
            wegent_project_scheduler::routes(incoming_hook_mysql)
                .context("failed to register project incoming hooks")?,
        )
        .merge(wegent_knowledge::routes(knowledge).context("failed to register knowledge routes")?)
        .merge(wegent_admin_api::routes(admin).context("failed to register admin routes")?)
        .merge(
            wegent_skill_market::routes(skill_market)
                .context("failed to register skill market routes")?,
        )
        .merge(
            wegent_notification_inbox::routes(notification_mysql)
                .context("failed to register notification inbox routes")?,
        )
        .merge(
            wegent_model_decisions::routes(decisions)
                .context("failed to register decision model routes")?,
        )
        .merge(
            wegent_web_content::routes(web_content)
                .context("failed to register web content routes")?,
        )
        .merge(
            wegent_knowledge_mcp::routes(knowledge_mcp)
                .context("failed to register knowledge MCP routes")?,
        )
        .merge(
            wegent_chat_history::routes(chat_history)
                .context("failed to register chat history routes")?,
        )
        .merge(
            wegent_connector_apps::routes(connectors)
                .context("failed to register connector app routes")?,
        )
        .merge(
            wegent_plugin_catalog::routes(catalog)
                .context("failed to register plugin catalog routes")?,
        )
        .merge(
            wegent_plugin_runtime::routes(plugin_runtime)
                .context("failed to register plugin runtime routes")?,
        )
        .merge(
            wegent_runtime_observations::routes(runtime_observations)
                .context("failed to register runtime observation routes")?,
        )
        .merge(llm_responses_proxy)
        .merge(wegent_git_repositories::routes(git).context("failed to register Git routes")?)
        .merge(wegent_git_inbox::routes(git_inbox).context("failed to register Git inbox routes")?)
        .merge(wegent_sites::routes(sites).context("failed to register Sites routes")?)
        .merge(
            wegent_resource_readiness::routes(resource_readiness)
                .context("failed to register resource readiness routes")?,
        )
        .merge(
            wegent_smart_apps::routes(smart_apps)
                .context("failed to register Smart Apps routes")?,
        );

    Ok(handler)
}
