// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bind the active deployment's workspace-archive services for background cleanup.
use crate::AppState;

pub async fn archive_task_workspace(
    state: &AppState,
    task_id: i64,
    owner_id: i64,
    executor: &str,
    namespace: &str,
) -> anyhow::Result<()> {
    wegent_workspace_archive::archive(
        &state.attachment_http,
        &state.executor_manager,
        state.task_store.as_ref(),
        task_id,
        owner_id,
        executor,
        namespace,
    )
    .await
}

#[cfg(test)]
mod tests {
    /// The cutover is real only when the route table selects the pattern the
    /// handler registers. `config/routes.toml` lists
    /// `/api/internal/workspace-archives/:task_id/restore-sandbox`, and the
    /// template must not answer the sibling `/archive` or `/archive-sandbox`
    /// methods.
    #[test]
    fn route_table_selects_the_registered_restore_sandbox_handler() {
        const PATH: &str = "/api/internal/workspace-archives/:task_id/restore-sandbox";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        const URI: &str = "/api/internal/workspace-archives/913144407018301/restore-sandbox";

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(table.matches(&http::Method::POST, URI));
        assert!(!table.matches(&http::Method::GET, URI));
        assert!(!table.matches(
            &http::Method::POST,
            "/api/internal/workspace-archives/913144407018301/archive"
        ));

        let registered = wegent_workspace_archive::registered_routes()
            .into_iter()
            .any(|(path, methods)| path == PATH && methods & POST != 0);
        assert!(registered, "POST {PATH} must be registered by the router");
    }
}
