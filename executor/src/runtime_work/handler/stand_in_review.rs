//! Personal review setup belongs to the current account on this Executor.
use super::*;
use crate::runtime_work::automations::weekly_review;
use crate::task_runtime::mcp::StandInMcpIdentity;

impl RuntimeWorkRpcHandler {
    pub(super) async fn read_stand_in_review_history(
        &self,
        identity: &StandInMcpIdentity,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        let denied = || {
            AppIpcError::new(
                "permission_denied",
                "Review history requires a current primary identity or a bound review run",
            )
        };
        if identity.device != self.device_id
            || identity.work.is_some()
            || identity.project.is_some()
            || identity.coordinator_batch.is_some()
            || !matches!(identity.role.as_deref(), None | Some("@primary"))
        {
            return Err(denied());
        }
        let actor = self.local_task_link(&identity.task_id).ok_or_else(denied)?;
        if !super::stand_in_history::history_owned(&actor, identity.user)
            || actor.runtime_handle["origin"]["userId"] != identity.user
        {
            return Err(denied());
        }
        let end = if identity.review {
            self.review_run_end(&actor, identity.user)?
        } else {
            if actor.runtime_handle["origin"]["type"] != "stand_in_identity" {
                return Err(denied());
            }
            match args["windowEnd"].as_str() {
                Some(value) => chrono::DateTime::parse_from_rfc3339(value)
                    .map(|at| at.with_timezone(&chrono::Utc))
                    .map_err(|_| AppIpcError::new("bad_request", "Invalid windowEnd"))?,
                None => chrono::Utc::now(),
            }
        };
        let start = end - chrono::Duration::days(7);
        let previous = args["previousReviews"] == true;
        if let Some(id) = args["taskId"].as_str() {
            let link = self
                .local_task_link(id)
                .filter(|link| super::stand_in_history::history_owned(link, identity.user))
                .ok_or_else(denied)?;
            if previous && link.runtime_handle["origin"]["weeklyReview"] != true {
                return Err(AppIpcError::new(
                    "bad_request",
                    "previousReviews only reads review reports",
                ));
            }
            if id == identity.task_id {
                return Err(denied());
            }
            let mut page = self.transcript(json!({"taskId":id,"limit":50,"includeFullContent":false,"beforeCursor":args["beforeCursor"]})).await?;
            super::stand_in_history::filter_history_page(
                &mut page,
                (!previous).then_some(start.timestamp_millis()),
                Some(end.timestamp_millis()),
            );
            page["windowStart"] = json!(start);
            page["windowEnd"] = json!(end);
            return Ok(page);
        }
        let mut links: Vec<_> = self
            .local_task_links(true)
            .into_iter()
            .filter(|link| {
                super::stand_in_history::history_owned(link, identity.user)
                    && link.local_task_id != identity.task_id
                    && !self.archived_link_is_deleted(link)
                    && if previous {
                        link.runtime_handle["origin"]["weeklyReview"] == true
                    } else {
                        link.runtime_handle["origin"]["weeklyReview"] != true
                            && (link.updated_at == 0 || link.updated_at >= start.timestamp_millis())
                    }
            })
            .collect();
        links.sort_by(|a, b| a.local_task_id.cmp(&b.local_task_id));
        let cursor = args["taskCursor"].as_str().unwrap_or("");
        let mut remaining = links
            .into_iter()
            .filter(|link| link.local_task_id.as_str() > cursor);
        let items: Vec<_> = remaining.by_ref().take(50).map(|link| json!({"taskId":link.local_task_id,"title":link.title,"updatedAt":link.updated_at})).collect();
        let next = remaining
            .next()
            .and_then(|_| items.last().map(|item| item["taskId"].clone()));
        Ok(json!({"items":items,"nextTaskCursor":next,"windowStart":start,"windowEnd":end}))
    }

