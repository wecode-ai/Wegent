// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use crate::state::AppState;
use serde_json::Value;
use wegent_project_notifications::LocalEmit;

pub(crate) use wegent_project_notifications::{
    Pending, active_dingtalk_channel_config, create_on, dingtalk_access_token, dingtalk_api_base,
    dingtalk_credentials, direct_human_on, execution_on, send_text, target, telegram_message, uuid,
};

pub(crate) struct GatewayEmit;

#[async_trait::async_trait]
impl LocalEmit for GatewayEmit {
    async fn emit(&self, event: &str, room: &str, frame: &Value) {
        crate::socketio::runtime::deliver_local_emit("/wework-runtime", event, room, None, frame)
            .await;
    }
}

pub(crate) async fn deliver(state: &AppState, pending: Pending) {
    wegent_project_notifications::deliver_with_issue_im_recipient(
        &state.mysql,
        state.redis.as_ref(),
        &GatewayEmit,
        state.issue_im_recipient.as_deref(),
        pending,
    )
    .await;
}
