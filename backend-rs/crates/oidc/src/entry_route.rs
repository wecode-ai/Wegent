//! Web callback binding to the retained deployment extension.
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// GET /api/auth/oidc/callback.
#[brz_http_server::get("/api/auth/oidc/callback", access = public)]
async fn oidc_callback(
    #[inject(state)] app: &AppState,
    query: brz_http_server::Query<crate::oidc_callback::CallbackQuery>,
) -> Result<brz_http_server::Redirect, FastApiError> {
    // `CallbackQuery` binds the source's `code`/`state`/`error` query names
    // through its serde fields; positional handler parameters would bind by
    // Rust name and could silently miss `state`.
    app.oidc_callback.handle(app, query.0).await
}
