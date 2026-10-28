// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/search` — fuzzy task-title search
//! (`app/api/endpoints/adapter/tasks.py:search_tasks_by_title` ->
//! `task_kinds_service.get_user_tasks_by_title_with_pagination`).
//!
//! The source filters titles before pagination. Because a deployment's task
//! store may span multiple physical tables, this handler scans bounded
//! owned-task pages, counts every title match, and only then restores the
//! requested page before running the shared related-data projection.
//!
//! This route is a literal sibling of `GET /api/tasks/{task_id}`. FastAPI
//! matches the literal `/search` first (declaration order), so the target
//! registers `/api/tasks/search` as a static route: the SDK router resolves
//! static paths before `:task_id` templates, so a non-numeric task id no longer
//! reaches the detail handler and its `i64` binding.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use brz_http_server::Query;
use brz_mysql::{FromMysqlRow as _, MysqlResult};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::crd::CrdDocument;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::task_store::TaskStore;
use crate::tasks_db_projection::{
    TaskListResponse, TaskListRow, assemble_items, is_non_interacted_subscription, query_error,
    validate_page_limit,
};

pub mod statements;

#[cfg(test)]
#[path = "mysql_tests.rs"]
mod mysql_tests;

/// Bound each owned-task read while scanning for title matches.
const SEARCH_SCAN_BATCH_SIZE: i64 = 200;

struct TaskSearchCandidate {
    id: i64,
    json: Value,
}

struct OwnedTaskSearchBatch {
    total: i64,
    scanned: i64,
    tasks: Vec<TaskSearchCandidate>,
}

struct OwnedTaskSearchResult {
    total: i64,
    ids: Vec<i64>,
}

#[async_trait]
trait OwnedTaskSearchSource: Sync {
    async fn batch(&self, user_id: i64, skip: i64, limit: i64)
    -> MysqlResult<OwnedTaskSearchBatch>;
}

struct StoreOwnedTaskSearchSource<'a> {
    store: &'a dyn TaskStore,
}

#[async_trait]
impl OwnedTaskSearchSource for StoreOwnedTaskSearchSource<'_> {
    async fn batch(
        &self,
        user_id: i64,
        skip: i64,
        limit: i64,
    ) -> MysqlResult<OwnedTaskSearchBatch> {
        let page = self.store.list_owned_task_ids(user_id, skip, limit).await?;
        let raw = self.store.list_tasks_by_ids(&page.ids).await?;
        let candidates = raw
            .into_iter()
            .map(TaskListRow::from_mysql_row)
            .collect::<MysqlResult<Vec<_>>>()?
            .into_iter()
            .map(|row| {
                (
                    row.id,
                    TaskSearchCandidate {
                        id: row.id,
                        json: row.json,
                    },
                )
            })
            .collect();
        Ok(OwnedTaskSearchBatch {
            total: page.total,
            scanned: page.ids.len() as i64,
            tasks: order_by_page(&page.ids, candidates),
        })
    }
}

/// `list_tasks_by_ids` only filters by `id IN (...)`, so rows arrive in
/// storage order. Restore the store's newest-first page order before the
/// caller counts matches and slices the requested page, otherwise a page of
/// matches is selected from the wrong rows.
fn order_by_page(ids: &[i64], rows: Vec<(i64, TaskSearchCandidate)>) -> Vec<TaskSearchCandidate> {
    let mut by_id: HashMap<i64, TaskSearchCandidate> = rows.into_iter().collect();
    ids.iter().filter_map(|id| by_id.remove(id)).collect()
}

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
    let source = StoreOwnedTaskSearchSource {
        store: state.task_store.as_ref(),
    };
    let matched =
        search_owned_task_ids(&source, user_id, &params.title, params.skip, params.limit).await?;

    let raw = state.task_store.list_tasks_by_ids(&matched.ids).await?;
    let rows = raw
        .into_iter()
        .map(TaskListRow::from_mysql_row)
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()?;

    let mut by_id: HashMap<i64, TaskListRow> = rows.into_iter().map(|row| (row.id, row)).collect();
    let mut ordered: Vec<TaskListRow> = Vec::new();
    for id in &matched.ids {
        if let Some(row) = by_id.remove(id) {
            ordered.push(row);
        }
    }

    assemble_items(state, user_id, &ordered, matched.total).await
}

