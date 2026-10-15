// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/responses/{response_id}` retrieve
//! (`get_response`) and `POST /api/v1/responses` create (`create_response`),
//! source `app/api/endpoints/openapi_responses.py`, mounted at
//! `/api` + `/v1/responses`. `POST /api/v1/responses/{response_id}/cancel` is
//! the `cancel_response` route and `DELETE /api/v1/responses/{response_id}` is
//! the `delete_response` route on the same source module.

pub mod auth;
pub mod auth_error;
mod create;
pub mod dispatch;
pub mod error;
pub mod http_error;
pub mod output_builder;
#[cfg(test)]
mod output_builder_tests;
pub mod python_json;
pub mod rate_limit;
pub mod responses_repository;

mod cancel;
mod delete;
mod generation_output;
mod handler;
mod shell_output;
mod stream_state;
