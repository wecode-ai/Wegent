// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/responses/{response_id}` retrieve
//! (`get_response`) and `POST /api/v1/responses` create (`create_response`),
//! source `app/api/endpoints/openapi_responses.py`, mounted at
//! `/api` + `/v1/responses`. `POST /api/v1/responses/{response_id}/cancel` is
//! the `cancel_response` route and `DELETE /api/v1/responses/{response_id}` is
//! the `delete_response` route on the same source module.

pub(crate) mod create;
pub use wegent_responses_api::{auth, error, output_builder, rate_limit, responses_repository};
pub mod dispatch;

#[cfg(test)]
mod test_mysql;
#[cfg(test)]
mod test_redis;
