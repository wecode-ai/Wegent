//! Host-bound traversal of authorized connection history for the active memory review.
use super::stand_in::settings_error;
use super::stand_in_ingress::message_time;
use super::*;
use crate::runtime_work::automations::AutomationRun;
use crate::task_runtime::mcp::StandInMcpIdentity;
use crate::task_runtime::personal_stand_in::ISSUE_COMMENTS_PROVIDER;
use std::collections::BTreeMap;

pub(super) const SOURCE_PREFIX: &str = "training-source:";
const LIST_PREFIX: &str = "training-list:";
const FIRST_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Default)]
pub(super) struct TrainingPreflight {
    // Only snapshot identifiers and error codes are cached, never provider text.
    pages: BTreeMap<String, String>,
    unavailable: BTreeMap<String, String>,
}

fn denied() -> AppIpcError {
    AppIpcError::new(
        "permission_denied",
        "Training evidence is not available for this review",
    )
}

fn source_id(binding: &Value) -> String {
    LocalTaskStore::training_source_id(
        binding["roleId"].as_str().unwrap_or_default(),
        &binding["source"],
    )
}

fn coverage_since(
    binding: &Value,
    since: i64,
    through: i64,
    page: &Value,
) -> Result<Option<i64>, AppIpcError> {
    let source = &binding["source"];
    let complete = page["reviewCoverage"] == "complete"
        && page["coverageGap"].is_null()
        && page["priorContextPartial"] != true
        && page["priorContextUnavailable"].is_null()
        && page["messages"].as_array().is_some_and(|messages| {
            messages.iter().all(|message| {
                matches!(
                    message["author"].as_str(),
                    Some("assistant" | "owner" | "participant")
                ) && message["truncated"] != true
            })
        });
    let start = since.max(message_time(&source["enabledAfter"])?);
    Ok((complete && start < through).then_some(start))
}

fn window_start(through: i64, state: &Value) -> i64 {
    state["completedThrough"]
        .as_i64()
        .filter(|time| *time > 0)
        .unwrap_or_else(|| through.saturating_sub(FIRST_WINDOW_MS).max(0))
}

fn next_cursor<'a>(
    page: &'a Value,
    previous: Option<&Value>,
) -> Result<Option<&'a Value>, AppIpcError> {
    if page["hasMore"] != true {
        return Ok(None);
    }
    let cursor = &page["nextCursor"];
    if cursor
        .as_str()
        .or_else(|| cursor["collectedEvents"].as_str())
        .is_some_and(|token| !token.is_empty())
        && Some(cursor) != previous
    {
        Ok(Some(cursor))
    } else {
        Err(AppIpcError::new(
            "incomplete_history",
            "Connection page did not advance",
        ))
    }
}

impl RuntimeWorkRpcHandler {
    async fn authorize_training_binding(
        &self,
        store: &LocalTaskStore,
        user: i64,
        binding: &Value,
    ) -> Result<(), AppIpcError> {
        if binding["source"]["providerId"] == ISSUE_COMMENTS_PROVIDER {
            self.authorize_issue_training_source(
                store,
                user,
                binding["roleId"].as_str().ok_or_else(denied)?,
                &binding["source"],
            )
            .await?;
        }
        Ok(())
    }

    async fn current_training_binding(
        &self,
        store: &LocalTaskStore,
        user: i64,
        source: &str,
    ) -> Result<Value, AppIpcError> {
        let binding = self
            .training_connection_sources(store, user)?
            .into_iter()
            .find(|binding| source_id(binding) == source)
            .ok_or_else(denied)?;
        self.authorize_training_binding(store, user, &binding)
            .await?;
        Ok(binding)
    }

    fn training_page_directory(&self) -> PathBuf {
        // All reviews share the TTL cleanup directory; the immutable envelope binds access.
        super::super::transcript_transport::snapshot_directory(
            self.store.index_path().parent().unwrap(),
            &json!({"taskId":"@stand-in-training-pages","threadId":"@connection-evidence"}),
        )
    }

    async fn fetch_training_page(
        &self,
        store: &LocalTaskStore,
        user: i64,
        binding: &Value,
        since: i64,
        through: i64,
        cursor: Option<&Value>,
    ) -> Result<Value, AppIpcError> {
        let role = binding["roleId"].as_str().ok_or_else(denied)?;
        self.training_connection_page(
            store,
            user,
            role,
            &binding["source"],
            since..through,
            cursor,
        )
        .await
    }

