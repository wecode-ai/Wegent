//! Task-scoped Git identities for native execution requests.
//!
//! `build_execution_git_user_info` + `classify_git_auth_transport`
//! (`app/services/execution/git_credentials.py`) are shared by every service
//! that builds an `ExecutionRequest`: the responses create path resolves the
//! identity from the reloaded request user, while native background jobs load
//! `users.git_info` themselves before enriching the request.
use crate::{AppState, responses::create::dispatch::ExecutionRequest};
use anyhow::Result;
use brz_mysql::Json;
use serde_json::Value;

use wegent_execution_request::git_identity::{apply_identity, resolve_identity};

pub(crate) async fn enrich(app: &AppState, request: &mut ExecutionRequest) -> Result<()> {
    let row: Option<brz_mysql::MysqlRow> = app
        .mysql
        .fetch_optional("SELECT git_info FROM users WHERE id=?", (request.user_id,))
        .await?;
    let accounts = row
        .and_then(|row| row.get_at::<Option<Json<Value>>>(0).ok().flatten())
        .map(|value| value.0)
        .unwrap_or(Value::Null);
    let identity = resolve_identity(
        app.repository_tokens.as_ref(),
        &accounts,
        request.git_domain.as_deref(),
    )
    .await?;
    apply_identity(request, &identity);
    Ok(())
}
