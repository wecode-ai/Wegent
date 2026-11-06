//! Native-approved webhook configuration keeps receiver secrets out of model input.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;

// Project webhook flags documented by GitLab; additional returned flags remain
// visible in the public result without claiming they are supported on every version.
const GITLAB_EVENTS: &[&str] = &[
    "push_events",
    "issues_events",
    "confidential_issues_events",
    "merge_requests_events",
    "tag_push_events",
    "note_events",
    "confidential_note_events",
    "job_events",
    "pipeline_events",
    "wiki_page_events",
    "deployment_events",
    "releases_events",
    "milestone_events",
    "feature_flag_events",
    "resource_access_token_events",
    "resource_deploy_token_events",
];

struct GitlabEventPlan {
    version: String,
    events: Vec<Value>,
    unavailable: Vec<String>,
}

impl GitlabEventPlan {
    fn parse(version: &str) -> Result<Self, AppIpcError> {
        let invalid = || {
            AppIpcError::new("git_version_unavailable", "Cannot determine GitLab event support; inspect the instance version before configuring its webhook")
        };
        if version.len() > 128 {
            return Err(invalid());
        }
        let release = version.split('-').next().ok_or_else(invalid)?;
        let parts: Vec<_> = release.split('.').map(str::parse::<u64>).collect();
        let [Ok(major), Ok(minor), Ok(_)] = parts.as_slice() else {
            return Err(invalid());
        };
        // GitLab's documented introduction versions, not optional permissions:
        // https://docs.gitlab.com/user/project/integrations/webhook_events/
        let gated = [
            ("milestone_events", (18, 2)),
            ("resource_deploy_token_events", (18, 4)),
        ];
        let unavailable: Vec<String> = gated
            .iter()
            .filter(|(_, minimum)| (*major, *minor) < *minimum)
            .map(|(name, _)| (*name).to_owned())
            .collect();
        let events = GITLAB_EVENTS
            .iter()
            .filter(|name| !unavailable.iter().any(|item| item == **name))
            .map(|name| json!(name))
            .collect();
        Ok(Self {
            version: version.to_owned(),
            events,
            unavailable,
        })
    }

    fn warnings(&self) -> Vec<String> {
        self.unavailable.iter().map(|name| format!("GitLab {} does not support {name}; this event is unavailable on this instance version", self.version)).collect()
    }

    fn accepts(&self, requested: &[Value]) -> bool {
        self.events.iter().all(|name| requested.contains(name))
            && !self
                .unavailable
                .iter()
                .any(|name| requested.contains(&json!(name)))
    }
}

