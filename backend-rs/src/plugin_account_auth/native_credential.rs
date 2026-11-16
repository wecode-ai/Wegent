// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use serde::Deserialize;
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::collections::HashSet;
use std::fmt;

use super::connections::AuthFailure;

/// Validate the OAuth escrow payload without allowing duplicate keys to be
/// interpreted differently by the backend and native adapter.
pub(super) fn oauth_payload(raw: &str) -> Result<Value, AuthFailure> {
    let invalid = AuthFailure::Refusal("plugin_auth_invalid_credential");
    let payload = validated_payload(raw, "oauth2")?;
    if !(payload["expires_at"].is_null() || payload["expires_at"].is_number())
        || payload
            .get("provider_private")
            .is_some_and(|value| !value.is_object())
    {
        return Err(invalid);
    }
    Ok(payload)
}

pub(super) fn validated_payload(raw: &str, credential_type: &str) -> Result<Value, AuthFailure> {
    let invalid = AuthFailure::Refusal("plugin_auth_invalid_credential");
    let fields: &[&str] = match credential_type {
        "password" => &["username", "password"],
        "bearer" => &["token"],
        "oauth2" => &["access_token"],
        _ => return Err(invalid),
    };
    serde_json::from_str::<UniqueJson>(raw).map_err(|_| invalid)?;
    let payload: Value = serde_json::from_str(raw).map_err(|_| invalid)?;
    if !fields.iter().all(|field| {
        payload[*field]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty())
    }) {
        return Err(invalid);
    }
    Ok(payload)
}

struct UniqueJson;

impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(Self)
    }
}

impl<'de> Visitor<'de> for UniqueJson {
    type Value = Self;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JSON with unique object keys")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self, A::Error> {
        let mut keys = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key) {
                return Err(de::Error::custom("duplicate object key"));
            }
            map.next_value::<Self>()?;
        }
        Ok(self)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self, A::Error> {
        while sequence.next_element::<Self>()?.is_some() {}
        Ok(self)
    }

    fn visit_str<E: de::Error>(self, _: &str) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self, E> {
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_escrow_validates_native_payload_and_rejects_ambiguous_objects() {
        assert!(
            oauth_payload(r#"{"access_token":"test","expires_at":123.5,"provider_private":{}}"#)
                .is_ok()
        );
        for raw in [
            r#"{"access_token":"test","access_token":"second"}"#,
            r#"{"access_token":"test","provider_private":{"nested":[{"key":1,"key":2}]}}"#,
            r#"{"access_token":" ","expires_at":null}"#,
            r#"{"access_token":"test","expires_at":true}"#,
            r#"{"access_token":"test","provider_private":null}"#,
        ] {
            assert!(oauth_payload(raw).is_err());
        }
    }
}
