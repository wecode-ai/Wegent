// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task/subtask sharding routing keys (open-source contract).
//!
//! These key types are used by open-source repository code to bind a routing
//! key on the `MysqlService` via `.route(ByTaskId(...))` / `.route(ByUserId(...))`.
//! They carry no internal logic — only the intent ("route by task id" vs
//! "route by owner user id"). The actual shard-resolution policy
//! defaults to [`NoSharding`]. The application supplies its own policy.
//!
//! `brz_mysql::MysqlRouteKey` is auto-implemented for any `Any + Send + Sync`
//! type, so these newtypes need no manual trait impl.

/// Route a task or subtask lookup by its task identifier.
pub struct ByTaskId(pub u64);

/// Route an owner-scoped task or subtask lookup.
pub struct ByUserId(pub u64);

/// Application-selected task storage behavior. The default uses base tables
/// and does not probe internal migrated legacy rows.
#[derive(Clone, Copy)]
pub struct TaskPolicy {
    pub is_scoped_id: fn(u64) -> bool,
    /// Enable the internal legacy-id migration probes. Public deployments
    /// leave this false; the private deployment enables it together with
    /// sharded routing.
    pub resolve_migrated_legacy: bool,
}

impl Default for TaskPolicy {
    fn default() -> Self {
        Self {
            is_scoped_id: base_tables_only,
            resolve_migrated_legacy: false,
        }
    }
}

fn base_tables_only(_task_id: u64) -> bool {
    false
}

/// Maximum number of ancestors visited while resolving fork history.
pub(crate) const MAX_FORK_DEPTH: u32 = 50;

/// Public application policy: logical table names are physical base tables.
/// Routing keys are accepted for shared repositories but never select a shard.
pub struct NoSharding;

impl brz_mysql::MysqlRouting for NoSharding {
    fn resolve<'a>(
        &'a self,
        template: &'a str,
        _key: &'a dyn brz_mysql::MysqlRouteKey,
    ) -> brz_mysql::MysqlResult<impl brz_mysql::MysqlRouteOutput + 'a> {
        Ok(template)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_mysql::{MysqlRouteKey, MysqlRouteOutput, MysqlRouting};

    #[test]
    fn no_sharding_ignores_task_user_and_other_keys() {
        let keys: [&dyn MysqlRouteKey; 5] = [
            &ByTaskId(42),
            &ByTaskId(u64::MAX),
            &ByUserId(509),
            &ByUserId(0),
            &(),
        ];
        for table in ["tasks", "subtasks"] {
            for key in keys {
                let mut rendered = String::new();
                NoSharding
                    .resolve(table, key)
                    .unwrap()
                    .write_to(&mut rendered)
                    .unwrap();
                assert_eq!(rendered, table);
            }
        }
    }

    #[test]
    fn default_policy_uses_base_tables_for_every_id() {
        let policy = TaskPolicy::default();
        for task_id in [0, 42, u64::MAX] {
            assert!(!(policy.is_scoped_id)(task_id));
        }
    }
}