fn webhook_result(hook: &Value, callback: &str, plan: Option<&GitlabEventPlan>) -> Value {
    let mut result = public_hook(hook, callback);
    if let Some(plan) = plan {
        result["platformVersion"] = json!(plan.version);
        result["coverageWarnings"] = json!(plan.warnings());
    }
    result
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn configure_git_webhook(
        &self,
        identity: &StandInMcpIdentity,
        args: &Value,
        plan: bool,
    ) -> Result<Value, AppIpcError> {
        if identity.device != self.device_id
            || identity.coordinator_batch.is_some()
            || identity.project.is_some()
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Webhook configuration requires an owner conversation",
            ));
        }
        let actor = self
            .local_task_link(&identity.task_id)
            .ok_or_else(|| AppIpcError::new("permission_denied", "Conversation unavailable"))?;
        if actor.runtime_handle["origin"]["userId"] != identity.user
            || actor.runtime_handle["executionRequest"]["user_id"].as_i64() != Some(identity.user)
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Conversation owner changed",
            ));
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let settings = store
            .personal_stand_in(identity.user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let roles = crate::task_runtime::personal_stand_in::stand_in_identities(&settings);
        let source = roles
            .iter()
            .filter(|r| {
                matches!(identity.role.as_deref(), None | Some("@primary"))
                    || r["id"].as_str() == identity.role.as_deref()
            })
            .flat_map(|r| r["connections"].as_array().into_iter().flatten())
            .find(|s| {
                s["subscriptionId"] == args["subscriptionId"]
                    && s["kind"] == "repository"
                    && s["providerId"]
                        .as_str()
                        .is_some_and(|p| p.starts_with(super::super::git_connections::PACKAGE))
            })
            .ok_or_else(|| {
                AppIpcError::new(
                    "source_removed",
                    "Save the repository connection before configuring its webhook",
                )
            })?;
        let profile: Value = serde_json::from_str(source["profile"].as_str().unwrap_or(""))
            .map_err(|_| AppIpcError::new("git_connection_invalid", "Invalid account"))?;
        if args["repository"] != source["name"] || args["instance"] != profile[0] {
            return Err(AppIpcError::new(
                "permission_denied",
                "Webhook target does not match the saved source",
            ));
        }
        let provider = source["providerId"].as_str().unwrap();
        let github = provider.ends_with("/github");
        let events = args["events"].as_array().cloned().unwrap_or_default();
        self.validate_git_source(source).await?;
        let event_plan = if github {
            None
        } else {
            let response = super::super::git_connections::read(json!({"providerId":provider,"instance":profile[0],"profile":source["profile"],"operation":"server_version"})).await?;
            Some(GitlabEventPlan::parse(
                response["data"]["version"].as_str().unwrap_or(""),
            )?)
        };
        if !plan {
            if events.is_empty() || events.len() > 64 {
                return Err(AppIpcError::new(
                    "bad_request",
                    "Explicit webhook events are required",
                ));
            }
            if github && events != vec![json!("*")] {
                return Err(AppIpcError::new(
                    "bad_request",
                    "GitHub repository connections subscribe to all events",
                ));
            }
            if !github
                && (!event_plan
                    .as_ref()
                    .is_some_and(|plan| plan.accepts(&events))
                    || !events.iter().all(|v| {
                        v.as_str().is_some_and(|s| {
                            s.len() <= 128
                                && s.ends_with("_events")
                                && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                        })
                    }))
            {
                return Err(AppIpcError::new(
                    "bad_request",
                    "Invalid GitLab event flags",
                ));
            }
        }
        let subscription = source["subscriptionId"].as_str().unwrap();
        let config=self.runtime_http(reqwest::Method::POST,&format!("/v1/git-connections/subscriptions/{subscription}/configuration"),Some(&json!({"deviceId":self.device_id,"generation":source["generation"],"reveal":!plan}))).await?;
        let connection = self
            .backend_connection_snapshot()?
            .ok_or_else(|| AppIpcError::new("cloud_unavailable", "Cloud unavailable"))?;
        let callback = format!(
            "{}{}",
            connection.backend_url.trim_end_matches('/'),
            config["callbackPath"].as_str().unwrap_or("")
        );
        if plan {
            return Ok(
                json!({"instance":profile[0],"repository":source["name"],"subscriptionId":subscription,"callbackUrl":callback,"events":event_plan.as_ref().map(|plan| json!(plan.events)).unwrap_or_else(||json!(["*"])),"platformVersion":event_plan.as_ref().map(|plan| &plan.version),"coverageWarnings":event_plan.as_ref().map(GitlabEventPlan::warnings).unwrap_or_default(),"eventReference":"https://docs.gitlab.com/api/project_webhooks/","nativeApprovalRequired":true}),
            );
        }
        if args["callbackUrl"] != callback {
            return Err(AppIpcError::new(
                "bad_request",
                "Read git_webhook_plan before approving the exact callback destination",
            ));
        }
        let read = json!({"providerId":provider,"instance":profile[0],"profile":source["profile"],"repository":source["name"],"operation":"api","path":"hooks"});
        let existing = find_hook(read.clone(), &callback).await?;
        if let Some(hook) = existing.as_ref() {
            if events_match(github, &events, hook) {
                return Ok(webhook_result(hook, &callback, event_plan.as_ref()));
            }
        }
        let request = super::stand_in_tasks::required(args, "requestId")?;
        let mut action = args.clone();
        action["profile"] = source["profile"].clone();
        let (receipt, previous) = store
            .begin_git_subscription_operation(identity.user, subscription, request, &action)
            .map_err(super::stand_in::settings_error)?;
        if let Some(previous) = previous {
            return Ok(previous);
        }
        let mut body = if github {
            json!({"name":"web","active":true,"events":["*"],"config":{"url":callback,"content_type":"json","secret":config["secret"],"insecure_ssl":"0"}})
        } else {
            json!({"url":callback,"token":config["secret"],"enable_ssl_verification":true})
        };
        if !github {
            for event in &events {
                body[event.as_str().unwrap()] = json!(true);
            }
        }
        let mut write = read;
        write["method"] = json!(if existing.is_some() {
            if github {
                "PATCH"
            } else {
                "PUT"
            }
        } else {
            "POST"
        });
        if let Some(hook) = existing.as_ref() {
            write["path"] = json!(format!("hooks/{}", hook["id"]));
        }
        write["body"] = body;
        let result = match super::super::git_connections::write(write).await {
            Ok(result) => result,
            Err(failure) => {
                if !failure.uncertain {
                    store
                        .fail_unsent_git_operation(identity.user, &receipt)
                        .map_err(super::stand_in::settings_error)?;
                }
                return Err(failure.error);
            }
        };
        if !events_match(github, &events, &result) {
            let mut partial = webhook_result(&result, &callback, event_plan.as_ref());
            partial["configured"] = json!(false);
            partial["coverageComplete"] = json!(false);
            store
                .complete_git_operation(identity.user, &receipt, &partial)
                .map_err(super::stand_in::settings_error)?;
            return Err(AppIpcError::new(
                "git_event_coverage_incomplete",
                "The platform did not enable every requested event; inspect webhook settings",
            ));
        }
        let result = webhook_result(&result, &callback, event_plan.as_ref());
        store
            .complete_git_operation(identity.user, &receipt, &result)
            .map_err(super::stand_in::settings_error)?;
        Ok(result)
    }
}

