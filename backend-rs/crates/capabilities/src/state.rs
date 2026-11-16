//! Retained services used by capability authorization and resource resolution.
use std::sync::Arc;

pub struct AppState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub task_store: Arc<dyn wegent_task_store::task_store::TaskStore>,
    pub erp: Arc<dyn wegent_directory::erp_provider::ErpProvider + Send + Sync>,
    pub entity_resolvers: wegent_access::permissions::EntityResolvers<brz_redis::RedisService>,
}
