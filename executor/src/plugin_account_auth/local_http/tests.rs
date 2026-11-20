use super::*;
use axum::{
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use tokio::sync::oneshot;

mod confirmation;

fn context(base: &str) -> LocalAuthContext {
    LocalAuthContext::new(Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: base.into(),
        auth_token: "account-a".into(),
        ..Default::default()
    }))))
}
fn configure(context: &LocalAuthContext, revision: u64, base: &str) {
    context
        .configure(json!({"configuration_revision":revision,"session":{
            "backend_url":base,"account_token":"account-a","native_token":"private-native-token",
            "expires_at":chrono::Utc::now().timestamp()+600
        }}))
        .unwrap();
}

fn configure_owner(
    context: &LocalAuthContext,
    revision: u64,
    base: &str,
    user: (i64, &str),
    thumbprint: &str,
) -> String {
    let token = |claims: Value| {
        format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(claims.to_string())
        )
    };
    let (user_id, subject) = user;
    let account_token = token(json!({"user_id":user_id,"sub":subject,"exp":revision}));
    let native_token = token(json!({
        "user_id":user_id,"sub":subject,"thumbprint":thumbprint,
        "token_use":"plugin_native","scope":"plugin_native","exp":revision
    }));
    {
        let mut connection = context.connection.lock().unwrap();
        let profile = connection.as_mut().unwrap();
        profile.backend_url = base.to_owned();
        profile.auth_token = account_token.clone();
    }
    context
        .configure(json!({"configuration_revision":revision,"session":{
            "backend_url":base,"account_token":account_token,"native_token":native_token,
            "expires_at":chrono::Utc::now().timestamp()+600
        }}))
        .unwrap();
    native_token
}

#[test]
fn native_availability_does_not_change_device_registration_or_cloud_mode() {
    let context = context("http://127.0.0.1:1");
    assert!(!context.available(false));
    configure(&context, 1, "http://127.0.0.1:1");
    assert!(context.available(false));
    context.socket(None, true);
    assert!(
        !context.available(false),
        "cloud profiles still require their Socket"
    );
    context.socket(None, false);
    assert!(context.available(false));
    context
        .connection
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .auth_token = "other-account".into();
    assert!(
        !context.available(true),
        "a native session cannot cross profiles"
    );
}
#[test]
fn clear_fences_late_configuration_and_expired_sessions() {
    let context = context("http://127.0.0.1:1");
    configure(&context, 1, "http://127.0.0.1:1");
    context
        .configure(json!({"configuration_revision":3,"session":null}))
        .unwrap();
    assert!(context
        .configure(json!({"configuration_revision":2,"session":null}))
        .is_err());
    assert!(!context.available(false));
    assert!(context.configure(json!({"configuration_revision":4,"session":{
        "backend_url":"http://127.0.0.1:1","account_token":"account-a","native_token":"secret","expires_at":1
    }})).is_err());
}

#[tokio::test]
async fn a_scoped_socket_call_cannot_switch_routes_when_native_activates() {
    let (calls, mut received) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route(
        "/api/plugins/native-auth/exchange",
        post(move |Json(body): Json<Value>| {
            calls.send(body).unwrap();
            async { Json(json!({"success":true,"status":"ok"})) }
        }),
    );
    let (base, server) = serve(app).await;
    let logins = Arc::new(PendingLogins::default());
    let context = context(&base).with_pending_logins(logins.clone());
    context.socket(Some(SocketIoTransport::default()), false);
    let socket = context.for_plugin(42, true);
    let operation = "plugin.auth.local_lifecycle";
    let payload = json!({"installed_plugin_id":42,"connector_slug":"mail","action":"login"});
    let timeout = Duration::from_secs(2);
    assert!(!socket.uses_native_http());
    assert_eq!(
        socket
            .exchange(operation, payload.clone(), timeout)
            .await
            .unwrap_err(),
        "Socket.IO client is not connected"
    );

    context.socket(Some(SocketIoTransport::default()), false);
    assert_eq!(
        socket
            .exchange(operation, payload.clone(), timeout)
            .await
            .unwrap_err(),
        BACKEND_UNAVAILABLE
    );
    let socket = context.for_plugin(42, true);
    configure(&context, 1, &base);
    let socket = socket.for_plugin(42, true);
    assert!(!socket.uses_native_http());
    assert!(!socket.available(true));
    assert_eq!(
        socket
            .exchange(operation, payload.clone(), timeout)
            .await
            .unwrap_err(),
        BACKEND_UNAVAILABLE
    );
    assert!(received.try_recv().is_err());

    let native = context.for_plugin(42, true);
    assert!(native.uses_native_http());
    assert_eq!(
        native
            .exchange(operation, payload.clone(), timeout)
            .await
            .unwrap()["status"],
        "ok"
    );
    assert_eq!(received.try_recv().unwrap()["data"], payload);
    assert!(logins.contains_installation(42));

    context
        .configure(json!({"configuration_revision":2,"session":null}))
        .unwrap();
    assert!(!socket.available(true));
    assert_eq!(
        socket
            .exchange(operation, payload, timeout)
            .await
            .unwrap_err(),
        BACKEND_UNAVAILABLE
    );
    server.abort();
}

