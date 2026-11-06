//! A binding is coordination ownership, never a substitute for execution grants.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn project_coordination_binding(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let user = payload["userId"]
            .as_i64()
            .filter(|id| *id >= 0)
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let project = super::stand_in_tasks::required(&payload, "projectId")?;
        let group = super::stand_in_tasks::required(&payload, "groupId")?;
        let storage = super::stand_in_tasks::required(&payload, "projectStore")?;
        super::project_coordinator::validate_project_coordinator_target(project, group)?;
        if !matches!(storage, "local" | "cloud") {
            return Err(AppIpcError::new("bad_request", "Invalid project storage"));
        }
        if storage == "cloud" || self.backend_connection_snapshot()?.is_some() {
            self.verify_runtime_user(&json!({"userId":user})).await?;
        }
        let save = method == "runtime.project_coordinator.binding.save";
        let mut input = payload["binding"].clone();
        // The addressed Executor supplies its identity; the caller cannot bind another host.
        if input.is_object() {
            input["deviceId"] = json!(self.device_id);
        }
        if storage == "cloud" {
            return self
                .project_coordination_http(
                    if save {
                        reqwest::Method::PUT
                    } else {
                        reqwest::Method::GET
                    },
                    &format!("/v1/cloud-projects/{project}/coordinator-bindings/{group}"),
                    save.then_some(&input),
                )
                .await;
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let binding = if save {
            store.set_project_coordination_binding(project, group, user, &self.device_id, &input)
        } else {
            store.project_coordination_binding(project, group)
        }
        .map_err(super::stand_in::settings_error)?;
        Ok(json!({"canEnable":true,"canStop":binding["userId"]==user,"binding":binding}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        routing::{get, put},
        Json, Router,
    };

    #[tokio::test]
    async fn local_binding_records_ownership_without_starting_or_reusing_a_conversation() {
        let home = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("addressed-device", "unused");
        handler.task_store_path = Arc::new(home.path().join("tasks.sqlite"));
        handler.store = RuntimeWorkStore::new(home.path().join("runtime-index.json"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Binding fixture"})).unwrap())
            .unwrap();
        let agent = store
            .create_chat_agent(
                &project.id,
                serde_json::from_value(json!({"name":"Leader"})).unwrap(),
            )
            .unwrap();
        store.update_project(&project.id,serde_json::from_value(json!({"version":project.version,"collaboration_groups":[{"id":"group","leader":{"kind":"agent","id":agent.id},"members":[]}]})).unwrap()).unwrap();
        let mut payload = json!({"userId":7,"projectStore":"local","projectId":project.id,"groupId":"group","binding":{"enabled":true,"expectedGeneration":null,"deviceId":"forged-device"}});
        let enabled = handler
            .dispatch_method("runtime.project_coordinator.binding.save", payload.clone())
            .await
            .unwrap();
        assert_eq!(enabled["binding"]["deviceId"], "addressed-device");
        assert_eq!(enabled["binding"]["userId"], 7);
        assert!(handler.local_task_links(true).is_empty());
        store
            .archive_chat_agent(&project.id, &agent.id, agent.version)
            .unwrap();
        payload["binding"] =
            json!({"enabled":false,"expectedGeneration":enabled["binding"]["generation"]});
        let stopped = handler
            .dispatch_method("runtime.project_coordinator.binding.save", payload)
            .await
            .unwrap();
        assert_eq!(stopped["binding"]["enabled"], false);
        assert!(handler.local_task_links(true).is_empty());
    }

    #[tokio::test]
    async fn cloud_binding_uses_verified_user_and_addressed_executor_identity() {
        let submitted = Arc::new(Mutex::new(Vec::<Value>::new()));
        let calls = submitted.clone();
        let app = Router::new()
            .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
            .route(
                "/api/v1/cloud-projects/1001/coordinator-bindings/101",
                put(move |Json(body): Json<Value>| {
                    calls.lock().unwrap().push(body.clone());
                    async move { Json(json!({"binding":body,"canEnable":true})) }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
        let mut handler = RuntimeWorkRpcHandler::new("addressed-device", "unused");
        handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: url,
            auth_token: "fixture".into(),
            ..Default::default()
        })));
        let payload = json!({"userId":7,"projectStore":"cloud","projectId":"1001","groupId":"101","binding":{"enabled":true,"expectedGeneration":null,"deviceId":"forged-device"}});
        let result = handler
            .dispatch_method("runtime.project_coordinator.binding.save", payload.clone())
            .await
            .unwrap();
        assert_eq!(result["binding"]["deviceId"], "addressed-device");
        assert_eq!(submitted.lock().unwrap().len(), 1);
        let mut other = payload;
        other["userId"] = json!(8);
        assert_eq!(
            handler
                .project_coordination_binding("runtime.project_coordinator.binding.save", other)
                .await
                .unwrap_err()
                .code,
            "permission_denied"
        );
        assert_eq!(submitted.lock().unwrap().len(), 1);
        server.abort();
    }
}
