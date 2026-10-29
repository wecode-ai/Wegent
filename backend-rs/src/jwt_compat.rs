// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared python-jose verification for user-session JWTs.
//!
//! Verify the signature before interpreting claims. The caller still owns the
//! token purpose, credential precedence and user lookup. Task tokens and device
//! proofs keep their separate endpoint-specific policies.
use brz_json::adapters::python_truthy;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::de::DeserializeOwned;
use serde_json::Value;

/// Decode with the active key followed by legacy decode-only keys.
pub(crate) fn decode_jose<T: DeserializeOwned>(
    token: &str,
    keys: impl IntoIterator<Item = impl AsRef<[u8]>>,
    algorithm: Algorithm,
) -> Option<T> {
    decode_at(
        token,
        keys,
        algorithm,
        jsonwebtoken::get_current_timestamp() as i64,
        jose_claims_valid,
    )
}

/// PyJWT 2.10 defaults for task and Skill identity tokens. Unlike python-jose,
/// PyJWT rejects future iat and exp equal to now, and does not validate at_hash.
pub(crate) fn decode_pyjwt<T: DeserializeOwned>(
    token: &str,
    keys: impl IntoIterator<Item = impl AsRef<[u8]>>,
    algorithm: Algorithm,
) -> Option<T> {
    decode_at(
        token,
        keys,
        algorithm,
        jsonwebtoken::get_current_timestamp() as i64,
        pyjwt_claims_valid,
    )
}

/// Match verify_task_token's required dictionary fields before user lookup.
pub(crate) fn decode_task<T: DeserializeOwned>(
    token: &str,
    keys: impl IntoIterator<Item = impl AsRef<[u8]>>,
    algorithm: Algorithm,
) -> Option<T> {
    let claims: Value = decode_pyjwt(token, keys, algorithm)?;
    if claims.get("type").and_then(Value::as_str) != Some("task_token")
        || ["task_id", "subtask_id", "user_id", "user_name"]
            .iter()
            .any(|field| claims.get(field).is_none())
    {
        return None;
    }
    serde_json::from_value(claims).ok()
}

fn decode_at<T: DeserializeOwned>(
    token: &str,
    keys: impl IntoIterator<Item = impl AsRef<[u8]>>,
    algorithm: Algorithm,
    now: i64,
    validate: fn(&Value, i64) -> bool,
) -> Option<T> {
    for key in keys {
        let Ok(data) = jsonwebtoken::decode::<Value>(
            token,
            &DecodingKey::from_secret(key.as_ref()),
            &jose_validation(algorithm),
        ) else {
            continue;
        };
        if !validate(&data.claims, now) {
            return None;
        }
        return serde_json::from_value(data.claims).ok();
    }
    None
}

/// Keep cryptographic validation enabled; validate claims with Python semantics.
pub(crate) fn jose_validation(algorithm: Algorithm) -> Validation {
    let mut validation = Validation::new(algorithm);
    validation.validate_aud = false;
    validation.validate_exp = false;
    validation.validate_nbf = false;
    validation.leeway = 0;
    validation.required_spec_claims.clear();
    validation
}

/// python-jose defaults when neither audience nor access_token is supplied.
pub(crate) fn jose_claims_valid(claims: &Value, now: i64) -> bool {
    if !claims.is_object() || claims.get("aud").is_some() || claims.get("at_hash").is_some() {
        return false;
    }
    for field in ["sub", "jti"] {
        if claims.get(field).is_some_and(|value| !value.is_string()) {
            return false;
        }
    }
    for field in ["iat", "exp", "nbf"] {
        if let Some(value) = claims.get(field) {
            let Some(value) = jose_integer(value) else {
                return false;
            };
            if (field == "exp" && value < i128::from(now))
                || (field == "nbf" && value > i128::from(now))
            {
                return false;
            }
        }
    }
    true
}

fn pyjwt_claims_valid(claims: &Value, now: i64) -> bool {
    if !claims.is_object() || claims.get("aud").is_some_and(python_truthy) {
        return false;
    }
    for field in ["sub", "jti"] {
        if claims.get(field).is_some_and(|value| !value.is_string()) {
            return false;
        }
    }
    for field in ["iat", "exp", "nbf"] {
        if let Some(value) = claims.get(field) {
            let Some(value) = jose_integer(value) else {
                return false;
            };
            if (field == "exp" && value <= i128::from(now))
                || (field != "exp" && value > i128::from(now))
            {
                return false;
            }
        }
    }
    true
}