#[tokio::test]
async fn http_works_without_socket_and_discards_response_after_account_change() {
    for change_profile in [false, true] {
        let (started, start) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let request = Arc::new(Mutex::new(Some((started, released))));
        let app = Router::new().route(
            "/api/plugins/native-auth/exchange",
            post(move |Json(body): Json<Value>| {
                let (started, released) = request.lock().unwrap().take().unwrap();
                async move {
                    assert_eq!(body["native_token"], "private-native-token");
                    assert_eq!(body["operation"], "plugin.auth.execute");
                    started.send(()).unwrap();
                    released.await.unwrap();
                    Json(json!({"success":true,"credential":"must-stay-native"}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let context = context(&base);
        configure(&context, 1, &base);
        assert!(context.available(false));
        let active = context.clone();
        let call = tokio::spawn(async move {
            active
                .exchange("plugin.auth.execute", json!({}), Duration::from_secs(5))
                .await
        });
        start.await.unwrap();
        if change_profile {
            context
                .connection
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .auth_token = "account-b".into();
        }
        release.send(()).unwrap();
        let result = call.await.unwrap();
        if change_profile {
            assert_eq!(result.unwrap_err(), "plugin_auth_backend_unavailable");
        } else {
            assert_eq!(result.unwrap()["credential"], "must-stay-native");
        }
        server.abort();
    }
}

async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, server)
}

#[tokio::test]
async fn native_login_hands_priority_to_pending_registration_until_the_owner_changes() {
    let app = Router::new().route(
        "/api/plugins/native-auth/exchange",
        post(|Json(body): Json<Value>| async move {
            if body["operation"] == "plugin.auth.transfer.abort" {
                assert_eq!(body["data"]["migration_id"], "staged-transfer");
                return Json(json!({"success":true,"state":"aborted"}));
            }
            Json(json!({"success":true,"status":"ok"}))
        }),
    );
    let (base, server) = serve(app).await;
    let logins = Arc::new(PendingLogins::default());
    let context = context(&base).with_pending_logins(logins.clone());
    configure_owner(&context, 1, &base, (7, "alice"), "device-a");
    let ordinary = context.for_plugin(42, false);
    let other = context.for_plugin(43, false);
    let unresolved = context.for_plugin(0, false);
    let timeout = Duration::from_secs(5);
    // An ordinary candidate reserved before login may send its write only after login completes.
    let pending_write = ordinary.exchange("plugin.auth.enroll", json!({}), timeout);
    let login = || async {
        let response = context
            .for_plugin(42, true)
            .exchange(
                "plugin.auth.local_lifecycle",
                json!({"installed_plugin_id":42,"connector_slug":"mail","action":"login"}),
                timeout,
            )
            .await
            .unwrap();
        assert_eq!(response["status"], "ok");
    };
    login().await;
    assert!(logins.contains_installation(42));
    assert_eq!(
        pending_write.await.unwrap()["error"],
        "plugin_auth_background_deferred"
    );
    let processing = logins.take();
    for writer in [&ordinary, &unresolved] {
        assert_eq!(
            writer
                .exchange("plugin.auth.oauth.revoke_begin", json!({}), timeout)
                .await
                .unwrap()["error"],
            "plugin_auth_background_deferred"
        );
    }
    assert_eq!(
        other
            .exchange("plugin.auth.enroll", json!({}), timeout)
            .await
            .unwrap()["success"],
        true
    );
    assert_eq!(
        ordinary
            .exchange("plugin.auth.transfer.finish", json!({}), timeout)
            .await
            .unwrap()["success"],
        true
    );
    super::super::NativeAuthGateway::new(ordinary.clone())
        .abort_transfer("staged-transfer")
        .await
        .expect("a processing login must allow recovery of an already-staged transfer");
    drop(processing);
    for writer in [&ordinary, &unresolved] {
        assert_eq!(
            writer
                .exchange("plugin.auth.oauth.revoke_begin", json!({}), timeout)
                .await
                .unwrap()["success"],
            true
        );
    }

    login().await;
    let old_processing = logins.take();
    configure_owner(&context, 2, &base, (7, "alice"), "device-a");
    assert!(logins.contains_installation(42));
    let queued_owner = context.for_plugin(42, true);
    configure_owner(&context, 3, &base, (7, "alice"), "device-b");
    assert!(!logins.contains_installation(42));
    assert!(queued_owner
        .exchange("plugin.auth.enroll", json!({}), timeout)
        .await
        .is_err());
    login().await;
    let new_processing = logins.take();
    drop(old_processing);
    assert!(logins.contains_installation(42));
    drop(new_processing);
    assert_eq!(
        context
            .for_plugin(42, false)
            .exchange("plugin.auth.enroll", json!({}), timeout)
            .await
            .unwrap()["success"],
        true
    );
    server.abort();
}

#[tokio::test]
async fn oauth_finish_retries_only_marked_prewrite_failures_with_the_same_body() {
    let business_busy = json!({"success":false,"error":BUSY_CODE,"retryable":true});
    let legacy_busy = json!({"detail":BUSY_DETAIL});
    let cases = [
        (StatusCode::OK, true, false, business_busy.clone(), 2),
        (StatusCode::OK, true, true, business_busy.clone(), 3),
        (StatusCode::OK, false, true, business_busy, 1),
        (
            StatusCode::OK,
            true,
            true,
            json!({"success":false,"error":BUSY_CODE,"retryable":false}),
            1,
        ),
        (
            StatusCode::OK,
            true,
            false,
            json!({"success":false,"error":LEASE_TIMEOUT_CODE,"retryable":true}),
            2,
        ),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            true,
            false,
            legacy_busy.clone(),
            2,
        ),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            true,
            true,
            legacy_busy.clone(),
            3,
        ),
        (StatusCode::SERVICE_UNAVAILABLE, false, true, legacy_busy, 1),
    ];
    for (status, marked, always_busy, busy_body, expected_calls) in cases {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let requests = calls.clone();
        let app = Router::new().route(
            "/api/plugins/native-auth/exchange",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let calls = requests.clone();
                let busy_body = busy_body.clone();
                async move {
                    assert_eq!(headers[CONTENTION_HEADER], "1");
                    assert_eq!(headers[RESULT_HEADER], "2");
                    let attempt = {
                        let mut calls = calls.lock().unwrap();
                        calls.push(body);
                        calls.len()
                    };
                    if attempt > 1 && !always_busy {
                        return Json(json!({"success":true,"state":"finished"})).into_response();
                    }
                    let mut response = (status, Json(busy_body)).into_response();
                    if marked {
                        response
                            .headers_mut()
                            .insert(CONTENTION_HEADER, BUSY_BEFORE_WRITE.parse().unwrap());
                    }
                    response
                }
            }),
        );
        let (base, server) = serve(app).await;
        let context = context(&base);
        configure(&context, 1, &base);
        let payload = json!({"operation_id":"same-operation","credential":"same-result"});
        let value = context
            .for_plugin(42, true)
            .exchange(
                "plugin.auth.oauth.finish",
                payload.clone(),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert_eq!(value["success"], !always_busy);
        if !always_busy {
            assert_eq!(value["state"], "finished");
        } else if expected_calls == 3 {
            assert_eq!(value["error"], "plugin_auth_busy_retry_later");
        } else {
            let expected_error = if status == StatusCode::OK {
                BUSY_CODE
            } else {
                BUSY_DETAIL
            };
            assert_eq!(value["error"], expected_error);
        }
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), expected_calls);
        assert!(calls.iter().all(|body| body["data"] == payload));
        server.abort();
    }
}

