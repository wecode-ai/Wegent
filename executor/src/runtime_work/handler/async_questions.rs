//! Persist async questions at the native notification publication boundary.
use super::*;
use std::sync::OnceLock;

static ISSUE_QUESTION_PUBLICATIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

impl RuntimeWorkRpcHandler {
    pub(super) fn unanswered_async_question_reply(
        &self,
        payload: &Value,
    ) -> Result<Option<(String, String)>, AppIpcError> {
        let Some(response) =
            request_user_input_response(payload).filter(|response| response["delivery"] == "async")
        else {
            return Ok(None);
        };
        let task_id = runtime_task_id(payload)
            .map(|id| self.canonical_local_task_id(&id))
            .ok_or_else(|| AppIpcError::new("bad_request", "taskId is required"))?;
        let link = self.local_task_link(&task_id);
        let key = json!([
            link.as_ref().and_then(runtime_session_id_from_link),
            response["interactionScope"],
            response["itemId"]
        ])
        .to_string();
        if link.is_some_and(|link| link.runtime_handle["answeredAsyncQuestions"][&key] == true) {
            return Err(AppIpcError::new(
                "stale_request_user_input",
                "This question already has an accepted answer",
            ));
        }
        Ok(Some((task_id, key)))
    }

    pub(super) async fn prepare_async_question_answer(
        &self,
        task_id: &str,
        response: &Value,
        payload: &Value,
    ) -> Result<PreparedQuestionReply, AppIpcError> {
        let transcript = self
            .transcript(json!({"taskId":task_id,"limit":1,"includeFullContent":true}))
            .await?;
        if !pending_async_question(&transcript, response) {
            return Err(AppIpcError::new(
                "stale_request_user_input",
                "This question is answered, expired, or belongs to another turn",
            ));
        }
        let link = self
            .local_task_link(task_id)
            .ok_or_else(|| AppIpcError::new("not_found", "Task no longer exists"))?;
        let saved = link
            .runtime_handle
            .get("executionRequest")
            .or_else(|| link.runtime_handle.get("execution_request"))
            .filter(|request| request.is_object())
            .ok_or_else(|| AppIpcError::new("bad_request", "Task execution request is missing"))?;
        let mut request = async_reply_execution_request(saved, payload)?;
        self.restore_question_execution_request(task_id, &mut request, &link.runtime_handle)?;
        let prepared = crate::agents::runtime_capabilities::prepare_user_input_response(
            request,
            response.clone(),
        )
        .await
        .map_err(|error| AppIpcError::new("attachment_preparation_failed", error))?;
        Ok(PreparedQuestionReply::Async {
            session: runtime_session_id_from_link(&link),
            answer: prepared,
        })
    }

    pub(super) async fn apply_prepared_async_question_reply(
        &self,
        task_id: &str,
        response: &Value,
        payload: &mut Value,
        prepared: Option<PreparedQuestionReply>,
    ) -> Result<(), AppIpcError> {
        let Some(PreparedQuestionReply::Async {
            session,
            answer: mut prepared,
        }) = prepared
        else {
            return Err(AppIpcError::new(
                "bad_request",
                "The question reply was not prepared",
            ));
        };
        let link = self
            .local_task_link(task_id)
            .ok_or_else(|| AppIpcError::new("not_found", "Task no longer exists"))?;
        let transcript = self
            .transcript(json!({"taskId":task_id,"limit":1,"includeFullContent":true}))
            .await?;
        if session != runtime_session_id_from_link(&link)
            || !pending_async_question(&transcript, response)
        {
            return Err(AppIpcError::new(
                "stale_request_user_input",
                "The question changed while preparing attachments",
            ));
        }
        if response["answers"].as_object().is_some_and(|answers| {
            answers.values().any(|answer| {
                answer["attachments"]
                    .as_array()
                    .is_some_and(|files| !files.is_empty())
            })
        }) {
            // Both guidance and a new turn must retain the question-to-file mapping.
            payload["message"] = json!(format!(
                "Question answers:\n{}",
                serde_json::to_string_pretty(&prepared.response["answers"])
                    .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?
            ));
            prepared.request.prompt = payload["message"].clone();
        }
        let client_user_message_id = prepared.request.subtask_id.clone();
        payload["attachments"] = prepared.request.extra["attachments"].clone();
        payload["executionRequest"] = serde_json::to_value(prepared.request)
            .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
        if let Some(selection) = link
            .runtime_handle
            .get("modelSelection")
            .or_else(|| link.runtime_handle.get("model_selection"))
        {
            payload["modelSelection"] = selection.clone();
        }
        let object = payload
            .as_object_mut()
            .expect("Runtime send payload is an object");
        object.remove("requestUserInputResponse");
        object.remove("request_user_input_response");
        object.insert("queueIfBusy".into(), json!(true));
        object.insert("clientUserMessageId".into(), json!(client_user_message_id));
        object.insert("clientGuidanceId".into(), json!(client_user_message_id));
        Ok(())
    }

