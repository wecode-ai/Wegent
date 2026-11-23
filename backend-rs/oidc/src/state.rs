//! Retained authentication services and new-user initialization dependencies.
use std::sync::Arc;
pub struct AppState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub auth: wegent_backend_config::AuthConfig,
    pub oidc_config: wegent_backend_config::OidcConfig,
    pub oidc: Arc<crate::oidc_service::OidcService>,
    pub oidc_callback: Arc<dyn crate::oidc_callback::OidcCallbackHandler + Send + Sync>,
    pub onboarding: Arc<wegent_onboarding::state::AppState>,
    pub seed_tasks: Arc<dyn wegent_onboarding::new_user_resources::tasks::TaskResources>,
}
