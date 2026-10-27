// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Disposable MySQL fixture shared by the base-table and routed-store regressions.

use brz_mysql::{Json, MysqlResult, MysqlRow, MysqlService, MysqlServiceOptions};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use wegent_backend_rs::task_store::TaskStore;

pub const LARGE_RESULT_BYTES: usize = 20 * 1024 * 1024;
pub const LONG_CONVERSATION_ROWS: usize = 65_536;

pub struct Fixture {
    admin: MysqlService,
    pub mysql: MysqlService,
    database: String,
}

impl Fixture {
    pub async fn new() -> Self {
        let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")
            .expect("set WEGENT_TEST_MYSQL_ADDRESS to the disposable MySQL 8 fixture");
        let address: std::net::SocketAddr = address.parse().expect("numeric loopback address");
        assert!(
            address.ip().is_loopback(),
            "only a disposable loopback fixture is allowed"
        );
        let admin =
            MysqlService::connect(&format!("mysql://root@{address}/mysql?ssl-mode=disabled"))
                .await
                .unwrap();
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let database = format!("responses_json_{}_{unique}", std::process::id());
        admin
            .execute(format!("CREATE DATABASE {database}"), ())
            .await
            .unwrap();
        // One connection keeps the session sort buffer deterministic for every read.
        let mysql = MysqlService::connect_lazy_with_options(
            &format!("mysql://root@{address}/{database}?ssl-mode=disabled"),
            MysqlServiceOptions::default()
                .with_max_connections(1)
                .with_query_timeout(Duration::from_secs(10)),
        )
        .unwrap();
        mysql
            .execute("SET SESSION sort_buffer_size = 262144", ())
            .await
            .unwrap();
        Self {
            admin,
            mysql,
            database,
        }
    }

    async fn create_subtasks_table(&self, table: &str) {
        self.mysql
            .execute(
                format!(
                    "CREATE TABLE {table} (
                id BIGINT PRIMARY KEY, user_id INT NOT NULL, task_id BIGINT NOT NULL,
                team_id BIGINT DEFAULT 0, title VARCHAR(100) DEFAULT '',
                bot_ids JSON, role VARCHAR(20) DEFAULT 'ASSISTANT',
                executor_namespace VARCHAR(100) DEFAULT '',
                executor_name VARCHAR(100) DEFAULT '', executor_deleted_at DATETIME,
                prompt TEXT, message_id BIGINT, parent_id BIGINT DEFAULT 0,
                status VARCHAR(20) DEFAULT 'COMPLETED', progress INT DEFAULT 100,
                result JSON, error_message TEXT,
                created_at DATETIME DEFAULT '2026-01-01 00:00:00',
                updated_at DATETIME DEFAULT '2026-01-01 00:00:00',
                completed_at DATETIME, sender_type VARCHAR(20) DEFAULT 'user',
                sender_user_id INT, reply_to_subtask_id BIGINT,
                INDEX idx_task_id (task_id), INDEX idx_user_id (user_id)
            ) ENGINE=InnoDB"
                ),
                (),
            )
            .await
            .unwrap();
    }

    pub async fn seed(&self, table: &str, task_id: i64, user_id: i32) {
        self.create_subtasks_table(table).await;
        for (id, owner, task, message, size) in [
            (20_i64, user_id, task_id, 1_i64, 4_usize),
            (10, user_id, task_id, 2, LARGE_RESULT_BYTES),
            (30, user_id + 1, task_id, 0, 4),
            (40, user_id, task_id + 1, 0, 4),
        ] {
            self.mysql
                .execute(
                    format!(
                        "INSERT INTO {table}
                    (id,user_id,task_id,message_id,result)
                    VALUES (?,?,?,?,JSON_OBJECT('value',REPEAT('x',?)))"
                    ),
                    (id, owner, task, message, size as i64),
                )
                .await
                .unwrap();
        }
    }

    pub async fn assert_original_query_fails(&self, table: &str, task_id: i64, user_id: i32) {
        // Keep the original query here so a server/version that stops reproducing
        // the defect cannot silently turn this into a passing regression.
        let result: MysqlResult<Vec<MysqlRow>> = self
            .mysql
            .fetch_all(
                format!(
                    "SELECT id,user_id,task_id,team_id,title,bot_ids,role,
                    executor_namespace,executor_name,executor_deleted_at,prompt,
                    message_id,parent_id,status,progress,result,error_message,
                    created_at,updated_at,completed_at,sender_type,sender_user_id,
                    reply_to_subtask_id FROM {table}
                WHERE task_id = ? AND user_id = ? ORDER BY message_id ASC"
                ),
                (task_id, user_id),
            )
            .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("the full JSON filesort must reproduce MySQL 1038"),
        };
        assert!(error.to_string().contains("1038"), "{error}");
        assert!(error.to_string().contains("Out of sort memory"), "{error}");
    }

    pub async fn seed_long_conversation(&self, table: &str, task_id: i64, user_id: i32) {
        self.create_subtasks_table(table).await;
        // Five decimal digits avoid recursive-CTE limits and bind no row ids.
        let digit = "(SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 \
                     UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 \
                     UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
        self.mysql
            .execute(
                format!(
                    "INSERT INTO {table} (id,user_id,task_id,message_id,result)
             SELECT n+1,?,?,{LONG_CONVERSATION_ROWS}-n,
                    JSON_OBJECT('value',CONCAT('row:',?,':',n+1))
             FROM (SELECT a.n+10*b.n+100*c.n+1000*d.n+10000*e.n AS n
                   FROM {digit} a CROSS JOIN {digit} b CROSS JOIN {digit} c
                   CROSS JOIN {digit} d CROSS JOIN {digit} e) seq
             WHERE n < {LONG_CONVERSATION_ROWS}"
                ),
                (user_id, task_id, task_id),
            )
            .await
            .unwrap();
        for (id, owner, task) in [
            (70_001_i64, user_id + 1, task_id),
            (70_002, user_id, task_id + 1),
        ] {
            self.mysql
                .execute(
                    format!(
                        "INSERT INTO {table} (id,user_id,task_id,message_id,result)
                 VALUES (?,?,?,0,JSON_OBJECT('value','excluded'))"
                    ),
                    (id, owner, task),
                )
                .await
                .unwrap();
        }
    }

    pub async fn close(self) {
        self.mysql.close().await;
        self.admin
            .execute(format!("DROP DATABASE {}", self.database), ())
            .await
            .unwrap();
        self.admin.close().await;
    }
}

