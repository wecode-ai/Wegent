// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use std::collections::BTreeMap;

use crate::json_compat::python_json_compact;

use super::connections::AuthFailure;

pub(super) struct CredentialCipher {
    keys: BTreeMap<String, [u8; 32]>,
    active_id: String,
}

impl CredentialCipher {
    pub(super) fn from_environment() -> Result<Self, AuthFailure> {
        let encoded =
            std::env::var("WEWORK_PLUGIN_CREDENTIAL_KEYS").map_err(|_| AuthFailure::Internal)?;
        let active = std::env::var("WEWORK_PLUGIN_CREDENTIAL_ACTIVE_KEY_ID")
            .map_err(|_| AuthFailure::Internal)?;
        Self::from_config(&encoded, &active).ok_or(AuthFailure::Internal)
    }

    fn from_config(encoded: &str, active: &str) -> Option<Self> {
        let encoded: BTreeMap<String, String> = serde_json::from_str(encoded).ok()?;
        let mut keys = BTreeMap::new();
        for (id, key) in encoded {
            if !(1..=64).contains(&id.len())
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            {
                return None;
            }
            keys.insert(id, STANDARD.decode(key).ok()?.try_into().ok()?);
        }
        keys.contains_key(active).then(|| Self {
            keys,
            active_id: active.to_owned(),
        })
    }

    pub(super) fn encrypt(&self, plaintext: &str, context: &str) -> Result<Value, AuthFailure> {
        let mut nonce = [0_u8; 12];
        getrandom::getrandom(&mut nonce).map_err(|_| AuthFailure::Internal)?;
        let key = &self.keys[&self.active_id];
        let aad = Self::aad(&self.active_id, context);
        let ciphertext = Aes256Gcm::new_from_slice(key)
            .map_err(|_| AuthFailure::Internal)?
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| AuthFailure::Internal)?;
        Ok(json!({
            "version": 1,
            "keyId": self.active_id,
            "nonce": STANDARD.encode(nonce),
            "ciphertext": STANDARD.encode(ciphertext)
        }))
    }

    pub(super) fn observation_key(
        &self,
        previous: Option<&Value>,
    ) -> Result<(&str, &[u8; 32]), AuthFailure> {
        let id = match previous {
            Some(observation) => observation["keyId"].as_str().ok_or(AuthFailure::Internal)?,
            None => &self.active_id,
        };
        self.keys
            .get_key_value(id)
            .map(|(id, key)| (id.as_str(), key))
            .ok_or(AuthFailure::Internal)
    }

    pub(super) fn decrypt(&self, envelope: &Value, context: &str) -> Result<String, AuthFailure> {
        self.open(envelope, context).ok_or(AuthFailure::Internal)
    }

    fn open(&self, envelope: &Value, context: &str) -> Option<String> {
        if envelope["version"].as_u64() != Some(1) {
            return None;
        }
        let id = envelope["keyId"].as_str()?;
        let key = self.keys.get(id)?;
        let nonce: [u8; 12] = STANDARD
            .decode(envelope["nonce"].as_str()?)
            .ok()?
            .try_into()
            .ok()?;
        let ciphertext = STANDARD.decode(envelope["ciphertext"].as_str()?).ok()?;
        let aad = Self::aad(id, context);
        let plaintext = Aes256Gcm::new_from_slice(key)
            .ok()?
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .ok()?;
        String::from_utf8(plaintext).ok()
    }

    fn aad(id: &str, context: &str) -> String {
        python_json_compact(&json!(["wegent-plugin-credential", 1, id, context]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_a_version_one_envelope_with_a_rotated_key_and_matching_context() {
        let keys = r#"{
            "old":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
            "new":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        }"#;
        let cipher = CredentialCipher::from_config(keys, "new").unwrap();
        let envelope = json!({
            "version": 1,
            "keyId": "old",
            "nonce": "AgICAgICAgICAgIC",
            "ciphertext": "Yb+xPT8lpNCwvtmsOcm228PZuhT80TCyv3UTfxouNx12Sg=="
        });
        let context = r#"["transfer",1,"intent","source","dws","\u8d26\u6237",{"a":1,"z":2}]"#;
        assert_eq!(
            cipher.decrypt(&envelope, context).unwrap(),
            "fixture-credential"
        );
        let fresh = cipher.encrypt("fixture-credential", context).unwrap();
        assert_eq!(fresh["keyId"], "new");
        assert_eq!(
            cipher.decrypt(&fresh, context).unwrap(),
            "fixture-credential"
        );
        assert!(
            cipher
                .decrypt(&envelope, &context.replace("intent", "other"))
                .is_err()
        );
    }
}