#[test]
fn lease_timeout_is_retryable_only_with_the_negotiated_response_shape() {
    let body = json!({"success":false,"error":LEASE_TIMEOUT_CODE,"retryable":true});
    assert_eq!(
        retry_before_write(StatusCode::OK, true, &body),
        Some(RetryBeforeWrite::LeaseTimeout)
    );
    assert_eq!(retry_before_write(StatusCode::OK, false, &body), None);
    assert_eq!(
        retry_before_write(StatusCode::SERVICE_UNAVAILABLE, true, &body),
        None
    );
    for (field, invalid) in [
        ("success", json!(true)),
        ("retryable", json!(false)),
        ("error", json!("dependency_failure")),
    ] {
        let mut invalid_body = body.clone();
        invalid_body[field] = invalid;
        assert_eq!(
            retry_before_write(StatusCode::OK, true, &invalid_body),
            None
        );
    }
}

#[tokio::test]
async fn lease_timeout_and_busy_share_three_attempts_and_preserve_the_final_recovery_delay() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed = requests.clone();
    let app = Router::new().route(
        "/api/plugins/native-auth/exchange",
        post(move |Json(body): Json<Value>| {
            let observed = observed.clone();
            async move {
                let attempt = {
                    let mut requests = observed.lock().unwrap();
                    requests.push((Instant::now(), body));
                    requests.len()
                };
                let code = if attempt == 1 {
                    LEASE_TIMEOUT_CODE
                } else {
                    // A late SET may hold the lease briefly while its owner cleans it up.
                    BUSY_CODE
                };
                (
                    [(CONTENTION_HEADER, BUSY_BEFORE_WRITE)],
                    Json(json!({"success":false,"error":code,"retryable":true})),
                )
            }
        }),
    );
    let (base, server) = serve(app).await;
    let context = context(&base);
    configure(&context, 1, &base);
    let started = Instant::now();
    let result = context
        .for_plugin(42, true)
        .exchange(
            "plugin.auth.local_lifecycle",
            json!({"installed_plugin_id":42,"action":"logout"}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(result, failed("plugin_auth_busy_retry_later"));
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1].1, requests[0].1);
    assert_eq!(requests[2].1, requests[0].1);
    assert!(requests[1].0 < started + LEASE_TIMEOUT_FINAL_RETRY);
    assert!(requests[2].0 >= started + LEASE_TIMEOUT_FINAL_RETRY);
    server.abort();
}

