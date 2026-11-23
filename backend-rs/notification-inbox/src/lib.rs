// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Desktop notifications and notification preferences over the user inbox.

#![forbid(unsafe_code)]

mod inbox;
mod preferences;

use brz_mysql::MysqlService;
use wegent_identity::auth::AppAuthenticator;

brz_http_server::registry!(dependencies(state: MysqlService), auth = AppAuthenticator);

pub fn routes(
    mysql: MysqlService,
) -> Result<brz_http_server::Router<AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = mysql)
}

pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_http_apis::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
