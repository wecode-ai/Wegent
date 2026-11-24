#[cfg(test)]
pub(crate) use wegent_project_participation::assignment_index::index_id;
pub(crate) use wegent_project_participation::assignment_index::refresh_active_index;

#[cfg(test)]
use brz_mysql::MysqlService;
#[cfg(test)]
use wegent_project_participation::assignment_index::ensure_active_index;

#[cfg(test)]
#[path = "assignment_index_mysql_tests.rs"]
mod mysql_tests;