#[tokio::test]
async fn foreground_submission_defers_only_the_same_plugins_new_background_write() {
    let (started, start) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let pending = Arc::new(Mutex::new(Some((started, released))));
    let app = Router::new().route(
        "/api/plugins/native-auth/exchange",
        post(move |Json(body): Json<Value>| {
            let pending = pending.clone();
            async move {
                if body["operation"] == "plugin.auth.local_lifecycle" {
                    let (started, released) = pending.lock().unwrap().take().unwrap();
                    started.send(()).unwrap();
                    released.await.unwrap();
                }
                Json(json!({"success":true}))
            }
        }),
    );
    let (base, server) = serve(app).await;
    let context = context(&base);
    configure(&context, 1, &base);
    let scoped = context.for_plugin(42, true);
    let foreground = tokio::spawn(async move {
        scoped
            .exchange(
                "plugin.auth.local_lifecycle",
                json!({"action":"logout"}),
                Duration::from_secs(5),
            )
            .await
    });
    start.await.unwrap();
    let background = |id| context.for_plugin(id, false);
    let same = background(42)
        .exchange("plugin.auth.automatic", json!({}), Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(same["error"], "plugin_auth_background_deferred");
    let aborted = background(42)
        .exchange(
            "plugin.auth.transfer.abort",
            json!({"migration_id":"staged-transfer"}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(aborted["success"], true);
    let other = background(43)
        .exchange("plugin.auth.automatic", json!({}), Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(other["success"], true);
    release.send(()).unwrap();
    assert_eq!(foreground.await.unwrap().unwrap()["success"], true);
    let same = background(42)
        .exchange("plugin.auth.automatic", json!({}), Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(same["success"], true);
    server.abort();
}

#[tokio::test]
async fn only_the_original_account_and_device_can_finish_oauth_after_renewal() {
    let (calls, mut received) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route(
        "/api/plugins/native-auth/exchange",
        post(move |Json(body): Json<Value>| {
            let state = if body["operation"] == "plugin.auth.oauth.begin" {
                "claimed"
            } else {
                "finished"
            };
            calls.send(body).unwrap();
            async move { Json(json!({"success":true,"state":state})) }
        }),
    );
    let (base, server) = serve(app).await;
    let context = context(&base);
    let initial = configure_owner(&context, 1, &base, (7, "account-a"), "device-a");
    let scoped = context.for_plugin(42, true);
    assert_eq!(
        scoped
            .exchange("plugin.auth.oauth.begin", json!({}), Duration::from_secs(5))
            .await
            .unwrap()["state"],
        "claimed"
    );
    assert_eq!(received.try_recv().unwrap()["native_token"], initial);

    let renewed = configure_owner(&context, 2, &base, (7, "account-a"), "device-a");
    let payload = json!({"operation_id":"same-operation","credential":"same-result"});
    assert_eq!(
        scoped
            .exchange(
                "plugin.auth.oauth.finish",
                payload.clone(),
                Duration::from_secs(5)
            )
            .await
            .unwrap()["state"],
        "finished"
    );
    let submitted = received.try_recv().unwrap();
    assert_eq!(submitted["native_token"], renewed);
    assert_eq!(submitted["data"], payload);

    let after_renewal = context.for_plugin(42, true);
    configure_owner(&context, 3, &base, (7, "account-a"), "device-b");
    let after_key_change = context.for_plugin(42, true);
    configure_owner(&context, 4, &base, (8, "account-b"), "device-b");
    for previous in [after_renewal, after_key_change] {
        assert_eq!(
            previous
                .exchange(
                    "plugin.auth.oauth.finish",
                    payload.clone(),
                    Duration::from_secs(5)
                )
                .await
                .unwrap_err(),
            BACKEND_UNAVAILABLE
        );
    }
    assert!(
        received.try_recv().is_err(),
        "An old result must never be sent"
    );
    assert!(context.available(false));
    server.abort();
}

#[tokio::test]
async fn renewed_completion_resends_only_marked_rejections_for_the_same_owner() {
    let identity = (7, "account-a");
    for (account, device, backend_changed, rejection, marked) in [
        (identity, "device-a", false, None, false),
        (
            identity,
            "device-a",
            false,
            Some(RetryBeforeWrite::Busy),
            true,
        ),
        (
            identity,
            "device-a",
            false,
            Some(RetryBeforeWrite::LeaseTimeout),
            true,
        ),
        (
            identity,
            "device-a",
            false,
            Some(RetryBeforeWrite::Busy),
            false,
        ),
        (
            identity,
            "device-b",
            false,
            Some(RetryBeforeWrite::Busy),
            true,
        ),
        (
            identity,
            "device-a",
            true,
            Some(RetryBeforeWrite::Busy),
            true,
        ),
        (
            (8, "account-b"),
            "device-a",
            false,
            Some(RetryBeforeWrite::LeaseTimeout),
            true,
        ),
    ] {
        let (calls, mut received) = tokio::sync::mpsc::unbounded_channel();
        let (release, hold) = oneshot::channel();
        let hold = Arc::new(Mutex::new(Some(hold)));
        let app = Router::new().route(
            "/api/plugins/native-auth/exchange",
            post(move |Json(body): Json<Value>| {
                calls.send(body).unwrap();
                let hold = hold.lock().unwrap().take();
                async move {
                    if let Some(hold) = hold {
                        hold.await.unwrap();
                        if let Some(rejection) = rejection {
                            let mut reply = match rejection {
                                RetryBeforeWrite::Busy => {
                                    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"detail":BUSY_DETAIL})))
                                        .into_response()
                                }
                                RetryBeforeWrite::LeaseTimeout => Json(
                                    json!({"success":false,"error":LEASE_TIMEOUT_CODE,"retryable":true}),
                                )
                                .into_response(),
                            };
                            if marked {
                                reply
                                    .headers_mut()
                                    .insert(CONTENTION_HEADER, BUSY_BEFORE_WRITE.parse().unwrap());
                            }
                            return reply;
                        }
                    }
                    Json(json!({"success":true,"state":"finished"})).into_response()
                }
            }),
        );
        let (base, server) = serve(app).await;
        let context = context(&base);
        let initial = configure_owner(&context, 1, &base, identity, "device-a");
        let scoped = context.for_plugin(42, true);
        let call = tokio::spawn(async move {
            scoped
                .exchange(
                    "plugin.auth.oauth.finish",
                    json!({"operation_id":"same-operation","credential":"same-result"}),
                    Duration::from_secs(5),
                )
                .await
        });
        let first = tokio::time::timeout(Duration::from_secs(2), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first["native_token"], initial);
        let current_base = if backend_changed {
            "http://127.0.0.1:1"
        } else {
            &base
        };
        let renewed = configure_owner(&context, 2, current_base, account, device);
        let same_owner = account == identity && device == "device-a" && !backend_changed;
        if same_owner {
            let deferred = context
                .for_plugin(42, false)
                .exchange("plugin.auth.enroll", json!({}), Duration::from_secs(5))
                .await
                .unwrap();
            assert_eq!(deferred["error"], "plugin_auth_background_deferred");
        }
        let _ = release.send(());
        let result = call.await.unwrap();
        if !same_owner {
            assert_eq!(result.unwrap_err(), BACKEND_UNAVAILABLE);
        } else if marked {
            assert_eq!(result.unwrap()["state"], "finished");
            let second = received.try_recv().unwrap();
            assert_eq!(second["native_token"], renewed);
            assert_eq!(second["operation"], first["operation"]);
            assert_eq!(second["data"], first["data"]);
        } else if rejection.is_some() {
            assert_eq!(result.unwrap()["error"], BUSY_DETAIL);
        } else {
            assert_eq!(result.unwrap()["state"], "finished");
        }
        assert!(received.try_recv().is_err());
        server.abort();
    }
}

#[tokio::test(start_paused = true)]
async fn contention_backoff_keeps_its_schedule_across_same_owner_renewal() {
    let base = "http://127.0.0.1:1";
    let identity = (7, "account-a");
    for (can_rebind, new_device, resumes) in [
        (true, "device-a", true),
        (false, "device-a", false),
        (true, "device-b", false),
    ] {
        let context = context(base);
        configure_owner(&context, 1, base, identity, "device-a");
        let owner = context.state.lock().unwrap().owner_generation;
        let mut changes = context.session_changes.subscribe();
        let next = Instant::now() + Duration::from_millis(100);
        let result = {
            let waiting = context.wait_for_retry(next, &mut changes, can_rebind.then_some(owner));
            tokio::pin!(waiting);
            assert!(futures_util::poll!(&mut waiting).is_pending());

            configure_owner(&context, 2, base, identity, new_device);
            if resumes {
                assert!(futures_util::poll!(&mut waiting).is_pending());
                tokio::time::advance(Duration::from_millis(100)).await;
            }
            waiting.await
        };
        if resumes {
            result.unwrap();
            assert_eq!(Instant::now(), next);

            let (second, _) = context.renewed_session(owner, &mut changes).unwrap();
            let latest = configure_owner(&context, 3, base, identity, new_device);
            let unsent = context
                .await_native_response(
                    async { panic!("The stale Native session reached the HTTP send") },
                    &mut changes,
                    Some(owner),
                )
                .await
                .unwrap();
            assert!(unsent.is_none());
            let (fresh, _) = context.renewed_session(owner, &mut changes).unwrap();
            assert_ne!(fresh.native_token, second.native_token);
            assert_eq!(fresh.native_token, latest);
            assert_eq!(Instant::now(), next);
        } else {
            assert_eq!(result.unwrap_err(), BACKEND_UNAVAILABLE);
            assert!(Instant::now() < next);
        }
    }
}

#[tokio::test(start_paused = true)]
async fn no_retry_starts_at_or_after_the_shared_deadline() {
    let started = Instant::now();
    let deadline = started + Duration::from_secs(5);
    let (next, retry_until) = retry_at(0, started, deadline, false).unwrap();
    assert!(next < retry_until);
    tokio::time::advance(Duration::from_millis(900)).await;
    assert_eq!(retry_at(0, started, deadline, false), None);
    assert_eq!(retry_at(2, started, deadline, false), None);
    assert_eq!(retry_at(2, started, deadline, true), None);
    assert_eq!(
        retry_at(1, started, started + LEASE_TIMEOUT_FINAL_RETRY, true),
        None
    );
    let (next, retry_until) = retry_at(1, started, deadline, true).unwrap();
    assert!(next >= started + LEASE_TIMEOUT_FINAL_RETRY);
    assert_eq!(retry_until, started + LEASE_TIMEOUT_RETRY_WINDOW);
}

#[test]
fn broker_owner_survives_token_rotation_but_not_account_switch() {
    let token = |sub: &str, exp: i32| {
        format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(json!({"sub":sub,"exp":exp}).to_string())
        )
    };
    let mut profile = ConnectionConfig {
        backend_url: "http://backend".into(),
        auth_token: token("a", 1),
        ..Default::default()
    };
    let old = account_scope(&profile);
    profile.auth_token = token("a", 2);
    assert_eq!(old, account_scope(&profile));
    profile.auth_token = token("b", 2);
    assert_ne!(old, account_scope(&profile));
}
