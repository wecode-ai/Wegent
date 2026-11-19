// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Socket event transport without application state or namespace ownership.

#![forbid(unsafe_code)]

pub mod callback_sequencer;
pub mod socketio_emit;
pub mod socketio_rpc;