pub async fn assert_long_conversation_read(
    store: &dyn TaskStore,
    task_id: i64,
    user_id: i32,
) -> MysqlResult<()> {
    let rows = store.list_subtasks_for_user(task_id, user_id).await?;
    assert_eq!(rows.len(), LONG_CONVERSATION_ROWS);
    for (index, row) in rows.iter().enumerate() {
        let id = (LONG_CONVERSATION_ROWS - index) as i64;
        assert_eq!(row.get_required::<i64>("id")?, id);
        assert_eq!(row.get_required::<i64>("message_id")?, index as i64 + 1);
        assert_eq!(row.get_required::<i64>("task_id")?, task_id);
        assert_eq!(row.get_required::<i32>("user_id")?, user_id);
        let result: Json<serde_json::Value> = row.get_required("result")?;
        assert_eq!(result.0["value"], format!("row:{task_id}:{id}"));
    }
    assert!(
        store
            .list_subtasks_for_user(task_id, user_id + 2)
            .await?
            .is_empty()
    );
    assert!(
        store
            .list_subtasks_for_user(task_id + 2, user_id)
            .await?
            .is_empty()
    );
    Ok(())
}

pub async fn assert_large_json_read(
    store: &dyn TaskStore,
    task_id: i64,
    user_id: i32,
) -> MysqlResult<()> {
    let rows = store.list_subtasks_for_user(task_id, user_id).await?;
    let ids = rows
        .iter()
        .map(|row| row.get_required::<i64>("id"))
        .collect::<MysqlResult<Vec<_>>>()?;
    // Primary-key order is 10,20; message order is 20,10. The second read must
    // restore the first read's order, and must exclude the other task/user.
    assert_eq!(ids, [20, 10]);
    // Base and partition fixtures deliberately reuse ids. Check task identity
    // too, so a second read routed to the wrong table cannot pass by accident.
    for row in &rows {
        assert_eq!(row.get_required::<i64>("task_id")?, task_id);
        assert_eq!(row.get_required::<i32>("user_id")?, user_id);
    }
    let result: Json<serde_json::Value> = rows[1].get_required("result")?;
    assert_eq!(
        result.0["value"].as_str().unwrap().len(),
        LARGE_RESULT_BYTES
    );
    assert!(
        store
            .list_subtasks_for_user(task_id, user_id + 2)
            .await?
            .is_empty()
    );
    assert!(
        store
            .list_subtasks_for_user(task_id + 2, user_id)
            .await?
            .is_empty()
    );
    Ok(())
}
