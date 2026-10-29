// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Public application defaults with explicit, isolated test dependencies.
use crate::{config, state::AppState};
use std::sync::Arc;

pub(crate) fn app(mysql: brz_mysql::MysqlService) -> Arc<AppState> {
    let auth = config::AuthConfig {
        jwt_key: "attachment-contract-test-key".into(),
        legacy_jwt_keys: vec![],
        algorithm: "HS256".into(),
    };
    let oidc_config = config::OidcConfig::default();
    Arc::new(AppState {
        completion_app: std::sync::OnceLock::new(),
        background_jobs: crate::background_jobs::BackgroundJobsClient::new(
            crate::background_jobs::config::BackgroundJobsConfig {
                scheduler_enabled: true,
                worker_enabled: true,
                job_allowlist: Default::default(),
                shutdown_grace: std::time::Duration::from_secs(30),
            },
        ),
        video_extensions: Arc::new(crate::background_jobs::video::DefaultVideoExtensions),
        entity_resolvers: crate::permissions::EntityResolvers::public(mysql.clone()),
        seed_tasks: crate::new_user_resources::default_tasks(mysql.clone()),
        user_profile: Arc::new(crate::user_profile::DefaultUserViewExtension),
        user_git_info: Arc::new(crate::user_profile::StoredGitInfo),
        user_git_info_mask: Arc::new(crate::user_profile::NoGitInfoMasking),
        media_policy: Arc::new(crate::media_policy::DefaultMediaPolicy),
        external_media: Arc::new(crate::attachments::external_media::NoExternalMediaRelay),
        attachment_upload: Arc::new(crate::attachments::upload::MySqlStorageBackend),
        external_playback: Arc::new(crate::attachments::external_media::NoExternalPlaybackResolver),
        document_download_policy: Arc::new(
            crate::knowledge_download_policy::DefaultDocumentDownloadPolicy,
        ),
        task_store: Arc::new(crate::task_store::DefaultTaskStore::new(mysql.clone())),
        workspace_repository: Arc::new(
            crate::subscriptions_list::workspaces::BaseWorkspaceRepository,
        ),
        user_reader: Arc::new(crate::user_reader::PublicUserReader::new(mysql.clone())),
        jwt_secret_keys: vec![Arc::from(auth.jwt_key.as_str())],
        jwt_algorithm: auth.algorithm.clone(),
        auth,
        internal_chat: config::InternalChatConfig {
            internal_service_token: None,
            max_extracted_text_length: 500_000,
            attachment_inject_max_chars: 32_000,
        },
        mysql,
        redis: None,
        celery: crate::celery_broker::CeleryBroker::new(None),
        socketio_rpc: None,
        oidc: crate::oidc_service::OidcService::new(&oidc_config).unwrap(),
        oidc_config,
        oidc_callback: Arc::new(crate::oidc_callback::DefaultOidcCallbackHandler),
        shutdown: Arc::new(crate::shutdown_state::ShutdownState::default()),
        attachment_http: crate::attachments::minio_client::build_client().unwrap(),
        decision_http: crate::decisions::provider::build_client().unwrap(),
        url_metadata_http: crate::url_metadata::build_client().unwrap(),
        erp: Arc::new(crate::erp_provider::NoopErpProvider),
        video_result_urls: Arc::new(crate::video_result_urls::NoVideoResultUrlRefresh),
        cloud_runtime_features: Arc::new(crate::devices::NoCloudRuntimeFeatures),
        skill_market: crate::skill_market::SkillMarketRegistry::default(),
        mcp_providers: crate::mcp_providers::McpProviderRegistry::default(),
        interactive_form: crate::InteractiveFormRegistry::default(),
        executor_version: crate::executor_version::ExecutorVersionService::from_redis(None)
            .unwrap(),
        executor_manager: crate::executor_manager::ExecutorManager::new("http://127.0.0.1:1")
            .unwrap(),
        sites: crate::sites::SitesClient::with_settings("", "", std::time::Duration::from_secs(1))
            .unwrap(),
        llm_proxy_credentials: Arc::new(crate::llm_proxy::StoredLlmProxyCredentials),
        repository_tokens: Arc::new(crate::repository_tokens::StoredRepositoryTokens),
        git_repositories: crate::git_repositories::GitRepositoriesService::new(None).unwrap(),
        token_issuer_extra_claims: Arc::new(crate::token_issuers::NoExtraClaims),
        external_knowledge_auth: Arc::new(crate::mcp::knowledge_external::auth::PersonalApiKeyAuth),
        responses_dispatch: Arc::new(crate::responses::dispatch::ResponsesDispatch::spawn()),
    })
}