    async fn cache_training_page(
        &self,
        run: &str,
        source: &str,
        page: Value,
    ) -> Result<String, AppIpcError> {
        let directory = self.training_page_directory();
        let envelope = json!({"run":run,"source":source,"page":page});
        super::super::transcript_work::run(move |cancel| {
            super::super::transcript_transport::store_native_page(&directory, &envelope, cancel)
        })
        .await
    }

    async fn add_preceding_context(
        &self,
        store: &LocalTaskStore,
        user: i64,
        binding: &Value,
        since: i64,
        page: &mut Value,
    ) {
        // A reply just after the watermark may refer to a request in the prior window.
        let earlier = self
            .fetch_training_page(
                store,
                user,
                binding,
                since.saturating_sub(FIRST_WINDOW_MS),
                since,
                None,
            )
            .await;
        match earlier {
            Ok(mut earlier) => {
                page["priorContextPartial"] = json!(
                    earlier["hasMore"] == true
                        || earlier["coverageGap"].is_object()
                        || earlier["reviewCoverage"] != "complete"
                );
                if let (Some(prior), Some(current)) = (
                    earlier["messages"].as_array_mut(),
                    page["messages"].as_array_mut(),
                ) {
                    for message in prior.iter_mut() {
                        message["contextOnly"] = json!(true);
                    }
                    current.append(prior);
                }
            }
            Err(error) => page["priorContextUnavailable"] = json!(error.code),
        }
    }

    async fn cached_training_page(
        &self,
        run: &str,
        source: &str,
        token: &str,
    ) -> Result<Value, AppIpcError> {
        let directory = self.training_page_directory();
        let token = token.to_owned();
        let mut envelope = super::super::transcript_work::run(move |cancel| {
            super::super::transcript_transport::read_native_page(&directory, &token, cancel)
        })
        .await?;
        if envelope["run"] != run || envelope["source"] != source {
            return Err(denied());
        }
        Ok(envelope["page"].take())
    }

    async fn preflight_training_source(
        &self,
        store: &LocalTaskStore,
        user: i64,
        run: &str,
        through: i64,
        binding: &Value,
    ) -> Result<Option<String>, AppIpcError> {
        let source = source_id(binding);
        let gate = self.task_send_gate(&format!("memory-source:{user}:{source}"));
        let _guard = gate.lock().await;
        let state = store
            .memory_review_progress(user, &source)
            .map_err(settings_error)?;
        let since = window_start(through, &state);
        if since >= through {
            return Ok(None);
        }
        let mut cursor = None;
        let mut visited = HashSet::new();
        let mut gap = Value::Null;
        let mut complete = true;
        loop {
            let mut page = self
                .fetch_training_page(store, user, binding, since, through, cursor.as_ref())
                .await?;
            complete &= page["reviewCoverage"] == "complete";
            if page["coverageGap"].is_object() {
                gap = page["coverageGap"].clone();
            }
            let next = next_cursor(&page, cursor.as_ref())?.cloned();
            if page["messages"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty())
            {
                if !complete {
                    page["reviewCoverage"] = json!("partial");
                }
                if !gap.is_null() {
                    page["coverageGap"] = gap;
                }
                if state["completedThrough"].as_i64().is_some_and(|at| at > 0) {
                    self.add_preceding_context(store, user, binding, since, &mut page)
                        .await;
                }
                return self.cache_training_page(run, &source, page).await.map(Some);
            }
            match next {
                Some(next) if visited.insert(next.clone()) => cursor = Some(next),
                Some(_) => {
                    return Err(AppIpcError::new(
                        "incomplete_history",
                        "Connection pagination repeated a cursor",
                    ))
                }
                None => break,
            }
        }
        self.current_training_binding(store, user, &source).await?;
        let current_run = self
            .automation_store
            .get_run(run)
            .filter(|item| {
                matches!(
                    item.status,
                    AutomationRunStatus::Pending | AutomationRunStatus::Running
                )
            })
            .ok_or_else(denied)?;
        self.current_arrangement(&current_run)?;
        let recorded = store
            .record_memory_review_page(
                user,
                &source,
                run,
                through,
                state["version"].as_i64().unwrap_or(0),
                json!([]),
                coverage_since(
                    binding,
                    since,
                    through,
                    &json!({"messages":[],"coverageGap":gap,"reviewCoverage":if complete {"complete"} else {"partial"}}),
                )?,
            )
            .map_err(settings_error)?;
        store
            .complete_memory_review_source(
                user,
                &source,
                run,
                recorded["version"].as_i64().unwrap_or(0),
                true,
            )
            .map_err(settings_error)?;
        if !gap.is_null() {
            return Err(AppIpcError::new(
                "connection_history_expired",
                "Earlier connection history exceeded the provider read window",
            ));
        }
        Ok(None)
    }

