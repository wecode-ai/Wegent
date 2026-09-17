// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/responses/{response_id}`
//! (source `app/api/endpoints/openapi_responses.py:get_response`, mounted at
//! `/api` + `/v1/responses`).

pub mod auth;
pub mod auth_error;
pub mod http_error;
pub mod output_builder;
#[cfg(test)]
mod output_builder_tests;
pub mod python_json;
pub mod rate_limit;
pub mod responses_repository;

mod handler;
