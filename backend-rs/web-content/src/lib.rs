// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Fetch public web page metadata and prepare web content for knowledge imports.

#![forbid(unsafe_code)]

mod url_metadata;
mod url_metadata_extract;
mod web_scraper;
mod web_scraper_create_document;

use std::sync::Arc;

use wegent_identity::auth::AppAuthenticator;

pub use url_metadata::build_client;

pub struct WebContentState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub entity_resolvers: wegent_access::permissions::EntityResolvers,
    pub url_metadata_http: brz_http::Client,
}

brz_http_server::registry!(
    dependencies(state: Arc<WebContentState>),
    auth = AppAuthenticator
);

pub fn routes(
    state: Arc<WebContentState>,
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
