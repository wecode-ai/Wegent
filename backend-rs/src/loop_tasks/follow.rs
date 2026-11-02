// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Issue subscriptions never confer Issue access or assignment authority.

use serde::Deserialize;
use serde_json::{Value, json};

use super::assignments::require_issue_read;
use super::auth::FlexibleUser;
use crate::{http_compat::FastApiError, state::AppState};

#[derive(Deserialize)]
struct FollowInput {
    following: bool,
}

#[brz_http_server::put("/api/v1/loop-items/:item_id/follow")]
async fn set_follow(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] user: FlexibleUser,
    input: FollowInput,
) -> Result<Value, FastApiError> {
    require_issue_read(state, item_id, &user).await?;
    crate::background_jobs::project::issue_follow_polling::set_follow(
        state,
        item_id,
        user.id,
        input.following,
    )
    .await?;
    Ok(json!({"following": input.following}))
}
