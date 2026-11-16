// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Response models for `GET /api/sites` (`app.schemas.site`).
//!
//! `SiteListItem` is the discriminated union
//! `SiteResponse | MiniProgramResponse`; the upstream `app_type` selects the
//! variant during parsing, so serialization only projects the already chosen
//! shape. Optional fields serialize as JSON `null`, matching pydantic's
//! default `model_dump` (no `exclude_none`).
use serde::Serialize;

/// `SiteListResponse`: one page of typed applications.
#[derive(Debug, Serialize)]
pub struct SiteListResponse {
    pub items: Vec<SiteListItem>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
    pub next_cursor: Option<String>,
}

/// `SiteListItem` (`SiteResponse | MiniProgramResponse`).
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum SiteListItem {
    Site(SiteResponse),
    MiniProgram(MiniProgramResponse),
}

/// `SiteResponse`: a generated site registered with the Sites service.
#[derive(Debug, Serialize)]
pub struct SiteResponse {
    pub app_type: &'static str,
    pub siteid: String,
    pub project_id: String,
    pub taskid: String,
    pub username: String,
    pub owner_username: String,
    pub access_role: String,
    pub name: String,
    pub slug: String,
    pub custom_domain_prefix: Option<String>,
    pub network: &'static str,
    pub internal_url: String,
    pub external_url: Option<String>,
    pub publish_status: &'static str,
    pub last_publish_error: Option<String>,
    pub thumbnail_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub published_at: Option<String>,
}

/// `MiniProgramResponse`: a mini program registered with the Sites service.
#[derive(Debug, Serialize)]
pub struct MiniProgramResponse {
    pub app_type: &'static str,
    pub siteid: String,
    pub project_id: String,
    pub taskid: String,
    pub username: String,
    pub owner_username: String,
    pub access_role: String,
    pub name: String,
    pub slug: String,
    pub app_id: Option<String>,
    pub status: String,
    pub version: Option<String>,
    pub experience_url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
