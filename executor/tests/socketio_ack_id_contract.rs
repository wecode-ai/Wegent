// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use tf_rust_socketio::Error;

mod error {
    pub(crate) type Result<T> = std::result::Result<T, tf_rust_socketio::Error>;
}

// Cargo does not run dependency unit tests, so include the allocator's regressions
// in the Executor suite and retain the vendor crate's large-error lint policy.
#[allow(clippy::result_large_err)]
#[path = "../vendor/tf-rust-socketio/src/ack_id.rs"]
mod ack_id;

#[test]
fn next_ack_id_uses_shared_counter() {
    let first = ack_id::next_ack_id().unwrap();
    let second = ack_id::next_ack_id().unwrap();

    assert_eq!(second, first + 1);
}
