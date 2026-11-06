//! Best-effort default resource application for newly provisioned users.
use wegent_access::permissions;
use wegent_backend_persistence::sql_support;
use wegent_python_compat::json_compat;
pub mod new_user_resources;
pub mod state {
    pub struct AppState {
        pub mysql: brz_mysql::MysqlService,
        pub redis: Option<brz_redis::RedisService>,
        pub entity_resolvers: wegent_access::permissions::EntityResolvers,
        pub task_store: std::sync::Arc<dyn wegent_task_store::task_store::TaskStore>,
    }
}
