// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/kinds/{kind}/skills/{skill_id}/download`.

pub mod auth;
pub mod entity_resolution;
pub mod internal_binary;
pub mod skill_download;

mod skills_api;

pub mod skills_unified;

mod input;
