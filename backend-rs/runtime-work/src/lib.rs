// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Runtime workbench, transcript access, and notification settings.

#![forbid(unsafe_code)]

use std::sync::Arc;
use wegent_device_identity as device_identity;
use wegent_devices::{DevicesState, device_commands, device_online_state, devices};
use wegent_http_compat as http_compat;
use wegent_identity::auth;
use wegent_project_coordination::{cloud_projects, loop_item_pages, loop_tasks};
use wegent_python_compat::{json_compat, py_json};
use wegent_socket_events::{socketio_emit, socketio_rpc};

#[cfg(test)]
use wegent_backend_test_support::{self as json_contract_tests, self as sql_test_support};

mod mcp_app_ownership;
mod runtime_request;
mod runtime_rpc;
mod runtime_rpc_policy;
mod runtime_transcript_search;
mod runtime_work;
mod runtime_work_im_notification_sessions;
mod runtime_work_im_notifications;
mod runtime_work_projection;
mod runtime_work_transcript;
mod runtime_work_transcript_access;
mod runtime_work_transcript_request;
mod runtime_work_transcript_response;

pub use mcp_app_ownership::Ownership;
pub use runtime_request::{
    RuntimeRequestIdentity, handle as handle_runtime_request, sync_runtime_auth_file,
};
pub use runtime_rpc::{CallFailure, RuntimeRpcError, call as call_owned_runtime};
pub use runtime_rpc_policy::personal_events_allowed;
pub use runtime_transcript_search::request::SearchRequest;
pub use runtime_work::{
    RuntimeCallError, RuntimeRpcServices, call_runtime_method_envelope, call_runtime_rpc,
    call_socketio_event, remote_control_is_enabled, runtime_instance_matches,
};
pub use runtime_work_im_notification_sessions::{
    NotificationSessionError, runtime_notification_sessions, runtime_question_sessions,
    runtime_task_notification_key,
};
pub use runtime_work_im_notifications::{
    PrivateSession, decode_json, parse_private_session, private_session_key, unix_seconds,
};
pub use runtime_work_projection::{RuntimeModelSelection, optional_model_selection};
pub use runtime_work_transcript_access::{
    ProjectScope, ResolvedTranscript, comment_manager_dispatch, comment_member_assignment,
    require_project_chat_scope, resolve_project_transcript,
};
pub use runtime_work_transcript_request::{
    NormalizedAddress, ProjectSessionRequest, TranscriptRequest, transcript_payload,
};

/// Resolves the account proxy used by remote Runtime model calls.
#[async_trait::async_trait]
pub trait RuntimeExecutionProxy: Send + Sync {
    async fn execution_proxy_url(
        &self,
        mysql: &brz_mysql::MysqlService,
        user_id: i32,
    ) -> Option<String>;
}

/// Dependencies of the native Socket.IO Runtime dispatcher.
pub struct RuntimeRequestServices<'a> {
    pub mysql: &'a brz_mysql::MysqlService,
    pub transport: RuntimeRpcServices<'a>,
    pub proxy: &'a dyn RuntimeExecutionProxy,
}

pub struct RuntimeWorkState {
    pub devices: Arc<DevicesState>,
    pub issue_http: brz_http::Client,
    pub jwt_key: String,
}

brz_http_server::registry!(
    dependencies(state: Arc<RuntimeWorkState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<RuntimeWorkState>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state)
}

pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_http_apis::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
