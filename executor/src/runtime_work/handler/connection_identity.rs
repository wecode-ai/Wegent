//! Device-private identity evidence grants local ownership, never cloud authority.
use super::stand_in::settings_error;
use super::*;
use sha2::{Digest, Sha256};

#[derive(Clone)]
pub(super) struct ConnectionActor {
    user: i64,
    fingerprint: Option<String>,
    generation: i64,
}

impl ConnectionActor {
    pub(super) fn user_id(&self) -> i64 {
        self.user
    }
}

pub(super) fn connection_fingerprint(connection: &ConnectionConfig) -> String {
    let mut hash = Sha256::new();
    for part in [&connection.backend_url, &connection.auth_token] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

impl RuntimeWorkRpcHandler {
    fn check_actor_binding(&self, actor: &ConnectionActor) -> Result<(), AppIpcError> {
        let identity = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(settings_error)?
            .connection_identity(&self.device_id)
            .map_err(settings_error)?;
        if identity.0 != actor.generation
            || identity.1 != actor.fingerprint
            || self
                .backend_connection_snapshot()?
                .as_ref()
                .map(connection_fingerprint)
                != actor.fingerprint
        {
            return Err(AppIpcError::new(
                "connection_account_changed",
                "Connected account changed",
            ));
        }
        Ok(())
    }

    pub(super) fn check_connection_actor(
        &self,
        user: i64,
        actor: &ConnectionActor,
    ) -> Result<(), AppIpcError> {
        self.check_actor_binding(actor)?;
        if actor.user != user {
            return Err(AppIpcError::new(
                "permission_denied",
                "Source rules belong to another account",
            ));
        }
        if let Some(fingerprint) = &actor.fingerprint {
            let store =
                LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
            if store
                .verified_connection_user(&self.device_id, fingerprint)
                .map_err(settings_error)?
                != Some(user)
            {
                return Err(AppIpcError::new(
                    "permission_denied",
                    "Source rules belong to another account",
                ));
            }
        }
        Ok(())
    }

    pub(super) async fn verify_local_connection_actor(
        &self,
        user: i64,
    ) -> Result<ConnectionActor, AppIpcError> {
        let connection = self.backend_connection_snapshot()?;
        let fingerprint = connection.as_ref().map(connection_fingerprint);
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let (generation, configured) = store
            .connection_identity(&self.device_id)
            .map_err(settings_error)?;
        if configured != fingerprint {
            return Err(AppIpcError::new(
                "connection_account_changed",
                "Connected account changed",
            ));
        }
        let actor = ConnectionActor {
            user,
            generation,
            fingerprint,
        };
        self.check_actor_binding(&actor)?;
        let Some(connection) = connection else {
            return Ok(actor);
        };
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let gate = self.task_send_gate("local-connection-identity");
        if store
            .verified_connection_user(&self.device_id, actor.fingerprint.as_deref().unwrap())
            .map_err(settings_error)?
            == Some(user)
        {
            self.check_connection_actor(user, &actor)?;
            if let Ok(guard) = gate.try_lock_owned() {
                let handler = self.clone();
                let evidence = actor.clone();
                tokio::spawn(async move {
                    let _guard = guard;
                    let _ = handler.refresh_connection_actor(connection, evidence).await;
                });
            }
            return Ok(actor);
        }
        let _guard = gate.lock().await;
        self.check_actor_binding(&actor)?;
        self.refresh_connection_actor(connection, actor).await
    }

    async fn refresh_connection_actor(
        &self,
        connection: ConnectionConfig,
        actor: ConnectionActor,
    ) -> Result<ConnectionActor, AppIpcError> {
        self.check_actor_binding(&actor)?;
        let response =
            Self::stand_in_request_on(&connection, reqwest::Method::GET, "/users/me", None).await?;
        self.check_actor_binding(&actor)?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        if !response.status().is_success() {
            if matches!(response.status().as_u16(), 401 | 403) {
                store
                    .forget_connection_user(&self.device_id)
                    .map_err(settings_error)?;
            }
            return Err(AppIpcError::new(
                "permission_denied",
                "Connected account identity could not be verified",
            ));
        }
        let identity = response
            .json::<Value>()
            .await
            .map_err(|_| AppIpcError::new("cloud_response_invalid", "Invalid account identity"))?;
        let user = identity["id"].as_i64().ok_or_else(|| {
            AppIpcError::new("cloud_response_invalid", "Missing account identity")
        })?;
        self.check_actor_binding(&actor)?;
        store
            .remember_connection_user(
                &self.device_id,
                actor.fingerprint.as_deref().unwrap(),
                user,
                actor.generation,
            )
            .map_err(settings_error)?;
        if user != actor.user {
            return Err(AppIpcError::new(
                "permission_denied",
                "Source rules belong to another account",
            ));
        }
        Ok(actor)
    }

    pub(super) async fn connection_rule_http(
        &self,
        user: i64,
        actor: &ConnectionActor,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, AppIpcError> {
        self.check_connection_actor(user, actor)?;
        let connection = self.backend_connection_snapshot()?.ok_or_else(|| {
            AppIpcError::new("cloud_unavailable", "Cloud connection is unavailable")
        })?;
        if actor.fingerprint.as_deref() != Some(connection_fingerprint(&connection).as_str()) {
            return Err(AppIpcError::new(
                "connection_account_changed",
                "Connected account changed",
            ));
        }
        let response = Self::stand_in_request_on(&connection, method, path, body).await?;
        self.check_connection_actor(user, actor)?;
        if !response.status().is_success() {
            if matches!(response.status().as_u16(), 401 | 403) {
                LocalTaskStore::open(self.task_store_path.as_ref())
                    .map_err(settings_error)?
                    .forget_connection_user(&self.device_id)
                    .map_err(settings_error)?;
                return Err(AppIpcError::new(
                    "permission_denied",
                    "Project authorization was denied",
                ));
            }
            return Err(AppIpcError::new(
                "cloud_request_failed",
                format!("Project request returned {}", response.status()),
            ));
        }
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        let value = response
            .json()
            .await
            .map_err(|_| AppIpcError::new("cloud_response_invalid", "Invalid project response"))?;
        self.check_connection_actor(user, actor)?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::StatusCode, routing::get, Json, Router};
    use std::sync::atomic::AtomicU16;

    #[tokio::test]
    async fn verified_local_identity_survives_transport_outage_but_cloud_authority_does_not() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/api/users/me", get(|| async { Json(json!({"id":7})) })),
            )
            .await
            .unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
            backend_url: url,
            auth_token: "private-test-token".into(),
            ..Default::default()
        });
        handler
            .update_local_account_identity(handler.backend_connection_snapshot().unwrap().as_ref())
            .unwrap();
        handler.verify_local_connection_actor(7).await.unwrap();
        server.abort();
        let _ = server.await;
        handler.verify_local_connection_actor(7).await.unwrap();
        assert!(handler.verify_local_connection_actor(8).await.is_err());
        assert!(handler
            .verify_stand_in_user(&json!({"userId":7}))
            .await
            .is_err());
        handler
            .backend_connection
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .auth_token = "another-account-token".into();
        assert!(handler.verify_local_connection_actor(7).await.is_err());
        let database = rusqlite::Connection::open(handler.task_store_path.as_ref()).unwrap();
        let evidence: String = database
            .query_row(
                "SELECT metadata FROM loop_items WHERE resource_type='verified_connection_user'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!evidence.contains("private-test-token"));
        assert!(!evidence.contains("another-account-token"));
    }

    #[tokio::test]
    async fn explicit_account_denial_invalidates_offline_evidence() {
        let status = Arc::new(AtomicU16::new(200));
        let response_status = status.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().route(
            "/api/users/me",
            get(move || {
                let code = response_status.load(Ordering::SeqCst);
                async move { (StatusCode::from_u16(code).unwrap(), Json(json!({"id":7}))) }
            }),
        );
        let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
            backend_url: url,
            auth_token: "test".into(),
            ..Default::default()
        });
        handler
            .update_local_account_identity(handler.backend_connection_snapshot().unwrap().as_ref())
            .unwrap();
        let actor = handler.verify_local_connection_actor(7).await.unwrap();
        status.store(401, Ordering::SeqCst);
        assert!(handler
            .refresh_connection_actor(
                handler.backend_connection_snapshot().unwrap().unwrap(),
                actor.clone()
            )
            .await
            .is_err());
        status.store(503, Ordering::SeqCst);
        assert!(handler.verify_local_connection_actor(7).await.is_err());
        server.abort();
        let _ = server.await;
        assert!(handler.verify_local_connection_actor(7).await.is_err());
    }

    #[tokio::test]
    async fn account_switch_while_identity_request_is_pending_rejects_the_old_actor() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        let start = entered.clone();
        let finish = resume.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().route(
            "/api/users/me",
            get(move || {
                let start = start.clone();
                let finish = finish.clone();
                async move {
                    start.notify_one();
                    finish.notified().await;
                    Json(json!({"id":7}))
                }
            }),
        );
        let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        *handler.backend_connection.lock().unwrap() = Some(ConnectionConfig {
            backend_url: url,
            auth_token: "old".into(),
            ..Default::default()
        });
        handler
            .update_local_account_identity(handler.backend_connection_snapshot().unwrap().as_ref())
            .unwrap();
        let worker = handler.clone();
        let checking = tokio::spawn(async move { worker.verify_local_connection_actor(7).await });
        entered.notified().await;
        handler
            .backend_connection
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .auth_token = "new".into();
        resume.notify_one();
        assert!(checking.await.unwrap().is_err());
        server.abort();
    }
    #[tokio::test]
    async fn a_stalled_identity_refresh_does_not_queue_local_reads() {
        use std::sync::atomic::AtomicUsize;
        let stalled = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        let (hold, count, start, finish) = (
            stalled.clone(),
            requests.clone(),
            entered.clone(),
            resume.clone(),
        );
        let router = Router::new().route(
            "/api/users/me",
            get(move || {
                let (hold, count, start, finish) =
                    (hold.clone(), count.clone(), start.clone(), finish.clone());
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    if hold.load(Ordering::SeqCst) {
                        start.notify_one();
                        finish.notified().await;
                    }
                    Json(json!({"id":7}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connection = ConnectionConfig {
            backend_url: format!("http://{}", listener.local_addr().unwrap()),
            auth_token: "same-account".into(),
            ..Default::default()
        };
        let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        handler
            .update_local_account_identity(Some(&connection))
            .unwrap();
        *handler.backend_connection.lock().unwrap() = Some(connection);
        handler.verify_local_connection_actor(7).await.unwrap();
        stalled.store(true, Ordering::SeqCst);
        handler.verify_local_connection_actor(7).await.unwrap();
        entered.notified().await;
        let reads = (0..20).map(|_| {
            let worker = handler.clone();
            tokio::spawn(async move { worker.verify_local_connection_actor(7).await })
        });
        let outcomes = tokio::time::timeout(
            Duration::from_secs(2),
            futures_util::future::join_all(reads),
        )
        .await
        .expect("Local reads queued behind the stalled cloud request");
        assert!(outcomes.into_iter().all(|result| result.unwrap().is_ok()));
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        resume.notify_one();
        server.abort();
    }
}
