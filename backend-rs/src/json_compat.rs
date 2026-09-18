// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed projections and opaque values at legacy JSON boundaries.
use serde::{Deserialize, Deserializer, de::IgnoredAny};

/// Legacy presence-aware input field retained for downstream compatibility.
/// Application models should use `Option<T>` and express response omission on
/// their serializable fields.
#[derive(Debug, Clone)]
pub struct JsonField<T> {
    pub present: bool,
    pub value: Option<T>,
}

impl<T> Default for JsonField<T> {
    fn default() -> Self {
        Self {
            present: false,
            value: None,
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for JsonField<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Input<T> {
            Typed(T),
            Other(IgnoredAny),
        }
        let value = match Input::deserialize(deserializer)? {
            Input::Typed(value) => Some(value),
            Input::Other(_) => None,
        };
        Ok(Self {
            present: true,
            value,
        })
    }
}

/// Freeze an already validated JSON value for an opaque response field.
/// The response can echo it without allowing further dictionary mutation.
/// Missing fields are represented separately by the caller's `Option`.
pub(crate) fn raw_json(value: &serde_json::Value) -> Box<serde_json::value::RawValue> {
    serde_json::value::to_raw_value(value).expect("JSON value serializes")
}

/// Explicit JSON null for response models. This avoids making a field
/// dynamically typed merely because its protocol value is always null.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct JsonNull;

impl serde::Serialize for JsonNull {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_unit()
    }
}

pub(crate) fn raw_null() -> Box<serde_json::value::RawValue> {
    serde_json::value::to_raw_value(&JsonNull).expect("JSON null serializes")
}

/// Opaque persisted JSON that retains legacy decoding behavior.
///
/// Some selected columns have no schema in this service and are never inspected.
/// Keep their JSON validated and stored as raw text. The transient value preserves
/// the previous number validation; directly decoding `RawValue` would also accept
/// numbers the old decoder rejected.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(transparent)]
pub struct OpaqueJson(Box<serde_json::value::RawValue>);

impl<'de> Deserialize<'de> for OpaqueJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        serde_json::Value::deserialize(deserializer).map(Self::from)
    }
}

impl From<serde_json::Value> for OpaqueJson {
    fn from(value: serde_json::Value) -> Self {
        Self(raw_json(&value))
    }
}

impl OpaqueJson {
    pub fn from_serializable(value: impl serde::Serialize) -> Self {
        Self(serde_json::value::to_raw_value(&value).expect("JSON value serializes"))
    }

    pub(crate) fn is_null(&self) -> bool {
        self.0.get() == "null"
    }

    pub(crate) fn project<T: serde::de::DeserializeOwned>(&self) -> Option<T> {
        serde_json::from_str(self.0.get()).ok()
    }

    pub(crate) fn to_value(&self) -> serde_json::Value {
        serde_json::from_str(self.0.get()).expect("opaque JSON remains valid")
    }

    pub(crate) fn to_raw_value(&self) -> Box<serde_json::value::RawValue> {
        self.0.clone()
    }

    /// Whether this value is a JSON object with at least one key. This lets
    /// callers select an opaque object without materializing a mutable tree.
    pub(crate) fn is_nonempty_object(&self) -> bool {
        serde_json::from_str::<std::collections::BTreeMap<String, IgnoredAny>>(self.0.get())
            .is_ok_and(|object| !object.is_empty())
    }
}

/// Serialize an optional opaque value at a response boundary. Input null and
/// a missing input key are both represented as `None`; the response model
/// chooses either a concrete default, JSON null, or field omission.
pub(crate) trait OptionalOpaqueJsonExt {
    fn raw_or(&self, default: impl serde::Serialize) -> Box<serde_json::value::RawValue>;
    fn raw_option(&self) -> Option<Box<serde_json::value::RawValue>>;
    fn raw_with_object_null_default(&self, key: &str) -> Box<serde_json::value::RawValue>;
}

impl OptionalOpaqueJsonExt for Option<OpaqueJson> {
    fn raw_or(&self, default: impl serde::Serialize) -> Box<serde_json::value::RawValue> {
        self.as_ref().map_or_else(
            || serde_json::value::to_raw_value(&default).expect("JSON default serializes"),
            OpaqueJson::to_raw_value,
        )
    }

    fn raw_option(&self) -> Option<Box<serde_json::value::RawValue>> {
        self.as_ref().map(OpaqueJson::to_raw_value)
    }

    fn raw_with_object_null_default(&self, key: &str) -> Box<serde_json::value::RawValue> {
        let Some(value) = self.as_ref() else {
            return raw_null();
        };
        let mut value = value.to_value();
        if let serde_json::Value::Object(object) = &mut value {
            object
                .entry(key.to_owned())
                .or_insert(serde_json::Value::Null);
        }
        raw_json(&value)
    }
}

/// Read-only projection of a legacy JSON document. Decode the complete JSON
/// first to retain number validation, then keep only the typed fields. Valid JSON
/// of the wrong shape is an absent projection.
#[derive(Debug, Clone)]
pub(crate) struct JsonProjection<T> {
    pub value: Option<T>,
}
impl<T: serde::de::DeserializeOwned> From<serde_json::Value> for JsonProjection<T> {
    fn from(value: serde_json::Value) -> Self {
        Self {
            value: serde_json::from_value(value).ok(),
        }
    }
}
impl<'de, T: serde::de::DeserializeOwned> Deserialize<'de> for JsonProjection<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        serde_json::Value::deserialize(deserializer).map(Self::from)
    }
}

impl<T: serde::de::DeserializeOwned> JsonProjection<T> {
    pub fn from_json(value: &serde_json::Value) -> Self {
        Self {
            value: T::deserialize(value).ok(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_columns_keep_legacy_number_validation() {
        for raw in [
            "null",
            "\"\"",
            "{}",
            "[]",
            "1",
            "1.0",
            "-0.0",
            "18446744073709551615",
            r#"{"x":null,"nested":{"v":[]}}"#,
            "1e400",
            "invalid",
        ] {
            let old = serde_json::from_str::<serde_json::Value>(raw);
            let new = serde_json::from_str::<OpaqueJson>(raw);
            match (old, new) {
                (Ok(old), Ok(new)) => assert_eq!(
                    serde_json::to_string(&old).unwrap(),
                    serde_json::to_string(&new).unwrap()
                ),
                (Err(old), Err(new)) => assert_eq!(old.to_string(), new.to_string()),
                _ => panic!("opaque JSON decoding changed for {raw}"),
            }
        }
    }
    #[test]
    fn explicit_null_serializes_as_json_null() {
        assert_eq!(serde_json::to_string(&JsonNull).unwrap(), "null");
        assert_eq!(raw_null().get(), "null");
    }
}
