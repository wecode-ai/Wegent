//! Protocol integration coverage with an isolated MySQL schema.

use super::*;
use serde_json::json;

fn delivery(recipient: &str) -> Delivery {
    Delivery {
        session: serde_json::from_value(json!({
            "session_key":recipient,"user_id":7,"channel_type":"dingtalk",
            "channel_id":42,"conversation_id":"private","sender_id":"staff-7"
        }))
        .unwrap(),
        address: json!({"deviceId":"computer","localTaskId":"task-1"}),
        message: "Identical text is allowed in another turn".to_owned(),
    }
}

#[tokio::test]
#[ignore = "requires WEGENT_TEST_MYSQL_ADDRESS; runs in Backend Rust CI"]
async fn runtime_notification_outbox_protocol() -> Result<()> {
    test_database(async |mysql| {
        // Concurrent event replays create one immutable intent.
        let (a, b) = tokio::join!(
            enqueue(mysql, vec![("first".to_owned(), delivery("recipient-a"))]),
            enqueue(mysql, vec![("first".to_owned(), delivery("recipient-a"))]),
        );
        a?;
        b?;
        let first = claim(mysql).await?.unwrap();
        assert_eq!(first.id, "first");
        assert!(claim(mysql).await?.is_none());

        // A crashed worker's lease expires; its stale acknowledgements are fenced.
        let recovered_at = Utc::now().naive_utc() + Duration::days(1);
        let replacement = claim_at(mysql, recovered_at).await?.unwrap();
        assert_eq!(replacement.id, first.id);
        assert_ne!(first.token, replacement.token);
        assert!(
            record_result(mysql, &first, &json!({"id":"stale"}))
                .await
                .is_err()
        );
        assert!(settle(mysql, &first, true).await.is_err());

        // One recipient's failure does not block a different recipient.
        record_result(
            mysql,
            &replacement,
            &json!({"processQueryKey":"provider-1"}),
        )
        .await?;
        settle_at(mysql, &replacement, false, recovered_at).await?;
        enqueue(mysql, vec![("other".to_owned(), delivery("recipient-b"))]).await?;
        let other = claim_at(mysql, recovered_at).await?.unwrap();
        assert_eq!(other.id, "other");
        settle(mysql, &other, true).await?;
        assert!(claim_at(mysql, recovered_at).await?.is_none());
        let retried = claim_at(mysql, recovered_at + Duration::seconds(2))
            .await?
            .unwrap();
        assert_eq!(retried.id, "first");
        assert_eq!(retried.delivery.message, delivery("recipient-a").message);
        assert_eq!(
            retried.provider_result,
            Some(json!({"processQueryKey":"provider-1"}))
        );
        settle(mysql, &retried, true).await?;

        // Event replay cannot resurrect a sent notification.
        enqueue(mysql, vec![("first".to_owned(), delivery("recipient-a"))]).await?;
        assert!(
            claim_at(mysql, Utc::now().naive_utc() + Duration::days(365))
                .await?
                .is_none()
        );
        Ok(())
    })
    .await
}