/// Match titles across the user's complete owned-task history before applying
/// the requested page. Stores may own multiple physical task tables, so scan
/// through their stable owned-task pages rather than applying a fixed window.
async fn search_owned_task_ids<S: OwnedTaskSearchSource + ?Sized>(
    source: &S,
    user_id: i64,
    title: &str,
    skip: i64,
    limit: i64,
) -> MysqlResult<OwnedTaskSearchResult> {
    let title_lower = title.to_lowercase();
    let selected_end = skip.saturating_add(limit);
    let mut matched_total = 0i64;
    let mut ids = Vec::new();
    let mut offset = 0i64;

    loop {
        let batch = source
            .batch(user_id, offset, SEARCH_SCAN_BATCH_SIZE)
            .await?;
        if batch.scanned == 0 {
            break;
        }
        for task in &batch.tasks {
            if !task_matches_title(task, &title_lower) {
                continue;
            }
            if matched_total >= skip && matched_total < selected_end {
                ids.push(task.id);
            }
            matched_total += 1;
        }
        offset += batch.scanned;
        if offset >= batch.total {
            break;
        }
    }

    Ok(OwnedTaskSearchResult {
        total: matched_total,
        ids,
    })
}

fn task_matches_title(task: &TaskSearchCandidate, title_lower: &str) -> bool {
    let crd = CrdDocument::project(&task.json);
    let status = crd
        .status
        .as_ref()
        .and_then(|status| status.status.as_deref())
        .unwrap_or("PENDING");
    if status == "DELETE" || is_non_interacted_subscription(&crd, &task.json) {
        return false;
    }
    crd.spec
        .as_ref()
        .and_then(|spec| spec.title.as_ref())
        .and_then(|title| title.to_value().as_str().map(str::to_owned))
        .is_some_and(|title| title.to_lowercase().contains(title_lower))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeOwnedTaskSearchSource {
        tasks: Vec<TaskSearchCandidate>,
    }

    #[async_trait]
    impl OwnedTaskSearchSource for FakeOwnedTaskSearchSource {
        async fn batch(
            &self,
            _user_id: i64,
            skip: i64,
            limit: i64,
        ) -> MysqlResult<OwnedTaskSearchBatch> {
            let start = usize::try_from(skip).unwrap().min(self.tasks.len());
            let end = start
                .saturating_add(usize::try_from(limit).unwrap())
                .min(self.tasks.len());
            Ok(OwnedTaskSearchBatch {
                total: self.tasks.len() as i64,
                scanned: (end - start) as i64,
                tasks: self.tasks[start..end]
                    .iter()
                    .map(|task| TaskSearchCandidate {
                        id: task.id,
                        json: task.json.clone(),
                    })
                    .collect(),
            })
        }
    }

    fn search_candidate(id: i64, title: &str) -> TaskSearchCandidate {
        TaskSearchCandidate {
            id,
            json: json!({
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Task",
                "metadata": {
                    "name": format!("task-{id}"),
                    "namespace": "default"
                },
                "spec": { "title": title },
                "status": { "status": "COMPLETED" }
            }),
        }
    }

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

    #[tokio::test]
    async fn title_matches_are_found_beyond_the_first_scan_batch() {
        let mut tasks = (0..451)
            .map(|index| search_candidate(1_000 + index, &format!("recent task {index}")))
            .collect::<Vec<_>>();
        tasks[405] = search_candidate(1_405, "云主机安装embedding");
        tasks[430] = search_candidate(1_430, "云主机 CPU 验证");
        let source = FakeOwnedTaskSearchSource { tasks };

        let first = search_owned_task_ids(&source, 1555, "云主机", 0, 1)
            .await
            .unwrap();
        assert_eq!(first.total, 2);
        assert_eq!(first.ids, vec![1_405]);

        let second = search_owned_task_ids(&source, 1555, "云主机", 1, 1)
            .await
            .unwrap();
        assert_eq!(second.total, 2);
        assert_eq!(second.ids, vec![1_430]);
    }

    #[tokio::test]
    async fn title_matching_is_case_insensitive() {
        let source = FakeOwnedTaskSearchSource {
            tasks: vec![search_candidate(7, "Cloud Host Embedding Setup")],
        };

        let result = search_owned_task_ids(&source, 1555, "embedding", 0, 20)
            .await
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.ids, vec![7]);
    }

    struct PageOnlyOwnedTaskSearchSource {
        page_size: i64,
        total: i64,
        matched_task: TaskSearchCandidate,
    }

    #[async_trait]
    impl OwnedTaskSearchSource for PageOnlyOwnedTaskSearchSource {
        async fn batch(
            &self,
            _user_id: i64,
            skip: i64,
            _limit: i64,
        ) -> MysqlResult<OwnedTaskSearchBatch> {
            if skip == 0 {
                return Ok(OwnedTaskSearchBatch {
                    total: self.total,
                    scanned: self.page_size,
                    tasks: Vec::new(),
                });
            }
            Ok(OwnedTaskSearchBatch {
                total: self.total,
                scanned: 1,
                tasks: vec![TaskSearchCandidate {
                    id: self.matched_task.id,
                    json: self.matched_task.json.clone(),
                }],
            })
        }
    }

    #[tokio::test]
    async fn advances_by_scanned_ids_when_page_rows_are_missing() {
        let source = PageOnlyOwnedTaskSearchSource {
            page_size: SEARCH_SCAN_BATCH_SIZE,
            total: SEARCH_SCAN_BATCH_SIZE + 1,
            matched_task: search_candidate(9, "must be found"),
        };

        let result = search_owned_task_ids(&source, 1555, "must be found", 0, 20)
            .await
            .unwrap();

        assert_eq!(result.total, 1);
        assert_eq!(result.ids, vec![9]);
    }

    #[test]
    fn restores_the_page_order_when_the_store_returns_rows_unsorted() {
        let rows = vec![
            (7, search_candidate(7, "oldest")),
            (30, search_candidate(30, "newest")),
            (12, search_candidate(12, "middle")),
        ];

        let ordered = order_by_page(&[30, 12, 7], rows);

        assert_eq!(
            ordered.iter().map(|task| task.id).collect::<Vec<_>>(),
            vec![30, 12, 7]
        );
    }

    #[test]
    fn keeps_one_entry_when_a_task_row_repeats_across_tables() {
        let rows = vec![
            (9, search_candidate(9, "once")),
            (9, search_candidate(9, "once")),
        ];

        assert_eq!(order_by_page(&[9], rows).len(), 1);
    }

    /// Mirrors the production source: the id page is newest first while
    /// `list_tasks_by_ids` only filters by id and returns storage order.
    struct StorageOrderedOwnedTaskSearchSource {
        page_order: Vec<i64>,
        storage: Vec<(i64, TaskSearchCandidate)>,
    }

    #[async_trait]
    impl OwnedTaskSearchSource for StorageOrderedOwnedTaskSearchSource {
        async fn batch(
            &self,
            _user_id: i64,
            skip: i64,
            limit: i64,
        ) -> MysqlResult<OwnedTaskSearchBatch> {
            let start = usize::try_from(skip).unwrap().min(self.page_order.len());
            let end = start
                .saturating_add(usize::try_from(limit).unwrap())
                .min(self.page_order.len());
            let ids = &self.page_order[start..end];
            let mut rows = self
                .storage
                .iter()
                .filter(|(id, _)| ids.contains(id))
                .map(|(id, task)| {
                    (
                        *id,
                        TaskSearchCandidate {
                            id: task.id,
                            json: task.json.clone(),
                        },
                    )
                })
                .collect::<Vec<_>>();
            rows.sort_by_key(|(id, _)| *id);
            Ok(OwnedTaskSearchBatch {
                total: self.page_order.len() as i64,
                scanned: ids.len() as i64,
                tasks: order_by_page(ids, rows),
            })
        }
    }

    /// Every task in a batch matches; storage returns them in ascending id
    /// order, the opposite of the newest-first id page. The selected page must
    /// still be the newest matches.
    #[tokio::test]
    async fn selects_the_newest_matches_when_storage_order_is_ascending() {
        let page_order = (0..30).rev().map(|index| 1_000 + index).collect::<Vec<_>>();
        let storage = page_order
            .iter()
            .rev()
            .map(|id| (*id, search_candidate(*id, "云主机安装")))
            .collect::<Vec<_>>();
        let source = StorageOrderedOwnedTaskSearchSource {
            page_order,
            storage,
        };

        let first = search_owned_task_ids(&source, 1555, "云主机", 0, 20)
            .await
            .unwrap();
        assert_eq!(first.total, 30);
        assert_eq!(
            first.ids,
            (0..20).rev().map(|index| 1_010 + index).collect::<Vec<_>>()
        );

        let second = search_owned_task_ids(&source, 1555, "云主机", 20, 20)
            .await
            .unwrap();
        assert_eq!(second.total, 30);
        assert_eq!(
            second.ids,
            (0..10).rev().map(|index| 1_000 + index).collect::<Vec<_>>()
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
