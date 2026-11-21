// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Socket.IO room emitters and inbound Redis adapter delivery.

#![forbid(unsafe_code)]

mod emitters;
pub mod redis_adapter;
pub mod upgrade;
pub use emitters::{IssueRoomAccess, SocketEmitters, TerminalRoomBinding};

/// Namespace that receives chat-room device broadcasts.
pub const CHAT_NAMESPACE: &str = "/chat";
/// Namespace that owns device sessions and the capability sync call.
pub const EXECUTOR_NAMESPACE: &str = "/local-executor";
/// Namespace that relays browser terminal traffic.
pub const TERMINAL_NAMESPACE: &str = "/terminal";
/// Namespace that carries Wework Runtime events.
pub const RUNTIME_NAMESPACE: &str = "/wework-runtime";
pub const RUNTIME_EVENT: &str = "runtime:event";
pub const PROJECT_CHAT_CREATED_EVENT: &str = "wework:project_chat:message:created";
pub const LOOP_ITEM_CHANGED_EVENT: &str = "wework:loop_item:changed";
pub const PROJECT_CHAT_AGENT_CHUNK_EVENT: &str = "wework:project_chat:agent:chunk";

pub fn runtime_user_room(user_id: i64) -> String {
    format!("wework-runtime:user:{user_id}")
}
