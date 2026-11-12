// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Real HTTP and server-side byte evidence for bounded, fork-aware history.

use brz_mysql::{MysqlRow, MysqlService};
use serde_json::{Value, json};
use std::net::SocketAddr;

pub(super) const TOKEN: &str = "history-window-fixture-token";
const PAYLOAD_BYTES: usize = 64 * 1024;

pub(super) async fn assert_history_windows(
    client: &brz_http::Client,
    address: SocketAddr,
    mysql: &MysqlService,
    root: i64,
    table: &str,
    user_id: i32,
) {
    let fork = root + 1;
    let task_table = table.replacen("subtasks", "tasks", 1);
    super::seed_task(mysql, &task_table, fork, user_id + 1).await;
    mysql
        .execute(
            format!("UPDATE {task_table} SET json = ? WHERE id = ?"),
            (
                brz_mysql::Json(json!({"spec": {"fork": {
                    "sourceTaskId": root, "afterMessageId": 25, "rootTaskId": root,
                }}})),
                fork,
            ),
        )
        .await
        .unwrap();
    mysql
        .execute(
            format!("DELETE FROM {table} WHERE task_id IN (?, ?)"),
            (root, fork),
        )
        .await
        .unwrap();
    for message in 1..=30_i64 {
        let content = format!("row:{message}:{}", "x".repeat(PAYLOAD_BYTES));
        let result = match message {
            1 | 3 => json!({"messages_chain": [{
                "role": "user", "content": format!("summary:{message}:"),
                "additional_kwargs": {"summary_compacted": true},
            }]}),
            28 | 29 => json!({"messages_chain": [{
                "role": "assistant", "content": content,
                "additional_kwargs": {"summary_compacted":
                    if message == 28 { json!("true") } else { json!(1) }},
            }]}),
            _ => json!({"value": content}),
        };
        mysql
            .execute(
                format!(
                    "INSERT INTO {table} \
                (id,user_id,task_id,message_id,role,status,result,sender_user_id) \
                VALUES (?, ?, ?, ?, 'ASSISTANT', ?, ?, 0)"
                ),
                (
                    1000 + message,
                    user_id,
                    root,
                    message,
                    if message == 30 {
                        "PENDING"
                    } else {
                        "COMPLETED"
                    },
                    brz_mysql::Json(result),
                ),
            )
            .await
            .unwrap();
    }
    mysql
        .execute(
            format!(
                "INSERT INTO {table} \
            (id,user_id,task_id,message_id,role,status,result,sender_user_id) \
            VALUES (2001, ?, ?, 26, 'ASSISTANT', 'COMPLETED', ?, 0)"
            ),
            (
                user_id + 1,
                fork,
                brz_mysql::Json(json!({
                    "value": format!("row:26:{}", "x".repeat(PAYLOAD_BYTES)),
                })),
            ),
        )
        .await
        .unwrap();

    let cases = [
        (root, 20, false, None, (10..30).collect::<Vec<_>>()),
        (
            root,
            20,
            true,
            None,
            std::iter::once(3).chain(11..30).collect(),
        ),
        (
            fork,
            20,
            true,
            Some(26),
            std::iter::once(3).chain(7..26).collect(),
        ),
        (fork, 20, false, None, (7..27).collect()),
        (fork, 20, false, Some(26), (6..26).collect()),
        (root, 0, true, None, Vec::new()),
    ];
    for (task_id, limit, compacted, before, expected) in cases {
        let mut path = format!(
            "/api/internal/chat/history/task-{task_id}?limit={limit}\
             &from_latest_compaction={compacted}"
        );
        if let Some(before) = before {
            path.push_str(&format!("&before_message_id={before}"));
        }
        let start_bytes = bytes_sent(mysql).await;
        let response = client
            .get(format!("http://{address}{path}"))
            .unwrap()
            .header("authorization", format!("Bearer {TOKEN}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200, "{path}");
        let body: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
        let actual = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| {
                message["content"]
                    .as_str()
                    .unwrap()
                    .split(':')
                    .nth(1)
                    .unwrap()
                    .parse::<i64>()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(actual, expected, "{path}");
        // The fixture uses a single MySQL connection shared with the HTTP app.
        // Reading all 30 payloads then slicing returns > 24 payloads of bytes;
        // selected ids + at most 21 fork payloads stay below this bound.
        let transferred = bytes_sent(mysql).await - start_bytes;
        let budget = if limit == 0 {
            PAYLOAD_BYTES
        } else {
            24 * PAYLOAD_BYTES
        };
        assert!(
            transferred < budget as u64,
            "history read transferred {transferred} DB bytes (budget {budget}): {path}"
        );
    }
}

async fn bytes_sent(mysql: &MysqlService) -> u64 {
    let row: MysqlRow = mysql
        .fetch_optional("SHOW SESSION STATUS LIKE 'Bytes_sent'", ())
        .await
        .unwrap()
        .unwrap();
    row.get_required::<String>("Value")
        .unwrap()
        .parse()
        .unwrap()
}
