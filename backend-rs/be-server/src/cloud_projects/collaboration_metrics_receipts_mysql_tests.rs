//! Replay the production receipt transaction and reads against isolated MySQL.
use super::super::*;
use v2::{ContributionBasis, Evidence, Fact, Window};

async fn append(
    mysql: &MysqlService,
    actor: i32,
    record: &Evidence,
) -> Result<Value, FastApiError> {
    mysql
        .with_transaction(async |tx| v2::repository::append(tx, "1001", actor, record).await)
        .await
        .unwrap()
}

fn record(key: &str, issue: &str) -> Evidence {
    Evidence {
        key: key.into(),
        revision: 1,
        issue_id: issue.into(),
        references: vec![issue.into()],
        fact: Fact::Contribution {
            user_id: Some(7),
            basis: ContributionBasis::FormalReview,
            effective_at: Utc::now() - Duration::hours(1),
            revoked: false,
        },
    }
}

async fn read(mysql: &MysqlService, actor: i32) -> Result<ProjectData, FastApiError> {
    mysql
        .with_transaction_options(snapshot_options(), async |mut tx| {
            Ok(project_data_on(&mut tx, 1001, actor, Window { as_of: Utc::now() }).await)
        })
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by Backend Rust CI"]
async fn receipts_replay_with_current_authority_and_canonical_delivery_provenance()
-> anyhow::Result<()> {
    crate::migrations::mysql_tests::isolated(verify).await
}

async fn verify(mysql: &MysqlService) -> anyhow::Result<()> {
    crate::project_coordination::mysql_tests::seed(mysql).await;
    mysql.execute("ALTER TABLE kinds ADD COLUMN namespace VARCHAR(100) DEFAULT 'default', ADD COLUMN created_at DATETIME(6), ADD COLUMN updated_at DATETIME(6)",()).await?;
    mysql.execute("ALTER TABLE users ADD COLUMN user_name VARCHAR(100) DEFAULT 'member', ADD COLUMN email VARCHAR(100)",()).await?;
    for (id, creator, security, project) in [
        ("root", 7, "open", "1001"),
        ("private", 1, "related", "1001"),
        ("foreign", 7, "open", "1002"),
    ] {
        mysql.execute("INSERT INTO loop_items (id,resource_type,cloud_project_id,status,created_by_user_id,created_at,completed_at,metadata,version) VALUES (?,'task',?,'completed',?,UTC_TIMESTAMP(6)-INTERVAL 2 HOUR,UTC_TIMESTAMP(6),?,1)",
            (id,project,creator,Json(json!({"security_level":security})))).await?;
    }
    let original = record("formal-review", "root");
    let (first, duplicate) = tokio::join!(append(mysql, 7, &original), append(mysql, 7, &original));
    assert_eq!(first.as_ref().unwrap(), duplicate.as_ref().unwrap());
    let first = first.unwrap();
    assert!(
        first["receipt_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );
    let (count,): (i64,) = mysql
        .fetch_one(
            "SELECT COUNT(*) FROM loop_items WHERE resource_type='comment'",
            (),
        )
        .await?;
    assert_eq!(
        count, 1,
        "Concurrent replay must not duplicate the persisted receipt"
    );
    let mut revised = original.clone();
    if let Fact::Contribution { revoked, .. } = &mut revised.fact {
        *revoked = true;
    }
    assert_eq!(
        append(mysql, 7, &revised).await.unwrap_err().status(),
        StatusCode::CONFLICT
    );
    revised.revision = 2;
    assert_eq!(
        append(mysql, 8, &revised).await.unwrap_err().status(),
        StatusCode::FORBIDDEN
    );
    append(mysql, 1, &revised).await.unwrap();
    let data = read(mysql, 7).await.unwrap();
    let metrics = v2::aggregate(
        &data.issues,
        &data.facts,
        &data.members,
        Window { as_of: Utc::now() },
        None,
    );
    assert_eq!(metrics["completion"]["completed"], 1);
    assert_eq!(
        metrics["completion"]["numerator"], 0,
        "Revoked contributions must not be resurrected"
    );
    assert_eq!(metrics["completion"]["unknown"], 1);
    assert_eq!(
        append(mysql, 9, &original).await.unwrap_err().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        append(mysql, 7, &record("private", "private"))
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        append(mysql, 7, &record("foreign", "foreign"))
            .await
            .unwrap_err()
            .status(),
        StatusCode::NOT_FOUND
    );
    let mut wrong_source = record("wrong-source", "root");
    wrong_source.references = vec!["foreign".into()];
    assert_eq!(
        append(mysql, 7, &wrong_source).await.unwrap_err().status(),
        StatusCode::NOT_FOUND
    );

    // Real published delivery rows have no cloud_project_id; their Issue provides scope.
    for (id, status) in [("draft", "draft"), ("published", "delivered")] {
        mysql.execute("INSERT INTO loop_items (id,resource_type,loop_item_id,status,created_by_user_id,delivered_at) VALUES (?,'delivery','root',?,8,UTC_TIMESTAMP(6)-INTERVAL 1 HOUR)",(id,status)).await?;
    }
    let data = read(mysql, 7).await.unwrap();
    assert!(
        data.facts
            .iter()
            .any(|fact| fact.key == "delivery:published")
    );
    assert!(!data.facts.iter().any(|fact| fact.key == "delivery:draft"));
    let metrics = v2::aggregate(
        &data.issues,
        &data.facts,
        &data.members,
        Window { as_of: Utc::now() },
        None,
    );
    assert_eq!(metrics["completion"]["per_person"]["8"], 1);
    assert_eq!(
        metrics["completion"]["denominator"], 4,
        "Include the owner and zero-contribution viewers"
    );
    append(mysql, 1, &record("private", "private"))
        .await
        .unwrap();
    assert!(
        !read(mysql, 7)
            .await
            .unwrap()
            .facts
            .iter()
            .any(|fact| fact.issue_id == "private")
    );
    assert!(
        read(mysql, 1)
            .await
            .unwrap()
            .facts
            .iter()
            .any(|fact| fact.issue_id == "private")
    );
    mysql.execute("UPDATE resource_members SET status='rejected' WHERE resource_type='Workspace' AND entity_id='7'",()).await?;
    assert_eq!(
        read(mysql, 7).await.err().unwrap().status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        append(mysql, 7, &record("revoked", "root"))
            .await
            .unwrap_err()
            .status(),
        StatusCode::FORBIDDEN
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by Backend Rust CI"]
async fn receipt_uses_the_deployed_schema() -> anyhow::Result<()> {
    crate::migrations::mysql_tests::isolated(async |mysql| {
        crate::migrations::mysql_tests::seed_collaboration(mysql).await?;
        let (schema,): (String,) = mysql.fetch_one("SELECT DATABASE()", ()).await?;
        let address = std::env::var("WEGENT_TEST_MYSQL_ADDRESS")?;
        let writers = MysqlService::connect_lazy_with_options(
            &format!("mysql://root@{address}/{schema}?ssl-mode=disabled"),
            brz_mysql::MysqlServiceOptions::default().with_max_connections(2),
        )?;
        let original = record("production-schema-review", "root");
        let barrier = tokio::sync::Barrier::new(2);
        let concurrent = async || writers.with_transaction(async |mut tx| {
            // Establish both snapshots before either writer wins the Issue
            // lock. Replay must read the winner's committed receipt.
            let _: Vec<(String,)> = tx.fetch_all("SELECT id FROM loop_items WHERE id='root'", ()).await?;
            barrier.wait().await;
            v2::repository::append(tx, "1001", 7, &original).await
        }).await;
        let (first, second) = tokio::join!(concurrent(), concurrent());
        let saved = first?.expect("first valid receipt");
        assert_eq!(saved, second?.expect("concurrent replay"));
        assert_eq!(
            saved,
            append(mysql, 7, &original)
                .await
                .expect("idempotent replay")
        );
        let (count,): (i64,) = mysql.fetch_one("SELECT COUNT(*) FROM loop_items WHERE resource_type='comment' AND JSON_EXTRACT(metadata,'$.event_type')='metric_evidence'",()).await?;
        assert_eq!(count, 1);
        Ok(())
    })
    .await
}