    async fn training_preflight(
        &self,
        store: &LocalTaskStore,
        user: i64,
        run: &str,
        through: i64,
    ) -> Result<TrainingPreflight, AppIpcError> {
        let gate = self.task_send_gate(&format!("training-preflight:{run}"));
        let _guard = gate.lock().await;
        if let Some(cached) = self
            .training_preflights
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(run)
            .cloned()
        {
            return Ok(cached);
        }
        let sources = self.training_connection_sources(store, user)?;
        Ok(self
            .scan_training_sources(store, user, run, through, sources)
            .await)
    }

    async fn scan_training_sources(
        &self,
        store: &LocalTaskStore,
        user: i64,
        run: &str,
        through: i64,
        sources: Vec<Value>,
    ) -> TrainingPreflight {
        let mut result = TrainingPreflight::default();
        for binding in sources {
            let id = source_id(&binding);
            match self
                .preflight_training_source(store, user, run, through, &binding)
                .await
            {
                Ok(Some(token)) => {
                    result.pages.insert(id, token);
                }
                Ok(None) => {}
                Err(error) => {
                    log_executor_event(
                        "connection training source unavailable",
                        &[("source", id.clone()), ("code", error.code.clone())],
                    );
                    result.unavailable.insert(id, error.code);
                }
            }
        }
        let mut cache = self
            .training_preflights
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        cache.retain(|id, _| {
            self.automation_store.get_run(id).is_some_and(|run| {
                matches!(
                    run.status,
                    AutomationRunStatus::Pending | AutomationRunStatus::Running
                )
            })
        });
        cache.insert(run.to_owned(), result.clone());
        result
    }

