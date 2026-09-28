// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! JSON baselines captured before response type refactoring.
#[allow(dead_code)]
pub(crate) fn assert_fixture(name: &str, actual: impl serde::Serialize) {
    let actual = serialized(actual).expect("response serializes");
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/typed_responses")
        .join(format!("{name}.json"));
    let expected: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    if let (Some(actual), Some(expected)) = (actual.as_array(), expected.as_array()) {
        assert_eq!(
            actual.len(),
            expected.len(),
            "JSON contract length changed: {name}"
        );
        for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
            assert_eq!(actual, expected, "JSON contract changed: {name}[{index}]");
        }
        return;
    }
    // Whole-object equality distinguishes absent keys from explicit null.
    assert_eq!(actual, expected, "JSON contract changed: {name}");
}

/// Exercise the byte serializer used by HTTP responses, then compare JSON.
pub(crate) fn serialized(value: impl serde::Serialize) -> serde_json::Result<serde_json::Value> {
    let bytes = serde_json::to_vec(&value)?;
    serde_json::from_slice(&bytes)
}