async fn find_hook(mut query: Value, callback: &str) -> Result<Option<Value>, AppIpcError> {
    for page in 1..=100 {
        query["path"] = json!(format!("hooks?per_page=100&page={page}"));
        let response = super::super::git_connections::read(query.clone()).await?;
        let hooks = response["data"]
            .as_array()
            .ok_or_else(|| AppIpcError::new("git_connection_invalid", "Invalid webhook list"))?;
        if let Some(hook) = hooks
            .iter()
            .find(|hook| hook["config"]["url"] == callback || hook["url"] == callback)
        {
            return Ok(Some(hook.clone()));
        }
        if hooks.len() < 100 {
            return Ok(None);
        }
    }
    Err(AppIpcError::new(
        "git_backlog_limit",
        "Cannot enumerate every webhook; refusing to create a possible duplicate",
    ))
}

fn events_match(github: bool, events: &[Value], hook: &Value) -> bool {
    if github {
        hook["active"] == true
            && hook["events"]
                .as_array()
                .is_some_and(|v| v.contains(&json!("*")))
    } else {
        !events.is_empty()
            && events
                .iter()
                .all(|event| event.as_str().is_some_and(|name| hook[name] == true))
    }
}

fn public_hook(hook: &Value, callback: &str) -> Value {
    let flags: Map<String, Value> = hook
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, value)| key.ends_with("_events") && value.is_boolean())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    json!({"id":hook["id"],"callbackUrl":callback,"events":hook["events"],"eventFlags":flags,"configured":true,"deliveryVerified":false})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn older_gitlab_plans_keep_all_available_events_and_report_version_gaps() {
        for version in ["17.11.7-ee", "18.1.0", "18.2.0", "18.4.0-ee"] {
            let plan = GitlabEventPlan::parse(version).unwrap();
            assert!(plan.accepts(&plan.events));
            let mut hook = json!({"id":1});
            for event in &plan.events {
                hook[event.as_str().unwrap()] = json!(true);
            }
            assert!(events_match(false, &plan.events, &hook));
            let result = webhook_result(&hook, "https://cloud/hook", Some(&plan));
            assert_eq!(result["configured"], true);
            assert_eq!(
                result["coverageWarnings"].as_array().unwrap().len(),
                plan.unavailable.len()
            );
            assert!(plan.events.contains(&json!("resource_access_token_events")));
            hook["resource_access_token_events"] = json!(false);
            assert!(!events_match(false, &plan.events, &hook));
        }
        let old = GitlabEventPlan::parse("17.11.7-ee").unwrap();
        assert_eq!(
            old.unavailable,
            ["milestone_events", "resource_deploy_token_events"]
        );
        let mut unavailable_requested = old.events.clone();
        unavailable_requested.push(json!("milestone_events"));
        assert!(!old.accepts(&unavailable_requested));
        let milestone = GitlabEventPlan::parse("18.2.0").unwrap();
        assert!(milestone.events.contains(&json!("milestone_events")));
        assert!(!milestone
            .events
            .contains(&json!("resource_deploy_token_events")));
        assert!(GitlabEventPlan::parse("18.4.0-ee")
            .unwrap()
            .unavailable
            .is_empty());
        for invalid in ["", "unknown", "18.4", "18.4.x"] {
            assert!(GitlabEventPlan::parse(invalid).is_err());
        }
    }
    #[test]
    fn gitlab_validates_requested_flags_and_preserves_additional_flags() {
        let plan = GitlabEventPlan::parse("18.4.0-ee").unwrap();
        assert!(!plan.accepts(&[json!("push_events")]));
        let mut complete: Vec<_> = GITLAB_EVENTS.iter().map(|name| json!(name)).collect();
        assert!(plan.accepts(&complete));
        complete.push(json!("future_events"));
        assert!(plan.accepts(&complete));
        let events = vec![json!("push_events")];
        assert!(events_match(
            false,
            &events,
            &json!({"push_events":true,"note_events":false})
        ));
        assert!(events_match(
            false,
            &events,
            &json!({"push_events":true,"future_events":false})
        ));
        assert!(events_match(
            false,
            &events,
            &json!({"push_events":true,"note_events":true})
        ));
        assert!(events_match(
            false,
            &events,
            &json!({"push_events":true,"repository_update_events":false})
        ));
        assert!(!events_match(
            false,
            &[json!("unknown_events")],
            &json!({"push_events":true})
        ));
    }
    #[test]
    fn configuration_results_hide_credentials_and_require_every_event() {
        let hook = json!({"id":1,"url":"https://cloud/hooks/id","token":"synthetic-secret","config":{"secret":"synthetic-secret"},"push_events":true,"note_events":false});
        assert!(!public_hook(&hook, "https://cloud/hooks/id")
            .to_string()
            .contains("synthetic-secret"));
        assert!(!events_match(
            false,
            &[json!("push_events"), json!("note_events")],
            &hook
        ));
        assert!(events_match(false, &[json!("push_events")], &hook));
        assert_eq!(
            public_hook(&hook, "https://cloud/hooks/id")["eventFlags"]["note_events"],
            false
        );
        assert!(!events_match(
            true,
            &[json!("*")],
            &json!({"active":true,"events":["issues"]})
        ));
    }
}
