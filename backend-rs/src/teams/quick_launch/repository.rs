// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MySQL data access for `GET /api/users/quick-launch`, mirroring the source
//! SQLAlchemy renderings token for token: full labeled projections with
//! `{table}_{column}` aliases and literal-inlined scalar filters.
use crate::json_compat::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;

use super::super::teams_repository::KIND_COLUMNS;

/// `QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY` (`app.api.endpoints.users`); pinned
/// by tests to the literal used in the SQL above.
#[cfg_attr(not(test), allow(dead_code))]
pub const QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY: &str = "quick_launch_functions";

/// One `system_configs` row
/// (`db.query(SystemConfig).filter(SystemConfig.config_key == ...)`);
/// `_get_system_config_value` reads only `config_value`.
#[derive(Debug, FromMysqlRow)]
pub struct SystemConfigRow {
    #[allow(dead_code)]
    pub system_configs_id: i64,
    #[allow(dead_code)]
    pub system_configs_config_key: String,
    pub system_configs_config_value: Json<OpaqueJson>,
    #[allow(dead_code)]
    pub system_configs_version: i64,
    #[allow(dead_code)]
    pub system_configs_updated_by: Option<i64>,
    #[allow(dead_code)]
    pub system_configs_created_at: Option<NaiveDateTime>,
    #[allow(dead_code)]
    pub system_configs_updated_at: Option<NaiveDateTime>,
}

/// `kind_service.get_team_by_id`: one active Team `kinds` row by id.
#[derive(Debug, FromMysqlRow)]
pub struct TeamKindRow {
    pub kinds_id: i64,
    #[allow(dead_code)]
    pub kinds_user_id: i64,
    #[allow(dead_code)]
    pub kinds_kind: String,
    /// Selected to match the recorded projection; the agent title comes from
    /// the stored JSON, not the column.
    #[allow(dead_code)]
    pub kinds_name: String,
    #[allow(dead_code)]
    pub kinds_namespace: String,
    pub kinds_json: Json<OpaqueJson>,
    #[allow(dead_code)]
    pub kinds_is_active: i8,
    #[allow(dead_code)]
    pub kinds_created_at: Option<NaiveDateTime>,
    #[allow(dead_code)]
    pub kinds_updated_at: Option<NaiveDateTime>,
}

/// Load the quick-launch `system_configs` row
/// (`WHERE system_configs.config_key = 'quick_launch_functions' LIMIT 1`).
pub async fn quick_launch_system_config<M>(mysql: &M) -> MysqlResult<Option<SystemConfigRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            "SELECT system_configs.id AS system_configs_id, \
             system_configs.config_key AS system_configs_config_key, \
             system_configs.config_value AS system_configs_config_value, \
             system_configs.version AS system_configs_version, \
             system_configs.updated_by AS system_configs_updated_by, \
             system_configs.created_at AS system_configs_created_at, \
             system_configs.updated_at AS system_configs_updated_at \
             FROM system_configs \
             WHERE system_configs.config_key = 'quick_launch_functions' \
             LIMIT 1",
            (),
        )
        .await
}

/// `kind_service.get_team_by_id(team_id)`
/// (`WHERE kinds.id = ? AND kinds.kind = 'Team' AND kinds.is_active = true
/// LIMIT 1`). The id is a Python int the source inlines as a text literal;
/// the target binds it as a parameter, which the replay matcher accepts.
pub async fn team_kind_by_id<M>(mysql: &M, team_id: i64) -> MysqlResult<Option<TeamKindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \n\
                 WHERE kinds.id = ? AND kinds.kind = 'Team' \
                 AND kinds.is_active = true \n LIMIT 1"
            )
            .as_str(),
            (team_id,),
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_key_is_source_constant() {
        assert_eq!(QUICK_LAUNCH_FUNCTIONS_CONFIG_KEY, "quick_launch_functions");
    }
}
