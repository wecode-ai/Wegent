// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/resource-library/tags` — the capability-center marketplace tag
//! catalog.
//!
//! Mirrors `app.api.endpoints.resource_library.get_marketplace_tags`: require an
//! authenticated user (`app.core.security.get_current_user`), then render the
//! shared catalog through [`marketplace_tags::get_config`]
//! (`MarketplaceTagService.get_config`). The admin
//! `GET /api/admin/system-config/marketplace-tags` endpoint returns the same
//! body under an admin check.
use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::marketplace_tags::{self, MarketplaceTagsResponse};
use crate::state::AppState;

/// GET /api/resource-library/tags: the marketplace tag catalog for the
/// authenticated user.
#[brz_http_server::get("/api/resource-library/tags")]
async fn get_marketplace_tags(
    #[inject(state)] state: &AppState,
    #[auth] _current_user: SessionUser,
) -> Result<MarketplaceTagsResponse, FastApiError> {
    marketplace_tags::get_config(&state.mysql).await
}