    pub(super) fn persist_async_question_interaction(
        &self,
        task_id: &str,
        message: &CodexNotification,
    ) {
        let notification = codex_notification(message);
        if notification.method != "item/completed" {
            return;
        }
        let thread = codex_notification_thread_id(message);
        let turn = codex_notification_turn_id(message);
        let Some(payload) = crate::runtime_work::codex_user_input::async_question_payload_from_item(
            notification.params,
        ) else {
            return;
        };
        let mut changed = false;
        {
            let _guard = self
                .stand_in_lifecycle_gate
                .lock()
                .expect("turn lifecycle gate poisoned");
            self.store.update_task(task_id, |link| {
                if !question_belongs_to_current_turn(
                    link,
                    thread.as_deref(),
                    turn.as_deref(),
                    message.process_generation(),
                ) || link.interaction_status.as_deref() == Some(INTERACTION_AWAITING_USER_REPLY)
                {
                    return;
                }
                link.interaction_status = Some(INTERACTION_AWAITING_USER_REPLY.to_owned());
                link.updated_at = now_ms().max(link.updated_at);
                changed = true;
            });
        }
        if changed {
            emit_runtime_work_changed(&self.event_tx, &self.device_id, task_id);
        }
        if let Some(link) = self.local_task_link(task_id).filter(|link| {
            question_belongs_to_current_turn(
                link,
                thread.as_deref(),
                turn.as_deref(),
                message.process_generation(),
            )
        }) {
            let origin = &link.runtime_handle["origin"];
            let Some((project, issue)) = origin["cloudProjectId"]
                .as_str()
                .zip(origin["loopItemId"].as_str())
            else {
                return;
            };
            let Some(item) = payload["itemId"].as_str() else {
                return;
            };
            let question = payload["questions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|question| question["question"].as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let report = json!({"project_id":project,"issue_id":issue,"project_store":origin["projectStore"],"runtime_device_id":self.device_id,"runtime_task_id":task_id,"item_id":item,"question":question,"questions":payload["questions"]});
            self.store.update_task(task_id, |link| {
                if !link.runtime_handle["issueHumanRequestOutbox"].is_object() {
                    link.runtime_handle["issueHumanRequestOutbox"] = json!({});
                }
                if link.runtime_handle["issueHumanRequestOutbox"]
                    .get(item)
                    .is_none()
                {
                    link.runtime_handle["issueHumanRequestOutbox"][item] = report;
                }
            });
            self.sync_issue_human_requests(task_id);
        }
    }

    pub(super) fn sync_issue_human_requests(&self, task_id: &str) {
        let Some(link) = self.local_task_link(task_id) else {
            return;
        };
        let reports = link.runtime_handle["issueHumanRequestOutbox"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        for (item, report) in reports {
            if report.get("error").is_some() {
                continue;
            }
            let handler = self.clone();
            let task = task_id.to_owned();
            let Ok(runtime) = tokio::runtime::Handle::try_current() else {
                continue;
            };
            let key = format!("{}:{task}:{item}", self.device_id);
            if !ISSUE_QUESTION_PUBLICATIONS
                .get_or_init(Default::default)
                .lock()
                .expect("Issue question publication lock")
                .insert(key.clone())
            {
                continue;
            }
            runtime.spawn(async move {
                let result: Result<(),String> = async {
                    if report["project_store"] == "local" {
                        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).map_err(|error| error.to_string())?;
                        store.report_issue_human_request(crate::task_runtime::IssueHumanRequestScope { project_id: report["project_id"].as_str().unwrap_or_default(), issue_id: report["issue_id"].as_str().unwrap_or_default() },&handler.device_id,&task,&item,report["question"].as_str().unwrap_or_default(),report["questions"].as_array().map(Vec::as_slice).unwrap_or_default()).map_err(|error| error.to_string())?;
                    } else {
                        let connection = handler.backend_connection_snapshot().map_err(|error| error.message)?.ok_or("Backend connection is unavailable")?;
                        let mut url = url::Url::parse(&format!("{}/api/v1/loop-items/", connection.backend_url.trim_end_matches('/'))).map_err(|error| error.to_string())?;
                        url.path_segments_mut().map_err(|_| "Invalid Backend URL")?.pop_if_empty().push(report["issue_id"].as_str().unwrap_or_default()).push("human-requests");
                        let response = crate::agents::backend_url::backend_http_client()?.post(url).bearer_auth(&connection.auth_token).json(&json!({"runtime_device_id":handler.device_id,"runtime_task_id":task,"item_id":item,"question":report["question"],"questions":report["questions"]})).send().await.map_err(|error| error.to_string())?;
                        if !response.status().is_success() {
                            if is_permanent_question_rejection(response.status()) {
                                handler.store.update_task(&task,|link| { link.runtime_handle["issueHumanRequestOutbox"][&item]["error"] = json!(format!("Question publication rejected: {}",response.status())); });
                            }
                            return Err(format!("Question publication rejected: {}",response.status()));
                        }
                    }
                    Ok(())
                }.await;
                match result {
                    Ok(()) => { handler.store.update_task(&task,|link| { if let Some(outbox) = link.runtime_handle["issueHumanRequestOutbox"].as_object_mut() { outbox.remove(&item); } }); },
                    Err(error) => { log_executor_event("Issue question publication failed",&[("task_id",task),("question_id",item),("error",error)]); },
                }
                ISSUE_QUESTION_PUBLICATIONS.get_or_init(Default::default).lock().expect("Issue question publication lock").remove(&key);
            });
        }
    }
}

fn async_reply_execution_request(
    saved: &Value,
    payload: &Value,
) -> Result<ExecutionRequest, AppIpcError> {
    // Preserve the task's model, tools and identity, but replace per-message data.
    let mut request: ExecutionRequest = serde_json::from_value(saved.clone())
        .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?;
    let client_user_message_id = string_field(payload, "clientUserMessageId")
        .or_else(|| string_field(payload, "client_user_message_id"))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    request.subtask_id = client_user_message_id.clone();
    for key in [
        "client_user_message_id",
        "clientUserMessageId",
        "runtime_generated_user_message",
    ] {
        request.extra.remove(key);
    }
    request.extra.insert(
        "client_user_message_id".into(),
        json!(client_user_message_id),
    );
    request.prompt = payload["message"].clone();
    request.history.clear();
    request.message_id = None;
    request.extra.insert(
        "attachments".into(),
        payload
            .get("attachments")
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    Ok(request)
}

fn pending_async_question(transcript: &Value, response: &Value) -> bool {
    let mut pending = false;
    for (turn, item) in transcript["turns"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|turn| {
            turn["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(move |item| (turn, item))
        })
    {
        if item["type"] == "user_message" {
            pending = false;
        }
        let block = &item["block"];
        let Some(question) = block
            .get("render_payload")
            .or_else(|| block.get("renderPayload"))
        else {
            continue;
        };
        if question["delivery"] != "async"
            || question["itemId"] != response["itemId"]
            || question["interactionScope"] != response["interactionScope"]
        {
            continue;
        }
        pending = !matches!(turn["status"].as_str(), Some("error" | "cancelled"))
            && question["response"].is_null()
            && question["expiresAtUnixMs"]
                .as_i64()
                .is_none_or(|deadline| deadline > now_ms())
            && !matches!(
                question["interactionStatus"].as_str(),
                Some("answered" | "cancelled" | "expired")
            );
    }
    pending
}

pub(super) fn is_permanent_question_rejection(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 400 | 404 | 409 | 422)
}

fn question_belongs_to_current_turn(
    link: &RuntimeTaskLink,
    thread: Option<&str>,
    turn: Option<&str>,
    process_generation: u64,
) -> bool {
    if matches!(link.status.as_str(), "failed" | "cancelled" | "archived")
        || link
            .interaction_status
            .as_deref()
            .is_some_and(|status| status != INTERACTION_AWAITING_USER_REPLY)
        || thread
            .zip(link.thread_id.as_deref())
            .is_some_and(|(question, root)| question != root)
    {
        return false;
    }
    // Native lifecycle identity remains authoritative after RPC observers finish.
    let native = crate::runtime_work::lifecycle::native_execution_state(link);
    if native
        .as_ref()
        .and_then(|state| state.process_generation)
        .is_some_and(|current| current != process_generation)
    {
        return false;
    }
    let current_turn = native
        .as_ref()
        .and_then(|state| state.turn_id.as_deref().or(state.latest_turn_id.as_deref()))
        .or_else(|| link.runtime_handle["lastTurnId"].as_str());
    !turn.is_some_and(|turn| current_turn.is_some_and(|current| turn != current))
}

#[cfg(test)]
mod reply_tests {
    use super::*;

    fn transcript() -> Value {
        json!({"turns":[{"items":[{"type":"block","block":{"render_payload":{
            "delivery":"async","itemId":"question","interactionScope":"turn"
        }}}]}]})
    }

    #[tokio::test]
    async fn async_reply_replaces_message_files_without_replacing_the_task_identity() {
        let saved = json!({
            "task_id":"task", "subtask_id":"turn", "model_config":{"model_id":"original"},
            "system_prompt":"Keep the task permissions", "history":[{"role":"user","content":"old"}],
            "message_id":42, "attachments":[{"id":1,"original_filename":"old.txt"}]
        });
        let files = json!([
            {"id":-1,"original_filename":"brief.txt","local_path":"/tmp/brief.txt","status":"ready"}
        ]);
        let payload = json!({
            "message":"First line\nSecond line", "attachments":files,
            "executionRequest":{"model_config":{"model_id":"foreign"},"system_prompt":"foreign"}
        });
        let request = async_reply_execution_request(&saved, &payload).unwrap();
        assert_eq!(request.task_id, "task");
        assert_eq!(request.model_config["model_id"], "original");
        assert_eq!(request.system_prompt, "Keep the task permissions");
        assert_eq!(request.prompt, payload["message"]);
        assert!(request.history.is_empty());
        assert!(request.message_id.is_none());
        assert_eq!(request.extra["attachments"], files);
        let prepared = crate::agents::runtime_capabilities::prepare_user_input_response(
            request,
            json!({"answers":{"q":{"answers":["First line\nSecond line"],"attachments":[{"id":-1}]}}}),
        ).await.unwrap();
        assert_eq!(prepared.request.extra["attachments"], files);
        assert_eq!(prepared.request.prompt, payload["message"]);
        assert!(prepared.response["answers"]["q"]["answers"][1]
            .as_str()
            .unwrap()
            .contains("/tmp/brief.txt"));
        let without_files =
            async_reply_execution_request(&saved, &json!({"message":"Text only"})).unwrap();
        assert_eq!(without_files.extra["attachments"], json!([]));
    }

    #[test]
    fn async_reply_has_its_own_user_message_identity() {
        let saved = json!({
            "task_id":"task", "subtask_id":"original-subtask",
            "client_user_message_id":"original-user", "clientUserMessageId":"original-user",
            "runtime_generated_user_message":{"id":"original-user", "message":"Original prompt"}
        });
        for client_id in [None, Some("answer-user")] {
            let mut payload = json!({"message":"STAFF\nPDF\nTomorrow"});
            if let Some(id) = client_id {
                payload["clientUserMessageId"] = json!(id);
            }
            let mut request = async_reply_execution_request(&saved, &payload).unwrap();
            apply_runtime_payload_metadata(&mut request, &payload);
            assert_ne!(request.subtask_id, "original-subtask");
            assert_ne!(request.extra["client_user_message_id"], "original-user");
            assert!(!request.extra.contains_key("clientUserMessageId"));
            assert!(!request.extra.contains_key("runtime_generated_user_message"));
            if let Some(id) = client_id {
                assert_eq!(request.subtask_id, id);
                assert_eq!(request.extra["client_user_message_id"], id);
            }
        }
    }

    #[test]
    fn async_replies_require_the_exact_pending_question_and_turn() {
        let response = json!({"itemId":"question","interactionScope":"turn"});
        assert!(pending_async_question(&transcript(), &response));
        for wrong in [
            json!({"itemId":"other","interactionScope":"turn"}),
            json!({"itemId":"question","interactionScope":"other"}),
        ] {
            assert!(!pending_async_question(&transcript(), &wrong));
        }
        let mut answered = transcript();
        answered["turns"][0]["items"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"user_message"}));
        assert!(!pending_async_question(&answered, &response));
        for status in ["answered", "cancelled", "expired"] {
            let mut settled = transcript();
            settled["turns"][0]["items"][0]["block"]["render_payload"]["interactionStatus"] =
                json!(status);
            assert!(!pending_async_question(&settled, &response));
        }
        let mut expired = transcript();
        expired["turns"][0]["items"][0]["block"]["render_payload"]["expiresAtUnixMs"] =
            json!(now_ms() - 1);
        assert!(!pending_async_question(&expired, &response));
        expired["turns"][0]["items"][0]["block"]["render_payload"]["expiresAtUnixMs"] =
            json!(now_ms() + 60_000);
        assert!(pending_async_question(&expired, &response));
    }
}
