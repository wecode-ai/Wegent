// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Deliver execution callbacks to external chat channels.

#![forbid(unsafe_code)]

pub mod channel;
pub mod dingtalk_card;
mod dingtalk_stream;
mod telegram_stream;

pub use telegram_stream::TelegramTransport;
