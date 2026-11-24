// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Verify the streaming bridge with the real in-process device queue and completion adapter.

use serde_json::json;
use wegent_responses_streaming::callback_source::callback_channel;

use super::*;
use crate::responses::create::seam::BodyStream;

const TEST_TASK_ID: i64 = 847_036_270_404_273;
const TEST_SUBTASK_ID: i64 = 847_036_270_404_276;
const TEST_CREATED_AT: i64 = 1_793_599_488;

#[tokio::test]
async fn a_queue_rejection_is_not_reported_as_settled_dispatch() {
    let body = reject_device_queue_admission(false).await;
    assert!(body.contains("response.failed"), "{body}");
    assert!(body.contains("Device dispatch queue unavailable"), "{body}");
}

#[tokio::test]
async fn a_queue_rejection_replays_an_already_committed_cancellation() {
    let body = reject_device_queue_admission(true).await;
    assert!(body.contains("response.completed"), "{body}");
    assert!(body.contains("committed cancellation output"), "{body}");
    assert!(!body.contains("response.failed"), "{body}");
}

async fn reject_device_queue_admission(cancelled: bool) -> String {
    use crate::sql_test_support::mysql_rows::{MysqlRows, Value as MysqlValue};
    use wegent_responses_streaming::callback_source::test_support::ScriptedSubscriptions;

    let fixture = MysqlRows::start_results(move |sql| {
        if cancelled && sql.starts_with("SELECT status, result, error_message") {
            let row = vec![
                ("status", MysqlValue::Text("CANCELLED".into())),
                (
                    "result",
                    MysqlValue::Text(json!({"value": "committed cancellation output"}).to_string()),
                ),
                ("error_message", MysqlValue::Text(String::new())),
            ];
            (row.clone(), vec![row])
        } else {
            (vec![("id", MysqlValue::I64(TEST_TASK_ID))], Vec::new())
        }
    })
    .await;
    let mut app = crate::app_test_support::app(fixture.mysql.clone());
    let subscriptions = Arc::new(ScriptedSubscriptions::new(Vec::new()));
    Arc::get_mut(&mut app)
        .expect("uniquely owned test app")
        .callback_subscriptions = Some(subscriptions.clone());
    assert!(
        app.completion_app
            .set(std::sync::Arc::downgrade(&app))
            .is_ok()
    );
    let request = ExecutionRequest {
        task_id: TEST_TASK_ID,
        subtask_id: TEST_SUBTASK_ID,
        message_id: Some(2),
        prompt: json!("hello"),
        model_config: json!({"model_id": "test-model"}),
        ..ExecutionRequest::default()
    };
    let input = BridgeInput {
        model_string: "test-model",
        previous_response_id: None,
        request_id: "request-id",
        created_at: TEST_CREATED_AT,
        target_url: None,
    };
    let body =
        stream_callback(&app, &request, &input, Some("test-device")).expect("callback bridge");
    let permits: Vec<_> = std::iter::from_fn(|| app.responses_dispatch.reserve()).collect();
    assert!(!permits.is_empty());
    let output = drain_stream(body).await;
    drop(permits);
    assert_eq!(
        subscriptions.channels(),
        [callback_channel(TEST_SUBTASK_ID)]
    );
    assert!(!subscriptions.connected());
    output
}

async fn drain_stream(mut body: BodyStream) -> String {
    let mut text = String::new();
    while let Some(chunk) = futures_util::StreamExt::next(&mut body).await {
        text.push_str(&String::from_utf8_lossy(&chunk.expect("body chunk")));
    }
    text
}
