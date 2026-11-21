// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Personal API key verification for unattended model requests.

use brz_http_server::StatusCode;
use sha2::{Digest, Sha256};
use std::{future::Future, pin::Pin};
use wegent_identity::{auth::AuthFailure, runtime_model_auth::PersonalModelKeyReader};

use crate::http_compat::FastApiError;
use crate::responses::auth_error::AuthError;

pub(crate) struct RuntimeModelKeys(pub(crate) brz_mysql::MysqlService);

impl PersonalModelKeyReader for RuntimeModelKeys {
    fn owner_id<'a>(
        &'a self,
        token: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<i32, AuthFailure>> + Send + 'a>> {
        Box::pin(async move {
            let key_hash = format!("{:x}", Sha256::digest(token.as_bytes()));
            let (_, owner_id) = crate::transaction_outcome::run(
                &self.0,
                async |transaction| {
                    let mut sql: &mut brz_mysql::MysqlTransactionService = transaction;
                    let identity =
                        crate::responses::auth::verify_personal_api_key_on(&mut sql, &key_hash)
                            .await
                            .map_err(|error| match error {
                                AuthError::Dependency(_) => FastApiError::internal(),
                                _ => FastApiError::unauthorized("Could not validate credentials"),
                            })?;
                    Ok(crate::transaction_outcome::Completion::Commit(identity))
                },
                FastApiError::internal,
            )
            .await
            .map_err(|error| {
                if error.status() == StatusCode::INTERNAL_SERVER_ERROR {
                    AuthFailure::Dependency
                } else {
                    AuthFailure::InvalidCredentials
                }
            })?;
            Ok(owner_id)
        })
    }
}
