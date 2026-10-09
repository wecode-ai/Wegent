// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn headers<'a>(pairs: &'a [(&'a str, &'a str)]) -> crate::headers::HeaderSlice<'a> {
    crate::headers::HeaderSlice::new(pairs)
}

#[test]
fn api_key_extraction_priority() {
    let both = headers(&[("x-api-key", "wg-abc"), ("authorization", "Bearer wg-def")]);
    assert_eq!(api_key_from_headers(&both).as_deref(), Some("wg-abc"));
    let bearer = headers(&[("authorization", "Bearer wg-def")]);
    assert_eq!(api_key_from_headers(&bearer).as_deref(), Some("wg-def"));
    let lower = headers(&[("authorization", "bearer wg-def")]);
    assert_eq!(api_key_from_headers(&lower).as_deref(), Some("wg-def"));
    let source = headers(&[("wegent-source", "wg-src")]);
    assert_eq!(api_key_from_headers(&source).as_deref(), Some("wg-src"));
    let jwt = headers(&[("authorization", "Bearer eyJ...")]);
    assert_eq!(api_key_from_headers(&jwt), None);
}

#[test]
fn key_with_username_split() {
    assert_eq!(
        split_key_with_username("wg-key#user"),
        ("wg-key".to_string(), Some("user".to_string()))
    );
    assert_eq!(
        split_key_with_username("wg-key#"),
        ("wg-key".to_string(), None)
    );
    assert_eq!(
        split_key_with_username("wg-key"),
        ("wg-key".to_string(), None)
    );
}

#[test]
fn sha256_is_lowercase_hex() {
    assert_eq!(
        hex_sha256(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn direct_lookups_reuse_the_shared_user_statements() {
    // The JWT and task-token fallbacks query `users` directly, like the
    // source's `db.query(User)`; they reuse the shared labeled projections
    // instead of hand-rolling a statement per call.
    assert!(USER_BY_ID_QUERY.contains("WHERE users.id = ? LIMIT 1"));
    assert!(USER_BY_NAME_QUERY.contains("WHERE users.user_name = ? LIMIT 1"));
    for label in [
        "users_id",
        "users_user_name",
        "users_is_active",
        "users_role",
        "users_auth_source",
    ] {
        assert!(USER_BY_ID_QUERY.contains(label), "missing {label}");
    }
}

#[test]
fn service_username_format() {
    let valid = |name: &str| {
        !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    assert!(valid("hongbin9"));
    assert!(valid("user-1_x"));
    assert!(!valid("user name"));
    assert!(!valid(""));
}
