//! Template recovery requires explicit encryption material, without legacy defaults.

use base64::{Engine, engine::general_purpose::STANDARD};
use wegent_crypto::{decrypt_cbc, encrypt_cbc};

use super::{FastApiError, Value, unavailable};

pub(super) struct IntentCipher {
    key: String,
    iv: String,
}

impl IntentCipher {
    pub(super) fn from_env() -> Result<Self, FastApiError> {
        Self::from_material(
            crate::config::env_or_dotenv("GIT_TOKEN_AES_KEY"),
            crate::config::env_or_dotenv("GIT_TOKEN_AES_IV"),
        )
    }

    pub(super) fn from_material(
        key: Option<String>,
        iv: Option<String>,
    ) -> Result<Self, FastApiError> {
        let key = key
            .filter(|key| matches!(key.len(), 16 | 24 | 32))
            .ok_or_else(unavailable)?;
        let iv = iv.filter(|iv| iv.len() == 16).ok_or_else(unavailable)?;
        Ok(Self { key, iv })
    }

    pub(super) fn seal(&self, intent: &Value) -> Result<String, FastApiError> {
        let plain = serde_json::to_vec(intent).map_err(|_| unavailable())?;
        let encrypted = encrypt_cbc(self.key.as_bytes(), self.iv.as_bytes(), &plain)
            .map_err(|_| unavailable())?;
        Ok(STANDARD.encode(encrypted))
    }

    pub(super) fn open(&self, encrypted: &str) -> Result<Value, FastApiError> {
        let bytes = STANDARD.decode(encrypted).map_err(|_| unavailable())?;
        let plain = decrypt_cbc(self.key.as_bytes(), self.iv.as_bytes(), &bytes)
            .map_err(|_| unavailable())?;
        serde_json::from_slice(&plain).map_err(|_| unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;
    use serde_json::json;

    #[test]
    fn requires_explicit_valid_key_and_iv() {
        for (key, iv) in [
            (None, Some("v".repeat(16))),
            (Some("k".repeat(32)), None),
            (Some(String::new()), Some("v".repeat(16))),
            (Some("k".repeat(31)), Some("v".repeat(16))),
            (Some("k".repeat(32)), Some("v".repeat(15))),
        ] {
            assert_eq!(
                IntentCipher::from_material(key, iv).err().unwrap().status(),
                StatusCode::SERVICE_UNAVAILABLE
            );
        }
    }

    #[test]
    fn explicit_material_encrypts_full_intent_and_rejects_corruption() {
        let cipher = IntentCipher::from_material(Some("k".repeat(32)), Some("v".repeat(16)))
            .ok()
            .unwrap();
        let intent = json!({"name":"产品全流程小组","mcp":{"Authorization":"secret-test-value"}});
        let encrypted = cipher.seal(&intent).unwrap();
        assert!(!encrypted.contains("secret-test-value"));
        assert_eq!(cipher.open(&encrypted).unwrap(), intent);
        assert_eq!(
            cipher.open("invalid ciphertext").unwrap_err().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
