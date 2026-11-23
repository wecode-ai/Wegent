use super::*;

fn lost_response() -> axum::response::Response {
    use axum::{body::Body, response::Response};
    Response::new(Body::from_stream(futures_util::stream::once(async {
        Err::<axum::body::Bytes, _>(std::io::Error::other("lost response"))
    })))
}

#[tokio::test]
async fn an_idempotent_result_can_replay_after_the_contention_window_closes() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed = requests.clone();
    let app = Router::new().route(
        "/api/plugins/native-auth/exchange",
        post(move |Json(body): Json<Value>| {
            let first = {
                let mut requests = requests.lock().unwrap();
                requests.push(body);
                requests.len() == 1
            };
            async move {
                if first {
                    tokio::time::sleep(RETRY_WINDOW + Duration::from_millis(10)).await;
                    return lost_response();
                }
                Json(json!({"success":true,"state":"finished"})).into_response()
            }
        }),
    );
    let (base, server) = serve(app).await;
    let context = context(&base);
    configure(&context, 1, &base);
    let payload = json!({"operation_id":"same-operation","credential":"same-result"});
    let result = context
        .for_plugin(42, true)
        .exchange(
            "plugin.auth.oauth.finish",
            payload.clone(),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(result["state"], "finished");
    let requests = observed.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0], requests[1]);
    assert_eq!(requests[0]["data"], payload);
    server.abort();
}

#[tokio::test]
async fn a_silent_completion_leaves_time_to_confirm_the_same_result() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed = requests.clone();
    let app = Router::new().route(
        "/api/plugins/native-auth/exchange",
        post(move |Json(body): Json<Value>| {
            let attempt = {
                let mut observed = observed.lock().unwrap();
                observed.push(body);
                observed.len()
            };
            async move {
                if attempt == 1 {
                    // The result was accepted, but this connection never returns a receipt.
                    return std::future::pending().await;
                }
                Json(json!({"success":true,"state":"finished"}))
            }
        }),
    );
    let (base, server) = serve(app).await;
    let context = context(&base);
    configure(&context, 1, &base);
    let payload = json!({"operation_id":"same-operation","credential":"same-result"});
    let result = context
        .for_plugin(42, true)
        .exchange(
            "plugin.auth.oauth.finish",
            payload.clone(),
            Duration::from_millis(1500),
        )
        .await;
    server.abort();
    assert_eq!(result.unwrap()["state"], "finished");
    let observed = requests.lock().unwrap();
    assert_eq!(observed.len(), 2);
    assert_eq!(observed[0], observed[1]);
    assert_eq!(observed[0]["data"], payload);
}

#[tokio::test]
async fn a_busy_confirmation_does_not_discard_the_live_original_receipt() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let confirmation_sent = Arc::new(tokio::sync::Notify::new());
    let release_original = Arc::new(tokio::sync::Notify::new());
    let app = Router::new().route(
        "/api/plugins/native-auth/exchange",
        post({
            let observed = requests.clone();
            let confirmation_sent = confirmation_sent.clone();
            let release_original = release_original.clone();
            move |Json(body): Json<Value>| {
                let attempt = {
                    let mut requests = observed.lock().unwrap();
                    requests.push(body);
                    requests.len()
                };
                let confirmation_sent = confirmation_sent.clone();
                let release_original = release_original.clone();
                async move {
                    match attempt {
                        1 => {
                            release_original.notified().await;
                            Json(json!({"success":true,"state":"finished"})).into_response()
                        }
                        2 => {
                            confirmation_sent.notify_one();
                            (
                                [(CONTENTION_HEADER, BUSY_BEFORE_WRITE)],
                                Json(json!({"success":false,"error":BUSY_CODE,"retryable":true})),
                            )
                                .into_response()
                        }
                        _ => panic!("The live result may be confirmed only once"),
                    }
                }
            }
        }),
    );
    let (base, server) = serve(app).await;
    let context = context(&base);
    configure(&context, 1, &base);
    let scoped = context.for_plugin(42, true);
    let payload = json!({"operation_id":"same-operation","credential":"same-result"});
    let exchange = tokio::spawn({
        let payload = payload.clone();
        async move {
            scoped
                .exchange(
                    "plugin.auth.oauth.finish",
                    payload,
                    Duration::from_millis(1500),
                )
                .await
        }
    });
    tokio::time::timeout(Duration::from_secs(2), confirmation_sent.notified())
        .await
        .expect("confirmation must be attempted while the original is pending");
    release_original.notify_one();
    assert_eq!(exchange.await.unwrap().unwrap()["state"], "finished");
    server.abort();
    let observed = requests.lock().unwrap();
    assert_eq!(observed.len(), 2);
    assert_eq!(observed[0], observed[1]);
    assert_eq!(observed[0]["data"], payload);
}

