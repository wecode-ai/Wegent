use super::*;
use crate::sql_test_support::mysql_rows::{MysqlRows, Value as Column};
use brz_mysql::{
    MysqlArgs, MysqlError, MysqlExecution, MysqlIsolationLevel, MysqlTransactionOptions,
};

async fn writer_service(mysql: &MysqlService) -> Result<MysqlService> {
    #[derive(FromMysqlRow)]
    struct Schema {
        name: String,
    }
    let schema: Schema = mysql.fetch_one("SELECT DATABASE() AS name", ()).await?;
    let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")?;
    Ok(crate::migrations::connect(&format!(
        "mysql://root@{address}/{}?ssl-mode=disabled",
        schema.name
    ))?)
}

pub(crate) async fn verify_concurrent_completion(mysql: &MysqlService) -> Result<()> {
    #[derive(FromMysqlRow)]
    struct Count {
        n: i64,
    }
    let writer = writer_service(mysql).await?;
    let definitions = definitions()?;
    let options = MysqlTransactionOptions::default()
        .with_isolation_level(MysqlIsolationLevel::RepeatableRead);
    let result = mysql
        .with_transaction_options(options, async |tx| {
            // Establish a snapshot before another initializer commits.
            let before: Count = tx
                .fetch_one(
                    "SELECT COUNT(*) AS n FROM system_configs WHERE config_key=?",
                    (COMPLETION_KEY,),
                )
                .await?;
            assert_eq!(before.n, 0);
            writer
                .with_transaction(async |tx| apply_transaction(tx, &definitions).await)
                .await?;
            apply_transaction(tx, &definitions).await
        })
        .await;
    writer.close().await;
    result?;
    let apps: Count = mysql
        .fetch_one(
            "SELECT COUNT(*) AS n FROM kinds WHERE kind='ConnectorApp' AND namespace='system' AND user_id=0",
            (),
        )
        .await?;
    assert_eq!(apps.n, 4);
    Ok(())
}

pub(crate) async fn verify_admin_edits_during_backfill(mysql: &MysqlService) -> Result<()> {
    mysql
        .execute(
            "DELETE FROM system_configs WHERE config_key=?",
            (COMPLETION_KEY,),
        )
        .await?;
    mysql.execute("UPDATE kinds SET json=JSON_REMOVE(json,'$.spec.builtinToolLoadingMode','$.spec.builtinKeywordsSeeded') WHERE user_id=0 AND kind='ConnectorApp' AND name='dingtalk_docs' AND namespace='system'", ()).await?;
    let definitions = definitions()?;
    let writer = writer_service(mysql).await?;
    let options = MysqlTransactionOptions::default()
        .with_isolation_level(MysqlIsolationLevel::RepeatableRead);
    let result = mysql
        .with_transaction_options(options, async |tx| {
            // An administrator commits after the initializer establishes its snapshot.
            let before = crate::initialization::kind(tx, "ConnectorApp", "dingtalk_docs", "system")
                .await?.unwrap();
            assert_eq!(before.payload.0["spec"]["enabled"], true);
            assert_eq!(before.payload.0["spec"]["toolAllowlist"], json!([]));
            writer.with_transaction(async |tx| {
                tx.execute("UPDATE kinds SET json=JSON_SET(json,'$.spec.enabled',false,'$.spec.toolAllowlist',JSON_ARRAY('admin-tool')),updated_at=NOW() WHERE user_id=0 AND kind='ConnectorApp' AND name='dingtalk_docs' AND namespace='system'", ()).await?;
                Ok(())
            }).await?;
            apply_transaction(tx, &definitions).await
        })
        .await;
    writer.close().await;
    result?;
    let after = mysql
        .with_transaction(async |tx| {
            crate::initialization::kind(tx, "ConnectorApp", "dingtalk_docs", "system").await
        })
        .await?
        .unwrap();
    assert_eq!(after.payload.0["spec"]["enabled"], false);
    assert_eq!(
        after.payload.0["spec"]["toolAllowlist"],
        json!(["admin-tool"])
    );
    assert_eq!(after.payload.0["spec"]["builtinToolLoadingMode"], "lazy");
    assert_eq!(after.payload.0["spec"]["builtinKeywordsSeeded"], true);
    Ok(())
}

#[derive(Default)]
struct SeedTransaction {
    writes: Vec<String>,
    fail_write: Option<usize>,
}

impl MysqlTransaction for SeedTransaction {
    async fn execute<S, A>(&mut self, sql: S, args: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        if self.fail_write == Some(self.writes.len()) {
            return Err(MysqlError::InvalidQuery {
                reason: "test write unavailable".into(),
            });
        }
        let sql = sql.as_ref();
        if sql.starts_with("INSERT INTO kinds") {
            assert_eq!(args.len(), 4);
            assert_eq!(
                args.first_route_value().unwrap().as_str().unwrap(),
                "ConnectorApp"
            );
        } else {
            assert_eq!(
                args.first_route_value().unwrap().as_str().unwrap(),
                COMPLETION_KEY
            );
        }
        self.writes.push(sql.to_owned());
        Ok(MysqlExecution {
            rows_affected: 1,
            last_insert_id: self.writes.len() as u64,
        })
    }

    async fn fetch_optional<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        assert!(
            sql.as_ref()
                .contains("user_id=0 AND kind=? AND name=? AND namespace=?")
        );
        assert_eq!(args.len(), 3);
        Ok(None)
    }

    async fn fetch_all<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        assert!(
            sql.as_ref()
                .contains("user_id=0 AND kind='ConnectorApp' AND namespace='system'")
        );
        Ok(Vec::new())
    }

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("unexpected fetch_one")
    }

    fn fetch<'a, S, A, T>(
        &'a mut self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::once(async { panic!("unexpected streaming query") })
    }
}

#[tokio::test]
async fn completion_marker_is_written_after_all_four_apps() {
    let mut tx = SeedTransaction::default();
    seed(&mut tx, &definitions().unwrap()).await.unwrap();
    assert_eq!(tx.writes.len(), 5);
    assert!(
        tx.writes[..4]
            .iter()
            .all(|sql| sql.starts_with("INSERT INTO kinds"))
    );
    assert!(tx.writes[4].starts_with("INSERT INTO system_configs"));
}

#[tokio::test]
async fn failed_seeding_never_marks_completion_and_can_be_retried() {
    for failed_write in 0..5 {
        let mut tx = SeedTransaction {
            fail_write: Some(failed_write),
            ..Default::default()
        };
        assert!(seed(&mut tx, &definitions().unwrap()).await.is_err());
        assert_eq!(tx.writes.len(), failed_write);
        assert!(
            tx.writes
                .iter()
                .all(|sql| sql.starts_with("INSERT INTO kinds"))
        );
        // A subsequent launch uses a fresh transaction after rollback.
        let mut retry = SeedTransaction::default();
        seed(&mut retry, &definitions().unwrap()).await.unwrap();
        assert_eq!(retry.writes.len(), 5);
    }
}

#[tokio::test]
async fn persisted_completion_skips_all_catalog_reads_and_writes() {
    let database = MysqlRows::start_results(|sql| {
        assert!(sql.contains("FROM system_configs WHERE config_key=?"));
        let row = vec![("payload", Column::Text(r#"{"completed":true}"#.into()))];
        (row.clone(), vec![row])
    })
    .await;
    for _ in 0..3 {
        apply(&database.mysql).await.unwrap();
    }
    assert_eq!(database.queries().len(), 3);
    database.mysql.close().await;
}
