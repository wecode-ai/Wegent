//! The existing ConnectorConnection encryption format, shared with Python.

use super::*;
use crate::plugin_account_auth::{
    connections, credential_cipher::CredentialCipher, execution, native_credential,
};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

pub(super) fn failure(error: connections::AuthFailure) -> MysqlError {
    match error {
        connections::AuthFailure::Refusal(code) => fail(code),
        connections::AuthFailure::Internal => MysqlError::InvalidQuery {
            reason: "native_plugin_dependency_unavailable".into(),
        },
    }
}

pub(super) fn canonical(value: &Value) -> String {
    let mut value = value.clone();
    value.sort_all_objects();
    wegent_python_compat::json_compat::python_json_compact(&value)
}

pub(super) fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(canonical(value).as_bytes()))
}

pub(super) fn source(spec: &Value) -> String {
    connections::source_identity(&spec["source"])
}
pub(super) fn context(user: i64, spec: &Value) -> String {
    connections::credential_context(user, spec)
}

pub(super) fn observation(
    user: i64,
    raw: &str,
    source: &str,
    slug: &str,
    account: &str,
    previous: &Value,
) -> MysqlResult<Value> {
    let cipher = CredentialCipher::from_environment().map_err(failure)?;
    let (id, key) = cipher
        .observation_key((!previous.is_null()).then_some(previous))
        .map_err(failure)?;
    let mut derive = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC key");
    derive.update(b"wework-native-source-observation-key-v1");
    let derived = derive.finalize().into_bytes();
    let value: Value =
        serde_json::from_str(raw).map_err(|_| fail("plugin_auth_invalid_credential"))?;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&derived).expect("HMAC key");
    mac.update(
        canonical(&json!([
            "wework-native-source-observation-v1",
            user,
            source,
            slug,
            account,
            value
        ]))
        .as_bytes(),
    );
    Ok(json!({"keyId":id,"digest":format!("{:x}",mac.finalize().into_bytes())}))
}

pub(super) fn encrypt(plaintext: &str, context: &str) -> MysqlResult<Value> {
    CredentialCipher::from_environment()
        .and_then(|cipher| cipher.encrypt(plaintext, context))
        .map_err(failure)
}
pub(super) fn decrypt(envelope: &Value, context: &str) -> MysqlResult<String> {
    CredentialCipher::from_environment()
        .and_then(|cipher| cipher.decrypt(envelope, context))
        .map_err(failure)
}
pub(super) fn token_payload(raw: &str) -> MysqlResult<Value> {
    native_credential::oauth_payload(raw).map_err(failure)
}

pub(super) fn expired(value: &Value) -> bool {
    execution::requires_refresh(value, chrono::Utc::now().timestamp() as f64)
}
pub(super) fn business(raw: String, kind: &Value) -> MysqlResult<String> {
    execution::business_credential(&json!({"credentialType":kind}), raw).map_err(failure)
}
