//! Persist async questions at the native notification publication boundary.
use super::*;
use std::sync::OnceLock;

static ISSUE_QUESTION_PUBLICATIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

impl RuntimeWorkRpcHandler {
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
                        store.report_issue_human_request(report["project_id"].as_str().unwrap_or_default(),report["issue_id"].as_str().unwrap_or_default(),&handler.device_id,&task,&item,report["question"].as_str().unwrap_or_default(),report["questions"].as_array().map(Vec::as_slice).unwrap_or_default()).map_err(|error| error.to_string())?;
                    } else {
                        let connection = handler.backend_connection_snapshot().map_err(|error| error.message)?.ok_or("Backend connection is unavailable")?;
                        let mut url = url::Url::parse(&format!("{}/api/v1/loop-items/", connection.backend_url.trim_end_matches('/'))).map_err(|error| error.to_string())?;
                        url.path_segments_mut().map_err(|_| "Invalid Backend URL")?.pop_if_empty().push(report["issue_id"].as_str().unwrap_or_default()).push("human-requests");
                        let response = crate::agents::backend_url::backend_http_client()?.post(url).bearer_auth(&connection.auth_token).json(&json!({"runtime_device_id":handler.device_id,"runtime_task_id":task,"item_id":item,"question":report["question"],"questions":report["questions"]})).send().await.map_err(|error| error.to_string())?;
                        if !response.status().is_success() {
                            if response.status().is_client_error() {
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