    pub(super) fn connection_training_due(
        &self,
        store: &LocalTaskStore,
        user: i64,
        run: &AutomationRun,
    ) -> Result<bool, AppIpcError> {
        // Provider I/O must never hold the per-account routing and settings gate.
        let gate = self.task_send_gate(&format!("training-preflight:{}", run.id));
        let Ok(guard) = gate.try_lock_owned() else {
            return Ok(false);
        };
        let scan = self
            .training_preflights
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&run.id)
            .cloned();
        let Some(scan) = scan else {
            match self.training_connection_sources(store, user) {
                Ok(sources) if sources.is_empty() => {
                    self.settle_arrangement(run, AutomationRunStatus::Succeeded, None, None)?
                }
                Ok(sources) => {
                    let handler = self.clone();
                    let store = store.clone();
                    let run = run.clone();
                    tokio::spawn(async move {
                        let _guard = guard;
                        handler
                            .scan_training_sources(
                                &store,
                                user,
                                &run.id,
                                run.scheduled_for.timestamp_millis(),
                                sources,
                            )
                            .await;
                    });
                }
                Err(error) => self.settle_arrangement(
                    run,
                    AutomationRunStatus::NeedsAttention,
                    None,
                    Some(error.code),
                )?,
            }
            return Ok(false);
        };
        let grants = self
            .training_connection_sources(store, user)?
            .into_iter()
            .map(|binding| source_id(&binding))
            .collect::<HashSet<_>>();
        if scan.pages.keys().any(|id| grants.contains(id)) {
            return Ok(true);
        }
        let mut codes = scan
            .unavailable
            .into_iter()
            .filter(|(id, _)| grants.contains(id))
            .map(|(_, code)| code)
            .collect::<Vec<_>>();
        if codes.is_empty() {
            self.settle_arrangement(run, AutomationRunStatus::Succeeded, None, None)?;
        } else {
            let count = codes.len();
            codes.sort_unstable();
            codes.dedup();
            self.settle_arrangement(
                run,
                AutomationRunStatus::NeedsAttention,
                None,
                Some(format!(
                    "Unable to read {count} connection histories: {}",
                    codes.join(", ")
                )),
            )?;
        }
        Ok(false)
    }

    pub(super) fn is_training_list_cursor(args: &Value) -> bool {
        args["cursor"]
            .as_str()
            .is_some_and(|cursor| cursor.starts_with(LIST_PREFIX))
    }

    pub(super) async fn append_training_sources(
        &self,
        store: &LocalTaskStore,
        identity: &StandInMcpIdentity,
        args: &Value,
        mut page: Value,
    ) -> Result<Value, AppIpcError> {
        if page["hasMore"] == true {
            return Ok(page);
        }
        let continuation = args["cursor"]
            .as_str()
            .and_then(|cursor| cursor.strip_prefix(LIST_PREFIX));
        let (run, through) = self.memory_review_window(store, identity)?;
        let scan = self
            .training_preflight(store, identity.user, &run, through)
            .await?;
        let grants: BTreeMap<_, _> = self
            .training_connection_sources(store, identity.user)?
            .into_iter()
            .map(|binding| (source_id(&binding), binding))
            .collect();
        self.memory_review_window(store, identity)?;
        page["unavailableConnections"] = json!(scan
            .unavailable
            .iter()
            .filter(|(id, _)| grants.contains_key(*id))
            .map(|(id, code)| json!({"taskId":id,"code":code}))
            .collect::<Vec<_>>());
        let limit = args["limit"].as_u64().unwrap_or(50) as usize;
        if !(1..=50).contains(&limit) {
            return Err(AppIpcError::new("bad_request", "limit must be 1-50"));
        }
        let mut items = page["items"].take().as_array().cloned().unwrap_or_default();
        let mut last_connection = continuation.unwrap_or("");
        let mut more = false;
        for id in scan
            .pages
            .keys()
            .filter(|id| id.as_str() > continuation.unwrap_or(""))
        {
            let Some(binding) = grants.get(id) else {
                continue;
            };
            if self
                .authorize_training_binding(store, identity.user, binding)
                .await
                .is_err()
            {
                continue;
            }
            let state = store
                .memory_review_progress(identity.user, id)
                .map_err(settings_error)?;
            if state["completedThrough"].as_i64().unwrap_or(0) >= through {
                continue;
            }
            if items.len() == limit {
                more = true;
                break;
            }
            last_connection = id;
            items.push(
                json!({"taskId":id, "kind":"connection", "trainingEligible":true,
                "roleId":binding["roleId"], "source":binding["source"], "canContinue":false}),
            );
        }
        page["items"] = Value::Array(items);
        page["nextCursor"] = json!(more.then(|| format!("{LIST_PREFIX}{last_connection}")));
        page["hasMore"] = json!(more);
        Ok(page)
    }

    pub(super) async fn training_progress_operation(
        &self,
        store: &LocalTaskStore,
        identity: &StandInMcpIdentity,
        name: &str,
        args: &Value,
        source: &str,
    ) -> Result<Value, AppIpcError> {
        let (run, through) = self.memory_review_window(store, identity)?;
        let binding = self
            .current_training_binding(store, identity.user, source)
            .await?;
        let state = store
            .memory_review_progress(identity.user, source)
            .map_err(settings_error)?;
        let version = state["version"].as_i64().unwrap_or(0);
        if name == "complete_memory_source" {
            return store
                .complete_memory_review_source(
                    identity.user,
                    source,
                    &run,
                    version,
                    args["reworkReviewComplete"] == true,
                )
                .map_err(settings_error);
        }
        let since = window_start(through, &state);
        if since >= through {
            return Err(AppIpcError::new(
                "source_completed",
                "Connection history already completed",
            ));
        }
        let continuing =
            state["runId"] == run && state["readStarted"] == true && args["restart"] != true;
        let pending = state["pending"]
            .as_array()
            .and_then(|pending| pending.first());
        let writes = state["pendingWrites"].as_array().map_or(0, Vec::len);
        if continuing && pending.is_none() {
            return Ok(
                json!({"taskId":source,"historyReadComplete":true,"readyToComplete":writes==0,"pendingWriteCount":writes,"version":version}),
            );
        }
        let cursor = if continuing { pending } else { None };
        let cached = if cursor.is_none() && args["restart"] != true {
            self.training_preflights
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get(&run)
                .and_then(|scan| scan.pages.get(source))
                .cloned()
        } else {
            None
        };
        let (page, token) = if let Some(token) = cached {
            (
                self.cached_training_page(&run, source, &token).await?,
                token,
            )
        } else {
            let mut page = self
                .fetch_training_page(store, identity.user, &binding, since, through, cursor)
                .await?;
            if cursor.is_none()
                && state["completedThrough"].as_i64().is_some_and(|at| at > 0)
                && page["messages"]
                    .as_array()
                    .is_some_and(|messages| !messages.is_empty())
            {
                self.add_preceding_context(store, identity.user, &binding, since, &mut page)
                    .await;
            }
            let token = self.cache_training_page(&run, source, page.clone()).await?;
            (page, token)
        };
        self.memory_review_window(store, identity)?;
        self.current_training_binding(store, identity.user, source)
            .await?;
        let next = next_cursor(&page, cursor)?;
        let state = store
            .record_memory_review_page(
                identity.user,
                source,
                &run,
                through,
                version,
                json!(next.into_iter().collect::<Vec<_>>()),
                coverage_since(&binding, since, through, &page)?,
            )
            .map_err(settings_error)?;
        Ok(
            json!({"page":page,"readArguments":{"taskId":source,"pageToken":token},"version":state["version"],"pendingWriteCount":writes,
            "historyReadComplete":next.is_none(),"readyToComplete":next.is_none() && writes==0}),
        )
    }

    pub(super) async fn verified_connection_training_message(
        &self,
        identity: &StandInMcpIdentity,
        task_id: &str,
        reference: &Value,
    ) -> Result<(Value, Value), AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let (run, _) = self.memory_review_window(&store, identity)?;
        self.current_training_binding(&store, identity.user, task_id)
            .await?;
        let args = &reference["readArguments"];
        if args["taskId"] != task_id {
            return Err(denied());
        }
        let token = args["pageToken"].as_str().ok_or_else(denied)?;
        let page = self.cached_training_page(&run, task_id, token).await?;
        let id = reference["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(denied)?;
        let excerpt = reference["excerpt"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 2000)
            .ok_or_else(denied)?;
        let mut matching = page["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|message| message["id"] == id);
        let message = matching.next().cloned().ok_or_else(denied)?;
        if matching.next().is_some()
            || !message["content"]
                .as_str()
                .is_some_and(|text| text.contains(excerpt))
        {
            return Err(denied());
        }
        self.memory_review_window(&store, identity)?;
        let binding = self
            .current_training_binding(&store, identity.user, task_id)
            .await?;
        Ok((binding, message))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fully_observable_pages_prove_rework_coverage() {
        let source = json!({"roleId":"@primary","source":{"kind":"direct","enabledAfter":"1970-01-01T00:00:01Z"}});
        let page =
            json!({"reviewCoverage":"complete","messages":[{"author":"owner","truncated":false}]});
        let evaluate =
            |source: &Value, page: &Value| coverage_since(source, 0, 2000, page).unwrap();
        assert_eq!(evaluate(&source, &page), Some(1000));
        let mut group = source.clone();
        group["source"]["kind"] = json!("group");
        assert_eq!(
            evaluate(&group, &json!({"reviewCoverage":"partial","messages":[]})),
            None
        );
        assert_eq!(evaluate(&group, &page), Some(1000));
        assert_eq!(evaluate(&source, &json!({"messages":[]})), None);
        for mut page in [
            json!({"messages":[],"coverageGap":{"through":1300}}),
            json!({"messages":[],"priorContextPartial":true}),
            json!({"messages":[],"priorContextUnavailable":"timeout"}),
            json!({"messages":[{"author":"unknown"}]}),
            json!({"messages":[{"author":"owner","truncated":true}]}),
        ] {
            page["reviewCoverage"] = json!("complete");
            assert_eq!(evaluate(&source, &page), None);
        }
    }

    #[tokio::test]
    async fn evidence_page_requires_live_same_run_source_and_learning_grant() {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        handler.automation_store = AutomationStore::new(root.path().join("automations.json"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        store.materialize_implicit_primary(7, "mac").unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"]["connections"] = json!([{"providerId":crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER,
            "kind":"direct","profile":"work","id":"one","name":"One",
            "policy":{"automatic":false,"askBeforeAct":true}}]);
        let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        assert!(handler
            .training_connection_sources(&store, 7)
            .unwrap()
            .is_empty());
        settings["primary"]["selfLearningEnabled"] = json!(true);
        let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
        let binding = handler
            .training_connection_sources(&store, 7)
            .unwrap()
            .pop()
            .unwrap();
        let source = source_id(&binding);
        let review = handler
            .automation_store
            .create(crate::runtime_work::automations::memory_review(7, "mac").unwrap())
            .unwrap();
        let (_, run) = handler
            .automation_store
            .start_manual_run(&review.id)
            .unwrap();
        let task = run.coordination.as_ref().unwrap().task_id.clone();
        handler.upsert_local_task(RuntimeTaskLink {local_task_id:task.clone(),runtime_handle:json!({
            "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
            "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
        }),..Default::default()});
        let identity = StandInMcpIdentity {
            task_id: task,
            user: 7,
            device: "mac".into(),
            role: Some("@primary".into()),
            work: None,
            ask_before_act: true,
            coordinator_batch: None,
            project: None,
            review: false,
            memory_review: true,
            readonly_worker: false,
        };
        let page = json!({"messages":[{"id":"response","author":"owner","content":"Please include the original date."}],"hasMore":false});
        let token = handler
            .cache_training_page(&run.id, &source, page)
            .await
            .unwrap();
        handler.training_preflights.lock().unwrap().insert(
            run.id.clone(),
            TrainingPreflight {
                pages: BTreeMap::from([(source.clone(), token.clone())]),
                ..Default::default()
            },
        );
        assert!(handler.connection_training_due(&store, 7, &run).unwrap());
        let listed = handler
            .memory_progress_operation(&identity, "list_memory_sources", &json!({}))
            .await
            .unwrap();
        assert!(listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["taskId"] == source && item["trainingEligible"] == true));
        let args = json!({"taskId":source});
        let read = handler
            .memory_progress_operation(&identity, "next_memory_page", &args)
            .await
            .unwrap();
        assert_eq!(read["readyToComplete"], true);
        assert_eq!(read["readArguments"]["pageToken"], token);
        assert_eq!(
            store.memory_review_progress(7, &source).unwrap()["completedThrough"],
            0
        );
        assert!(handler
            .cached_training_page("another-run", &source, &token)
            .await
            .is_err());
        assert!(handler
            .cached_training_page(&run.id, "another-grant", &token)
            .await
            .is_err());
        let mut reference = json!({"id":"response","excerpt":"original date","readArguments":{"taskId":source,"pageToken":token}});
        assert_eq!(
            handler
                .verified_connection_training_message(&identity, &source, &reference)
                .await
                .unwrap()
                .1["author"],
            "owner"
        );
        reference["excerpt"] = json!("invented");
        assert!(handler
            .verified_connection_training_message(&identity, &source, &reference)
            .await
            .is_err());
        reference["excerpt"] = json!("original date");
        let duplicate = handler.cache_training_page(&run.id, &source, json!({"messages":[
            {"id":"response","content":"original date"},{"id":"response","content":"different content"}
        ]})).await.unwrap();
        let mut ambiguous = reference.clone();
        ambiguous["readArguments"]["pageToken"] = json!(duplicate);
        assert!(handler
            .verified_connection_training_message(&identity, &source, &ambiguous)
            .await
            .is_err());
        settings["primary"]["selfLearningEnabled"] = json!(false);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        assert!(handler
            .memory_progress_operation(&identity, "complete_memory_source", &args)
            .await
            .is_err());
        assert!(handler
            .verified_connection_training_message(&identity, &source, &reference)
            .await
            .is_err());
        assert!(store.memory_review_progress(7, &source).unwrap()["completedThrough"] == 0);
        assert!(!handler.connection_training_due(&store, 7, &run).unwrap());
        assert_eq!(
            handler.automation_store.get_run(&run.id).unwrap().status,
            AutomationRunStatus::Succeeded
        );
    }
}