/// Only validity and ordering against an i64 clock are needed. Saturation
/// preserves that ordering for Python integers outside Rust's integer range.
fn jose_integer(value: &Value) -> Option<i128> {
    match value {
        Value::Bool(value) => Some(i128::from(*value)),
        Value::String(value) => python_integer_string(value),
        Value::Number(value) => value
            .as_i64()
            .map(i128::from)
            .or_else(|| value.as_u64().map(i128::from))
            .or_else(|| {
                value
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .map(|value| value.trunc() as i128)
            }),
        _ => None,
    }
}

fn python_integer_string(value: &str) -> Option<i128> {
    let value = value.trim();
    let (negative, digits) = match value.as_bytes().first() {
        Some(b'-') => (true, &value[1..]),
        Some(b'+') => (false, &value[1..]),
        _ => (false, value),
    };
    let mut integer = 0_i128;
    let mut previous_digit = false;
    for character in digits.chars() {
        if character == '_' {
            if !previous_digit {
                return None;
            }
            previous_digit = false;
        } else {
            let digit = decimal_digit(character)?;
            integer = integer.saturating_mul(10).saturating_add(i128::from(digit));
            previous_digit = true;
        }
    }
    previous_digit.then_some(if negative { -integer } else { integer })
}

/// Python int() accepts Unicode decimal digits, including adjacent sets of
/// mathematical digits. Each contiguous Nd run consists of complete 0..9 sets.
fn decimal_digit(character: char) -> Option<u32> {
    if character.is_ascii_digit() {
        return character.to_digit(10);
    }
    static DECIMAL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let decimal =
        DECIMAL.get_or_init(|| regex::Regex::new(r"^\p{Nd}$").expect("decimal digit regex"));
    let is_decimal = |character: char| {
        let mut bytes = [0; 4];
        decimal.is_match(character.encode_utf8(&mut bytes))
    };
    if !is_decimal(character) {
        return None;
    }
    let mut start = character as u32;
    while let Some(previous) = start.checked_sub(1).and_then(char::from_u32) {
        if !is_decimal(previous) {
            break;
        }
        start -= 1;
    }
    Some((character as u32 - start) % 10)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    pub(crate) struct Fixture {
        pub(crate) now: i64,
        pub(crate) cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    pub(crate) struct Case {
        pub(crate) name: String,
        pub(crate) claims: Value,
        pub(crate) jose_valid: bool,
        pub(crate) pyjwt_valid: bool,
        pub(crate) session_valid: bool,
    }

    pub(crate) fn fixture() -> Fixture {
        serde_json::from_str(include_str!("../tests/fixtures/jwt-python-jose.json")).unwrap()
    }

    pub(crate) fn sign(claims: &Value, key: &[u8]) -> String {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(Algorithm::HS256),
            claims,
            &jsonwebtoken::EncodingKey::from_secret(key),
        )
        .unwrap()
    }

    pub(crate) fn session_cases() -> Vec<(&'static str, Value, bool)> {
        let now = jsonwebtoken::get_current_timestamp();
        vec![
            ("without_exp", serde_json::json!({"sub":"u"}), true),
            (
                "string_exp",
                serde_json::json!({"sub":"u","exp":(now+600).to_string()}),
                true,
            ),
            (
                "float_exp",
                serde_json::json!({"sub":"u","exp":now as f64+600.5}),
                true,
            ),
            (
                "scope_empty",
                serde_json::json!({"sub":"u","scope":""}),
                true,
            ),
            (
                "scope_false",
                serde_json::json!({"sub":"u","scope":false}),
                true,
            ),
            (
                "scope_array",
                serde_json::json!({"sub":"u","scope":[]}),
                true,
            ),
            (
                "scope_object",
                serde_json::json!({"sub":"u","scope":{}}),
                true,
            ),
            (
                "expired",
                serde_json::json!({"sub":"u","exp":now-30}),
                false,
            ),
            (
                "expired_5m",
                serde_json::json!({"sub":"u","exp":now-300}),
                false,
            ),
            (
                "future_nbf",
                serde_json::json!({"sub":"u","nbf":now+300}),
                false,
            ),
            (
                "future_iat",
                serde_json::json!({"sub":"u","iat":now+300}),
                true,
            ),
            (
                "invalid_iat",
                serde_json::json!({"sub":"u","iat":"invalid"}),
                false,
            ),
            (
                "invalid_jti",
                serde_json::json!({"sub":"u","jti":123}),
                false,
            ),
            (
                "aud",
                serde_json::json!({"sub":"u","aud":"other-service"}),
                false,
            ),
            (
                "at_hash",
                serde_json::json!({"sub":"u","at_hash":"test-value"}),
                false,
            ),
            (
                "refresh",
                serde_json::json!({"sub":"u","token_use":"wework_refresh"}),
                false,
            ),
            (
                "scoped",
                serde_json::json!({"sub":"u","scope":"read"}),
                false,
            ),
        ]
    }

    #[test]
    fn matches_python_jose_at_a_fixed_clock() {
        let fixture = fixture();
        for case in fixture.cases {
            let token = sign(&case.claims, b"test-key");
            let claims: Option<Value> = decode_at(
                &token,
                [b"test-key"],
                Algorithm::HS256,
                fixture.now,
                jose_claims_valid,
            );
            assert_eq!(claims.is_some(), case.jose_valid, "{}", case.name);
            let session = claims
                .and_then(|claims| {
                    serde_json::from_value::<crate::auth::SessionClaims>(claims).ok()
                })
                .and_then(|claims| claims.username());
            assert_eq!(session.is_some(), case.session_valid, "{}", case.name);
        }
    }

    #[test]
    fn matches_pyjwt_without_applying_session_policy_to_task_tokens() {
        let fixture = fixture();
        for case in fixture.cases {
            let token = sign(&case.claims, b"test-key");
            let claims: Option<Value> = decode_at(
                &token,
                [b"test-key"],
                Algorithm::HS256,
                fixture.now,
                pyjwt_claims_valid,
            );
            assert_eq!(claims.is_some(), case.pyjwt_valid, "{}", case.name);
        }
    }

    #[test]
    fn never_accepts_a_wrong_signature_or_algorithm() {
        let token = sign(&serde_json::json!({"sub":"u"}), b"other-key");
        assert!(decode_jose::<Value>(&token, [b"test-key"], Algorithm::HS256).is_none());
        let token = sign(&serde_json::json!({"sub":"u"}), b"test-key");
        assert!(decode_jose::<Value>(&token, [b"test-key"], Algorithm::HS512).is_none());
        assert!(decode_jose::<Value>("not-a-jwt", [b"test-key"], Algorithm::HS256).is_none());
    }

    #[test]
    fn supports_legacy_keys_without_bypassing_claim_checks() {
        let valid = sign(&serde_json::json!({"sub":"u"}), b"legacy-key");
        let keys: [&[u8]; 2] = [b"active-key", b"legacy-key"];
        assert!(decode_jose::<Value>(&valid, keys, Algorithm::HS256).is_some());
        let invalid = sign(&serde_json::json!({"sub":"u","exp":1}), b"legacy-key");
        assert!(decode_jose::<Value>(&invalid, keys, Algorithm::HS256).is_none());
    }

    #[test]
    fn rejects_malformed_python_integer_strings() {
        for value in [
            "",
            "+",
            "-",
            "_1",
            "1_",
            "1__2",
            "1.2",
            "1e3",
            "²",
            "+ 1",
            "\u{001c}1",
            "1\u{001f}",
        ] {
            assert!(python_integer_string(value).is_none(), "{value:?}");
        }
        assert_eq!(python_integer_string("  -1_234 "), Some(-1234));
        assert_eq!(python_integer_string("١٢٣"), Some(123));
    }

    #[test]
    fn task_tokens_require_the_python_identity_fields_and_purpose() {
        let claims = serde_json::json!({"type":"task_token", "task_id":1,
            "subtask_id":2, "user_id":3, "user_name":"u"});
        let decode = |claims: &Value| {
            decode_task::<Value>(&sign(claims, b"test-key"), [b"test-key"], Algorithm::HS256)
        };
        assert!(decode(&claims).is_some());
        for field in ["type", "task_id", "subtask_id", "user_id", "user_name"] {
            let mut incomplete = claims.clone();
            incomplete.as_object_mut().unwrap().remove(field);
            assert!(decode(&incomplete).is_none(), "missing {field}");
        }
        let mut wrong_purpose = claims;
        wrong_purpose["type"] = "skill_identity".into();
        assert!(decode(&wrong_purpose).is_none());
    }
}
