//! Authenticated, subscription-bound storage and provider signature verification.
use aes_gcm::{
    Aes256Gcm,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

pub(super) fn random_id() -> Result<String, ()> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| ())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(super) fn seal(key: &str, context: &str, value: &str) -> Result<String, ()> {
    let key = Sha256::digest(format!("wework-git-inbox:{key}"));
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| ())?;
    let mut nonce = [0_u8; 12];
    getrandom::getrandom(&mut nonce).map_err(|_| ())?;
    let encrypted = cipher
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: value.as_bytes(),
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| ())?;
    Ok(STANDARD.encode([nonce.as_slice(), encrypted.as_slice()].concat()))
}

pub(super) fn open(key: &str, context: &str, value: &str) -> Result<String, ()> {
    let bytes = STANDARD.decode(value).map_err(|_| ())?;
    if bytes.len() < 28 {
        return Err(());
    }
    let key = Sha256::digest(format!("wework-git-inbox:{key}"));
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| ())?;
    let plaintext = cipher
        .decrypt(
            bytes[..12].into(),
            Payload {
                msg: &bytes[12..],
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| ())?;
    String::from_utf8(plaintext).map_err(|_| ())
}

pub(super) fn verify(provider: &str, secret: &str, raw: &[u8], signature: &str) -> bool {
    if provider == "gitlab" {
        // Compare fixed-length digests through constant-time MAC verification.
        let expected = Sha256::digest(secret.as_bytes());
        let supplied = Sha256::digest(signature.as_bytes());
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&expected).unwrap();
        mac.update(b"gitlab-webhook");
        let tag = mac.finalize().into_bytes();
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&supplied).unwrap();
        mac.update(b"gitlab-webhook");
        return mac.verify_slice(&tag).is_ok();
    }
    let Some(hex) = signature
        .strip_prefix("sha256=")
        .filter(|s| s.len() == 64 && s.is_ascii())
    else {
        return false;
    };
    let digest: Result<Vec<u8>, _> = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
        .collect();
    let Ok(digest) = digest else {
        return false;
    };
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(raw);
    mac.verify_slice(&digest).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secret_envelopes_are_bound_to_subscription_and_key() {
        let sealed = seal("key", "user:subscription", "secret").unwrap();
        assert_eq!(open("key", "user:subscription", &sealed).unwrap(), "secret");
        assert!(open("key", "other", &sealed).is_err());
        assert!(open("other", "user:subscription", &sealed).is_err());
        assert_ne!(sealed, seal("key", "user:subscription", "secret").unwrap());
    }
    #[test]
    fn signatures_bind_exact_body_and_secret() {
        let raw = br#"{"action":"opened"}"#;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(b"secret").unwrap();
        mac.update(raw);
        let signature = format!("sha256={:x}", mac.finalize().into_bytes());
        assert!(verify("github", "secret", raw, &signature));
        assert!(!verify("github", "secret", b"other", &signature));
        assert!(!verify("github", "secret", raw, "sha256=invalid"));
        assert!(verify("gitlab", "secret", raw, "secret"));
        assert!(!verify("gitlab", "secret", raw, "other"));
    }
}
