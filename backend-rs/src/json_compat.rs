//! Opaque JSON values at legacy response boundaries.
//!
//! Ported from the reference implementation's `src/json_compat.rs`. A field
//! the source service passes through without inspecting or type-validating it
//! must round-trip exactly, including an explicit `null` and any nested shape.

use serde::{Deserialize, Deserializer};

/// JSON retained as raw text so it can be echoed without being inspected.
///
/// Decoding goes through [`serde_json::Value`] first to keep the source
/// decoder's number validation: decoding [`serde_json::value::RawValue`]
/// directly would also accept numbers the source rejected.
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
        Self::from_serializable(value)
    }
}

impl OpaqueJson {
    /// Freezes an already-validated value for an opaque response field.
    ///
    /// # Panics
    ///
    /// Panics when `value` is not representable as JSON. Callers pass values
    /// derived from JSON or from plain Rust scalars, which always are.
    #[must_use]
    pub fn from_serializable(value: impl serde::Serialize) -> Self {
        Self(serde_json::value::to_raw_value(&value).expect("JSON value serializes"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echoed(raw: &str) -> String {
        let value: OpaqueJson = serde_json::from_str(raw).expect("valid JSON");
        serde_json::to_string(&value).expect("serializable")
    }

    #[test]
    fn echoes_every_json_shape_unchanged() {
        assert_eq!(echoed("null"), "null");
        assert_eq!(echoed("\"\""), "\"\"");
        assert_eq!(echoed("0"), "0");
        assert_eq!(echoed("0.33"), "0.33");
        assert_eq!(echoed("\"test-user\""), "\"test-user\"");
        assert_eq!(echoed("[1,2]"), "[1,2]");
        assert_eq!(echoed("{\"a\":1,\"b\":null}"), "{\"a\":1,\"b\":null}");
    }

    #[test]
    fn preserves_upstream_object_key_order() {
        // The source echoes a Python dict, whose order is the upstream
        // response order; `preserve_order` keeps it instead of sorting.
        assert_eq!(echoed("{\"b\":1,\"a\":2}"), "{\"b\":1,\"a\":2}");
    }

    #[test]
    fn from_serializable_matches_direct_json() {
        assert_eq!(
            serde_json::to_string(&OpaqueJson::from_serializable(0)).expect("serializable"),
            "0"
        );
        assert_eq!(
            serde_json::to_string(&OpaqueJson::from_serializable("")).expect("serializable"),
            "\"\""
        );
    }

    #[test]
    fn rejects_numbers_the_source_decoder_rejected() {
        // Decoding through `serde_json::Value` keeps the source's number
        // validation: out-of-range literals are a decode error, not a
        // silently accepted raw value.
        assert!(serde_json::from_str::<OpaqueJson>("1e400").is_err());
        assert!(serde_json::from_str::<serde_json::Value>("1e400").is_err());
    }
}
