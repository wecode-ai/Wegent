#[path = "../../tests/support/mysql_pool.rs"]
mod pool;
pub(super) use pool::assert_shared_pool;
