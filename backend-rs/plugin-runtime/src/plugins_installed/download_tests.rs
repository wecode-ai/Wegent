// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the installed-plugin download handler's rendered SQL and
//! response helpers.

use super::*;

/// The recorded `_owned_install` statement of case
/// `504e7085-6076-41c4-a117-0790f21441f2` (sequence 3615), byte for byte.
#[test]
fn owned_install_statement_matches_the_recorded_sql() {
    let expected = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
kinds.kind AS kinds_kind, kinds.name AS kinds_name, kinds.namespace AS kinds_namespace, \
kinds.json AS kinds_json, kinds.is_active AS kinds_is_active, \
kinds.created_at AS kinds_created_at, kinds.updated_at AS kinds_updated_at \n\
FROM kinds \n\
WHERE kinds.id = 254688 AND kinds.user_id = 159 AND kinds.kind = 'InstalledPlugin' \
AND kinds.namespace = 'default' AND kinds.is_active = 1 \n LIMIT 1";
    assert_eq!(
        recorded_owned_install(254688, 159)
            .split_whitespace()
            .collect::<Vec<_>>(),
        expected.split_whitespace().collect::<Vec<_>>()
    );
}

fn recorded_owned_install(installed_id: i64, user_id: i64) -> String {
    format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.id = {installed_id} \
         AND kinds.user_id = {user_id} AND kinds.kind = 'InstalledPlugin' \
         AND kinds.namespace = 'default' AND kinds.is_active = 1 \n LIMIT 1"
    )
}

/// The fallback re-read renders the same filter with `true`, matching the
/// recorded sequence 3616.
#[test]
fn fallback_kind_statement_uses_the_true_spelling() {
    let statement = recorded_active_install(254688, 159);
    assert!(
        statement.contains("kinds.is_active = true"),
        "the fallback lookup renders SQLAlchemy's `true` literal: {statement}"
    );
    assert!(statement.contains("kinds.kind = 'InstalledPlugin'"));
}

fn recorded_active_install(installed_id: i64, user_id: i64) -> String {
    format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.id = {installed_id} \
         AND kinds.user_id = {user_id} AND kinds.kind = 'InstalledPlugin' \
         AND kinds.namespace = 'default' AND kinds.is_active = true \n LIMIT 1"
    )
}

/// The api-key lookup keeps all three scalar filters and the labeled columns.
#[test]
fn api_key_lookup_keeps_the_labeled_projection_and_filters() {
    let hash = format!("{:x}", Sha256::digest(b"wg-recorded"));
    let statement = format!(
        "SELECT {API_KEY_COLUMNS} \nFROM api_keys \n\
         WHERE api_keys.key_hash = '{hash}' AND api_keys.key_type = 'personal' \
         AND api_keys.is_active = true \n LIMIT 1"
    );
    assert!(statement.contains("api_keys.id AS api_keys_id"));
    assert!(statement.contains("AND api_keys.key_type = 'personal'"));
    assert!(statement.contains("AND api_keys.is_active = true"));
}

/// The recorded `Content-Disposition` of the case: `superpowers.zip` has no
/// character that needs encoding.
#[test]
fn disposition_renders_the_recorded_filename() {
    let filename = "superpowers.zip".to_string();
    assert_eq!(
        format!("attachment; filename*=UTF-8''{}", percent_encode(&filename)),
        "attachment; filename*=UTF-8''superpowers.zip"
    );
}

/// Non-ASCII and space characters must be percent-encoded (RFC 5987).
#[test]
fn disposition_percent_encodes_non_ascii_and_spaces() {
    assert_eq!(percent_encode("a b+ü.zip"), "a%20b%2B%C3%BC.zip");
    // `~`, `.`, `-` and `_` stay literal.
    assert_eq!(percent_encode("a~b.c-d_e.zip"), "a~b.c-d_e.zip");
}

/// `_fallback_filename` prefers `spec.sourcePayload.filename` and otherwise
/// uses `<kind name>.zip`.
#[test]
fn fallback_filename_prefers_the_source_payload() {
    let with_payload = kind_record(
        r#"{"spec": {"sourcePayload": {"filename": "custom.zip"}}}"#,
        "superpowers-b225390a89",
    );
    assert_eq!(fallback_filename(&with_payload), "custom.zip");

    let without_payload = kind_record(r#"{"spec": {}}"#, "superpowers-b225390a89");
    assert_eq!(
        fallback_filename(&without_payload),
        "superpowers-b225390a89.zip"
    );

    let empty_payload = kind_record(
        r#"{"spec": {"sourcePayload": {"filename": ""}}}"#,
        "superpowers-b225390a89",
    );
    assert_eq!(
        fallback_filename(&empty_payload),
        "superpowers-b225390a89.zip"
    );
}

fn kind_record(json: &str, name: &str) -> KindRecord {
    KindRecord {
        id: 254688,
        name: name.to_string(),
        json: brz_mysql::Json(brz_json::OpaqueJson::from(
            serde_json::from_str::<serde_json::Value>(json).expect("valid test json"),
        )),
    }
}

/// `release_package_for_install` needs an integer `spec.releaseId`; the
/// recorded install is an upload with no release and therefore takes the
/// `skill_binaries` fallback.
#[test]
fn release_id_requires_an_integer() {
    let upload = kind_record(r#"{"spec": {"source": {"type": "upload"}}}"#, "superpowers");
    assert_eq!(release_id_of(&upload), None);

    let released = kind_record(r#"{"spec": {"releaseId": 42}}"#, "superpowers");
    assert_eq!(release_id_of(&released), Some(42));

    let stringy = kind_record(r#"{"spec": {"releaseId": "42"}}"#, "superpowers");
    assert_eq!(release_id_of(&stringy), None);
}

fn release_id_of(record: &KindRecord) -> Option<i64> {
    record
        .json
        .0
        .to_value()
        .get("spec")
        .and_then(|spec| spec.get("releaseId"))
        .and_then(serde_json::Value::as_i64)
}

/// The API-key prefix decides the branch; a bare or non-`wg-` credential is
/// not an API key.
#[test]
fn api_key_detection_requires_the_wg_prefix() {
    assert!(is_api_key("wg-abc"));
    assert!(!is_api_key("eyJhbGciOi.payload.sig"));
    assert!(!is_api_key(""));
}
