// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks` — the current user's paginated task list
//! (`app/api/endpoints/adapter/tasks.py:get_tasks` ->
//! `task_kinds_service.get_user_tasks_with_pagination`).
//!
//! Source pipeline: `task_store.list_accessible_task_ids` (the current page's
//! accessible active non-system tasks — owned or approved member — plus the
//! distinct total), `load_task_list_rows_by_ids`, `filter_tasks_for_display`
//! (`DELETE`/background/non-interacted subscription), `restore_task_order`,
//! `get_tasks_related_data_batch` and `convert_to_task_dict_optimized`
//! restricted to the `TaskInDB` response fields.
//!
//! This route is a literal sibling of `GET /api/tasks/{task_id}` and of the
//! static `/api/tasks/lite*` and `/api/tasks/search` routes; the SDK router
//! resolves static paths before `:task_id` templates, so `/api/tasks` never
//! reaches the detail handler.

use std::sync::Arc;

use brz_http_server::Query;
use serde::Deserialize;

use crate::crd::CrdDocument;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::tasks_db_projection::{
    TaskListResponse, TaskListRow, assemble_items, is_displayable, validate_page_limit,
};

pub mod statements;

/// `get_tasks`'s `extra_limit` for the accessible-task page.
const EXTRA_LIMIT: i64 = 50;

/// `Query(1, ge=1)`, `Query(10, ge=1, le=100)`.
#[derive(Debug, Deserialize)]
pub struct TasksParams {
    page: Option<i64>,
    limit: Option<i64>,
}

impl TasksParams {
    fn validated(self) -> Result<(i64, i64), FastApiError> {
        let page_limit = validate_page_limit(self.page, self.limit)?;
        Ok((page_limit.skip, page_limit.limit))
    }
}

/// GET /api/tasks: the list free function, injecting the process-lifetime
/// application state.
#[brz_http_server::get("/api/tasks")]
async fn get_tasks(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] current_user: crate::auth::SessionUser,
    query: Query<TasksParams>,
) -> Result<TaskListResponse, FastApiError> {
    let (skip, limit) = TasksParams {
        page: query.page,
        limit: query.limit,
    }
    .validated()?;
    list_tasks(state, i64::from(current_user.id), skip, limit)
        .await
        .map_err(|_| FastApiError::internal())
}

/// Handler body for `GET /api/tasks`.
async fn list_tasks(
    state: &Arc<AppState>,
    user_id: i64,
    skip: i64,
    limit: i64,
) -> brz_mysql::MysqlResult<TaskListResponse> {
    use brz_mysql::FromMysqlRow as _;

    // `get_accessible_task_ids_and_total`: the page's accessible task ids plus
    // the source's distinct total.
    let page = state
        .task_store
        .list_accessible_task_ids(user_id, skip, limit + EXTRA_LIMIT)
        .await?;

    // `load_task_list_rows_by_ids`: the full rows of the page's ids. An empty
    // page issues no read.
    let raw = state.task_store.list_tasks_by_ids(&page.ids).await?;
    let rows = raw
        .into_iter()
        .map(TaskListRow::from_mysql_row)
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;

    // `filter_tasks_for_display`: keep the displayable rows by id.
    let mut matched: std::collections::HashMap<i64, TaskListRow> = std::collections::HashMap::new();
    for row in rows {
        let crd = CrdDocument::project(&row.json);
        if !is_displayable(&crd, &row.json) {
            continue;
        }
        matched.insert(row.id, row);
    }

    // `restore_task_order(task_ids, id_to_task, limit)`.
    let mut ordered: Vec<TaskListRow> = Vec::new();
    for id in &page.ids {
        if let Some(row) = matched.remove(id) {
            ordered.push(row);
            if ordered.len() as i64 >= limit {
                break;
            }
        }
    }

    // `get_tasks_related_data_batch` + `convert_to_task_dict_optimized`.
    assemble_items(state, user_id, &ordered, page.total).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn params_validate_like_the_source_query_constraints() {
        assert_eq!(
            TasksParams {
                page: None,
                limit: None
            }
            .validated()
            .unwrap(),
            (0, 10)
        );
        assert_eq!(
            TasksParams {
                page: Some(2),
                limit: Some(20)
            }
            .validated()
            .unwrap(),
            (20, 20)
        );
        assert!(
            TasksParams {
                page: Some(0),
                limit: None
            }
            .validated()
            .is_err()
        );
        assert!(
            TasksParams {
                page: None,
                limit: Some(101)
            }
            .validated()
            .is_err()
        );
        assert!(
            TasksParams {
                page: None,
                limit: Some(0)
            }
            .validated()
            .is_err()
        );
    }

    #[test]
    fn validation_error_body_is_a_query_entry() {
        let error = TasksParams {
            page: Some(0),
            limit: None,
        }
        .validated()
        .unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn display_filter_drops_delete_and_non_interacted_subscription() {
        let delete = CrdDocument::project(&json!({"status": {"status": "DELETE"}}));
        assert!(!is_displayable(&delete, &json!({})));
        let background = CrdDocument::project(
            &json!({"metadata": {"labels": {"source": "background_executor"}}}),
        );
        assert!(!is_displayable(&background, &json!({})));
        let plain = CrdDocument::project(&json!({"status": {"status": "RUNNING"}}));
        assert!(is_displayable(&plain, &json!({})));
    }
}

#[cfg(test)]
mod routing_tests {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    // A dedicated probe group carrying the literal `/api/tasks` sibling and the
    // `/api/tasks/:task_id` template, so the router exercises their dispatch
    // without the crate's real handlers.
    mod probe {
        brz_http_server::registry!(group = tasks_list_probe, dependencies());
    }

    #[brz_http_server::get("/api/tasks/:task_id", group = probe::tasks_list_probe, access = public)]
    async fn probe_detail(task_id: i64) -> String {
        format!("detail:{task_id}")
    }

    #[brz_http_server::get("/api/tasks", group = probe::tasks_list_probe, access = public)]
    async fn probe_list() -> &'static str {
        "list"
    }

    /// Drives the probe router over a real `http-server` socket.
    async fn serve(request: &str) -> String {
        let handler =
            brz_http_server::handlers!(; group = probe::tasks_list_probe).expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = TcpStream::connect(address).await.expect("connect");
        client.write_all(request.as_bytes()).await.expect("send");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    fn body_of(raw: &str) -> &str {
        raw.split_once("\r\n\r\n").map_or("", |(_, body)| body)
    }

    /// The exact `/api/tasks` path is served by the list handler, not the
    /// `:task_id` template.
    #[tokio::test]
    async fn the_exact_list_path_is_served_by_the_list_route() {
        let raw = serve(
            "GET /api/tasks HTTP/1.1\r\n\
             Host: localhost\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
        assert_eq!(body_of(&raw), "\"list\"");
    }

    /// A numeric id still resolves to the detail template.
    #[tokio::test]
    async fn a_numeric_id_still_resolves_to_the_detail_template() {
        let raw = serve(
            "GET /api/tasks/42 HTTP/1.1\r\n\
             Host: localhost\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
        assert_eq!(body_of(&raw), "\"detail:42\"");
    }
}
