//! Login dependencies retained and shared by application startup.
pub struct AppState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub auth: wegent_backend_config::AuthConfig,
    pub frontend_url: String,
}
