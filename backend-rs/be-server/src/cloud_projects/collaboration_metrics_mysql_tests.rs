//! Exercise the production metric cohort against MySQL's DATETIME(0) rounding.
use super::*;

fn at(hour: i64) -> NaiveDateTime {
    DateTime::from_timestamp(1_800_000_000 + hour * 3600, 0)
        .unwrap()
        .naive_utc()
}
#[tokio::test]
#[ignore = "requires disposable loopback MySQL; invoked by Backend Rust CI"]
async fn precise_completion_window_survives_second_precision_storage() -> anyhow::Result<()> {
    crate::migrations::mysql_tests::isolated(verify).await
}

async fn verify(mysql: &MysqlService) -> anyhow::Result<()> {
    mysql
        .execute(
            "CREATE TABLE loop_items (id VARCHAR(64) PRIMARY KEY,cloud_project_id VARCHAR(64),\
         resource_type VARCHAR(32),parent_id VARCHAR(64),status VARCHAR(32),created_at DATETIME(6),\
         completed_at DATETIME(0),deleted_at DATETIME(6),metadata JSON)",
            (),
        )
        .await?;
    let edge = at(168);
    let recent = edge + Duration::milliseconds(800);
    let as_of = edge + Duration::milliseconds(900);
    let before_window = recent - Duration::days(7);
    let sentinel = DateTime::from_timestamp(1, 0).unwrap().naive_utc();
    for (id, status, parent, completed, actual, deleted) in [
        ("recent", "completed", None, Some(recent), recent, None),
        (
            "old",
            "completed",
            None,
            Some(before_window),
            before_window,
            None,
        ),
        ("edge", "completed", None, Some(as_of), as_of, None),
        ("missing", "completed", None, None, recent, None),
        ("sentinel", "completed", None, Some(sentinel), recent, None),
        (
            "child",
            "completed",
            Some("recent"),
            Some(recent),
            recent,
            None,
        ),
        (
            "deleted",
            "completed",
            None,
            Some(recent),
            recent,
            Some(recent),
        ),
        ("reopened", "pending", None, Some(recent), recent, None),
    ] {
        mysql
            .execute(
                "INSERT INTO loop_items VALUES (?,'project','task',?,?,?, ?,?,?)",
                (
                    id,
                    parent,
                    status,
                    at(0),
                    completed,
                    deleted,
                    Json(
                        json!({"status_history":[{"to_status":"completed","at":actual.and_utc(),
                 "trigger":"user_update","by_user_id":7}]}),
                    ),
                ),
            )
            .await?;
    }
    let (rounded,): (NaiveDateTime,) = mysql
        .fetch_one("SELECT completed_at FROM loop_items WHERE id='recent'", ())
        .await?;
    assert_eq!(rounded, edge + Duration::seconds(1));
    let issues = load_issues(mysql, "project", "", as_of).await?;
    assert_eq!(
        v2::aggregate(
            &issues,
            &[],
            &BTreeSet::from([7, 8]),
            v2::Window {
                as_of: as_of.and_utc()
            },
            None
        )["completion"]["completed"],
        3
    );
    assert_eq!(
        v2::aggregate(
            &issues,
            &[],
            &BTreeSet::from([7, 8]),
            v2::Window {
                as_of: as_of.and_utc()
            },
            None
        )["completion"]["per_person"]["7"],
        3
    );
    let ids: BTreeSet<_> = issues
        .iter()
        .filter(|issue| completed_in_window(issue, as_of))
        .map(|issue| issue.id.as_str())
        .collect();
    assert_eq!(ids, BTreeSet::from(["recent", "missing", "sentinel"]));
    Ok(())
}

#[path = "collaboration_metrics_receipts_mysql_tests.rs"]
mod receipts;
