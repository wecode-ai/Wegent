// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Protocol integration: real event parsing, Redis callbacks and card writes.
//! Only the external DingTalk transport is substituted; no real account is used.

use super::*;
use crate::internal_callback::dingtalk_card::{CardRef, CardStream};
use brz_redis::{Redis, RedisService};
use futures_util::FutureExt;
use sha2::{Digest, Sha256};
use std::sync::Mutex;

#[derive(Default)]
struct Cards(Mutex<Vec<(String, String, String)>>);

impl Cards {
    fn record(&self, method: &str, card: &CardRef<'_>, text: &str) {
        assert_eq!(card.channel_id, 1001);
        assert_eq!(card.content_key, "content");
        self.0
            .lock()
            .unwrap()
            .push((method.into(), card.out_track_id.into(), text.into()));
    }
}

impl CardStream for Cards {
    async fn update(&self, card: &CardRef<'_>, text: &str) -> Result<(), String> {
        self.record("update", card, text);
        Ok(())
    }
    async fn finish(&self, card: &CardRef<'_>, text: &str) -> Result<(), String> {
        self.record("finish", card, text);
        Ok(())
    }
    async fn fail(&self, card: &CardRef<'_>, text: &str) -> Result<(), String> {
        self.record("fail", card, text);
        Ok(())
    }
}

struct Fixture {
    state: std::sync::Arc<AppState>,
    redis: RedisService,
    device: String,
    cards: Cards,
    cleanup: Vec<String>,
}

impl Fixture {
    async fn register(&mut self, message: &str, legacy: bool) -> (Value, String) {
        let mut source = json!({"source":"im", "channel_type":"dingtalk",
            "channel_id":1001, "message_id":message});
        let mut address = format!("runtime:{}:stand-in-chat-7-primary", self.device);
        if !legacy {
            let callback = format!("test-session:{message}");
            address.push_str(&format!(":{:x}", Sha256::digest(callback.as_bytes())));
            source["callback_id"] = json!(callback);
        }
        let key = format!("channel:task_callback:dingtalk:{address}");
        let card = format!("test-card-{message}");
        let info = json!({"channel_type":"dingtalk", "channel_id":1001,
            "card_instance_id":card, "card_subtask_id":0,
            "chat_card":{"content_key":"content"},
            "incoming_message_data":{"msgId":message}});
        // Python save_callback_info/cache_manager serialize the document twice.
        self.redis
            .set(&key, serde_json::to_string(&info.to_string()).unwrap())
            .await
            .unwrap();
        let base = format!("channel:streaming_content:{address}");
        let answer = format!("{base}:{card}:{card}");
        self.cleanup.extend([key.clone(), base, answer.clone()]);
        for suffix in ["progress", "display-lock", "terminal", "terminal:writer"] {
            self.cleanup.push(format!("{answer}:{suffix}"));
        }
        (source, key)
    }

    async fn send(&self, source: &Value, name: &str, data: Value) {
        let event = local_execution_event(name, &data, 17, None)
            .unwrap()
            .unwrap();
        forward_local_task_callbacks_with_transport(
            &self.state,
            &self.device,
            "stand-in-chat-7-primary",
            Some(source),
            &event,
            &self.cards,
        )
        .await;
    }

    async fn callback_exists(&self, key: &str) -> bool {
        self.redis.get::<_, String>(key).await.unwrap().is_some()
    }
}

async fn with_fixture(run: impl AsyncFnOnce(&mut Fixture)) {
    let address = std::env::var("WEGENT_TEST_REDIS_ADDRESS").expect("disposable Redis address");
    assert!(
        address
            .parse::<std::net::SocketAddr>()
            .unwrap()
            .ip()
            .is_loopback()
    );
    let redis = RedisService::single(address).await.unwrap();
    // This IM path has no SQL operations; an unused real client satisfies AppState.
    let mysql = brz_mysql::MysqlService::connect_lazy("mysql://root@127.0.0.1:1/test").unwrap();
    let mut state = crate::app_test_support::app(mysql);
    std::sync::Arc::get_mut(&mut state).unwrap().redis = Some(redis.clone());
    let mut fixture = Fixture {
        state,
        redis,
        device: format!(
            "test-im-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ),
        cards: Cards::default(),
        cleanup: Vec::new(),
    };
    let result = std::panic::AssertUnwindSafe(run(&mut fixture))
        .catch_unwind()
        .await;
    fixture.redis.del_many(fixture.cleanup).await.unwrap();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
#[ignore = "requires disposable Redis; run by Backend Rust CI"]
async fn stand_in_replies_update_and_finish_their_own_message_cards() {
    with_fixture(async |fixture| {
        let (first, first_key) = fixture.register("first", false).await;
        let (second, second_key) = fixture.register("second", false).await;
        let mut stale = first.clone();
        stale["message_id"] = json!("other-message");
        fixture.send(&stale, "response.output_text.delta", json!({"delta":"stale"})).await;
        let mut private = first.clone();
        private["source"] = json!("stand_in_activity");
        fixture.send(&private, "response.output_text.delta", json!({"delta":"private"})).await;
        assert!(fixture.cards.0.lock().unwrap().is_empty());
        for (source, key, message) in [(&second, &second_key, "second"), (&first, &first_key, "first")] {
            fixture.send(source, "response.output_text.delta", json!({"delta":format!("{message} progress")})).await;
            assert_eq!(fixture.cards.0.lock().unwrap().last().unwrap(),
                &("update".into(),format!("test-card-{message}"),format!("{message} progress")));
            fixture.send(source, "response.completed", json!({"response":{"output":[{
                "type":"message", "content":[{"type":"output_text","text":format!("{message} final")}]
            }]}})).await;
            assert!(!fixture.callback_exists(key).await);
            assert_eq!(fixture.cards.0.lock().unwrap().last().unwrap(),
                &("finish".into(),format!("test-card-{message}"),format!("{message} final")));
            let calls = fixture.cards.0.lock().unwrap().len();
            fixture.send(source, "response.output_text.delta", json!({"delta":"late"})).await;
            assert_eq!(fixture.cards.0.lock().unwrap().len(), calls);
            if message == "second" { assert!(fixture.callback_exists(&first_key).await); }
        }
        assert_eq!(fixture.cards.0.lock().unwrap().iter().filter(|call| call.0 == "finish").count(), 2);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable Redis; run by Backend Rust CI"]
async fn legacy_callbacks_and_failed_turns_still_settle_the_card() {
    with_fixture(async |fixture| {
        let (source, key) = fixture.register("legacy", true).await;
        fixture
            .send(&source, "error", json!({"message":"test failure"}))
            .await;
        assert!(!fixture.callback_exists(&key).await);
        let calls = fixture.cards.0.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "update");
        assert_eq!(calls[1].0, "fail");
        assert_eq!(calls[1].1, "test-card-legacy");
        assert!(calls[1].2.contains("test failure"));
    })
    .await;
}
