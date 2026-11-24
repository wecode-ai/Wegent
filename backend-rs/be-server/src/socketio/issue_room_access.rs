// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Issue-room delivery revalidation for authenticated Runtime connections.

use brz_socket_io::extract::SocketRef;
use wegent_socket_adapter::IssueRoomAccess;

use crate::state::AppState;

pub(super) struct ProjectIssueRoomAccess(pub(super) std::sync::Weak<AppState>);

#[async_trait::async_trait]
impl IssueRoomAccess for ProjectIssueRoomAccess {
    /// Revalidate the captured recipients using their namespace-owned identity.
    async fn authorize(
        &self,
        room: &str,
        project_id: &str,
        issue_id: &str,
        sockets: Vec<SocketRef>,
    ) -> Vec<SocketRef> {
        let Some(state) = self.0.upgrade() else {
            return Vec::new();
        };
        let external =
            match crate::loop_tasks::loop_repository::LoopItemRepository::new(&state.mysql)
                .find_external_project(issue_id)
                .await
            {
                Ok(external) => external,
                Err(error) => {
                    tracing::warn!(%error, room, "Issue delivery scope is unavailable");
                    return Vec::new();
                }
            };
        // External providers retain their existing subscription admission policy.
        // Native invitations do not extend provider authority or add per-chunk HTTP calls.
        if external.is_some() {
            return sockets;
        }
        let mut decisions = std::collections::HashMap::new();
        let mut recipients = Vec::new();
        for socket in sockets {
            let user_id = socket.rooms().iter().find_map(|room| {
                room.strip_prefix("wework-runtime:user:")
                    .and_then(|id| id.parse::<i64>().ok())
            });
            let Some(user_id) = user_id else { continue };
            let permitted = if let Some(permitted) = decisions.get(&user_id) {
                *permitted
            } else {
                let permitted = crate::socketio::project_chat_events::permits_comment(
                    &state, user_id, project_id, issue_id,
                )
                .await;
                decisions.insert(user_id, permitted);
                permitted
            };
            if permitted {
                recipients.push(socket);
            } else {
                socket.leave(room.to_owned());
            }
        }
        recipients
    }
}
