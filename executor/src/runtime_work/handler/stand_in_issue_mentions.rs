//! Mention notifications are hints; the persisted comment and live project grant authorize intake.
use super::stand_in::settings_error;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn collect_stand_in_issue_events(&self) -> Result<(), AppIpcError> {
        let Some(connection) = self.backend_connection_snapshot()? else {
            return Ok(());
        };
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let settings = store
            .all_personal_stand_ins(&self.device_id)
            .map_err(settings_error)?;
        if !settings.iter().any(|settings| {
            crate::task_runtime::personal_stand_in::stand_in_identities(settings)
                .iter()
                .any(|role| role["enabled"] == true && role["collaboration"]["enabled"] == true)
        }) {
            return Ok(());
        }
        let user = self
            .runtime_http(reqwest::Method::GET, "/users/me", None)
            .await?["id"]
            .as_i64()
            .ok_or_else(|| AppIpcError::new("permission_denied", "Issue event owner is missing"))?;
        if !settings
            .iter()
            .any(|settings| settings["userId"] == user && settings["lifecycle"]["status"].is_null())
        {
            return Ok(());
        }
        let source = json!({"providerId":"wework/issue-events","profile":user.to_string(),"kind":"issue_inbox","id":connection.backend_url});
        let cursor = store
            .stand_in_source(user, &source)
            .map_err(settings_error)?["cursor"]
            .as_i64()
            .unwrap_or(0);
        let page = self
            .runtime_http(
                reqwest::Method::GET,
                &format!("/v1/stand-in-issue-events?after={cursor}"),
                None,
            )
            .await?;
        let mut next = cursor;
        for event in page["events"].as_array().into_iter().flatten() {
            let mut payload = event["payload"].clone();
            payload["recipientUserId"] = json!(user);
            store.queue_stand_in_dispatch(&json!({"backendUrl":connection.backend_url,"deviceId":self.device_id,"userId":user,"notification":payload})).map_err(settings_error)?;
            next = event["sequence"].as_i64().ok_or_else(|| {
                AppIpcError::new("cloud_response_invalid", "Issue event sequence is missing")
            })?;
        }
        // Queue first: a crash before this checkpoint redelivers the same durable intent.
        store
            .save_stand_in_source(user, &source, &json!({"cursor":next}))
            .map_err(settings_error)?;
        Ok(())
    }

    pub(super) async fn read_stand_in_issue_mention(
        &self,
        origin: &Value,
    ) -> Result<Value, AppIpcError> {
        let project = origin["cloudProjectId"].as_str().unwrap_or_default();
        let issue = origin["loopItemId"].as_str().unwrap_or_default();
        let comment = origin["triggerCommentId"].as_str().unwrap_or_default();
        self.verify_runtime_user(origin).await?;
        let mut path = url::Url::parse("http://local/").unwrap();
        path.set_path(&format!(
            "/v1/cloud-projects/{project}/loop-items/{issue}/activity-comments"
        ));
        path.query_pairs_mut().append_pair("message_id", comment);
        let response = self
            .runtime_request(
                reqwest::Method::GET,
                &format!("{}?{}", path.path(), path.query().unwrap_or_default()),
                None,
            )
            .await?;
        if matches!(response.status().as_u16(), 403 | 404) {
            return Err(AppIpcError::new(
                "source_removed",
                "Issue mention access was revoked",
            ));
        }
        if !response.status().is_success() {
            return Err(AppIpcError::new(
                "cloud_request_failed",
                format!("Issue mention returned {}", response.status()),
            ));
        }
        let result: Value = response
            .json()
            .await
            .map_err(|error| AppIpcError::new("cloud_response_invalid", error.to_string()))?;
        result
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| {
                row["id"] == comment
                    && row["mentions"].as_array().is_some_and(|mentions| {
                        mentions.iter().any(|mention| {
                            mention["type"] == "user"
                                && mention["id"].as_str()
                                    == origin["userId"]
                                        .as_i64()
                                        .map(|user| user.to_string())
                                        .as_deref()
                        })
                    })
            })
            .cloned()
            .ok_or_else(|| {
                AppIpcError::new(
                    "source_removed",
                    "The original Issue mention no longer exists",
                )
            })
    }

    pub(super) async fn process_stand_in_issue_mention(
        &self,
        payload: Value,
    ) -> Result<(), AppIpcError> {
        let project = payload["projectId"]
            .as_str()
            .ok_or_else(|| AppIpcError::new("bad_request", "Mention project is missing"))?;
        let issue_id = payload["itemId"]
            .as_str()
            .ok_or_else(|| AppIpcError::new("bad_request", "Mention Issue is missing"))?;
        let user = payload["recipientUserId"]
            .as_i64()
            .ok_or_else(|| AppIpcError::new("bad_request", "Mention owner is missing"))?;
        let origin = json!({"cloudProjectId":project,"loopItemId":issue_id,"triggerCommentId":payload["commentId"],"userId":user});
        let comment = self.read_stand_in_issue_mention(&origin).await?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(settings_error)?;
        if !settings["lifecycle"]["status"].is_null() {
            return Ok(());
        }
        let configs = self.stand_in_project_configs(&[settings], project, "cloud");
        let issue = self
            .runtime_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}"),
                None,
            )
            .await?;
        if issue["cloud_project_id"] != project {
            return Err(AppIpcError::new(
                "permission_denied",
                "Mention project does not match",
            ));
        }
        let gate = self.task_send_gate(&format!("stand-in-issue:{project}:{issue_id}"));
        let _guard = gate.lock().await;
        let existing = self
            .runtime_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}/tasks"),
                None,
            )
            .await?;
        let mut eligible = Vec::new();
        for config in super::personal_stand_in::matching_personal_roles(&configs, &issue) {
            if comment["stand_in_reply_to"]["role_id"]
                .as_str()
                .is_some_and(|role| config["id"] != role)
            {
                continue;
            }
            if config["enabled"] != true
                || config["handlingPolicy"]["automatic"] != true
                || !super::stand_in::assignment_after_enable(
                    &json!({"created_at":comment["created_at"]}),
                    config,
                )
            {
                continue;
            }
            let mut config = config.clone();
            config["triggerCommentId"] = payload["commentId"].clone();
            config["triggerMessage"] = comment["body"].clone();
            config["intakeRouted"] = json!(true);
            eligible.push(config);
        }
        let binding = json!({"humanAssignmentId":format!("mention:{}",payload["commentId"].as_str().unwrap_or_default()),"triggerCommentId":payload["commentId"]});
        self.dispatch_cloud_stand_in_roles(
            &eligible.iter().collect::<Vec<_>>(),
            &issue,
            &binding,
            &existing,
        )
        .await
    }
}
