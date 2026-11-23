// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Read-only catalog and grant projection for execution request assembly.

use brz_mysql::{MysqlResult, MysqlService};
use serde::Deserialize;

use crate::apps_installed::{db, service};

#[derive(Default, Deserialize)]
struct Keywords {
    #[serde(default, deserialize_with = "brz_json::adapters::null_as_default")]
    keywords: Vec<String>,
}

#[derive(Default, Deserialize)]
struct AppDocument {
    #[serde(default)]
    spec: Option<Keywords>,
}

pub struct ExecutionApp {
    pub config: service::ConnectorApp,
    pub keywords: Vec<String>,
    pub available: bool,
}

pub enum ExecutionApps {
    EmptyCatalog,
    InactiveCaller,
    Visible(Vec<ExecutionApp>),
}

pub async fn execution_apps(
    mysql: &MysqlService,
    user_id: i64,
    user_name: &str,
) -> MysqlResult<ExecutionApps> {
    let rows = db::list_connector_app_kinds(mysql).await?;
    if rows.is_empty() {
        return Ok(ExecutionApps::EmptyCatalog);
    }
    let Some(user) = db::find_user_by_id_and_name(mysql, user_id, user_name)
        .await?
        .filter(|user| user.users_is_active)
    else {
        return Ok(ExecutionApps::InactiveCaller);
    };
    let mut apps = Vec::new();
    for row in rows {
        let config = service::row_to_app(&row);
        if !service::is_visible(&config, &user) {
            continue;
        }
        let available = service::app_connected(mysql, &config, user_id).await?;
        let keywords = row
            .kinds_json
            .0
            .project::<AppDocument>()
            .and_then(|doc| doc.spec)
            .unwrap_or_default()
            .keywords;
        apps.push(ExecutionApp {
            config,
            keywords,
            available,
        });
    }
    Ok(ExecutionApps::Visible(apps))
}
