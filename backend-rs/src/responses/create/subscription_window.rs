// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Subscription continuation and retry share the scheduler's history bounds.

use crate::request_sql::{RequestSql, RouteKey};
use crate::sql_support::StatementArg;
use brz_mysql::{Json, MysqlResult};
use serde_json::Value;

pub(crate) fn is_subscription(task: &Value) -> bool {
    task.pointer("/metadata/labels/type")
        .and_then(Value::as_str)
        == Some("subscription")
}

pub(crate) async fn resolve_on(
    sql: &mut dyn RequestSql,
    task: &Value,
    user_id: i64,
    requested: Option<i64>,
    retained_subscription: bool,
) -> MysqlResult<Option<i64>> {
    if !retained_subscription && !is_subscription(task) {
        return Ok(requested);
    }
    if let Some(limit) = requested {
        return Ok(Some(limit.clamp(0, 50)));
    }
    let id = task
        .pointer("/metadata/labels/subscriptionId")
        .and_then(Value::as_str)
        .and_then(|id| id.parse::<i64>().ok());
    let Some(id) = id else {
        return Ok(Some(10));
    };
    let row = sql
        .fetch_optional_row(
            RouteKey::None,
            "SELECT json FROM kinds WHERE id = ? AND user_id = ? AND kind = 'Subscription' LIMIT 1",
            vec![StatementArg::Int(id), StatementArg::Int(user_id)],
        )
        .await?;
    let Some(row) = row else {
        return Ok(Some(10));
    };
    let document = row.get_required::<Json<Value>>("json")?.0;
    Ok(Some(spec_limit(&document["spec"])))
}

fn spec_limit(spec: &Value) -> i64 {
    if spec["preserveHistory"] == true {
        spec["historyMessageCount"]
            .as_i64()
            .unwrap_or(10)
            .clamp(0, 50)
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn windows_keep_disabled_history_empty_and_cap_invalid_stored_counts() {
        assert_eq!(spec_limit(&json!({"historyMessageCount": 10000})), 0);
        for (count, expected) in [(0, 0), (-1, 0), (20, 20), (10000, 50)] {
            assert_eq!(
                spec_limit(&json!({"preserveHistory":true,"historyMessageCount":count})),
                expected
            );
        }
        assert_eq!(spec_limit(&json!({"preserveHistory":true})), 10);
        assert!(!is_subscription(&json!({"metadata":{"labels":{}}})));
    }

    #[tokio::test]
    async fn retained_subscription_flag_bounds_legacy_tasks_without_type_labels() {
        use crate::sql_test_support::mysql_rows::MysqlRows;

        let fixture = MysqlRows::start_results(|_| panic!("no configuration read expected")).await;
        let task = json!({"metadata":{"labels":{}}});
        let mut sql = &fixture.mysql;
        assert_eq!(
            resolve_on(&mut sql, &task, 7, None, false).await.unwrap(),
            None
        );
        assert_eq!(
            resolve_on(&mut sql, &task, 7, Some(10000), false)
                .await
                .unwrap(),
            Some(10000)
        );
        assert_eq!(
            resolve_on(&mut sql, &task, 7, None, true).await.unwrap(),
            Some(10)
        );
        assert_eq!(
            resolve_on(&mut sql, &task, 7, Some(10000), true)
                .await
                .unwrap(),
            Some(50)
        );
        assert_eq!(
            resolve_on(&mut sql, &task, 7, Some(0), true).await.unwrap(),
            Some(0)
        );
        assert!(fixture.queries().is_empty());
    }
}
