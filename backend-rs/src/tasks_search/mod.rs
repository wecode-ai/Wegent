// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/search` — fuzzy task-title search
//! (`app/api/endpoints/adapter/tasks.py:search_tasks_by_title` ->
//! `task_kinds_service.get_user_tasks_by_title_with_pagination`).
//!
//! Source pipeline: `task_store.list_owned_task_ids` (the current page's owned
//! active non-system tasks), `task_store.list_by_ids`, the title filter
//! (`filter_tasks_with_title_match`), `restore_task_order`,
//! `get_tasks_related_data_batch` (workspaces, teams, the user cache and the
//! group-chat member counts) and `convert_to_task_dict_optimized` restricted to
//! the `TaskInDB` response fields.
//!
//! This route is a literal sibling of `GET /api/tasks/{task_id}`. FastAPI
//! matches the literal `/search` first (declaration order), so the target
//! registers `/api/tasks/search` as a static route: the SDK router resolves
//! static paths before `:task_id` templates, so a non-numeric task id no longer
//! reaches the detail handler and its `i64` binding.

use std::sync::Arc;

use brz_http_server::Query;
use serde::Deserialize;
use serde_json::json;

use crate::crd::CrdDocument;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::tasks_db_projection::{
    TaskListResponse, TaskListRow, assemble_items, is_non_interacted_subscription, query_error,
    validate_page_limit,
};

pub mod statements;

/// `search_tasks_by_title`'s `extra_limit` for the owned-task page.
const EXTRA_LIMIT: i64 = 100;

/// `Query(..., min_length=1)`, `Query(1, ge=1)`, `Query(10, ge=1, le=100)`.
#[derive(Debug, Deserialize)]
pub struct SearchTasksParams {
    title: Option<String>,
    page: Option<i64>,
    limit: Option<i64>,
}

/// Validated `search_tasks_by_title` arguments.
pub(crate) struct ValidatedParams {
    pub(crate) title: String,
    pub(crate) skip: i64,
    pub(crate) limit: i64,
}

impl SearchTasksParams {
    fn validated(self) -> Result<ValidatedParams, FastApiError> {
        let title = match self.title {
            None => {
                return Err(query_error(
                    "missing",
                    "title",
                    "Field required",
                    json!({}),
                    None,
                ));
            }
            Some(title) if !title.is_empty() => title,
            Some(title) => {
                return Err(query_error(
                    "string_too_short",
                    "title",
                    "String should have at least 1 character",
                    json!({"min_length": 1}),
                    Some(json!(title)),
                ));
            }
        };
        let page_limit = validate_page_limit(self.page, self.limit)?;
        Ok(ValidatedParams {
            title,
            skip: page_limit.skip,
            limit: page_limit.limit,
        })
    }
}

/// GET /api/tasks/search: the search free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/tasks/search")]
async fn search_tasks_by_title(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] current_user: crate::auth::SessionUser,
    query: Query<SearchTasksParams>,
) -> Result<TaskListResponse, FastApiError> {
    let params = SearchTasksParams {
        title: query.title.clone(),
        page: query.page,
        limit: query.limit,
    }
    .validated()?;
    search_tasks(state, i64::from(current_user.id), &params)
        .await
        .map_err(|_| FastApiError::internal())
}