    fn review_run_end(
        &self,
        actor: &RuntimeTaskLink,
        user: i64,
    ) -> Result<chrono::DateTime<chrono::Utc>, AppIpcError> {
        use crate::runtime_work::automations::WEEKLY_REVIEW_TEMPLATE;
        let denied = || {
            AppIpcError::new(
                "permission_denied",
                "The review run binding is no longer valid",
            )
        };
        let schedule = &actor.runtime_handle["executionRequest"]["standInSchedule"];
        let automation = schedule["id"]
            .as_str()
            .and_then(|id| self.automation_store.get(id))
            .ok_or_else(denied)?;
        if actor.runtime_handle["origin"]["type"] != "stand_in_schedule"
            || actor.runtime_handle["origin"]["weeklyReview"] != true
            || actor.runtime_handle["origin"]["automationId"] != automation.id
            || automation.task_request["standInOwner"]["userId"] != user
            || automation.task_request["standInOwner"]["roleId"] != "@primary"
            || automation.task_request["standInCalendar"]["template"] != WEEKLY_REVIEW_TEMPLATE
            || json!(automation.version) != schedule["version"]
        {
            return Err(denied());
        }
        let run = self
            .automation_store
            .list_runs(Some(&automation.id))
            .into_iter()
            .find(|run| {
                json!(run.id) == schedule["runId"]
                    && matches!(
                        run.status,
                        AutomationRunStatus::Pending | AutomationRunStatus::Running
                    )
                    && run.coordination.as_ref().is_some_and(|binding| {
                        binding.user_id == user
                            && binding.role_id == "@primary"
                            && binding.automation_version == automation.version
                            && binding.task_id == actor.local_task_id
                    })
            })
            .ok_or_else(denied)?;
        Ok(run.scheduled_for)
    }

