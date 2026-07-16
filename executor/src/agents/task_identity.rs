// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use crate::protocol::ExecutionRequest;

pub(super) fn task_identity_env(request: &ExecutionRequest) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();

    if !request.task_id.trim().is_empty() {
        env.insert("WEGENT_TASK_ID".to_owned(), request.task_id.clone());
    }
    if let Some(auth_token) = non_empty(request.auth_token.as_deref()) {
        env.insert("AUTH_TOKEN".to_owned(), auth_token.to_owned());
    }
    if let Some(token) = non_empty(request.skill_identity_token.as_deref()) {
        env.insert("WEGENT_SKILL_IDENTITY_TOKEN".to_owned(), token.to_owned());
    }
    if let Some(user_name) = non_empty(request.user_name.as_deref()) {
        env.insert("WEGENT_SKILL_USER_NAME".to_owned(), user_name.to_owned());
    }

    env
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}
