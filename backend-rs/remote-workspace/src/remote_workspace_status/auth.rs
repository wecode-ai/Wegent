// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! JWT session verification matching `app.core.security.verify_token` and
//! `app.core.jwt_compat.decode_jose_jwt`.
use anyhow::Result;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};

use super::config::AppConfig;
use crate::auth::SessionClaims;

#[allow(
    dead_code,
    reason = "route authentication now runs through AppAuthenticator"
)]
pub struct JwtVerifier {
    decoding_keys: Vec<(Vec<u8>, Algorithm)>,
    validation: Validation,
}

#[allow(
    dead_code,
    reason = "route authentication now runs through AppAuthenticator"
)]
impl JwtVerifier {
    pub fn new(config: &AppConfig) -> Self {
        let algorithm = match config.jwt_algorithm.as_str() {
            "HS256" => Algorithm::HS256,
            "HS384" => Algorithm::HS384,
            "HS512" => Algorithm::HS512,
            _ => Algorithm::HS256,
        };
        let mut decoding_keys = vec![(config.jwt_zinfoid_05q_key.as_bytes().to_vec(), algorithm)];
        for key in &config.jwt_legacy_zinfoid_05q_keys {
            decoding_keys.push((key.as_bytes().to_vec(), algorithm));
        }
        let mut validation = Validation::new(algorithm);
        // Source `decode_jose_jwt` does not require an `exp` claim to be present.
        validation.required_spec_claims.clear();
        validation.validate_exp = false;
        validation.validate_aud = false;
        Self {
            decoding_keys,
            validation,
        }
    }

    /// Returns the username when the token is a valid interactive user
    /// session; `None` maps to the source 401 response.
    pub fn verify_session(&self, token: &str) -> Result<Option<String>> {
        for (key, algorithm) in &self.decoding_keys {
            let mut validation = self.validation.clone();
            validation.algorithms = vec![*algorithm];
            if let Ok(token_data) =
                decode::<SessionClaims>(token, &DecodingKey::from_secret(key), &validation)
            {
                return Ok(token_data.claims.username());
            }
        }
        Ok(None)
    }
}