    pub(super) async fn stand_in_onboarding_rpc(
        &self,
        method: &str,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let user = payload["userId"]
            .as_i64()
            .filter(|id| *id >= 0)
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let template = weekly_review(
            user,
            &self.device_id,
            if method == "runtime.stand_in.onboarding.complete" && payload["weeklyReview"] == true {
                payload["time"].as_str().unwrap_or("09:00")
            } else {
                "09:00"
            },
            payload["language"].as_str().unwrap_or("zh-CN"),
        )
        .map_err(|error| AppIpcError::new("bad_request", error))?;
        let state = if method == "runtime.stand_in.onboarding.complete" {
            let selected = payload["weeklyReview"]
                .as_bool()
                .ok_or_else(|| AppIpcError::new("bad_request", "weeklyReview is required"))?;
            let gate = self.task_send_gate(&format!("stand-in-processing:{user}"));
            let _guard = gate.lock().await;
            let mut initialized = None;
            if selected
                && self
                    .automation_store
                    .stand_in_onboarding(user)
                    .map_err(|error| AppIpcError::new("automation_store_error", error))?
                    ["completed"]
                    != true
            {
                let store = LocalTaskStore::open(self.task_store_path.as_ref())
                    .map_err(super::stand_in::settings_error)?;
                if let Some(previous) = store
                    .materialize_implicit_primary(user, &self.device_id)
                    .map_err(super::stand_in::settings_error)?
                {
                    initialized = Some((store, previous));
                }
            }
            let result = match self
                .automation_store
                .complete_stand_in_onboarding(user, selected.then(|| template.clone()))
            {
                Ok(result) => result,
                Err(error) => {
                    if let Some((store, previous)) = initialized {
                        store
                            .restore_implicit_primary(user, &self.device_id, &previous)
                            .map_err(|rollback| {
                                AppIpcError::new(
                                    "automation_store_error",
                                    format!(
                                        "{error}; restoring primary settings failed: {rollback}"
                                    ),
                                )
                            })?;
                    }
                    return Err(AppIpcError::new("automation_store_error", error));
                }
            };
            self.emit_automations_changed(&template.id, "updated");
            result
        } else {
            self.automation_store
                .stand_in_onboarding(user)
                .map_err(|error| AppIpcError::new("automation_store_error", error))?
        };
        let settings = if method == "runtime.stand_in.onboarding.complete" {
            Some(
                LocalTaskStore::open(self.task_store_path.as_ref())
                    .map_err(super::stand_in::settings_error)?
                    .personal_stand_in(user, &self.device_id)
                    .map_err(super::stand_in::settings_error)?,
            )
        } else {
            None
        };
        Ok(json!({"state":state,"reviewTemplate":template,"settings":settings}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_filter_preserves_pagination_and_discloses_unknown_time_and_truncation() {
        let start = 1_780_000_000_000_i64;
        let end = start + 1000;
        let mut page = json!({"messages":[
            {"id":"old","createdAt":start-1}, {"id":"start","createdAt":start},
            {"id":"inside","createdAt":end-1}, {"id":"end","createdAt":end},
            {"id":"unknown"}], "turns":[{"private":"unfiltered"}],
            "beforeCursor":"older", "hasMoreBefore":true, "fullContent":false});
        super::super::stand_in_history::filter_history_page(&mut page, Some(start), Some(end));
        assert_eq!(
            page["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["start", "inside", "unknown"]
        );
        assert!(page.get("turns").is_none());
        assert_eq!(page["unknownTimestamps"], true);
        assert_eq!(page["contentMayBeTruncated"], true);
        assert_eq!(page["beforeCursor"], "older");
        assert_eq!(page["hasMoreBefore"], true);
        let mut previous = json!({"messages":[{"createdAt":start-1},{"createdAt":end}]});
        super::super::stand_in_history::filter_history_page(&mut previous, None, Some(end));
        assert_eq!(previous["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn onboarding_never_resumes_unrelated_persisted_turns() {
        assert!(!should_resume_persisted_turns_before_rpc(
            "runtime.stand_in.onboarding.get"
        ));
        assert!(!should_resume_persisted_turns_before_rpc(
            "runtime.stand_in.onboarding.complete"
        ));
    }

    #[tokio::test]
    async fn scheduled_review_uses_the_real_run_window_and_rejects_stale_versions() {
        let root = tempfile::tempdir().unwrap();
        let (handler, mut identity) = fixture(root.path());
        let review = handler
            .automation_store
            .create(weekly_review(7, "mac", "09:00", "en").unwrap())
            .unwrap();
        let (_, run) = handler
            .automation_store
            .start_manual_run(&review.id)
            .unwrap();
        let binding = run.coordination.as_ref().unwrap();
        identity.task_id = binding.task_id.clone();
        identity.review = true;
        handler.upsert_local_task(RuntimeTaskLink {local_task_id:binding.task_id.clone(),runtime_handle:json!({
            "origin":{"type":"stand_in_schedule","weeklyReview":true,"userId":7,"automationId":review.id},
            "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
        }),..Default::default()});
        let page = handler
            .read_stand_in_review_history(&identity, &json!({"windowEnd":"2000-01-01T00:00:00Z"}))
            .await
            .unwrap();
        let end =
            chrono::DateTime::parse_from_rfc3339(page["windowEnd"].as_str().unwrap()).unwrap();
        assert_eq!(end.with_timezone(&chrono::Utc), run.scheduled_for);
        handler.automation_store.update(review).unwrap();
        assert_eq!(
            handler
                .read_stand_in_review_history(&identity, &json!({}))
                .await
                .unwrap_err()
                .code,
            "permission_denied"
        );
    }

    fn fixture(root: &std::path::Path) -> (RuntimeWorkRpcHandler, StandInMcpIdentity) {
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.join("runtime.json"));
        handler.task_store_path = Arc::new(root.join("tasks.sqlite"));
        handler.automation_store =
            crate::runtime_work::automations::AutomationStore::new(root.join("automations.json"));
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id:"primary".into(),
            runtime_handle:json!({"origin":{"type":"stand_in_identity","userId":7},"executionRequest":{"user_id":7}}),
            ..Default::default()
        });
        (
            handler,
            StandInMcpIdentity {
                task_id: "primary".into(),
                user: 7,
                device: "mac".into(),
                role: None,
                work: None,
                ask_before_act: true,
                coordinator_batch: None,
                project: None,
                review: false,
                readonly_worker: false,
            },
        )
    }

    #[tokio::test]
    async fn discovery_reads_all_pages_and_keeps_identity_and_recent_updates_to_old_tasks() {
        let root = tempfile::tempdir().unwrap();
        let (handler, identity) = fixture(root.path());
        for index in 0..121 {
            handler.upsert_local_task(RuntimeTaskLink {
                local_task_id: format!("task-{index:03}"),
                created_at: 1,
                updated_at: chrono::Utc::now().timestamp_millis(),
                runtime_handle: json!({"executionRequest":{"user_id":7}}),
                ..Default::default()
            });
        }
        handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "other-user".into(),
            updated_at: chrono::Utc::now().timestamp_millis(),
            runtime_handle: json!({"executionRequest":{"user_id":8}}),
            ..Default::default()
        });
        handler.upsert_local_task(RuntimeTaskLink {local_task_id:"role-chat".into(),updated_at:chrono::Utc::now().timestamp_millis(),runtime_handle:json!({"origin":{"type":"stand_in_identity"},"executionRequest":{"user_id":7}}),..Default::default()});
        let mut args = json!({});
        let mut ids = Vec::new();
        loop {
            let page = handler
                .read_stand_in_review_history(&identity, &args)
                .await
                .unwrap();
            ids.extend(
                page["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| item["taskId"].as_str().unwrap().to_owned()),
            );
            if page["nextTaskCursor"].is_null() {
                break;
            }
            args = json!({"taskCursor":page["nextTaskCursor"],"windowEnd":page["windowEnd"]});
        }
        assert_eq!(ids.len(), 122);
        assert!(ids.contains(&"role-chat".into()));
        assert!(!ids.contains(&"other-user".into()));
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 122);
    }

    #[tokio::test]
    async fn history_rejects_forged_runs_foreign_owners_roles_devices_and_previous_report_bypass() {
        let root = tempfile::tempdir().unwrap();
        let (handler, identity) = fixture(root.path());
        for forbidden in [
            StandInMcpIdentity {
                user: 8,
                ..identity.clone()
            },
            StandInMcpIdentity {
                device: "other".into(),
                ..identity.clone()
            },
            StandInMcpIdentity {
                role: Some("other".into()),
                ..identity.clone()
            },
            StandInMcpIdentity {
                work: Some("external".into()),
                ..identity.clone()
            },
            StandInMcpIdentity {
                review: true,
                readonly_worker: false,
                ..identity.clone()
            },
        ] {
            assert_eq!(
                handler
                    .read_stand_in_review_history(&forbidden, &json!({}))
                    .await
                    .unwrap_err()
                    .code,
                "permission_denied"
            );
        }
        assert_eq!(
            handler
                .read_stand_in_review_history(
                    &identity,
                    &json!({"taskId":"primary","previousReviews":true})
                )
                .await
                .unwrap_err()
                .code,
            "bad_request"
        );
        assert_eq!(
            handler
                .read_stand_in_review_history(&identity, &json!({"taskId":"missing"}))
                .await
                .unwrap_err()
                .code,
            "permission_denied"
        );
    }

    #[tokio::test]
    async fn onboarding_rpc_is_offline_and_repeated_completion_does_not_recreate_deleted_review() {
        let root = tempfile::tempdir().unwrap();
        let (handler, _) = fixture(root.path());
        let args = json!({"userId":7,"weeklyReview":true,"time":"09:00"});
        let before = handler
            .stand_in_onboarding_rpc("runtime.stand_in.onboarding.get", args.clone())
            .await
            .unwrap();
        assert_eq!(before["state"]["completed"], false);
        let completed = handler
            .stand_in_onboarding_rpc("runtime.stand_in.onboarding.complete", args.clone())
            .await
            .unwrap();
        assert_eq!(completed["state"]["completed"], true);
        assert_eq!(completed["settings"]["primary"]["enabled"], true);
        handler
            .automation_store
            .delete("stand-in-weekly-review-7")
            .unwrap();
        handler
            .stand_in_onboarding_rpc("runtime.stand_in.onboarding.complete", args)
            .await
            .unwrap();
        assert!(handler.automation_store.list().is_empty());
    }

    #[tokio::test]
    async fn onboarding_preserves_a_paused_primary_and_does_not_initialize_on_opt_out() {
        let root = tempfile::tempdir().unwrap();
        let (handler, _) = fixture(root.path());
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"] =
            json!({"enabled":false,"prompt":"Keep this","preferences":"Private preference"});
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        let completed = handler
            .stand_in_onboarding_rpc(
                "runtime.stand_in.onboarding.complete",
                json!({"userId":7,"weeklyReview":true}),
            )
            .await
            .unwrap();
        assert_eq!(completed["settings"]["primary"]["enabled"], false);
        assert_eq!(completed["settings"]["primary"]["prompt"], "Keep this");
        let opted_out = handler
            .stand_in_onboarding_rpc(
                "runtime.stand_in.onboarding.complete",
                json!({"userId":8,"weeklyReview":false}),
            )
            .await
            .unwrap();
        assert!(opted_out["settings"]["primary"].is_null());
    }
}
