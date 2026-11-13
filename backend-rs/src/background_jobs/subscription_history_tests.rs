//! Exercise the production preparation and cold-cache reads on a recorded handle.
use super::history;
use crate::{
    request_sql::{RequestSql, RouteKey, StatementArgs},
    responses::create::session::load_existing_subtasks,
    sql_test_support::KindQueryCapture,
    task_store::DefaultTaskStore,
    task_store_statements::StatementArg,
};
use brz_mysql::{MysqlExecution, MysqlResult, MysqlRow};

#[derive(Default)]
struct RecordedSql {
    calls: Vec<(RouteKey, String, StatementArgs)>,
}

#[async_trait::async_trait]
impl RequestSql for RecordedSql {
    async fn execute_statement(
        &mut self,
        _route: RouteKey,
        _statement: &str,
        _arguments: StatementArgs,
    ) -> MysqlResult<MysqlExecution> {
        panic!("History reads must not write");
    }

    async fn fetch_optional_row(
        &mut self,
        route: RouteKey,
        statement: &str,
        arguments: StatementArgs,
    ) -> MysqlResult<Option<MysqlRow>> {
        self.calls.push((route, statement.into(), arguments));
        Ok(None)
    }

    async fn fetch_all_rows(
        &mut self,
        route: RouteKey,
        statement: &str,
        arguments: StatementArgs,
    ) -> MysqlResult<Vec<MysqlRow>> {
        self.calls.push((route, statement.into(), arguments));
        Ok(Vec::new())
    }
}

fn assert_window(sql: &RecordedSql, limit: i64, before: Option<i64>) {
    if limit == 0 {
        assert!(sql.calls.is_empty(), "{:?}", sql.calls);
        return;
    }
    // No candidates means the production store must skip the payload query.
    assert_eq!(sql.calls.len(), 1, "{:?}", sql.calls);
    let (route, statement, args) = &sql.calls[0];
    assert_eq!(*route, RouteKey::Task(123));
    assert!(statement.starts_with("SELECT id, message_id, created_at FROM subtasks"));
    assert!(statement.contains("SELECT id FROM tasks WHERE id = ? AND user_id = ?"));
    assert!(statement.ends_with("ORDER BY message_id DESC, created_at DESC, id DESC LIMIT ?"));
    assert_eq!(statement.contains("AND message_id < ?"), before.is_some());
    let expected: Vec<_> = [123, 123, 7]
        .into_iter()
        .chain(before)
        .chain([limit])
        .collect();
    let integers: Vec<_> = args
        .iter()
        .map(|arg| match arg {
            StatementArg::Int(value) => *value,
            other => panic!("Unexpected history argument: {other:?}"),
        })
        .collect();
    assert_eq!(integers, expected);
}

#[tokio::test]
async fn subscription_preparation_bounds_the_production_read() {
    let store = DefaultTaskStore::new(KindQueryCapture::default());
    for limit in [0, 1, 10, 20, 50] {
        let mut sql = RecordedSql::default();
        assert!(
            load_existing_subtasks(&store, &mut sql, 123, 7, Some(limit))
                .await
                .unwrap()
                .is_empty()
        );
        assert_window(&sql, limit, None);
        for (_, statement, _) in &sql.calls {
            assert!(!statement.contains("status"));
            assert!(!statement.contains("result"));
        }
    }
}

#[tokio::test]
async fn subscription_cold_cache_bounds_the_production_read_before_loading_payloads() {
    let store = DefaultTaskStore::new(KindQueryCapture::default());
    for limit in [0, 1, 10, 20, 50] {
        let mut sql = RecordedSql::default();
        assert!(
            history::load_entries(&store, &mut sql, 123, 7, 30, limit)
                .await
                .unwrap()
                .is_empty()
        );
        assert_window(&sql, limit, Some(30));
        for (_, statement, _) in &sql.calls {
            assert!(statement.contains("status = 'COMPLETED'"));
            assert!(statement.contains("role = 'USER' AND OCTET_LENGTH(prompt) > 0"));
            assert!(statement.contains("JSON_TYPE(JSON_EXTRACT(result, '$.value')) = 'STRING'"));
        }
    }
}

#[tokio::test]
async fn ordinary_preparation_keeps_its_unbounded_listing() {
    let store = DefaultTaskStore::new(KindQueryCapture::default());
    let mut sql = RecordedSql::default();
    assert!(
        load_existing_subtasks(&store, &mut sql, 123, 7, None)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(!sql.calls.is_empty());
    assert!(
        sql.calls
            .iter()
            .any(|(_, statement, _)| statement.contains("FROM subtasks"))
    );
    for (route, statement, _) in &sql.calls {
        assert_eq!(*route, RouteKey::Task(123));
        assert!(!statement.contains("LIMIT"));
        assert!(!statement.contains("SELECT id, message_id, created_at"));
    }
}
