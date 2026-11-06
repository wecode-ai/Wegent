//! Share the desktop's existing compiler while keeping dispatch device-local.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn control_materialize_local(
        &self,
        context: &ControlContext,
        mut intent: Value,
        new_session: bool,
    ) -> Result<Value, AppIpcError> {
        intent["deviceId"] = json!(self.device_id);
        if let Some(selection) = super::super::creation::normalized_selection(&intent)? {
            intent["modelId"] = selection["modelName"].clone();
            intent["modelType"] = selection["modelType"].clone();
            intent["modelOptions"] = selection["options"].clone();
            intent["modelSelection"] = selection;
        }
        let team = intent["wegentTeamId"].as_u64().is_some_and(|id| id > 0);
        let mut body = intent.clone();
        let fields = body.as_object_mut().unwrap();
        for field in [
            "executionRequest",
            "inheritModelConfiguration",
            "runtimeHandle",
        ] {
            fields.remove(field);
        }
        body["schemaVersion"] = json!(if team { 3 } else { 2 });
        body["newSession"] = json!(new_session);
        if !team {
            body["compileOnDevice"] = json!(true);
        }
        let materialized = self
            .control_backend(context, "/runtime-work/materialize", body)
            .await?;
        let mut compiled = materialized["payload"].clone();
        if !compiled.is_object()
            || compiled["taskId"] != intent["taskId"]
            || (!new_session && compiled["workspacePath"] != intent["workspacePath"])
        {
            return Err(AppIpcError::new(
                "invalid_response",
                "Materialization returned a different local conversation identity",
            ));
        }
        // Native credentials stay in the device's trusted profile registry.
        // Backend owns execution identity, Team configuration and resource grants.
        if !team
            && matches!(intent["modelType"].as_str(), None | Some("runtime"))
            && intent["executionRequest"]["model_config"].is_object()
        {
            compiled["executionRequest"]["model_config"] =
                intent["executionRequest"]["model_config"].clone();
        }
        let mut payload = intent;
        payload
            .as_object_mut()
            .unwrap()
            .extend(compiled.as_object().unwrap().clone());
        if materialized["runtimeHandle"].is_object() {
            payload["runtimeHandle"] = materialized["runtimeHandle"].clone();
        }
        Ok(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_work::handler::control::tests::{context, EnvGuard};

    #[test]
    fn materialization_preserves_model_ownership_and_rejects_identity_changes() {
        let _guard = crate::test_env::lock();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let root = tempfile::tempdir().unwrap();
                let _env = EnvGuard::home(root.path().to_str().unwrap());
                let app = axum::Router::new().route(
                    "/api/runtime-work/materialize",
                    axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
                        assert!(body.get("executionRequest").is_none());
                        assert!(body.get("inheritModelConfiguration").is_none());
                        assert_eq!(body["deviceId"], "control-test-device");
                        assert_eq!(body["modelId"], "saved-model");
                        let team = body["message"] == "team";
                        assert_eq!(body["schemaVersion"], if team { 3 } else { 2 });
                        assert_eq!(body["compileOnDevice"], if team { Value::Null } else { json!(true) });
                        axum::Json(json!({"payload":{
                            "taskId":if body["message"] == "foreign-task" {"other-task"} else {"target"},
                            "workspacePath":if body["message"] == "foreign-workspace" {"/other"} else {"/repo"},
                            "executionRequest":{"model_config":{"model_id":"current-backend-model"},
                                "origin":{"type":"board_task","dispatch_role":"executor"}}
                        }}))
                    }),
                );
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let mut ctx = context("caller");
                ctx.request.backend_url = Some(format!("http://{}/api", listener.local_addr().unwrap()));
                ctx.request.auth_token = Some("synthetic-token".into());
                let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
                let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
                for mode in ["native", "team", "cloud-model", "foreign-task", "foreign-workspace"] {
                    let mut intent = json!({"taskId":"target","workspacePath":"/repo","message":mode,
                        "modelSelection":{"modelName":"saved-model","modelType":if mode == "cloud-model" {"public"} else {"runtime"}},
                        "executionRequest":{"model_config":{"model_id":"device-owned-model"}},
                        "inheritModelConfiguration":true});
                    if mode == "team" {
                        intent["wegentTeamId"] = json!(7);
                    }
                    let result = handler.control_materialize_local(&ctx, intent, false).await;
                    if mode.starts_with("foreign-") {
                        assert_eq!(result.unwrap_err().code, "invalid_response");
                    } else {
                        let compiled = result.unwrap();
                        assert_eq!(compiled["executionRequest"]["model_config"]["model_id"],
                            if mode == "native" {"device-owned-model"} else {"current-backend-model"});
                        assert_eq!(compiled["executionRequest"]["origin"]["dispatch_role"], "executor");
                    }
                }
                server.abort();
            });
    }
}
