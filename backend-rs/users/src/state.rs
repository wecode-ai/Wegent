//! Retained account services supplied by application composition.
use crate::user_profile::{UserGitInfoMasker, UserGitInfoProvider, UserViewExtension};
use std::sync::Arc;

pub struct AppState {
    pub mysql: brz_mysql::MysqlService,
    pub auth: wegent_backend_config::AuthConfig,
    pub user_profile: Arc<dyn UserViewExtension>,
    pub user_git_info: Arc<dyn UserGitInfoProvider>,
    pub user_git_info_mask: Arc<dyn UserGitInfoMasker>,
    pub user_reader: Arc<dyn wegent_identity::user_reader::UserByIdReader>,
    pub git_http: brz_http::Client,
}