/// Handler body for `GET /api/tasks/search`.
async fn search_tasks(
    state: &Arc<AppState>,
    user_id: i64,
    params: &ValidatedParams,
) -> brz_mysql::MysqlResult<TaskListResponse> {
    use brz_mysql::FromMysqlRow as _;

    // `get_owned_task_ids_and_total`: the page's owned task ids plus the total.
    let page = state
        .task_store
        .list_owned_task_ids(user_id, params.skip, params.limit + EXTRA_LIMIT)
        .await?;

    // `load_tasks_by_ids`: the full rows of the page's ids.
    let raw = state.task_store.list_tasks_by_ids(&page.ids).await?;
    let rows = raw
        .into_iter()
        .map(TaskListRow::from_mysql_row)
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;

    // `filter_tasks_with_title_match` keeps the rows whose CRD title contains
    // the lowercased query. The source reports the matched-row count, not the
    // store total, so `total` is counted here.
    let title_lower = params.title.to_lowercase();
    let mut total = 0i64;
    let mut matched: std::collections::HashMap<i64, TaskListRow> = std::collections::HashMap::new();
    for row in rows {
        let crd = CrdDocument::project(&row.json);
        let status = crd
            .status
            .as_ref()
            .and_then(|status| status.status.as_deref())
            .unwrap_or("PENDING");
        if status == "DELETE" {
            continue;
        }
        let task_title = crd
            .spec
            .as_ref()
            .and_then(|spec| spec.title.as_ref())
            .map(|title| {
                title
                    .to_value()
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        if !task_title.to_lowercase().contains(&title_lower) {
            continue;
        }
        if is_non_interacted_subscription(&crd, &row.json) {
            continue;
        }
        total += 1;
        matched.insert(row.id, row);
    }

    // `restore_task_order(task_ids, id_to_task, limit)`.
    let mut ordered: Vec<TaskListRow> = Vec::new();
    for id in &page.ids {
        if let Some(row) = matched.remove(id) {
            ordered.push(row);
            if ordered.len() as i64 >= params.limit {
                break;
            }
        }
    }

    // `get_tasks_related_data_batch` + `convert_to_task_dict_optimized`.
    assemble_items(state, user_id, &ordered, total).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_validate_like_the_source_query_constraints() {
        let params = SearchTasksParams {
            title: Some("vdbench".into()),
            page: Some(1),
            limit: Some(20),
        }
        .validated()
        .unwrap();
        assert_eq!(params.title, "vdbench");
        assert_eq!(params.skip, 0);
        assert_eq!(params.limit, 20);

        assert!(
            SearchTasksParams {
                title: None,
                page: None,
                limit: None
            }
            .validated()
            .is_err()
        );
        assert!(
            SearchTasksParams {
                title: Some(String::new()),
                page: None,
                limit: None
            }
            .validated()
            .is_err()
        );
        assert!(
            SearchTasksParams {
                title: Some("x".into()),
                page: Some(0),
                limit: None
            }
            .validated()
            .is_err()
        );
        assert!(
            SearchTasksParams {
                title: Some("x".into()),
                page: None,
                limit: Some(101)
            }
            .validated()
            .is_err()
        );
    }
}

#[cfg(test)]
mod routing_tests {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    // A dedicated probe group carrying both the detail template and the literal
    // search sibling, so the router exercises their precedence without the
    // crate's real handlers.
    mod probe {
        brz_http_server::registry!(group = tasks_search_probe, dependencies());
    }

    #[brz_http_server::get(
        "/api/tasks/:task_id",
        group = probe::tasks_search_probe,
        access = public
    )]
    async fn probe_detail(task_id: i64) -> String {
        format!("detail:{task_id}")
    }

    #[brz_http_server::get(
        "/api/tasks/search",
        group = probe::tasks_search_probe,
        access = public
    )]
    async fn probe_search() -> &'static str {
        "search"
    }

    /// Drives the probe router over a real `http-server` socket.
    async fn serve(request: &str) -> String {
        let handler =
            brz_http_server::handlers!(; group = probe::tasks_search_probe).expect("probe router");
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

    /// The recorded failure: `/api/tasks/search` reached the `:task_id` template,
    /// whose `i64` binding rejected the literal segment with `400`. The static
    /// route must win so the source's declaration order is reproduced.
    #[tokio::test]
    async fn the_literal_search_route_wins_over_the_task_id_template() {
        let raw = serve(
            "GET /api/tasks/search?title=vdbench HTTP/1.1\r\n\
             Host: localhost\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
        assert_eq!(body_of(&raw), "\"search\"");
    }

    /// A numeric id still resolves to the template.
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