#[tokio::test]
async fn the_first_failed_reply_does_not_hide_the_other_success() {
    let base = "http://127.0.0.1:1";
    let context = context(base);
    configure(&context, 1, base);
    let (session, generation, owner_generation) = {
        let state = context.state.lock().unwrap();
        (
            state.session.clone().unwrap(),
            state.generation,
            state.owner_generation,
        )
    };
    for original_fails in [false, true] {
        let reply = |status, value, retry_before_write| {
            Ok(Some(NativeResponse {
                value,
                retry_before_write,
                request_id: String::new(),
                status,
            }))
        };
        let success = || {
            reply(
                StatusCode::OK,
                json!({"success":true,"state":"finished"}),
                None,
            )
        };
        let first_observed = tokio::sync::Notify::new();
        let confirmation_started = tokio::sync::Notify::new();
        let observed = Mutex::new(Vec::new());
        let original = async {
            if original_fails {
                confirmation_started.notified().await;
                return reply(StatusCode::SERVICE_UNAVAILABLE, failed(BUSY_DETAIL), None);
            }
            first_observed.notified().await;
            success()
        };
        let confirmation = async {
            if original_fails {
                confirmation_started.notify_one();
                first_observed.notified().await;
                return success();
            }
            reply(
                StatusCode::OK,
                failed(BUSY_CODE),
                Some(RetryBeforeWrite::Busy),
            )
        };
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            context.confirm_in_flight(
                original,
                confirmation,
                &session,
                generation,
                owner_generation,
                |offset, _| {
                    observed.lock().unwrap().push(offset);
                    first_observed.notify_one();
                },
            ),
        )
        .await
        .expect("both in-flight replies must be observed")
        .unwrap();
        assert_eq!(result["state"], "finished");
        assert_eq!(
            *observed.lock().unwrap(),
            if original_fails { [0, 1] } else { [1, 0] }
        );
    }
}

#[tokio::test]
async fn a_lost_result_after_lease_timeout_requires_confirmation_in_the_original_session() {
    let run = |confirmation_busy, renewed_device: Option<&'static str>| async move {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let second_started = Arc::new(tokio::sync::Notify::new());
        let written = second_started.clone();
        let app = Router::new().route(
            "/api/plugins/native-auth/exchange",
            post(move |Json(body): Json<Value>| {
                let attempt = {
                    let mut observed = observed.lock().unwrap();
                    observed.push(body);
                    observed.len()
                };
                let written = written.clone();
                async move {
                    let contention = |code| {
                        (
                            [(CONTENTION_HEADER, BUSY_BEFORE_WRITE)],
                            Json(json!({"success":false,"error":code,"retryable":true})),
                        )
                            .into_response()
                    };
                    match attempt {
                        1 => contention(LEASE_TIMEOUT_CODE),
                        2 => {
                            written.notify_one();
                            let delay = LEASE_TIMEOUT_RETRY_WINDOW + Duration::from_millis(100);
                            tokio::time::sleep(delay).await;
                            lost_response()
                        }
                        3 if confirmation_busy => contention(BUSY_CODE),
                        3 => Json(json!({"success":true,"state":"finished"})).into_response(),
                        _ => panic!("Exceeded the three-attempt limit"),
                    }
                }
            }),
        );
        let (base, server) = serve(app).await;
        let context = context(&base);
        let identity = (7, "account-a");
        let token = configure_owner(&context, 1, &base, identity, "device-a");
        let scoped = context.for_plugin(42, true);
        let operation = "plugin.auth.oauth.finish";
        let payload = json!({"operation_id":"same-operation","credential":"same-result"});
        let expected = json!({"operation":operation,"native_token":token,"data":payload});
        let call = tokio::spawn(async move {
            scoped
                .exchange(operation, payload, Duration::from_secs(6))
                .await
        });
        if let Some(device) = renewed_device {
            tokio::time::timeout(Duration::from_secs(2), second_started.notified())
                .await
                .unwrap();
            configure_owner(&context, 2, &base, identity, device);
        }
        let result = call.await.unwrap();
        let count = if renewed_device.is_some() { 2 } else { 3 };
        assert_eq!(*requests.lock().unwrap(), vec![expected; count]);
        if confirmation_busy || renewed_device.is_some() {
            assert_eq!(result.unwrap_err(), BACKEND_UNAVAILABLE);
        } else {
            assert_eq!(result.unwrap()["state"], "finished");
        }
        server.abort();
    };
    tokio::join!(
        run(false, None),
        run(true, None),
        run(false, Some("device-a")),
        run(false, Some("device-b")),
    );
}
