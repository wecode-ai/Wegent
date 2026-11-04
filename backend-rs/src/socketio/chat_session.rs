// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/chat` namespace session state.
//!
//! Source: `app/api/ws/chat_namespace.py::on_connect`, which stores
//! `user_id`, `token_exp` (`get_token_expiry`), and `client_origin` on the
//! namespace session. Event handlers read them for the token-expiry guard and
//! the Wework task-room selection.

use super::auth::Identity;

/// `CLIENT_ORIGIN_WEWORK`.
pub const CLIENT_ORIGIN_WEWORK: &str = "wework";

/// One `/chat` namespace connection's business session.
#[derive(Debug, Clone)]
pub struct ChatSession {
    user_id: i64,
    user_name: String,
    token_exp: Option<i64>,
    client_origin: Option<&'static str>,
}

impl ChatSession {
    /// Builds the session from the verified identity and connect credential.
    #[must_use]
    pub fn new(
        identity: &Identity,
        token: Option<&str>,
        client_origin: Option<&'static str>,
    ) -> Self {
        Self {
            user_id: identity.user_id,
            user_name: identity.user_name.clone(),
            token_exp: token.and_then(super::auth::token_expiry),
            client_origin,
        }
    }

    /// The authenticated user id.
    #[must_use]
    pub fn user_id(&self) -> i64 {
        self.user_id
    }

    /// The authenticated user name (trace context in the source).
    #[must_use]
    pub fn user_name(&self) -> &str {
        &self.user_name
    }

    /// `_check_token_expiry`: a missing expiry is treated as expired.
    #[must_use]
    pub fn token_expired(&self, now_unix: i64) -> bool {
        match self.token_exp {
            Some(expiry) => now_unix > expiry,
            None => true,
        }
    }

    /// Whether the connection identified itself as the Wework origin.
    #[must_use]
    pub fn is_wework(&self) -> bool {
        self.client_origin == Some(CLIENT_ORIGIN_WEWORK)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> Identity {
        Identity {
            user_id: 92,
            user_name: "xinyu60".into(),
            auth_type: "jwt",
            email: None,
        }
    }

    #[test]
    fn a_missing_expiry_is_expired_like_the_source() {
        let session = ChatSession::new(&identity(), Some("not-a-jwt"), None);
        assert!(session.token_expired(0));
        assert!(!session.is_wework());
    }

    #[test]
    fn the_connect_origin_selects_the_wework_room() {
        let session = ChatSession::new(&identity(), None, Some(CLIENT_ORIGIN_WEWORK));
        assert!(session.is_wework());
        assert_eq!(session.user_id(), 92);
        assert_eq!(session.user_name(), "xinyu60");
    }

    #[test]
    fn token_expiry_decodes_the_unverified_claim() {
        use base64::Engine as _;
        let claims = serde_json::json!({"sub": "xinyu60", "exp": 1_800_000_000_i64});
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).unwrap());
        let token = format!("header.{payload}.signature");
        assert_eq!(
            super::super::auth::token_expiry(&token),
            Some(1_800_000_000)
        );
    }
}
