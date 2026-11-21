// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use brz_http_server::StatusCode;
use brz_mysql::FromMysqlRow;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};

const CONFIG_PREFIX: &str = "model-primary-group-icon:";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Icon {
    Globe,
    MapPin,
    Zap,
    Brain,
    Code,
    Cpu,
    Layers,
    Sparkles,
    Shield,
    FlaskConical,
}

#[derive(Deserialize, Serialize)]
struct GroupIcon {
    group: String,
    icon: Option<Icon>,
}

#[derive(FromMysqlRow)]
struct ConfigRow {
    config_value: String,
}

fn config_key(group: &str) -> String {
    format!("{CONFIG_PREFIX}{:x}", Sha256::digest(group.as_bytes()))
}

#[brz_http_server::get("/api/models/primary-group-icons")]
async fn get_primary_group_icons(
    #[inject(state)] state: &AppState,
    #[auth] _user: SessionUser,
) -> Result<BTreeMap<String, Icon>, FastApiError> {
    let rows: Vec<ConfigRow> = state
        .mysql
        .fetch_all(
            "SELECT config_value FROM system_configs WHERE config_key LIKE ?",
            (format!("{CONFIG_PREFIX}%"),),
        )
        .await
        .map_err(database_error)?;
    let mut icons = BTreeMap::new();
    for row in rows {
        let entry: GroupIcon = serde_json::from_str(&row.config_value).map_err(|error| {
            tracing::error!(%error, "invalid model primary group icon configuration");
            FastApiError::internal()
        })?;
        if let Some(icon) = entry.icon {
            icons.insert(entry.group, icon);
        }
    }
    Ok(icons)
}

#[brz_http_server::put("/api/models/primary-group-icons")]
async fn set_primary_group_icon(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: Value,
) -> Result<Value, FastApiError> {
    let entry = parse_update(&user.0.role, body)?;
    let key = config_key(&entry.group);
    if entry.icon.is_some() {
        let value = serde_json::to_string(&entry).map_err(|_| FastApiError::internal())?;
        state.mysql.execute(
            "INSERT INTO system_configs (config_key, config_value, version, updated_by, created_at, updated_at) \
             VALUES (?, ?, 1, ?, NOW(), NOW()) ON DUPLICATE KEY UPDATE \
             config_value = VALUES(config_value), version = version + 1, updated_by = VALUES(updated_by), updated_at = NOW()",
            (key, value, user.0.id),
        ).await.map_err(database_error)?;
    } else {
        state
            .mysql
            .execute("DELETE FROM system_configs WHERE config_key = ?", (key,))
            .await
            .map_err(database_error)?;
    }
    Ok(json!({"group": entry.group, "icon": entry.icon}))
}

fn parse_update(role: &str, body: Value) -> Result<GroupIcon, FastApiError> {
    if role != "admin" {
        return Err(FastApiError::forbidden(
            "Permission denied. Admin access required.",
        ));
    }
    let invalid = || {
        FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid primary model group icon",
        )
    };
    if body.get("icon").is_none() {
        return Err(invalid());
    }
    let mut entry: GroupIcon = serde_json::from_value(body).map_err(|_| invalid())?;
    entry.group = entry.group.trim().to_owned();
    if entry.group.is_empty()
        || serde_json::to_string(&entry)
            .map_err(|_| invalid())?
            .chars()
            .count()
            > 4096
    {
        return Err(invalid());
    }
    Ok(entry)
}

fn database_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "model primary group icon database operation failed");
    FastApiError::internal()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_admin_can_set_or_reset_a_group_icon() {
        let body = json!({"group": "  国内  ", "icon": "map-pin"});
        assert_eq!(
            parse_update("user", body.clone()).err().unwrap().status(),
            StatusCode::FORBIDDEN,
        );
        let update = parse_update("admin", body).unwrap();
        assert_eq!(update.group, "国内");
        assert_eq!(update.icon, Some(Icon::MapPin));
        let reset = parse_update("admin", json!({"group": "国内", "icon": null})).unwrap();
        assert_eq!(reset.icon, None);
        assert!(parse_update("admin", json!({"group": "国内", "icon": "unknown"})).is_err());
        assert!(parse_update("admin", json!({"group": "国内"})).is_err());
    }
}
