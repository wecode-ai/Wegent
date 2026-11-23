// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Administrator read APIs assembled over one database dependency.

#![forbid(unsafe_code)]

mod im_channels;
mod im_channels_status;
mod service_keys;
mod system_config_slogan_tips;

use std::sync::Arc;

use wegent_identity::auth::AppAuthenticator;

pub struct AdminState {
    pub mysql: brz_mysql::MysqlService,
}

brz_http_server::registry!(
    dependencies(state: Arc<AdminState>),
    auth = AppAuthenticator
);

pub fn routes(
    state: Arc<AdminState>,
) -> Result<brz_http_server::Router<AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state)
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
